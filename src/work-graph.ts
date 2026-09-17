import { normalizeReference, normalizeReferences } from "./graph-engine";

export const WORK_GRAPH_SCHEMA_VERSION = 1;
export const WORK_GRAPH_BUILD = "2026.09.16.12";

export type RelationshipKind =
  | "containment"
  | "sequence"
  | "dependency"
  | "association"
  | "membership"
  | "recovery";

export const RELATIONSHIP_FIELDS: Record<RelationshipKind, string> = {
  containment: "parent",
  sequence: "sequence_after",
  dependency: "depends_on",
  association: "associations",
  membership: "rollup_to",
  recovery: "compensates",
};

export interface Provenance {
  by: string;
  at: string;
  reason: string;
  evidence: string[];
}

export interface DependencyAssessment extends Provenance {
  source: string;
  action: string;
  assessment: "unresolved" | "satisfied" | "waived";
}

export interface SuggestedNext extends Provenance {
  scope: string;
  rank: number;
}

export interface WorkRecord {
  path: string;
  properties: Record<string, unknown>;
}

export interface DependencyAdvisory {
  source: string;
  action: string;
  assessment: DependencyAssessment["assessment"];
  missing: boolean;
  provenance: DependencyAssessment | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasProvenance(value: Record<string, unknown>): boolean {
  return (
    typeof value.by === "string" &&
    value.by.trim().length > 0 &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at)) &&
    Array.isArray(value.evidence) &&
    value.evidence.every((entry: unknown) => typeof entry === "string")
  );
}

export function readDependencyAssessments(
  value: unknown,
): DependencyAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry: unknown): entry is DependencyAssessment =>
      isObject(entry) &&
      hasProvenance(entry) &&
      typeof entry.source === "string" &&
      entry.source.trim().length > 0 &&
      typeof entry.action === "string" &&
      entry.action.trim().length > 0 &&
      ["unresolved", "satisfied", "waived"].includes(String(entry.assessment)),
  );
}

export function readSuggestedNext(value: unknown): SuggestedNext[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry: unknown): entry is SuggestedNext =>
      isObject(entry) &&
      hasProvenance(entry) &&
      typeof entry.scope === "string" &&
      entry.scope.trim().length > 0 &&
      typeof entry.rank === "number" &&
      Number.isFinite(entry.rank) &&
      entry.rank > 0,
  );
}

export function getDependencyAdvisories(
  properties: Record<string, unknown>,
  resolve: (reference: string) => WorkRecord | null,
  action = typeof properties.dependency_action === "string"
    ? properties.dependency_action
    : "work",
): DependencyAdvisory[] {
  const assessments = readDependencyAssessments(
    properties.dependency_assessments,
  );
  return normalizeReferences(properties.depends_on).map((source) => {
    const matches = assessments.filter(
      (entry) =>
        normalizeReference(entry.source) === source && entry.action === action,
    );
    const provenance = matches[matches.length - 1] ?? null;
    return {
      source,
      action,
      assessment: provenance?.assessment ?? "unresolved",
      missing: resolve(source) === null,
      provenance,
    };
  });
}

export function getSuggestedNext<T extends WorkRecord>(
  records: T[],
  scope = "all",
): { record: T; suggestion: SuggestedNext }[] {
  const result: { record: T; suggestion: SuggestedNext }[] = [];
  for (const record of records) {
    for (const suggestion of readSuggestedNext(
      record.properties.suggested_next,
    )) {
      if (scope === "all" || suggestion.scope === scope)
        result.push({ record, suggestion });
    }
  }
  return result.sort(
    (left, right) =>
      left.suggestion.rank - right.suggestion.rank ||
      left.record.path.localeCompare(right.record.path) ||
      left.suggestion.scope.localeCompare(right.suggestion.scope),
  );
}

