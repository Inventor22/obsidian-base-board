import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  applyMigrationPlan,
  buildMigrationPlan,
  migrationInventory,
  runNativeMigration,
  graphRequestUri,
} from "../scripts/work-graph.mjs";

const temporary = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "baseboard-migration-test-"),
  );
  temporary.push(directory);
  const vault = path.join(directory, "vault");
  await mkdir(path.join(vault, ".obsidian", "plugins", "base-board"), {
    recursive: true,
  });
  const notes = {
    "Stage.md":
      "---\r\nid: stable-stage\r\ngraph_order: 1\r\nstatus: Completed\r\ncustom: {zone: west} # retained\r\nstatus_history: [{at: '2020-01-01', to: Completed}]\r\n---\r\nOriginal Stage body.\r\n",
    "Zone.md":
      "---\nid: zone\ngraph_order: 2\nparent: Stage\nstatus: Failed\n---\nResidual issue.\n",
    "Canary.md":
      "---\nid: canary\nkanban_order: a0\ndepends_on: [Stage]\nstatus: In Progress\n---\nPromoted with known residual.\n",
    "Tasks.base":
      "views:\n  - type: graph\n    graphPresentation: physics\n    graphRoot: stable-stage\n    graphNodePositions: {canary: {x: 12, y: 34}}\n  - type: kanban\n    boardProjection: active-frontier\n    frontierPriority: {all::2020-01-01: [Canary.md]}\n    frontierScope: all\n    unknown: {keep: true}\n",
    ".obsidian/plugins/base-board/data.json": JSON.stringify({
      graphHistories: { graph: { frames: ["original"] } },
      custom: { keep: true },
    }),
  };
  for (const [filename, content] of Object.entries(notes))
    await writeFile(path.join(vault, filename), content);
  return { vault, directory, notes };
}

