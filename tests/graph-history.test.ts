import { describe, expect, it } from "vitest";
import {
  adjacentGraphHistoryChange,
  changedGraphHistoryKeys,
  compareGraphSnapshots,
  graphAtTime,
  isGraphHistoryGap,
  parseGraphHistory,
  recordGraphObservation,
  scopeGraphHistory,
  scopeGraphSnapshot,
  stepGraphHistoryDay,
  type GraphHistoryNode,
} from "../src/graph-history";

function node(
  key: string,
  changes: Partial<GraphHistoryNode> = {},
): GraphHistoryNode {
  return {
    key,
    path: `${key}.md`,
    title: key,
    identities: [key],
    status: "Planned",
    parentKey: null,
    parentValue: null,
    dependsOnKeys: [],
    breaksToKeys: [],
    restartsToKeys: [],
    rollupToKeys: [],
    compensatesKeys: [],
    effecting: false,
    nodeType: null,
    workflow: null,
    kindExplicit: null,
    executorExplicit: null,
    autonomyExplicit: null,
    lockedExplicit: null,
    order: null,
    ...changes,
  };
}

describe("recorded graph history", () => {
  it("filters timeline changes to a selected scope while retaining moves in and out", () => {
    const scope = node("scope", { kindExplicit: "group" });
    const feature = node("feature", { rollupToKeys: ["scope"] });
    const task = node("task", { parentKey: "feature" });
    const other = node("other");
    let history = recordGraphObservation(
      null,
      [scope, feature, task, other],
      100,
      "first",
    ).history;
    history = recordGraphObservation(
      history,
      [scope, feature, task, { ...other, status: "Completed" }],
      200,
      "first",
    ).history;
    history = recordGraphObservation(
      history,
      [scope, feature, { ...task, parentKey: null }, other],
      300,
      "first",
    ).history;
    const original = JSON.stringify(history);
    const filtered = scopeGraphHistory(history, "scope");
    expect(filtered.frames.map((frame) => frame.at)).toEqual([100, 300]);
    expect(graphAtTime(filtered, 250)?.map((entry) => entry.key)).toEqual([
      "scope",
      "feature",
      "task",
    ]);
    expect(filtered.frames[1].removed).toEqual(["task"]);
    expect(adjacentGraphHistoryChange(filtered, 100, 1)).toBe(300);
    expect(JSON.stringify(history)).toBe(original);
    expect(
      scopeGraphSnapshot([scope, feature, task, other], "@unassigned"),
    ).toEqual([other]);
  });

  it("keeps scope-local observation gaps and does not substitute another scope when absent", () => {
    const baseline = recordGraphObservation(
      null,
      [node("other")],
      100,
      "first",
    ).history;
    const history = recordGraphObservation(
      baseline,
      [node("other")],
      500,
      "second",
    ).history;
    const scoped = scopeGraphHistory(history, "future-feature");
    expect(scoped.frames).toHaveLength(2);
    expect(graphAtTime(scoped, 300)).toEqual([]);
    expect(isGraphHistoryGap(scoped, 300)).toBe(true);
  });

  it("highlights both old and new ancestry when work is moved or removed", () => {
    const scope = node("scope", { kindExplicit: "group" });
    const first = node("first", { rollupToKeys: ["scope"] });
    const second = node("second", { rollupToKeys: ["scope"] });
    const task = node("task", { parentKey: "first" });
    expect(
      [
        ...changedGraphHistoryKeys(
          [scope, first, second, task],
          [scope, first, second, { ...task, parentKey: "second" }],
        ),
      ].sort(),
    ).toEqual(["first", "scope", "second", "task"]);
    expect(
      [...changedGraphHistoryKeys([scope, first, task], [scope, first])].sort(),
    ).toEqual(["first", "scope", "task"]);
  });

  it("starts from an explicit baseline, never fabricating earlier graph state", () => {
    const result = recordGraphObservation(null, [node("task")], 100, "first");
    expect(result.history.frames[0].kind).toBe("baseline");
    expect(graphAtTime(result.history, 99)).toBeNull();
    expect(graphAtTime(result.history, 100)).toEqual([node("task")]);
  });

  it("does not turn rerenders or elapsed days into progress events", () => {
    const original = recordGraphObservation(
      null,
      [node("task")],
      100,
      "first",
    ).history;
    const result = recordGraphObservation(
      original,
      [node("task")],
      500,
      "first",
    );
    expect(result.changed).toBe(false);
    expect(result.history.frames).toHaveLength(1);
    expect(result.history.observedThrough).toBe(500);
  });

  it("reconstructs status, hierarchy, membership, and additions at the selected time", () => {
    const baseline = recordGraphObservation(
      null,
      [node("feature"), node("task")],
      100,
      "first",
    ).history;
    const changed = node("task", {
      status: "Awaiting",
      parentKey: "feature",
      rollupToKeys: ["scope"],
    });
    const history = recordGraphObservation(
      baseline,
      [node("feature"), changed, node("scope", { kindExplicit: "group" })],
      200,
      "first",
    ).history;
    expect(graphAtTime(history, 199)).toEqual([node("feature"), node("task")]);
    expect(graphAtTime(history, 200)).toEqual([
      node("feature"),
      changed,
      node("scope", { kindExplicit: "group" }),
    ]);
    expect(history.frames[1].upserts.map((entry) => entry.key).sort()).toEqual([
      "scope",
      "task",
    ]);
  });

  it("retains removed items in history without claiming why they left the graph", () => {
    const baseline = recordGraphObservation(
      null,
      [node("first"), node("second")],
      100,
      "first",
    ).history;
    const history = recordGraphObservation(
      baseline,
      [node("second")],
      200,
      "first",
    ).history;
    expect(graphAtTime(history, 150)).toHaveLength(2);
    expect(graphAtTime(history, 200)).toEqual([node("second")]);
    expect(history.frames[1].removed).toEqual(["first"]);
    expect(
      compareGraphSnapshots(
        graphAtTime(history, 100)!,
        graphAtTime(history, 200)!,
      ).removed,
    ).toEqual([node("first")]);
  });

  it("keeps stable identity across a recorded path rename", () => {
    const baseline = recordGraphObservation(
      null,
      [node("stable-id")],
      100,
      "first",
    ).history;
    const renamed = node("stable-id", { path: "Renamed.md", title: "Renamed" });
    const history = recordGraphObservation(
      baseline,
      [renamed],
      200,
      "first",
    ).history;
    const changes = compareGraphSnapshots(
      graphAtTime(history, 100)!,
      graphAtTime(history, 200)!,
    );
    expect(changes.added).toEqual([]);
    expect(changes.updated).toEqual([renamed]);
    expect(changes.removed).toEqual([]);
  });

  it("records observation gaps when a graph resumes without inventing change timestamps", () => {
    const baseline = recordGraphObservation(
      null,
      [node("task")],
      100,
      "first",
    ).history;
    const observed = recordGraphObservation(
      baseline,
      [node("task")],
      150,
      "first",
    ).history;
    const resumed = recordGraphObservation(
      observed,
      [node("task", { status: "Completed" })],
      500,
      "second",
    ).history;
    expect(resumed.frames[1]).toMatchObject({
      kind: "resume",
      at: 500,
      gapAfter: 150,
    });
    expect(isGraphHistoryGap(resumed, 300)).toBe(true);
    expect(isGraphHistoryGap(resumed, 500)).toBe(false);
    expect(graphAtTime(resumed, 300)![0].status).toBe("Planned");
  });

  it("protects recorded state from later mutation and survives JSON persistence", () => {
    const input = node("task", { dependsOnKeys: ["before"] });
    const history = recordGraphObservation(null, [input], 100, "first").history;
    input.dependsOnKeys.push("later");
    const replay = graphAtTime(history, 100)!;
    replay[0].dependsOnKeys.push("also-later");
    expect(
      graphAtTime(
        parseGraphHistory(JSON.parse(JSON.stringify(history))),
        100,
      )![0].dependsOnKeys,
    ).toEqual(["before"]);
  });

  it("steps by local calendar days and clamps to recorded boundaries", () => {
    const from = new Date(2026, 8, 10, 12).getTime();
    const through = new Date(2026, 8, 15, 12).getTime();
    expect(stepGraphHistoryDay(through, -1, from, through)).toBe(
      new Date(2026, 8, 14, 12).getTime(),
    );
    expect(stepGraphHistoryDay(from, -1, from, through)).toBe(from);
    expect(stepGraphHistoryDay(through, 1, from, through)).toBe(through);
  });

  it("jumps between observations without needing to visit unchanged days", () => {
    const first = recordGraphObservation(
      null,
      [node("task")],
      100,
      "first",
    ).history;
    const history = recordGraphObservation(
      first,
      [node("task", { status: "Completed" })],
      500,
      "first",
    ).history;
    expect(adjacentGraphHistoryChange(history, 300, -1)).toBe(100);
    expect(adjacentGraphHistoryChange(history, 300, 1)).toBe(500);
    expect(adjacentGraphHistoryChange(history, 500, 1)).toBeNull();
  });

  it("rejects damaged journals and duplicate identities instead of resetting history", () => {
    const history = recordGraphObservation(
      null,
      [node("task")],
      100,
      "first",
    ).history;
    expect(() => parseGraphHistory({ ...history, version: 2 })).toThrow();
    expect(() =>
      recordGraphObservation(
        history,
        [node("task"), node("task")],
        200,
        "first",
      ),
    ).toThrow();
    expect(() =>
      recordGraphObservation(history, [node("task")], 99, "first"),
    ).toThrow();
    expect(() =>
      parseGraphHistory({
        ...history,
        frames: [{ ...history.frames[0], upserts: [{ key: "broken" }] }],
      }),
    ).toThrow();
  });
});
