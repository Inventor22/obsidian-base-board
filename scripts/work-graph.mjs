import { build } from "esbuild";
import { parseDocument } from "yaml";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
let sharedPromise;
async function shared() {
  sharedPromise ??= build({
    stdin: {
      contents:
        'export * from "./src/graph-commands.ts"; export * from "./src/work-graph.ts"; export * from "./src/graph-engine.ts";',
      resolveDir: project,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    banner: {
      js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(import.meta.url)});`,
    },
  }).then(
    (result) =>
      import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      ),
  );
  return sharedPromise;
}

const hash = (text) => createHash("sha256").update(text).digest("hex");
const exists = async (filename) => {
  try {
    await realpath(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

async function vaultPaths(vault) {
  if (!(await exists(path.join(vault, ".obsidian"))))
    throw new Error("Not an Obsidian vault");
  const paths = [];
  const visit = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (/\.(md|base)$/.test(entry.name))
        paths.push(path.relative(vault, filename).replaceAll("\\", "/"));
    }
  };
  await visit(vault);
  return paths.sort();
}

function eligible(properties) {
  const hasOrder = [properties.graph_order, properties.kanban_order].some(
    (value) => value !== undefined && value !== null && value !== "",
  );
  return hasOrder || properties.baseboard_schema !== undefined;
}

function migrateBase(content) {
  const document = parseDocument(content);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const properties = document.toJS();
  if (!properties || !Array.isArray(properties.views)) return content;
  let changed = false;
  for (const [index, view] of properties.views.entries()) {
    if (!["kanban", "graph", "timeline", "rollout"].includes(view.type))
      continue;
    const legacy = {};
    for (const key of ["frontierPriority", "frontierScope"]) {
      if (view[key] !== undefined) legacy[key] = view[key];
    }
    if (view.boardProjection === "active-frontier")
      legacy.boardProjection = view.boardProjection;
    if (Object.keys(legacy).length) {
      if (view.baseboard_legacy_frontier !== undefined)
        throw new Error("Existing legacy-frontier archive requires review");
      document.setIn(["views", index, "baseboard_legacy_frontier"], legacy);
      for (const key of ["frontierPriority", "frontierScope"])
        document.deleteIn(["views", index, key]);
      if (
        view.frontierScope !== undefined &&
        view.suggestedNextScope === undefined
      )
        document.setIn(
          ["views", index, "suggestedNextScope"],
          view.frontierScope,
        );
      if (view.boardProjection === "active-frontier")
        document.setIn(["views", index, "boardProjection"], "suggested-next");
      changed = true;
    }
  }
  if (!changed) return content;
  const result = document.toString({ lineWidth: 0 });
  return content.includes("\r\n") ? result.replace(/\r?\n/g, "\r\n") : result;
}

export async function buildMigrationPlan(vault) {
  vault = await realpath(vault);
  const core = await shared();
  const paths = await vaultPaths(vault);
  const at = new Date().toISOString();
  const notes = [];
  const files = [];
  const issues = [];
  for (const relative of paths) {
    const before = await readFile(path.join(vault, relative), "utf8");
    if (relative.endsWith(".base")) {
      try {
        files.push({
          path: relative,
          kind: "base",
          before,
          after: migrateBase(before),
          warnings: [],
        });
      } catch (error) {
        issues.push({ path: relative, error: error.message });
      }
      continue;
    }
    try {
      const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        before,
      );
      if (!header) continue;
      const metadata = parseDocument(header[1]);
      if (
        !["graph_order", "kanban_order", "baseboard_schema"].some((key) =>
          metadata.has(key),
        )
      )
        continue;
      const document = await core.readGraphDocument(relative, before);
      if (eligible(document.properties)) notes.push({ ...document, before });
    } catch (error) {
      if (/^(graph_order|kanban_order|baseboard_schema):/m.test(before))
        issues.push({ path: relative, error: error.message });
    }
  }
  const byReference = new Map();
  for (const note of notes) {
    for (const raw of [
      note.path,
      note.path.split("/").pop(),
      note.properties.id,
      note.properties.title,
    ]) {
      const key = core.normalizeReference(raw);
      if (!key) continue;
      const values = byReference.get(key) ?? new Set();
      values.add(note.path);
      byReference.set(key, values);
    }
  }
  const containers = new Set();
  const relationships = [];
  for (const note of notes) {
    for (const field of [
      "parent",
      "rollup_to",
      "depends_on",
      "sequence_after",
      "associations",
      "compensates",
    ]) {
      for (const reference of core.normalizeReferences(
        note.properties[field],
      )) {
        const targets = byReference.get(reference);
        if (targets?.size !== 1)
          relationships.push({
            path: note.path,
            field,
            reference,
            assessment: "unresolved-or-ambiguous",
          });
        else if (field === "parent" || field === "rollup_to")
          containers.add([...targets][0]);
      }
    }
  }
  for (const note of notes) {
    try {
      const planned = core.planWorkMigration(
        note.properties,
        containers.has(note.path),
        at,
      );
      const after = Object.keys(planned.set).length
        ? core.patchGraphMarkdown(note.before, { set: planned.set })
        : note.before;
      const parsed = await core.readGraphDocument(note.path, after);
      const preserved = { ...parsed.properties };
      delete preserved.baseboard_schema;
      delete preserved.baseboard_migration;
      const original = { ...note.properties };
      delete original.baseboard_schema;
      delete original.baseboard_migration;
      if (
        !core.graphValuesEqual(original, preserved) ||
        parsed.body !== note.body
      )
        throw new Error("Migration preservation check failed");
      files.push({
        path: note.path,
        kind: "note",
        before: note.before,
        after,
        warnings: planned.warnings,
      });
    } catch (error) {
      issues.push({ path: note.path, error: error.message });
    }
  }
  const manifest = JSON.parse(
    await readFile(path.join(project, "manifest.json"), "utf8"),
  );
  const dataPath = `.obsidian/plugins/${manifest.id}/data.json`;
  if (await exists(path.join(vault, dataPath))) {
    const before = await readFile(path.join(vault, dataPath), "utf8");
    try {
      const data = JSON.parse(before);
      if (data.workGraphSchema !== undefined && data.workGraphSchema !== 1)
        throw new Error("Unsupported plugin work-graph schema");
      const after =
        data.workGraphSchema === 1
          ? before
          : JSON.stringify({ ...data, workGraphSchema: 1 }, null, 2) + "\n";
      files.push({
        path: dataPath,
        kind: "plugin-data",
        before,
        after,
        warnings: [],
      });
    } catch (error) {
      issues.push({ path: dataPath, error: error.message });
    }
  }
  return {
    version: 1,
    vault,
    at,
    files,
    issues,
    relationships,
    notes: notes.length,
    identityConflicts: [...byReference]
      .filter(([, values]) => values.size > 1)
      .map(([reference, values]) => ({ reference, paths: [...values] })),
  };
}

export function migrationInventory(plan) {
  return {
    version: plan.version,
    vault: plan.vault,
    at: plan.at,
    notes: plan.notes,
    changed: plan.files.filter((file) => file.before !== file.after).length,
    bases: plan.files.filter((file) => file.kind === "base").length,
    issues: plan.issues,
    relationships: plan.relationships,
    identityConflicts: plan.identityConflicts,
    files: plan.files.map(
      ({ path: filename, kind, before, after, warnings }) => ({
        path: filename,
        kind,
        changed: before !== after,
        beforeRevision: hash(before),
        afterRevision: hash(after),
        warnings,
      }),
    ),
  };
}

async function atomicWrite(filename, before, after) {
  const temporary = `${filename}.baseboard-${randomUUID()}.tmp`;
  try {
    if ((await readFile(filename, "utf8")) !== before)
      throw new Error(`Revision conflict: ${filename}`);
    await writeFile(temporary, after, { flag: "wx" });
    if ((await readFile(filename, "utf8")) !== before)
      throw new Error(`Concurrent edit: ${filename}`);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyMigrationPlan(
  plan,
  { backup, app, beforeWrite } = {},
) {
  if (plan.issues.length)
    throw new Error(
      "Migration inventory has blocking issues; no writes performed",
    );
  const changed = plan.files.filter((file) => file.before !== file.after);
  if (!changed.length) return { state: "unchanged", changed: 0, backup: null };
  backup ??= path.join(
    tmpdir(),
    `baseboard-work-graph-migration-${randomUUID()}`,
  );
  if (await exists(backup)) throw new Error("Backup directory must be new");
  await mkdir(backup, { recursive: true });
  const journal = {
    state: "prepared",
    vault: plan.vault,
    backup,
    inventory: migrationInventory(plan),
    applied: [],
    conflicts: [],
  };
  const saveJournal = () =>
    writeFile(
      path.join(backup, "journal.json"),
      JSON.stringify(journal, null, 2),
    );
  for (const file of plan.files) {
    if (
      (await readFile(path.join(plan.vault, file.path), "utf8")) !== file.before
    )
      throw new Error(`Inventory became stale: ${file.path}`);
    const target = path.join(backup, "vault", file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(plan.vault, file.path), target);
    if (hash(await readFile(target, "utf8")) !== hash(file.before))
      throw new Error(`Backup changed while copying: ${file.path}`);
  }
  await saveJournal();
  const write = async (file, before, after) => {
    const filename = path.join(plan.vault, file.path);
    if (app && file.kind !== "plugin-data") {
      const target = app.vault.getAbstractFileByPath(file.path);
      if (!target) throw new Error(`Missing vault file: ${file.path}`);
      await app.vault.process(target, (current) => {
        if (current !== before)
          throw new Error(`Concurrent vault edit: ${file.path}`);
        return after;
      });
    } else await atomicWrite(filename, before, after);
    if ((await readFile(filename, "utf8")) !== after)
      throw new Error(`Post-write verification failed: ${file.path}`);
  };
  try {
    journal.state = "applying";
    await saveJournal();
    for (const file of changed) {
      await beforeWrite?.(file, journal.applied.length);
      try {
        await write(file, file.before, file.after);
      } catch (error) {
        if (
          (await readFile(path.join(plan.vault, file.path), "utf8")) ===
          file.after
        )
          journal.applied.push(file.path);
        throw error;
      }
      journal.applied.push(file.path);
      await saveJournal();
    }
    journal.state = "applied";
  } catch (error) {
    journal.error = error.message;
    for (const filename of [...journal.applied].reverse()) {
      const file = changed.find((candidate) => candidate.path === filename);
      try {
        await write(file, file.after, file.before);
      } catch (rollbackError) {
        journal.conflicts.push({
          path: filename,
          error: rollbackError.message,
        });
      }
    }
    journal.state = journal.conflicts.length ? "partial" : "rolled-back";
  }
  await saveJournal();
  return {
    state: journal.state,
    changed: journal.applied.length,
    backup,
    error: journal.error,
    conflicts: journal.conflicts,
  };
}

export async function runNativeMigration(app, vault, resultPath) {
  if (
    path.resolve(app.vault.adapter.basePath).toLowerCase() !==
    path.resolve(vault).toLowerCase()
  )
    throw new Error("Native vault mismatch");
  const pluginId = JSON.parse(
    await readFile(path.join(project, "manifest.json"), "utf8"),
  ).id;
  const plugin = app.plugins.plugins[pluginId];
  const activeLeaf = app.workspace.activeLeaf;
  const embedded = app.workspace
    .getLeavesOfType("markdown")
    .some((leaf) => leaf.view.containerEl?.querySelector(".base-board-graph"));
  if (embedded)
    throw new Error(
      "Close embedded Graph views before native migration; editable Markdown panes will not be closed automatically",
    );
  const views = app.workspace
    .getLeavesOfType("bases")
    .filter((leaf) =>
      leaf.view.containerEl?.querySelector(
        ".base-board-graph, .base-board-container, .base-board-timeline",
      ),
    )
    .map((leaf) => ({ leaf, state: leaf.getViewState() }));
  const recordingOwners = new Set(
    [
      plugin,
      ...views.map(({ leaf }) => leaf.view.controller?.view?.plugin),
    ].filter(Boolean),
  );
  await writeFile(
    `${resultPath}.views.json`,
    JSON.stringify(
      {
        pluginLoaded: Boolean(plugin),
        activeLeaf: activeLeaf?.id,
        views: views.map(({ leaf, state }) => ({ id: leaf.id, state })),
      },
      null,
      2,
    ),
  );
  let result;
  try {
    for (const { leaf } of views)
      await leaf.setViewState({ type: "empty", state: {} });
    if (plugin) {
      await app.plugins.disablePlugin(pluginId);
    }
    for (const owner of recordingOwners) await owner.pluginDataWrites;
    const plan = await buildMigrationPlan(vault);
    result = await applyMigrationPlan(plan, { app });
    result.inventory = migrationInventory(plan);
  } catch (error) {
    result = { state: "failed", error: error.message };
  } finally {
    const restoreErrors = [];
    try {
      if (plugin) await app.plugins.enablePlugin(pluginId);
    } catch (error) {
      restoreErrors.push(error.message);
    }
    for (const { leaf, state } of views) {
      try {
        await leaf.setViewState(state);
      } catch (error) {
        restoreErrors.push(error.message);
      }
    }
    if (activeLeaf) app.workspace.setActiveLeaf(activeLeaf, { focus: false });
    result.viewsRestored = restoreErrors.length === 0;
    if (restoreErrors.length) result.restoreErrors = restoreErrors;
  }
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  return {
    state: result.state,
    changed: result.changed,
    backup: result.backup,
    resultPath,
  };
}

async function offlineStore(vault) {
  const core = await shared();
  const commandPath = (id) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id))
      throw new Error("Invalid batch id");
    return path.join(vault, ".baseboard", "commands", `${id}.json`);
  };
  const notePath = (relative) => {
    if (
      !relative.endsWith(".md") ||
      /(^[\\/]|^[a-zA-Z]:|\\|(^|\/)\.)/.test(relative)
    )
      throw new Error("Invalid note path");
    return path.join(vault, relative);
  };
  const store = {
    list: async () =>
      (await vaultPaths(vault)).filter((filename) => filename.endsWith(".md")),
    read: async (relative) => {
      const filename = notePath(relative);
      return core.readGraphDocument(
        relative,
        (await exists(filename)) ? await readFile(filename, "utf8") : null,
      );
    },
    write: async (change) => {
      const current = await store.read(change.path);
      if (current.revision !== change.expectedRevision)
        throw new Error(`Revision conflict: ${change.path}`);
      const filename = notePath(change.path);
      if (change.create) {
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, core.patchGraphMarkdown("", change), {
          flag: "wx",
        });
      } else if (change.delete) {
        const trash = path.join(
          vault,
          ".baseboard",
          "deleted",
          `${randomUUID()}.md`,
        );
        await mkdir(path.dirname(trash), { recursive: true });
        await rename(filename, trash);
      } else {
        const before = await readFile(filename, "utf8");
        if (hash(before) !== change.expectedRevision)
          throw new Error(`Revision conflict: ${change.path}`);
        await atomicWrite(
          filename,
          before,
          core.patchGraphMarkdown(before, change),
        );
      }
      return store.read(change.path);
    },
    getReceipt: async (id) =>
      (await exists(commandPath(id)))
        ? JSON.parse(await readFile(commandPath(id), "utf8"))
        : null,
    saveReceipt: async (receipt) => {
      const filename = commandPath(receipt.id);
      await mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp`;
      await writeFile(temporary, JSON.stringify(receipt, null, 2));
      await rename(temporary, filename);
    },
  };
  return store;
}

