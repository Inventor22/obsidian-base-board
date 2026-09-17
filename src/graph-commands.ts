import { isMap, isScalar, parseDocument } from "yaml";
import { buildTransitionEvent } from "./transition-history";
import {
  RELATIONSHIP_FIELDS,
  readDependencyAssessments,
  validateWorkPatch,
  WORK_GRAPH_SCHEMA_VERSION,
} from "./work-graph";
import { normalizeReference, normalizeReferences } from "./graph-engine";

export interface GraphDocument {
  path: string;
  revision: string | null;
  properties: Record<string, unknown>;
  body: string;
}

export interface GraphChange {
  path: string;
  expectedRevision: string | null;
  set?: Record<string, unknown>;
  unset?: string[];
  body?: string;
  create?: boolean;
  delete?: boolean;
}

export interface GraphBatch {
  id: string;
  actor: { kind: "human" | "agent"; name: string };
  reason: string;
  evidence: string[];
  changes: GraphChange[];
  reverses?: string;
}

export interface FieldValue {
  exists: boolean;
  value?: unknown;
}

export interface PreparedChange {
  path: string;
  expectedRevision: string | null;
  fields: { key: string; before: FieldValue; after: FieldValue }[];
  bodyBefore?: string;
  bodyAfter?: string;
  create?: boolean;
  delete?: boolean;
}

export interface GraphPreview {
  batch: GraphBatch;
  changes: PreparedChange[];
  token: string;
}

export interface GraphBatchReceipt {
  id: string;
  batch: GraphBatch;
  state: "applying" | "applied" | "rolled-back" | "partial";
  at: string;
  planned: PreparedChange[];
  applied: { change: PreparedChange; revision: string | null }[];
  error?: string;
  conflicts: string[];
}

export interface GraphCommandStore {
  read(path: string): Promise<GraphDocument>;
  list?(): Promise<string[]>;
  write(change: GraphChange): Promise<GraphDocument>;
  getReceipt(id: string): Promise<GraphBatchReceipt | null>;
  saveReceipt(receipt: GraphBatchReceipt): Promise<void>;
}

export interface GraphCommandOptions {
  transitions?: { property: string; historyProperty: string }[];
}

export async function graphRevision(content: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(hash), (value) =>
    `0${value.toString(16)}`.slice(-2),
  ).join("");
}

