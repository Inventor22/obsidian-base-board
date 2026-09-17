import { describe, expect, it } from "vitest";
import { icons } from "lucide";
import { buildFrontierGraph, type FrontierRawNode } from "../src/graph-engine";
import {
  connectOverviewToRoot,
  planOverviewTransition,
  getGraphStateVisual,
  getOverviewCompletion,
  getOverviewSummaryState,
  getOverviewDescendants,
  layoutOverviewClusters,
  layoutGraphOverview,
  projectOverview,
  summarizeGraphWork,
  selectOverviewScope,
} from "../src/graph-overview";

function row(
  key: string,
  overrides: Partial<FrontierRawNode> = {},
): FrontierRawNode {
  return {
    key,
    title: key,
    identities: [key],
    kindExplicit: null,
    status: "Planned",
    parentKey: null,
    dependsOnKeys: [],
    rollupToKeys: [],
    compensatesKeys: [],
    ...overrides,
  };
}

function hierarchy() {
  return buildFrontierGraph([
    row("scope", { kindExplicit: "group" }),
    row("feature", { rollupToKeys: ["scope"] }),
    row("process", { parentKey: "feature" }),
    row("done", { parentKey: "process", status: "Completed" }),
    row("running", { parentKey: "process", status: "In Progress" }),
    row("awaiting", { parentKey: "feature", status: "Awaiting" }),
    row("impact", {
      parentKey: "feature",
      kindExplicit: "impact",
      status: "Failed",
    }),
  ]);
}