function requireClosed(options) {
  if (!options.closed)
    throw new Error(
      "Offline writes require --closed after closing Obsidian; use queue/native for an open vault",
    );
  if (process.platform === "win32") {
    const processes = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq Obsidian.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8" },
    );
    if (/"Obsidian\.exe"/i.test(processes))
      throw new Error("Obsidian is running; use the native plugin interface");
  }
}

export function graphRequestUri(vault, requestId, registry) {
  const normalize = (value) =>
    path.resolve(value).replaceAll("\\", "/").toLowerCase();
  const matches = Object.entries(registry.vaults ?? {}).filter(
    ([, entry]) =>
      typeof entry.path === "string" &&
      normalize(entry.path) === normalize(vault),
  );
  if (matches.length !== 1)
    throw new Error(
      "Vault must have one matching entry in Obsidian's local registry before queuing a native request",
    );
  return `obsidian://baseboard-command?vault=${encodeURIComponent(matches[0][0])}&request=${encodeURIComponent(requestId)}`;
}

async function readVaultRegistry() {
  const directory =
    process.platform === "win32"
      ? path.join(process.env.APPDATA, "obsidian")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support", "obsidian")
        : path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
            "obsidian",
          );
  return JSON.parse(
    await readFile(path.join(directory, "obsidian.json"), "utf8"),
  );
}

