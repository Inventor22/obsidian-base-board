import { describe, expect, it } from "vitest";
import {
  buildFrontierGraph,
  deriveStates,
  getAggregationChildren,
  getRecordedState,
  getScopeAncestors,
  type FrontierNode,
  type FrontierRawNode,
} from "../src/graph-engine";

function row(
  key: string,
  overrides: Partial<FrontierRawNode> = {},
): FrontierRawNode {
  return {
    key,
    title: key,
    identities: [key],
    status: "Planned",
    kindExplicit: null,
    parentKey: null,
    dependsOnKeys: [],
    rollupToKeys: [],
    compensatesKeys: [],
    ...overrides,
  };
}

function rollout(verificationStatus = "Awaiting"): FrontierRawNode[] {
  return [
    row("scope", { kindExplicit: "group" }),
    row("ring", { kindExplicit: "process", rollupToKeys: ["scope"] }),
    row("enable", { parentKey: "ring", status: "Completed" }),
    row("verify", {
      parentKey: "ring",
      status: verificationStatus,
      dependsOnKeys: ["enable"],
    }),
    row("disable", { parentKey: "ring", compensatesKeys: ["enable"] }),
  ];
}

function node(graph: FrontierNode[], key: string): FrontierNode {
  const found = graph.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing fixture node: ${key}`);
  return found;
}

const parentOf = (candidate: FrontierNode): FrontierNode | null =>
  candidate.parent;

describe("shared recorded work state", () => {
  it("does not resolve an ambiguous title alias to an arbitrary record", () => {
    const graph = buildFrontierGraph([
      row("first", { identities: ["first", "shared"] }),
      row("second", { identities: ["second", "shared"] }),
      row("child", { parentKey: "shared", dependsOnKeys: ["shared"] }),
    ]);
    expect(node(graph, "child").parent).toBeNull();
    expect(node(graph, "child").predecessors).toEqual([]);
  });

  it.each(["Failed", "Interrupted", "Blocked", "Completed", "Awaiting"])(
    "does not activate recovery work after %s verification",
    (status) => {
      const graph = buildFrontierGraph(rollout(status));
      expect(node(graph, "disable").state).toBe("waiting");
      expect(node(graph, "disable").status).toBe("Planned");
      expect(node(graph, "ring").state).toBe("waiting");
    },
  );

  it("retains container assertions separately from descendant counts", () => {
    const raw = rollout("Completed");
    raw.find((candidate) => candidate.key === "ring")!.status = "In Progress";
    const graph = buildFrontierGraph(raw);
    expect(node(graph, "ring").state).toBe("active");
    expect(node(graph, "scope").state).toBe("waiting");
    expect(getAggregationChildren(node(graph, "ring"))).toHaveLength(2);
  });

  it("records partial Stage and active Canary without completing Stage", () => {
    const graph = buildFrontierGraph([
      row("stage", { status: "In Progress" }),
      row("healthy-zone", { parentKey: "stage", status: "Completed" }),
      row("broken-zone", { parentKey: "stage", status: "Failed" }),
      row("canary", { status: "In Progress", dependsOnKeys: ["stage"] }),
      row("pilot", { dependsOnKeys: ["canary"] }),
    ]);
    expect(graph.map((candidate) => candidate.state)).toEqual([
      "active",
      "completed",
      "interrupted",
      "active",
      "waiting",
    ]);
    const before = graph.map((candidate) => candidate.status);
    deriveStates(graph);
    expect(graph.map((candidate) => candidate.status)).toEqual(before);
  });

  it("keeps explicit recovery activity when failures clear", () => {
    const graph = buildFrontierGraph(rollout("Failed"));
    node(graph, "disable").status = "In Progress";
    node(graph, "verify").status = "Completed";
    deriveStates(graph);
    expect(node(graph, "disable").state).toBe("active");
  });

  it("retains an explicit assertion on every node kind", () => {
    for (const kind of ["work", "process", "group", "impact"] as const) {
      const graph = buildFrontierGraph([
        row(kind, { kindExplicit: kind, status: "Failed" }),
      ]);
      expect(graph[0].state).toBe("interrupted");
    }
  });

  it.each([
    ["Cancelled", "cancelled"],
    ["Invalidated", "invalidated"],
    ["Completed", "completed"],
    ["Awaiting", "awaiting"],
    ["Blocked", "blocked"],
    ["In Progress", "active"],
    ["Flighting", "waiting"],
    [null, "idle"],
  ] as const)("interprets only the recorded %s assertion", (status, state) => {
    expect(getRecordedState(status)).toBe(state);
  });

  it("retains scope membership independently of recovery state", () => {
    const graph = buildFrontierGraph(rollout("Failed"));
    const scopes = getScopeAncestors(node(graph, "disable"), (candidate) =>
      parentOf(candidate as FrontierNode),
    );
    expect(scopes).toEqual([node(graph, "scope")]);
  });
});