describe("backed-up work graph migration", () => {
  it("routes native requests by the verified registry ID rather than a filesystem path", () => {
    const vault = path.join(tmpdir(), "work-vault");
    expect(
      graphRequestUri(vault, "request-1", {
        vaults: { registered: { path: vault } },
      }),
    ).toBe("obsidian://baseboard-command?vault=registered&request=request-1");
    expect(() => graphRequestUri(vault, "request-1", { vaults: {} })).toThrow(
      /registry/,
    );
  });

  it("suspends retained Bases views before writes and restores the prior native tab", async () => {
    const setup = await fixture();
    const original = {
      type: "bases",
      state: { file: "Tasks.base", viewName: "Graph" },
    };
    let viewState = original;
    const events = [];
    let drainedRetainedOwner = false;
    const retainedOwner = {
      get pluginDataWrites() {
        drainedRetainedOwner = true;
        return Promise.resolve();
      },
    };
    const leaf = {
      id: "active-graph",
      view: {
        containerEl: { querySelector: () => ({}) },
        controller: { view: { plugin: retainedOwner } },
      },
      getViewState: () => viewState,
      setViewState: async (state) => {
        viewState = state;
        events.push(`view:${state.type}`);
      },
    };
    const plugin = { pluginDataWrites: Promise.resolve() };
    const app = {
      workspace: {
        activeLeaf: leaf,
        getLeavesOfType: (type) => (type === "bases" ? [leaf] : []),
        setActiveLeaf: (target) => {
          expect(target).toBe(leaf);
          events.push("active-restored");
        },
      },
      plugins: {
        plugins: { "base-board": plugin },
        disablePlugin: async () => {
          events.push("plugin-disabled");
        },
        enablePlugin: async () => {
          events.push("plugin-enabled");
        },
      },
      vault: {
        adapter: { basePath: setup.vault },
        getAbstractFileByPath: (filename) => ({ path: filename }),
        process: async (file, update) => {
          expect(viewState.type).toBe("empty");
          events.push("write");
          const filename = path.join(setup.vault, file.path);
          await writeFile(filename, update(await readFile(filename, "utf8")));
        },
      },
    };
    const resultPath = path.join(setup.directory, "native-result.json");
    const result = await runNativeMigration(app, setup.vault, resultPath);
    if (result.backup) temporary.push(result.backup);
    expect(result.state).toBe("applied");
    expect(drainedRetainedOwner).toBe(true);
    expect(events.slice(0, 3)).toEqual([
      "view:empty",
      "plugin-disabled",
      "write",
    ]);
    expect(events.slice(-3)).toEqual([
      "plugin-enabled",
      "view:bases",
      "active-restored",
    ]);
    expect(viewState).toEqual(original);
    expect(JSON.parse(await readFile(resultPath, "utf8")).viewsRestored).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(`${resultPath}.views.json`, "utf8")).views[0]
        .state,
    ).toEqual(original);
  });

  it("does not migrate empty ordered templates or unrelated placeholder notes", async () => {
    const setup = await fixture();
    const content =
      "---\nkanban_order:\nstatus: Planned\n---\nUnrelated template.\n";
    await writeFile(path.join(setup.vault, "Template.md"), content);
    const plan = await buildMigrationPlan(setup.vault);
    expect(plan.notes).toBe(3);
    expect(plan.files.some((file) => file.path === "Template.md")).toBe(false);
    expect(await readFile(path.join(setup.vault, "Template.md"), "utf8")).toBe(
      content,
    );
  });

  it("dry-runs without writes, backs up notes/Bases/data, preserves source facts, and reruns idempotently", async () => {
    const setup = await fixture();
    const plan = await buildMigrationPlan(setup.vault);
    expect(migrationInventory(plan)).toMatchObject({
      notes: 3,
      changed: 5,
      issues: [],
    });
    for (const [filename, content] of Object.entries(setup.notes))
      expect(await readFile(path.join(setup.vault, filename), "utf8")).toBe(
        content,
      );
    const result = await applyMigrationPlan(plan, {
      backup: path.join(setup.directory, "backup"),
    });
    expect(result.state).toBe("applied");
    for (const [filename, content] of Object.entries(setup.notes))
      expect(
        await readFile(path.join(result.backup, "vault", filename), "utf8"),
      ).toBe(content);
    const stage = await readFile(path.join(setup.vault, "Stage.md"), "utf8");
    expect(stage).toContain("status: Completed\r\n");
    expect(stage).toContain("custom: {zone: west} # retained\r\n");
    expect(stage.endsWith("Original Stage body.\r\n")).toBe(true);
    expect(stage).toContain("container-status");
    const base = parse(
      await readFile(path.join(setup.vault, "Tasks.base"), "utf8"),
    );
    expect(base.views[0]).toEqual(parse(setup.notes["Tasks.base"]).views[0]);
    expect(base.views[1]).toMatchObject({
      boardProjection: "suggested-next",
      suggestedNextScope: "all",
      unknown: { keep: true },
      baseboard_legacy_frontier: {
        frontierPriority: { "all::2020-01-01": ["Canary.md"] },
      },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(setup.vault, ".obsidian/plugins/base-board/data.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      graphHistories: { graph: { frames: ["original"] } },
      custom: { keep: true },
      workGraphSchema: 1,
    });
    const rerun = await buildMigrationPlan(setup.vault);
    expect(migrationInventory(rerun).changed).toBe(0);
    expect(await applyMigrationPlan(rerun)).toMatchObject({
      state: "unchanged",
      changed: 0,
    });
  });

  it("rejects stale inventory before touching the vault", async () => {
    const setup = await fixture();
    const plan = await buildMigrationPlan(setup.vault);
    await writeFile(
      path.join(setup.vault, "Stage.md"),
      setup.notes["Stage.md"] + "New external text.\n",
    );
    await expect(
      applyMigrationPlan(plan, {
        backup: path.join(setup.directory, "backup"),
      }),
    ).rejects.toThrow(/stale/);
    expect(await readFile(path.join(setup.vault, "Canary.md"), "utf8")).toBe(
      setup.notes["Canary.md"],
    );
  });

  it("rolls back partial failures without losing original bytes or uncertainty evidence", async () => {
    const setup = await fixture();
    const result = await applyMigrationPlan(
      await buildMigrationPlan(setup.vault),
      {
        backup: path.join(setup.directory, "backup"),
        beforeWrite: (_file, ordinal) => {
          if (ordinal === 2)
            throw new Error("Injected migration write failure");
        },
      },
    );
    expect(result.state).toBe("rolled-back");
    for (const [filename, content] of Object.entries(setup.notes))
      expect(await readFile(path.join(setup.vault, filename), "utf8")).toBe(
        content,
      );
    expect(
      JSON.parse(
        await readFile(path.join(result.backup, "journal.json"), "utf8"),
      ).error,
    ).toMatch(/Injected/);
  });

  it("preserves a concurrent edit when rollback cannot safely restore a file", async () => {
    const setup = await fixture();
    let first;
    const result = await applyMigrationPlan(
      await buildMigrationPlan(setup.vault),
      {
        backup: path.join(setup.directory, "backup"),
        beforeWrite: async (file, ordinal) => {
          if (ordinal === 0) first = file.path;
          if (ordinal === 1) {
            await writeFile(
              path.join(setup.vault, first),
              "User changed this file concurrently.\n",
            );
            throw new Error("Concurrent write");
          }
        },
      },
    );
    expect(result.state).toBe("partial");
    expect(result.conflicts).toHaveLength(1);
    expect(await readFile(path.join(setup.vault, first), "utf8")).toBe(
      "User changed this file concurrently.\n",
    );
  });
});