describe("hierarchical graph overview", () => {
  it("collapses deepest visible children first and expands in the opposite order", () => {
    const nodes = hierarchy();
    const visible = new Set(nodes.map((node) => node.key));
    const changed = new Set(["process", "done", "running"]);
    const collapse = planOverviewTransition(
      nodes[1],
      changed,
      visible,
      (node) => node.key,
      false,
    );
    const expand = planOverviewTransition(
      nodes[1],
      changed,
      visible,
      (node) => node.key,
      true,
    );
    expect(collapse.find((step) => step.key === "done")).toMatchObject({
      parentKey: "process",
      delay: 0,
    });
    expect(
      collapse.find((step) => step.key === "process")!.delay,
    ).toBeGreaterThan(0);
    expect(expand.find((step) => step.key === "process")).toMatchObject({
      parentKey: "feature",
      delay: 0,
    });
    expect(expand.find((step) => step.key === "done")!.delay).toBeGreaterThan(
      0,
    );
    expect(collapse.map((step) => step.key).sort()).toEqual(
      [...changed].sort(),
    );
    expect(collapse.every((step) => step.delay + step.duration <= 660)).toBe(
      true,
    );
  });

  it("leaves shared visible nodes alone and skips hidden wrappers in animation paths", () => {
    const nodes = hierarchy();
    const steps = planOverviewTransition(
      nodes[0],
      new Set(["running"]),
      new Set(["scope", "feature", "running"]),
      (node) => node.key,
      false,
    );
    expect(steps).toEqual([
      {
        key: "running",
        parentKey: "feature",
        depth: 2,
        delay: 0,
        duration: 180,
      },
    ]);
    expect(nodes[2].children.map((node) => node.key)).toEqual([
      "done",
      "running",
    ]);
  });

  it("bounds animation planning through hierarchy cycles", () => {
    const nodes = buildFrontierGraph([
      row("root", { kindExplicit: "group", rollupToKeys: ["scope"] }),
      row("scope", { kindExplicit: "group", rollupToKeys: ["root"] }),
      row("task", { rollupToKeys: ["scope"] }),
    ]);
    const steps = planOverviewTransition(
      nodes[0],
      new Set(["scope", "task"]),
      new Set(nodes.map((node) => node.key)),
      (node) => node.key,
      false,
    );
    expect(steps).toHaveLength(2);
    expect(new Set(steps.map((step) => step.key)).size).toBe(2);
  });

  const clusterOptions = {
    viewportWidth: 1100,
    width: 220,
    summaryHeight: 136,
    headingHeight: 64,
    taskHeight: 88,
  };

  it("restores real ancestry from a focused branch to its root without unrelated work", () => {
    const nodes = hierarchy();
    const before = nodes.map((node) => ({
      children: [...node.children],
      members: [...node.members],
      state: node.state,
    }));
    const projection = connectOverviewToRoot(nodes, [nodes[4]], nodes[0]);
    expect(new Set(projection.nodes.map((node) => node.key))).toEqual(
      new Set(["scope", "feature", "process", "running"]),
    );
    expect(
      new Set(projection.edges.map(({ from, to }) => `${from.key}>${to.key}`)),
    ).toEqual(new Set(["scope>feature", "feature>process", "process>running"]));
    expect(
      nodes.map((node) => ({
        children: node.children,
        members: node.members,
        state: node.state,
      })),
    ).toEqual(before);
  });

  it("does not invent ancestry for disconnected work or inject a missing historical root", () => {
    const nodes = hierarchy();
    const [loose] = buildFrontierGraph([row("loose")]);
    expect(connectOverviewToRoot([...nodes, loose], [loose], nodes[0])).toEqual(
      {
        nodes: [loose, nodes[0]],
        edges: [],
      },
    );
    expect(connectOverviewToRoot(nodes.slice(1), [nodes[4]], nodes[0])).toEqual(
      {
        nodes: [nodes[4]],
        edges: [],
      },
    );
  });

  it("connects through cyclic multi-membership without duplicating nodes", () => {
    const nodes = buildFrontierGraph([
      row("root", { kindExplicit: "group", rollupToKeys: ["scope"] }),
      row("scope", { kindExplicit: "group", rollupToKeys: ["root"] }),
      row("task", { rollupToKeys: ["root", "scope"] }),
    ]);
    const projection = connectOverviewToRoot(nodes, [nodes[2]], nodes[0]);
    expect(new Set(projection.nodes)).toEqual(new Set([nodes[0], nodes[2]]));
    expect(projection.edges).toEqual([{ from: nodes[0], to: nodes[2] }]);
  });

  it("uses a scope spine as navigation and collects disconnected tasks without inventing parents", () => {
    const nodes = buildFrontierGraph([
      row("person", { kindExplicit: "group" }),
      row("career", { kindExplicit: "group", rollupToKeys: ["person"] }),
      row("work", { kindExplicit: "group", rollupToKeys: ["career"] }),
      row("feature", { rollupToKeys: ["work"] }),
      row("task", { parentKey: "feature" }),
      row("loose"),
    ]);
    const context = selectOverviewScope(nodes);
    expect(context.focus?.key).toBe("work");
    expect(context.breadcrumbs.map((node) => node.key)).toEqual([
      "person",
      "career",
      "work",
    ]);
    expect(context.roots.map((node) => node.key)).toEqual(["feature"]);
    expect(context.unassigned.map((node) => node.key)).toEqual(["loose"]);
    expect(nodes[5].parent).toBeNull();
    expect(
      selectOverviewScope(nodes, null).roots.map((node) => node.key),
    ).toEqual(["person"]);
  });

  it("wraps many independent workstreams into bounded columns at readable sizes", () => {
    const nodes = buildFrontierGraph(
      Array.from({ length: 28 }, (_, index) => row(`root-${index}`)),
    );
    const layout = layoutOverviewClusters(
      nodes,
      nodes,
      new Set(),
      clusterOptions,
    );
    expect(layout.items).toHaveLength(28);
    expect(layout.width).toBeLessThanOrEqual(1100);
    expect(new Set(layout.items.map((item) => item.x)).size).toBe(3);
    expect(new Set(layout.items.map((item) => item.y)).size).toBeGreaterThan(1);
    expect(layout.items.every((item) => item.height === 88)).toBe(true);
  });

  it("expands a branch locally without shifting neighboring columns", () => {
    const nodes = hierarchy();
    const peers = buildFrontierGraph([row("other"), row("third")]);
    const roots = [nodes[1], ...peers];
    const all = [...nodes.slice(1), ...peers];
    const before = layoutOverviewClusters(
      roots,
      all,
      new Set([nodes[1], nodes[2]]),
      clusterOptions,
    );
    const after = layoutOverviewClusters(
      roots,
      all,
      new Set([nodes[2]]),
      clusterOptions,
    );
    for (const peer of peers) {
      const previous = before.items.find((item) => item.node === peer)!;
      const current = after.items.find((item) => item.node === peer)!;
      expect({ x: current.x, y: current.y }).toEqual({
        x: previous.x,
        y: previous.y,
      });
    }
    expect(after.items.find((item) => item.node === nodes[1])!.role).toBe(
      "heading",
    );
  });

  it("compresses expanded single-child wrappers into a navigable trail", () => {
    const nodes = buildFrontierGraph([
      row("feature"),
      row("iteration", { parentKey: "feature" }),
      row("dev", { parentKey: "iteration" }),
      row("step", { parentKey: "dev" }),
    ]);
    const layout = layoutOverviewClusters(
      [nodes[0]],
      nodes,
      new Set(),
      clusterOptions,
    );
    expect(layout.items.map((item) => item.node.key)).toEqual([
      "feature",
      "dev",
      "step",
    ]);
    expect(layout.items[1].trail.map((node) => node.key)).toEqual([
      "iteration",
    ]);
    expect(nodes[0].children[0]).toBe(nodes[1]);
  });

  it("fills completion only with completed work and keeps ancestor attention separate", () => {
    const nodes = hierarchy();
    nodes[4].state = "blocked";
    const summary = summarizeGraphWork(nodes[0]);
    expect(summary.blocked).toBe(1);
    expect(summary.state).toBe("blocked");
    expect(getOverviewSummaryState(summary)).toBe("awaiting");
    expect(getOverviewCompletion(summary)).toBeCloseTo(1 / 3);
    expect(getOverviewCompletion({ ...summary, completed: 0 })).toBe(0);
    expect(getOverviewCompletion({ ...summary, total: 0 })).toBe(0);
  });

  it.each([
    ["completed", "lucide-circle-check", "--color-green", "Completed"],
    ["awaiting", "lucide-clock", "--color-yellow", "Awaiting"],
    ["blocked", "lucide-octagon-alert", "--color-red", "Needs attention"],
    ["interrupted", "lucide-octagon-alert", "--color-red", "Failed"],
    ["in-progress", "lucide-circle-arrow-right", "--color-blue", "In progress"],
  ] as const)(
    "uses the visual status contract for %s",
    (state, icon, color, label) => {
      const visual = getGraphStateVisual(state);
      expect(visual.icon).toBe(icon);
      expect(visual.color).toContain(color);
      expect(visual.label).toBe(label);
      const iconName = visual.icon
        .replace(/^lucide-/, "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
      expect(icons[iconName as keyof typeof icons]).toBeDefined();
    },
  );

  it("lays out only visible hierarchy nodes with one incoming hierarchy edge", () => {
    const nodes = hierarchy();
    const layout = layoutGraphOverview(nodes, new Set([nodes[1]]), {
      width: 220,
      height: 156,
    });
    expect([...layout.positions.keys()].map((node) => node.key)).toEqual([
      "scope",
      "feature",
    ]);
    expect(layout.edges).toEqual([{ from: nodes[0], to: nodes[1] }]);
    expect(
      layout.positions.get(nodes[1])!.y - layout.positions.get(nodes[0])!.y,
    ).toBeGreaterThan(156);
    expect(nodes[1].children).toHaveLength(3);
  });

  it("collapses membership and containment into one scope summary", () => {
    const nodes = hierarchy();
    expect(
      projectOverview(nodes, new Set([nodes[0]])).visible.map(
        (node) => node.key,
      ),
    ).toEqual(["scope"]);
    expect(getOverviewDescendants(nodes[0])).toHaveLength(6);
    expect(summarizeGraphWork(nodes[0])).toMatchObject({
      total: 3,
      completed: 1,
      active: 1,
      awaiting: 1,
    });
  });

  it("expands only the requested level while preserving nested collapse", () => {
    const nodes = hierarchy();
    const collapsed = new Set([nodes[1], nodes[2]]);
    expect(
      projectOverview(nodes, collapsed).visible.map((node) => node.key),
    ).toEqual(["scope", "feature"]);
    collapsed.delete(nodes[1]);
    expect(
      projectOverview(nodes, collapsed).visible.map((node) => node.key),
    ).toEqual(["scope", "feature", "process", "awaiting", "impact"]);
  });

  it("keeps shared work visible through another expanded scope without double counting it", () => {
    const nodes = buildFrontierGraph([
      row("first", { kindExplicit: "group" }),
      row("second", { kindExplicit: "group", rollupToKeys: ["first"] }),
      row("task", { rollupToKeys: ["first", "second"], status: "Completed" }),
    ]);
    expect(
      projectOverview(nodes, new Set([nodes[1]])).visible.map(
        (node) => node.key,
      ),
    ).toEqual(["first", "second", "task"]);
    expect(summarizeGraphWork(nodes[0]).total).toBe(1);
  });

  it("retains a visible entry point for cycles", () => {
    const nodes = buildFrontierGraph([
      row("first", { parentKey: "second" }),
      row("second", { parentKey: "first" }),
    ]);
    expect(projectOverview(nodes, new Set([nodes[0]])).visible).toEqual([
      nodes[0],
    ]);
    expect(getOverviewDescendants(nodes[0])).toEqual([nodes[1]]);
  });

  it("surfaces hidden failures without changing execution state", () => {
    const nodes = hierarchy();
    nodes[4].state = "interrupted";
    const state = nodes[0].state;
    expect(summarizeGraphWork(nodes[0])).toMatchObject({
      state: "blocked",
      blocked: 1,
      total: 3,
    });
    expect(nodes[0].state).toBe(state);
  });

  it("keeps recovery visible and counts only recorded recovery activity", () => {
    const nodes = buildFrontierGraph([
      row("ring"),
      row("enable", { parentKey: "ring", status: "Completed" }),
      row("verify", { parentKey: "ring", status: "Failed" }),
      row("disable", { parentKey: "ring", compensatesKeys: ["enable"] }),
    ]);
    expect(summarizeGraphWork(nodes[0])).toMatchObject({
      total: 2,
      completed: 1,
      blocked: 1,
      mitigations: 0,
    });
    nodes[3].state = "active";
    expect(summarizeGraphWork(nodes[0]).mitigations).toBe(1);
    nodes[3].state = "idle";
    expect(projectOverview(nodes, new Set()).visible).toContain(nodes[3]);
  });

  it("does not prune or mutate the underlying work graph", () => {
    const nodes = hierarchy();
    const children = [...nodes[1].children];
    const members = [...nodes[0].members];
    projectOverview(nodes, new Set([nodes[0]]));
    expect(nodes[1].children).toEqual(children);
    expect(nodes[0].members).toEqual(members);
  });
});
