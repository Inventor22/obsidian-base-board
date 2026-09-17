import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { build } from "esbuild";

const [vaultArg, rootPath, ...flags] = process.argv.slice(2);
if (
  !vaultArg ||
  !rootPath ||
  flags.some((flag) => !["--check", "--summary"].includes(flag))
)
  throw new Error(
    "Usage: node scripts/audit-graph-root.mjs <vault> <root-note-path> [--check] [--summary]",
  );
const vault = path.resolve(vaultArg);
const base = load(readFileSync(path.join(vault, "Tasks/Tasks.base"), "utf8"));
const graphView = base.views?.find((view) => view.type === "graph");
const expectedFilters = ["!graph_order.isEmpty()", "!kanban_order.isEmpty()"];
if (
  base.filters ||
  JSON.stringify([...(graphView?.filters?.or ?? [])].sort()) !==
    JSON.stringify(expectedFilters)
) {
  throw new Error(
    "Graph query changed; update this audit's dataset selection before relying on it.",
  );
}
const output = await build({
  entryPoints: ["src/graph-engine.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const engine = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);
const notes = [];
const parseErrors = [];
const hasValue = (value) =>
  value !== undefined && value !== null && value !== "";
function visit(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const content = readFileSync(fullPath, "utf8");
    const header = content.match(
      /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
    );
    if (!header) continue;
    let properties;
    try {
      properties = load(header[1]);
    } catch (error) {
      parseErrors.push({
        path: path.relative(vault, fullPath),
        message: error.message.split("\n")[0],
      });
      continue;
    }
    if (!properties || typeof properties !== "object") continue;
    if (!hasValue(properties.kanban_order) && !hasValue(properties.graph_order))
      continue;
    const title =
      typeof properties.title === "string"
        ? properties.title
        : path.basename(fullPath, ".md");
    notes.push({
      key: path.relative(vault, fullPath).replaceAll("\\", "/"),
      title,
      properties,
    });
  }
}
visit(vault);
const graph = engine.buildFrontierGraph(
  notes.map(({ key, title, properties }) => ({
    key,
    title,
    identities: [
      key.replace(/\.md$/i, "").toLowerCase(),
      path.basename(key, ".md").toLowerCase(),
      title.toLowerCase(),
      String(properties.id ?? "").toLowerCase(),
    ].filter(Boolean),
    status: typeof properties.status === "string" ? properties.status : null,
    kindExplicit: engine.ENGINE_NODE_KINDS.includes(properties.kind)
      ? properties.kind
      : null,
    parentKey: engine.normalizeReference(properties.parent),
    dependsOnKeys: engine.normalizeReferences(properties.depends_on),
    rollupToKeys: engine.normalizeReferences(properties.rollup_to),
    compensatesKeys: engine.normalizeReferences(properties.compensates),
  })),
);
const root = graph.find((node) => node.key === rootPath.replaceAll("\\", "/"));
if (!root) throw new Error(`Root is absent from Graph: ${rootPath}`);
const configuredReference = engine.normalizeReference(graphView.graphRoot);
if (configuredReference && !root.identities.includes(configuredReference))
  throw new Error("Configured graphRoot does not match the audited root");
const identities = new Map();
for (const node of graph) {
  for (const identity of new Set(node.identities)) {
    const matches = identities.get(identity) ?? new Set();
    matches.add(node);
    identities.set(identity, matches);
  }
}
const unresolved = [];
const ambiguous = [];
for (const node of graph) {
  for (const [relation, references] of [
    ["parent", node.parentKey ? [node.parentKey] : []],
    ["rollup_to", node.rollupToKeys],
  ]) {
    for (const reference of references) {
      const matches = identities.get(reference);
      if (!matches) unresolved.push({ path: node.key, relation, reference });
      else if (matches.size > 1)
        ambiguous.push({ path: node.key, relation, reference });
    }
  }
}
const connected = new Set();
const visitRoot = (node) => {
  if (connected.has(node)) return;
  connected.add(node);
  for (const child of node.children) visitRoot(child);
  if (node.kind === "group")
    for (const member of node.members) visitRoot(member);
};
visitRoot(root);
const cycles = new Set();
const complete = new Set();
const visiting = new Set();
const checkCycle = (node) => {
  if (visiting.has(node)) {
    cycles.add(node.key);
    return;
  }
  if (complete.has(node)) return;
  visiting.add(node);
  for (const child of [
    ...node.children,
    ...(node.kind === "group" ? node.members : []),
  ])
    checkCycle(child);
  visiting.delete(node);
  complete.add(node);
};
for (const node of graph) checkCycle(node);
const detached = graph.filter((node) => !connected.has(node));
const rootParents = [root.parent, ...root.rollupTargets]
  .filter(Boolean)
  .map((node) => node.key);
console.log(
  JSON.stringify({
    root: root.key,
    configuredRoot: graphView.graphRoot ?? null,
    total: graph.length,
    connected: connected.size,
    disconnected: detached.length,
    unresolved,
    ambiguous,
    cycles: [...cycles],
    rootParents,
    parseErrors,
  }),
);
if (!flags.includes("--summary"))
  for (const node of graph) {
    const properties = notes.find((note) => note.key === node.key).properties;
    console.log(
      JSON.stringify({
        path: node.key,
        kind: node.kind,
        status: node.status,
        parent: properties.parent ?? null,
        rollup: properties.rollup_to ?? null,
        feature: properties.feature ?? null,
        connected: connected.has(node),
      }),
    );
  }
if (
  flags.includes("--check") &&
  (detached.length ||
    unresolved.length ||
    ambiguous.length ||
    cycles.size ||
    rootParents.length ||
    parseErrors.length)
) {
  throw new Error("Graph hierarchy is not fully connected and validated");
}
