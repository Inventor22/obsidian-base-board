import { describe, expect, it } from "vitest";
import {
  getDependencyAdvisories,
  getSuggestedNext,
  getFoldedSequencePaths,
  planWorkMigration,
  validateWorkPatch,
} from "../src/work-graph";

const provenance = {
  by: "Dustin",
  at: "2026-09-16T12:00:00.000Z",
  reason:
    "Healthy zones have baked sufficiently; broken zone tracked separately.",
  evidence: ["[[Stage#Bake evidence]]", "[[Broken zone]]"],
};

describe("canonical work graph metadata", () => {
  it("folds only downstream sequence and containment without reparenting or activity changes", () => {
    const records = [
      {
        path: "Canary.md",
        properties: { status: "In Progress", parent: "Rollout" },
      },
      {
        path: "Pilot.md",
        properties: {
          status: "Planned",
          parent: "Rollout",
          sequence_after: ["Canary"],
        },
      },
      {
        path: "Broad.md",
        properties: {
          status: "Planned",
          parent: "Rollout",
          sequence_after: ["Pilot"],
        },
      },
      { path: "Zone.md", properties: { status: "Failed", parent: "Pilot" } },
      {
        path: "Dependency.md",
        properties: { status: "In Progress", depends_on: ["Canary"] },
      },
    ];
    const before = structuredClone(records);
    expect(
      [...getFoldedSequencePaths(records, new Set(["Canary.md"]))].sort(),
    ).toEqual(["Broad.md", "Pilot.md", "Zone.md"]);
    expect(getFoldedSequencePaths(records, new Set()).size).toBe(0);
    expect(records).toEqual(before);
  });

  it("records an action-specific Stage waiver without completing Stage", () => {
    const stage = { path: "Stage.md", properties: { status: "In Progress" } };
    const canary = {
      status: "In Progress",
      depends_on: ["[[Stage]]"],
      dependency_assessments: [
        {
          ...provenance,
          source: "[[Stage]]",
          action: "promote-canary",
          assessment: "waived",
        },
      ],
      decision: provenance,
    };
    validateWorkPatch(canary);
    expect(
      getDependencyAdvisories(canary, () => stage, "promote-canary")[0]
        .assessment,
    ).toBe("waived");
    expect(getDependencyAdvisories(canary, () => stage)[0].assessment).toBe(
      "unresolved",
    );
    expect(
      getDependencyAdvisories(
        { ...canary, dependency_action: "promote-canary" },
        () => stage,
      )[0].assessment,
    ).toBe("waived");
    expect(stage.properties.status).toBe("In Progress");
  });

  it("does not invent satisfaction from a completed source or approval without provenance", () => {
    expect(
      getDependencyAdvisories({ depends_on: ["Stage"] }, () => ({
        path: "Stage.md",
        properties: { status: "Completed" },
      }))[0].assessment,
    ).toBe("unresolved");
    expect(() =>
      validateWorkPatch({
        dependency_assessments: [{ source: "Stage", assessment: "waived" }],
      }),
    ).toThrow(/provenance/);
  });

  it("persists ordered scoped suggestions without a daily frontier or status filter", () => {
    const records = [
      {
        path: "Canary.md",
        properties: {
          status: "In Progress",
          suggested_next: [{ ...provenance, scope: "rollout", rank: 2 }],
        },
      },
      {
        path: "Residual.md",
        properties: {
          status: "Blocked",
          suggested_next: [{ ...provenance, scope: "rollout", rank: 1 }],
        },
      },
      { path: "Other.md", properties: { status: "Planned" } },
    ];
    expect(
      getSuggestedNext(records, "rollout").map(({ record }) => record.path),
    ).toEqual(["Residual.md", "Canary.md"]);
    expect(getSuggestedNext(records, "career")).toEqual([]);
    expect(records).toHaveLength(3);
  });

  it("migrates idempotently and preserves uncertain legacy source values", () => {
    const properties = {
      id: "stable",
      status: "Completed",
      depends_on: ["[[Stage]]"],
      custom: { nested: 42 },
      status_history: [{ from: "Planned", to: "Completed", at: "2020-01-01" }],
    };
    const before = structuredClone(properties);
    const plan = planWorkMigration(properties, true, provenance.at);
    expect(plan.warnings.map((warning) => warning.kind)).toEqual([
      "legacy-dependency",
      "container-status",
    ]);
    expect(properties).toEqual(before);
    const migrated = { ...properties, ...plan.set };
    expect(planWorkMigration(migrated, true, "2026-09-17").set).toEqual({});
    expect(migrated.status_history).toEqual(before.status_history);
    expect(migrated.custom).toEqual(before.custom);
  });

  it("refuses unknown schema versions and conflicting fields", () => {
    expect(() =>
      planWorkMigration({ baseboard_schema: 99 }, false, provenance.at),
    ).toThrow(/Unsupported/);
    expect(() =>
      validateWorkPatch({ status: "Completed" }, ["status"]),
    ).toThrow(/both/);
    expect(() => validateWorkPatch({ parent: ["A", "B"] })).toThrow(
      /one parent/,
    );
  });
});