async function main() {
  const [operation, ...arguments_] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    if (!arguments_[index].startsWith("--"))
      throw new Error("Options must start with --");
    const key = arguments_[index].slice(2);
    options[key] =
      arguments_[index + 1] && !arguments_[index + 1].startsWith("--")
        ? arguments_[++index]
        : true;
  }
  if (!options.vault)
    throw new Error(
      "Usage: node scripts/work-graph.mjs <inventory|migrate|query|preview|apply|undo|queue> --vault <path>",
    );
  const vault = await realpath(options.vault);
  await vaultPaths(vault);
  const core = await shared();
  let result;
  if (operation === "inventory" || (operation === "migrate" && !options.apply))
    result = migrationInventory(await buildMigrationPlan(vault));
  else if (operation === "migrate") {
    requireClosed(options);
    result = await applyMigrationPlan(await buildMigrationPlan(vault), {
      backup: options.backup,
    });
  } else if (operation === "queue") {
    const request = JSON.parse(await readFile(options.request, "utf8"));
    const id = randomUUID();
    const uri = graphRequestUri(vault, id, await readVaultRegistry());
    const directory = path.join(vault, ".baseboard", "requests");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, `${id}.request.json`);
    await writeFile(filename, JSON.stringify(request, null, 2), { flag: "wx" });
    result = {
      id,
      uri,
      response: path.join(directory, `${id}.response.json`),
    };
  } else {
    const store = await offlineStore(vault);
    if (operation === "query") {
      const documents = await Promise.all(
        (options.path ? [options.path] : await store.list()).map((filename) =>
          store.read(filename),
        ),
      );
      result = documents
        .filter(
          (document) =>
            options.path || options.all || eligible(document.properties),
        )
        .map(({ body, ...document }) => ({
          ...document,
          ...(options.body ? { body } : {}),
        }));
      if (options.scope) result = core.getSuggestedNext(result, options.scope);
    } else if (operation === "undo") {
      const receipt = await store.getReceipt(options.batch);
      if (!receipt) throw new Error("Missing receipt");
      const batch = await core.proposeGraphUndo(
        store,
        receipt,
        { kind: "agent", name: "GitHub Copilot" },
        `undo-${randomUUID()}`,
      );
      result = await core.previewGraphBatch(store, batch);
    } else {
      const input = JSON.parse(await readFile(options.batch, "utf8"));
      const batch = input.batch ?? input;
      if (operation === "preview")
        result = await core.previewGraphBatch(store, batch);
      else if (operation === "apply") {
        requireClosed(options);
        result = await core.applyGraphBatch(
          store,
          batch,
          options.token ?? input.token,
        );
      } else throw new Error("Unknown operation");
    }
  }
  const output = JSON.stringify(result, null, 2) + "\n";
  if (options.output) await writeFile(options.output, output);
  else process.stdout.write(output);
  if (result?.state && !["applied", "unchanged"].includes(result.state))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