export function validateWorkPatch(
  set: Record<string, unknown>,
  unset: string[] = [],
): void {
  for (const key of [...Object.keys(set), ...unset]) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error(`Unsafe field: ${key}`);
    if (Object.prototype.hasOwnProperty.call(set, key) && unset.includes(key))
      throw new Error(`Field both set and removed: ${key}`);
  }
  if ("status" in set && typeof set.status !== "string" && set.status !== null)
    throw new Error("Status must be text or null");
  if (
    "baseboard_schema" in set &&
    set.baseboard_schema !== WORK_GRAPH_SCHEMA_VERSION
  )
    throw new Error("Unsupported work graph schema");
  for (const kind of Object.keys(RELATIONSHIP_FIELDS) as RelationshipKind[]) {
    const field = RELATIONSHIP_FIELDS[kind];
    if (!(field in set)) continue;
    const value = set[field];
    if (value === null) continue;
    if (kind === "containment") {
      if (typeof value !== "string" || !value.trim())
        throw new Error("Containment requires one parent reference");
    } else if (
      !Array.isArray(value) ||
      !value.every(
        (reference: unknown) =>
          typeof reference === "string" && reference.trim().length > 0,
      )
    ) {
      throw new Error(`${field} must be a list of references`);
    }
  }
  if ("dependency_assessments" in set) {
    const value = set.dependency_assessments;
    if (
      !Array.isArray(value) ||
      readDependencyAssessments(value).length !== value.length
    )
      throw new Error(
        "Dependency assessments require an action, assessment, and provenance",
      );
  }
  if ("suggested_next" in set) {
    const value = set.suggested_next;
    if (
      !Array.isArray(value) ||
      readSuggestedNext(value).length !== value.length
    )
      throw new Error(
        "Suggested Next requires scope, positive rank, and provenance",
      );
    const scopes = readSuggestedNext(value).map((entry) => entry.scope);
    if (new Set(scopes).size !== scopes.length)
      throw new Error("Only one suggestion per node and scope is allowed");
  }
}

export interface MigrationWarning {
  kind: "legacy-dependency" | "container-status";
  source: unknown;
  assessment: "unreviewed";
  reason: string;
}

export function planWorkMigration(
  properties: Record<string, unknown>,
  hasChildren: boolean,
  at: string,
): { set: Record<string, unknown>; warnings: MigrationWarning[] } {
  if (properties.baseboard_schema === WORK_GRAPH_SCHEMA_VERSION)
    return { set: {}, warnings: [] };
  if (properties.baseboard_schema !== undefined)
    throw new Error(
      "Unsupported existing work graph schema; preserved without migration",
    );
  const warnings: MigrationWarning[] = [];
  if (normalizeReferences(properties.depends_on).length > 0) {
    warnings.push({
      kind: "legacy-dependency",
      source: properties.depends_on,
      assessment: "unreviewed",
      reason:
        "Legacy depends_on may have meant ordering or a specific requirement. Source values retained; no satisfaction or waiver inferred.",
    });
  }
  if (hasChildren && properties.status !== undefined) {
    warnings.push({
      kind: "container-status",
      source: properties.status,
      assessment: "unreviewed",
      reason:
        "Older builds ignored container assertions. This source value may be stale; retained without reconstructing past activity.",
    });
  }
  if (properties.baseboard_migration !== undefined)
    throw new Error(
      "Existing migration metadata requires review; preserved without replacement",
    );
  return {
    set: {
      baseboard_schema: WORK_GRAPH_SCHEMA_VERSION,
      baseboard_migration: {
        version: WORK_GRAPH_SCHEMA_VERSION,
        at,
        by: "baseboard-migration",
        warnings,
      },
    },
    warnings,
  };
}

export function getFoldedSequencePaths(
  records: WorkRecord[],
  foldedPaths: ReadonlySet<string>,
): Set<string> {
  const successors = new Map<string, WorkRecord[]>();
  const children = new Map<string, WorkRecord[]>();
  const byReference = new Map<string, WorkRecord | null>();
  for (const record of records) {
    const keys = [
      record.path,
      record.path.split("/").pop(),
      record.properties.id,
      record.properties.title,
    ];
    for (const value of keys) {
      const key = normalizeReference(value);
      if (!key) continue;
      const previous = byReference.get(key);
      byReference.set(
        key,
        previous && previous !== record
          ? null
          : previous === null
            ? null
            : record,
      );
    }
  }
  for (const record of records) {
    for (const key of normalizeReferences(record.properties.sequence_after)) {
      const source = byReference.get(key);
      if (source && source !== record)
        successors.set(source.path, [
          ...(successors.get(source.path) ?? []),
          record,
        ]);
    }
    const parentKey = normalizeReference(record.properties.parent);
    const parent = parentKey ? byReference.get(parentKey) : null;
    if (parent && parent !== record)
      children.set(parent.path, [...(children.get(parent.path) ?? []), record]);
  }
  const hidden = new Set<string>();
  for (const origin of foldedPaths) {
    const seen = new Set<string>([origin]);
    const pending = [...(successors.get(origin) ?? [])];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current.path)) continue;
      seen.add(current.path);
      if (!foldedPaths.has(current.path)) hidden.add(current.path);
      pending.push(
        ...(successors.get(current.path) ?? []),
        ...(children.get(current.path) ?? []),
      );
    }
  }
  return hidden;
}