function noteParts(content: string) {
  const startsWithHeader = /^\uFEFF?---[ \t]*\r?\n/.test(content);
  const match = startsWithHeader
    ? /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(content)
    : null;
  if (startsWithHeader && !match)
    throw new Error("Unclosed frontmatter boundary");
  const document = parseDocument(match?.[2] ?? "", { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid YAML: ${document.errors[0].message}`);
  const parsed: unknown = document.toJS({ maxAliasCount: 100 });
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
    throw new Error("Frontmatter must be a mapping");
  return {
    document,
    yaml: match?.[2] ?? "",
    properties: (parsed ?? {}) as Record<string, unknown>,
    body: match ? content.slice(match[0].length) : content,
    prefix: match?.[1] ?? "---\n",
    suffix: match?.[3] ?? "---\n",
    newline: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

export async function readGraphDocument(
  path: string,
  content: string | null,
): Promise<GraphDocument> {
  if (content === null)
    return { path, revision: null, properties: {}, body: "" };
  const { properties, body } = noteParts(content);
  return { path, revision: await graphRevision(content), properties, body };
}

export function patchGraphMarkdown(
  content: string,
  change: Pick<GraphChange, "set" | "unset" | "body">,
): string {
  const parts = noteParts(content);
  const replacements: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  const keys = [
    ...new Set([...Object.keys(change.set ?? {}), ...(change.unset ?? [])]),
  ];
  for (const key of keys) {
    const pair = isMap(parts.document.contents)
      ? parts.document.contents.items.find(
          (entry) => isScalar(entry.key) && entry.key.value === key,
        )
      : undefined;
    const keyRange = pair && isScalar(pair.key) ? pair.key.range : null;
    const valueRange =
      pair?.value && typeof pair.value === "object" && "range" in pair.value
        ? (pair.value as { range?: [number, number, number] }).range
        : null;
    const start = keyRange?.[0] ?? parts.yaml.length;
    const lineEnd = parts.yaml.indexOf("\n", keyRange?.[2] ?? start);
    const end =
      valueRange?.[2] ?? (lineEnd < 0 ? parts.yaml.length : lineEnd + 1);
    let text = "";
    if (!(change.unset ?? []).includes(key)) {
      const fieldDocument = parseDocument(
        pair ? parts.yaml.slice(start, end) : "",
      );
      fieldDocument.set(key, change.set![key]);
      text = fieldDocument
        .toString({ lineWidth: 0 })
        .replace(/\r?\n/g, parts.newline);
    }
    if (pair) replacements.push({ start, end, text });
    else if (text) additions.push(text);
  }
  let yaml = parts.yaml;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  )) {
    yaml =
      yaml.slice(0, replacement.start) +
      replacement.text +
      yaml.slice(replacement.end);
  }
  if (additions.length && yaml && !yaml.endsWith("\n")) yaml += parts.newline;
  yaml += additions.join("");
  const result =
    parts.prefix + yaml + parts.suffix + (change.body ?? parts.body);
  const expected = { ...parts.properties, ...change.set };
  for (const key of change.unset ?? []) delete expected[key];
  const actual = noteParts(result);
  if (
    !graphValuesEqual(expected, actual.properties) ||
    actual.body !== (change.body ?? parts.body)
  ) {
    throw new Error(
      "YAML patch would change unrelated data; review this note's structure before editing",
    );
  }
  return result;
}

function field(properties: Record<string, unknown>, key: string): FieldValue {
  return Object.prototype.hasOwnProperty.call(properties, key)
    ? { exists: true, value: properties[key] }
    : { exists: false };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function graphValuesEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function assertBatch(batch: GraphBatch): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(batch.id))
    throw new Error("Invalid batch identity");
  if (
    !batch.actor?.name?.trim() ||
    !["human", "agent"].includes(batch.actor.kind)
  )
    throw new Error("Batch attribution is required");
  if (
    !batch.reason?.trim() ||
    !Array.isArray(batch.evidence) ||
    batch.evidence.some((value) => typeof value !== "string")
  )
    throw new Error("Batch reason and evidence list are required");
  if (!Array.isArray(batch.changes) || !batch.changes.length)
    throw new Error("Name the items to change");
  const paths = new Set<string>();
  for (const change of batch.changes) {
    if (
      !change.path ||
      /(^[\\/]|^[a-zA-Z]:|\\|(^|\/)\.\.?($|\/))/.test(change.path) ||
      !change.path.endsWith(".md")
    )
      throw new Error(`Invalid note path: ${change.path}`);
    if (paths.has(change.path.toLowerCase()))
      throw new Error(`Duplicate item: ${change.path}`);
    paths.add(change.path.toLowerCase());
    if (
      change.expectedRevision !== null &&
      typeof change.expectedRevision !== "string"
    )
      throw new Error(`Expected revision required: ${change.path}`);
    if (
      change.delete &&
      (change.create || change.set || change.unset || change.body !== undefined)
    )
      throw new Error("Delete cannot be combined with edits");
    validateWorkPatch(change.set ?? {}, change.unset);
  }
}

export async function previewGraphBatch(
  store: GraphCommandStore,
  batch: GraphBatch,
): Promise<GraphPreview> {
  assertBatch(batch);
  if (store.list) await validateGraphLinks(store, batch);
  const changes: PreparedChange[] = [];
  for (const requested of batch.changes) {
    const current = await store.read(requested.path);
    if (current.revision !== requested.expectedRevision)
      throw new Error(`Revision conflict: ${requested.path}`);
    if ((current.revision === null) !== Boolean(requested.create))
      throw new Error(
        `Explicit create required only for a missing note: ${requested.path}`,
      );
    const set = { ...requested.set };
    const unset = requested.unset ?? [];
    if (
      current.properties.id !== undefined &&
      (("id" in set && !graphValuesEqual(set.id, current.properties.id)) ||
        unset.includes("id"))
    )
      throw new Error(`Stable identity cannot be replaced: ${requested.path}`);
    if (!requested.delete) {
      if (current.properties.id === undefined && set.id === undefined)
        set.id = `node-${batch.id}-${changes.length + 1}`;
      if (requested.create) set.baseboard_schema = WORK_GRAPH_SCHEMA_VERSION;
      set.baseboard_last_batch = batch.id;
    }
    const keys = requested.delete
      ? Object.keys(current.properties)
      : [...new Set([...Object.keys(set), ...unset])];
    const fields = keys
      .map((key) => ({
        key,
        before: field(current.properties, key),
        after:
          requested.delete || unset.includes(key)
            ? { exists: false }
            : { exists: true, value: set[key] },
      }))
      .filter((entry) => !graphValuesEqual(entry.before, entry.after));
    changes.push({
      path: requested.path,
      expectedRevision: current.revision,
      fields,
      ...(requested.body !== undefined || requested.delete
        ? {
            bodyBefore: current.body,
            bodyAfter: requested.delete ? "" : requested.body,
          }
        : {}),
      ...(requested.create ? { create: true } : {}),
      ...(requested.delete ? { delete: true } : {}),
    });
  }
  return {
    batch,
    changes,
    token: await graphRevision(canonical({ batch, changes })),
  };
}

async function validateGraphLinks(
  store: GraphCommandStore,
  batch: GraphBatch,
): Promise<void> {
  const relationFields = Object.keys(RELATIONSHIP_FIELDS).map(
    (kind) => RELATIONSHIP_FIELDS[kind as keyof typeof RELATIONSHIP_FIELDS],
  );
  const structural = batch.changes.filter(
    (change) =>
      change.create ||
      Object.keys(change.set ?? {}).some(
        (key) =>
          relationFields.includes(key) || key === "dependency_assessments",
      ),
  );
  if (!structural.length) return;
  const records = new Map<string, GraphDocument>();
  for (const path of await store.list!())
    records.set(path, await store.read(path));
  for (const change of batch.changes) {
    if (change.delete) {
      records.delete(change.path);
      continue;
    }
    const current = records.get(change.path) ?? (await store.read(change.path));
    const properties = { ...current.properties, ...change.set };
    for (const key of change.unset ?? []) delete properties[key];
    records.set(change.path, { ...current, properties });
  }
  const byReference = new Map<string, Set<string>>();
  for (const record of records.values()) {
    for (const raw of [
      record.path,
      record.path.split("/").pop(),
      record.properties.id,
      record.properties.title,
    ]) {
      const key = normalizeReference(raw);
      if (!key) continue;
      const candidates = byReference.get(key) ?? new Set<string>();
      candidates.add(record.path);
      byReference.set(key, candidates);
    }
  }
  const resolve = (reference: string): string => {
    const paths = byReference.get(reference);
    if (paths?.size !== 1)
      throw new Error(`Unresolved or ambiguous relationship: ${reference}`);
    return [...paths][0];
  };
  for (const change of structural) {
    const record = records.get(change.path)!;
    for (const key of relationFields) {
      if (!(key in (change.set ?? {}))) continue;
      for (const reference of normalizeReferences(record.properties[key])) {
        if (resolve(reference) === change.path)
          throw new Error(`Self relationship: ${change.path} (${key})`);
      }
    }
    if (change.create && record.properties.id !== undefined) {
      const identity = normalizeReference(record.properties.id);
      if (!identity || byReference.get(identity)?.size !== 1)
        throw new Error(`Duplicate stable identity on ${record.path}`);
    }
    if ("dependency_assessments" in (change.set ?? {})) {
      const sources = normalizeReferences(record.properties.depends_on);
      for (const assessment of readDependencyAssessments(
        record.properties.dependency_assessments,
      )) {
        if (!sources.includes(normalizeReference(assessment.source) ?? ""))
          throw new Error(
            `Assessment must name a declared dependency: ${assessment.source}`,
          );
      }
    }
    if ("parent" in (change.set ?? {})) {
      const seen = new Set<string>([change.path]);
      let parent = normalizeReference(record.properties.parent);
      while (parent) {
        const path = resolve(parent);
        if (seen.has(path))
          throw new Error(`Containment cycle: ${change.path}`);
        seen.add(path);
        parent = normalizeReference(records.get(path)?.properties.parent);
      }
    }
  }
}

function materialize(
  change: PreparedChange,
  current: GraphDocument,
): GraphChange {
  if (change.delete)
    return {
      path: change.path,
      expectedRevision: current.revision,
      delete: true,
    };
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const entry of change.fields) {
    if (entry.after.exists) set[entry.key] = entry.after.value;
    else unset.push(entry.key);
  }
  return {
    path: change.path,
    expectedRevision: current.revision,
    set,
    unset,
    body: change.bodyAfter,
    create: change.create,
  };
}

function addTransitions(
  change: GraphChange,
  current: GraphDocument,
  batch: GraphBatch,
  options: GraphCommandOptions,
): void {
  if (change.delete) return;
  for (const transition of options.transitions ?? [
    { property: "status", historyProperty: "status_history" },
    { property: "rollout_ring", historyProperty: "rollout_history" },
  ]) {
    if (
      !(transition.property in (change.set ?? {})) &&
      !change.unset?.includes(transition.property)
    )
      continue;
    const before = current.properties[transition.property] ?? null;
    const after = change.set?.[transition.property] ?? null;
    if (graphValuesEqual(before, after)) continue;
    const saved = current.properties[transition.historyProperty];
    const history: unknown[] = Array.isArray(saved)
      ? [...(saved as unknown[])]
      : saved === undefined
        ? []
        : [saved];
    const identity = current.properties.id ?? change.set?.id;
    const textValue = (value: unknown): string | null =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : null;
    const event = buildTransitionEvent({
      node: typeof identity === "string" ? identity : current.path,
      from: textValue(before),
      to: textValue(after),
      property: transition.property,
      source: "baseboard-command",
      causedBy: batch.actor.kind,
      by: batch.actor.name,
      reason: batch.reason,
      evidence: batch.evidence,
      batchId: batch.id,
      reverses: batch.reverses,
    });
    change.set ??= {};
    change.set[transition.historyProperty] = [...history, event];
  }
}

function checkHistoryEdits(
  batch: GraphBatch,
  options: GraphCommandOptions,
): void {
  const protectedFields = new Set([
    "status_history",
    "rollout_history",
    ...(options.transitions ?? []).map((entry) => entry.historyProperty),
  ]);
  for (const change of batch.changes) {
    if (change.create) continue;
    for (const key of [
      ...Object.keys(change.set ?? {}),
      ...(change.unset ?? []),
    ]) {
      if (protectedFields.has(key))
        throw new Error(`Recorded history is append-only: ${key}`);
    }
  }
}

async function inverseChange(
  store: GraphCommandStore,
  applied: GraphBatchReceipt["applied"][number],
): Promise<GraphChange> {
  const { change } = applied;
  const current = await store.read(change.path);
  if (change.create) {
    if (current.revision !== applied.revision)
      throw new Error(`Created note changed: ${change.path}`);
    return {
      path: change.path,
      expectedRevision: current.revision,
      delete: true,
    };
  }
  if (change.delete && current.revision !== null)
    throw new Error(`Deleted path was reused: ${change.path}`);
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const entry of change.fields) {
    if (entry.key === "id" && !entry.before.exists) continue;
    if (
      !change.delete &&
      !graphValuesEqual(field(current.properties, entry.key), entry.after)
    )
      throw new Error(`Undo conflict: ${change.path} (${entry.key})`);
    if (entry.before.exists) set[entry.key] = entry.before.value;
    else unset.push(entry.key);
  }
  if (
    change.bodyAfter !== undefined &&
    current.body !== change.bodyAfter &&
    !change.delete
  )
    throw new Error(`Undo conflict: ${change.path} (body)`);
  return {
    path: change.path,
    expectedRevision: current.revision,
    set,
    unset,
    body: change.bodyBefore,
    create: change.delete,
  };
}

export async function applyGraphBatch(
  store: GraphCommandStore,
  batch: GraphBatch,
  token: string,
  options: GraphCommandOptions = {},
): Promise<GraphBatchReceipt> {
  checkHistoryEdits(batch, options);
  const existing = await store.getReceipt(batch.id);
  if (existing) {
    if (existing.state === "applied" && graphValuesEqual(existing.batch, batch))
      return existing;
    throw new Error(
      `Batch already exists (${existing.state}); review its receipt: ${batch.id}`,
    );
  }
  const preview = await previewGraphBatch(store, batch);
  if (token !== preview.token)
    throw new Error(
      "Preview token mismatch; review the current before/after changes",
    );
  const receipt: GraphBatchReceipt = {
    id: batch.id,
    batch,
    state: "applying",
    at: new Date().toISOString(),
    planned: preview.changes,
    applied: [],
    conflicts: [],
  };
  await store.saveReceipt(receipt);
  try {
    for (const prepared of preview.changes) {
      const current = await store.read(prepared.path);
      if (current.revision !== prepared.expectedRevision)
        throw new Error(`Revision conflict: ${prepared.path}`);
      const change = materialize(prepared, current);
      addTransitions(change, current, batch, options);
      try {
        const after = await store.write(change);
        receipt.applied.push({ change: prepared, revision: after.revision });
      } catch (error) {
        const after = await store.read(prepared.path);
        if (
          after.properties.baseboard_last_batch === batch.id ||
          (prepared.delete && after.revision === null)
        )
          receipt.applied.push({ change: prepared, revision: after.revision });
        throw error;
      }
      await store.saveReceipt(receipt);
    }
    receipt.state = "applied";
    await store.saveReceipt(receipt);
    return receipt;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    for (const applied of [...receipt.applied].reverse()) {
      try {
        const inverse = await inverseChange(store, applied);
        const current = await store.read(inverse.path);
        addTransitions(
          inverse,
          current,
          {
            ...batch,
            id: `${batch.id}-rollback`,
            reverses: batch.id,
            reason: `Rollback of failed batch: ${batch.reason}`,
          },
          options,
        );
        await store.write(inverse);
      } catch (rollbackError) {
        receipt.conflicts.push(
          `${applied.change.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    receipt.state = receipt.conflicts.length ? "partial" : "rolled-back";
    await store.saveReceipt(receipt);
    return receipt;
  }
}

export async function proposeGraphUndo(
  store: GraphCommandStore,
  receipt: GraphBatchReceipt,
  actor: GraphBatch["actor"],
  id: string,
): Promise<GraphBatch> {
  if (receipt.state !== "applied")
    throw new Error(
      "Only an applied batch can be undone; partial batches require receipt review",
    );
  const changes: GraphChange[] = [];
  for (const applied of [...receipt.applied].reverse())
    changes.push(await inverseChange(store, applied));
  return {
    id,
    actor,
    reason: `Undo: ${receipt.batch.reason}`,
    evidence: [`batch:${receipt.id}`],
    reverses: receipt.id,
    changes,
  };
}
