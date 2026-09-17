import { describe, expect, it } from "vitest";
import {
  buildFrontierGraph,
  deriveStates,
  getFailureScope,
  getFrontierNodes,
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

describe("shared frontier compensation state", () => {
  it("keeps an untriggered rollback dormant and off the frontier", () => {
    const graph = buildFrontierGraph(rollout());
    expect(node(graph, "disable").state).toBe("idle");
    expect(getFrontierNodes(graph).map((candidate) => candidate.key)).toEqual([
      "verify",
    ]);
  });

  it("excludes dormant rollbacks from completed process and scope rollups", () => {
    const raw = rollout("Completed");
    raw.find((candidate) => candidate.key === "disable")!.rollupToKeys = [
      "scope",
    ];
    const graph = buildFrontierGraph(raw);
    expect(node(graph, "ring").state).toBe("completed");
    expect(node(graph, "scope").state).toBe("completed");
    expect(getFrontierNodes(graph)).toEqual([]);
  });

  it.each(["Failed", "Interrupted", "Blocked"])(
    "activates a declared rollback after %s verification",
    (status) => {
      const graph = buildFrontierGraph(rollout(status));
      expect(node(graph, "disable").state).toBe("active");
      expect(getFrontierNodes(graph)).toContain(node(graph, "disable"));
    },
  );

  it("requires a completed effect before activating its rollback", () => {
    const raw = rollout("Failed");
    raw.find((candidate) => candidate.key === "enable")!.status = "Planned";
    const graph = buildFrontierGraph(raw);
    expect(node(graph, "disable").state).toBe("idle");
  });

  it("does not offer a rollback with an unresolved target as ordinary work", () => {
    const graph = buildFrontierGraph([
      row("disable", { compensatesKeys: ["filtered-out-enable"] }),
    ]);
    expect(node(graph, "disable").state).toBe("idle");
    expect(getFrontierNodes(graph)).toEqual([]);
  });

  it.each([
    ["Completed", "completed"],
    ["Failed", "interrupted"],
  ])("retains a rollback's %s outcome", (status, expected) => {
    const raw = rollout("Failed");
    raw.find((candidate) => candidate.key === "disable")!.status = status;
    const graph = buildFrontierGraph(raw);
    expect(node(graph, "disable").state).toBe(expected);
  });

  it("returns a rollback to dormancy when a failure is cleared", () => {
    const graph = buildFrontierGraph(rollout("Failed"));
    expect(node(graph, "disable").state).toBe("active");
    node(graph, "verify").status = "Awaiting";
    deriveStates(graph, (candidate) => parentOf(candidate as FrontierNode));
    expect(node(graph, "disable").state).toBe("idle");
  });

  it("does not activate compensations in an unrelated ring", () => {
    const graph = buildFrontierGraph([
      ...rollout(),
      row("other-ring", { kindExplicit: "process", rollupToKeys: ["scope"] }),
      row("other-failure", { parentKey: "other-ring", status: "Failed" }),
    ]);
    expect(node(graph, "disable").state).toBe("idle");
  });

  it("absorbs failure at a nested group boundary", () => {
    const graph = buildFrontierGraph([
      row("outer", { kindExplicit: "process" }),
      row("enable", { parentKey: "outer", status: "Completed" }),
      row("disable", { parentKey: "outer", compensatesKeys: ["enable"] }),
      row("inner", { parentKey: "outer", kindExplicit: "group" }),
      row("failure", { parentKey: "inner", status: "Failed" }),
    ]);
    const scope = getFailureScope(graph, (candidate) =>
      parentOf(candidate as FrontierNode),
    );
    expect(scope.has(node(graph, "inner"))).toBe(true);
    expect(scope.has(node(graph, "outer"))).toBe(false);
    expect(node(graph, "disable").state).toBe("idle");
  });

  it("ignores failed impact nodes in failure propagation and rollups", () => {
    const graph = buildFrontierGraph([
      ...rollout("Completed"),
      row("impact", {
        kindExplicit: "impact",
        parentKey: "ring",
        status: "Failed",
      }),
    ]);
    expect(node(graph, "impact").state).toBe("idle");
    expect(node(graph, "disable").state).toBe("idle");
    expect(node(graph, "ring").state).toBe("completed");
    expect(getFrontierNodes(graph)).toEqual([]);
  });

  it("keeps Awaiting nonterminal for dependent work", () => {
    const graph = buildFrontierGraph([
      row("await", { status: "Awaiting" }),
      row("next", { dependsOnKeys: ["await"] }),
    ]);
    expect(node(graph, "next").state).toBe("waiting");
    expect(getFrontierNodes(graph).map((candidate) => candidate.key)).toEqual([
      "await",
    ]);
  });

  it("retains scope membership for an activated rollback", () => {
    const graph = buildFrontierGraph(rollout("Failed"));
    const scopes = getScopeAncestors(node(graph, "disable"), (candidate) =>
      parentOf(candidate as FrontierNode),
    );
    expect(scopes).toEqual([node(graph, "scope")]);
  });
});
