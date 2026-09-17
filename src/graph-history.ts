import type { EngineNodeKind } from "./graph-engine";
import type { OrderValue } from "./order";

export interface GraphHistoryNode {
  key: string;
  path: string;
  title: string;
  identities: string[];
  status: string | null;
  parentKey: string | null;
  parentValue: string | null;
  dependsOnKeys: string[];
  breaksToKeys: string[];
  restartsToKeys: string[];
  rollupToKeys: string[];
  compensatesKeys: string[];
  effecting: boolean;
  nodeType: string | null;
  workflow: string | null;
  kindExplicit: EngineNodeKind | null;
  executorExplicit: "human" | "agent" | "mixed" | null;
  autonomyExplicit: "propose" | "execute" | "autopilot" | null;
  lockedExplicit: boolean | null;
  order: OrderValue;
}

export interface GraphHistoryFrame {
  at: number;
  session: string;
  kind: "baseline" | "change" | "resume";
  gapAfter: number | null;
  upserts: GraphHistoryNode[];
  removed: string[];
}

export interface GraphHistory {
  version: 1;
  observedThrough: number;
  frames: GraphHistoryFrame[];
}

export interface GraphHistoryChanges {
  added: GraphHistoryNode[];
  updated: GraphHistoryNode[];
  removed: GraphHistoryNode[];
}

function copyNode(node: GraphHistoryNode): GraphHistoryNode {
  return {
    ...node,
    identities: [...node.identities],
    dependsOnKeys: [...node.dependsOnKeys],
    breaksToKeys: [...node.breaksToKeys],
    restartsToKeys: [...node.restartsToKeys],
    rollupToKeys: [...node.rollupToKeys],
    compensatesKeys: [...node.compensatesKeys],
  };
}

export function graphAtTime(
  history: GraphHistory,
  at: number,
): GraphHistoryNode[] | null {
  if (
    !Number.isFinite(at) ||
    !history.frames.length ||
    at < history.frames[0].at
  )
    return null;
  const nodes = new Map<string, GraphHistoryNode>();
  for (const frame of history.frames) {
    if (frame.at > at) break;
    for (const key of frame.removed) nodes.delete(key);
    for (const node of frame.upserts) nodes.set(node.key, node);
  }
  return [...nodes.values()].map(copyNode);
}

export function compareGraphSnapshots(
  before: GraphHistoryNode[],
  after: GraphHistoryNode[],
): GraphHistoryChanges {
  const previous = new Map(before.map((node) => [node.key, node]));
  const current = new Map(after.map((node) => [node.key, node]));
  return {
    added: after.filter((node) => !previous.has(node.key)),
    updated: after.filter((node) => {
      const old = previous.get(node.key);
      return old !== undefined && JSON.stringify(old) !== JSON.stringify(node);
    }),
    removed: before.filter((node) => !current.has(node.key)),
  };
}

export function scopeGraphSnapshot(
  nodes: GraphHistoryNode[],
  focusKey: string | null,
): GraphHistoryNode[] {
  if (focusKey === null || focusKey === "@all") return nodes;
  const byIdentity = new Map<string, GraphHistoryNode>();
  const children = new Map<GraphHistoryNode, Set<GraphHistoryNode>>();
  const incoming = new Set<GraphHistoryNode>();
  const membershipTargets = new Set<GraphHistoryNode>();
  for (const node of nodes) {
    children.set(node, new Set());
    for (const identity of node.identities) byIdentity.set(identity, node);
  }
  for (const node of nodes) {
    const parent =
      node.parentKey === null ? undefined : byIdentity.get(node.parentKey);
    if (parent && parent !== node) {
      children.get(parent)?.add(node);
      incoming.add(node);
    }
    for (const reference of node.rollupToKeys) {
      const scope = byIdentity.get(reference);
      if (
        !scope ||
        scope === node ||
        (scope.kindExplicit !== null && scope.kindExplicit !== "group")
      )
        continue;
      membershipTargets.add(scope);
      children.get(scope)?.add(node);
      incoming.add(node);
    }
  }
  if (focusKey === "@unassigned") {
    return nodes.filter(
      (node) =>
        !incoming.has(node) &&
        children.get(node)?.size === 0 &&
        node.kindExplicit !== "group" &&
        !membershipTargets.has(node) &&
        node.compensatesKeys.length === 0,
    );
  }
  const focus = nodes.find((node) => node.key === focusKey);
  if (!focus) return [];
  const included = new Set<GraphHistoryNode>();
  const visit = (node: GraphHistoryNode): void => {
    if (included.has(node)) return;
    included.add(node);
    for (const child of children.get(node) ?? []) visit(child);
  };
  visit(focus);
  return nodes.filter((node) => included.has(node));
}

export function scopeGraphHistory(
  history: GraphHistory,
  focusKey: string | null,
): GraphHistory {
  if (focusKey === null || focusKey === "@all") return history;
  const nodes = new Map<string, GraphHistoryNode>();
  const frames: GraphHistoryFrame[] = [];
  let previous: GraphHistoryNode[] = [];
  for (const frame of history.frames) {
    for (const key of frame.removed) nodes.delete(key);
    for (const node of frame.upserts) nodes.set(node.key, node);
    const current = scopeGraphSnapshot([...nodes.values()], focusKey);
    const changes = compareGraphSnapshots(previous, current);
    if (
      frame.kind !== "change" ||
      changes.added.length + changes.updated.length + changes.removed.length > 0
    ) {
      frames.push({
        ...frame,
        upserts: [...changes.added, ...changes.updated].map(copyNode),
        removed: changes.removed.map((node) => node.key),
      });
    }
    previous = current;
  }
  return { ...history, frames };
}

export function changedGraphHistoryKeys(
  before: GraphHistoryNode[],
  after: GraphHistoryNode[],
): Set<string> {
  const changes = compareGraphSnapshots(before, after);
  const changed = new Set(
    [...changes.added, ...changes.updated, ...changes.removed].map(
      (node) => node.key,
    ),
  );
  for (const snapshot of [before, after]) {
    const byIdentity = new Map<string, GraphHistoryNode>();
    for (const node of snapshot)
      for (const identity of node.identities) byIdentity.set(identity, node);
    const visited = new Set<string>();
    const visit = (node: GraphHistoryNode): void => {
      if (visited.has(node.key)) return;
      visited.add(node.key);
      changed.add(node.key);
      const references = [...node.rollupToKeys];
      if (node.parentKey !== null) references.push(node.parentKey);
      for (const reference of references) {
        const parent = byIdentity.get(reference);
        if (parent) visit(parent);
      }
    };
    for (const node of snapshot) if (changed.has(node.key)) visit(node);
  }
  return changed;
}

export function recordGraphObservation(
  history: GraphHistory | null,
  nodes: GraphHistoryNode[],
  at: number,
  session: string,
): { history: GraphHistory; changed: boolean } {
  if (!Number.isFinite(at) || at < 0)
    throw new Error("Invalid graph observation time");
  if (new Set(nodes.map((node) => node.key)).size !== nodes.length) {
    throw new Error("Duplicate graph history identity");
  }
  if (history && at < history.observedThrough) {
    throw new Error("The system clock moved before the last graph observation");
  }
  if (!history?.frames.length) {
    return {
      changed: true,
      history: {
        version: 1,
        observedThrough: at,
        frames: [
          {
            at,
            session,
            kind: "baseline",
            gapAfter: null,
            upserts: nodes.map(copyNode),
            removed: [],
          },
        ],
      },
    };
  }
  const last = history.frames[history.frames.length - 1];
  const changes = compareGraphSnapshots(
    graphAtTime(history, last.at) ?? [],
    nodes,
  );
  const resumed = session !== last.session;
  const changed =
    resumed ||
    changes.added.length + changes.updated.length + changes.removed.length > 0;
  const next: GraphHistory = { ...history, observedThrough: at };
  if (changed) {
    next.frames = [
      ...history.frames,
      {
        at,
        session,
        kind: resumed ? "resume" : "change",
        gapAfter: resumed ? history.observedThrough : null,
        upserts: [...changes.added, ...changes.updated].map(copyNode),
        removed: changes.removed.map((node) => node.key),
      },
    ];
  }
  return { history: next, changed };
}

export function isGraphHistoryGap(history: GraphHistory, at: number): boolean {
  return history.frames.some(
    (frame) => frame.gapAfter !== null && at > frame.gapAfter && at < frame.at,
  );
}

export function stepGraphHistoryDay(
  at: number,
  direction: -1 | 1,
  from: number,
  through: number,
): number {
  const next = new Date(at);
  next.setDate(next.getDate() + direction);
  return Math.max(from, Math.min(through, next.getTime()));
}

export function adjacentGraphHistoryChange(
  history: GraphHistory,
  at: number,
  direction: -1 | 1,
): number | null {
  const times = history.frames.map((frame) => frame.at);
  if (direction < 0) return times.filter((time) => time < at).pop() ?? null;
  return times.find((time) => time > at) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHistoryNode(value: unknown): value is GraphHistoryNode {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !value.key ||
    typeof value.path !== "string" ||
    typeof value.title !== "string"
  )
    return false;
  for (const field of [
    "identities",
    "dependsOnKeys",
    "breaksToKeys",
    "restartsToKeys",
    "rollupToKeys",
    "compensatesKeys",
  ]) {
    const entries = value[field];
    if (
      !Array.isArray(entries) ||
      !entries.every((entry: unknown) => typeof entry === "string")
    )
      return false;
  }
  for (const field of [
    "status",
    "parentKey",
    "parentValue",
    "nodeType",
    "workflow",
  ]) {
    if (value[field] !== null && typeof value[field] !== "string") return false;
  }
  return (
    typeof value.effecting === "boolean" &&
    (value.lockedExplicit === null ||
      typeof value.lockedExplicit === "boolean") &&
    [null, "work", "process", "group", "impact"].includes(
      value.kindExplicit as string | null,
    ) &&
    [null, "human", "agent", "mixed"].includes(
      value.executorExplicit as string | null,
    ) &&
    [null, "propose", "execute", "autopilot"].includes(
      value.autonomyExplicit as string | null,
    ) &&
    (value.order === null ||
      typeof value.order === "string" ||
      (typeof value.order === "number" && Number.isFinite(value.order)))
  );
}

export function parseGraphHistory(value: unknown): GraphHistory {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.frames) ||
    !value.frames.length ||
    typeof value.observedThrough !== "number" ||
    !Number.isFinite(value.observedThrough)
  ) {
    throw new Error("Unsupported or damaged graph history");
  }
  let previousTime = -1;
  for (const [index, frame] of value.frames.entries()) {
    if (
      !isRecord(frame) ||
      typeof frame.at !== "number" ||
      !Number.isFinite(frame.at) ||
      frame.at < previousTime ||
      frame.at > value.observedThrough ||
      typeof frame.session !== "string" ||
      !["baseline", "change", "resume"].includes(frame.kind as string) ||
      (index === 0 && frame.kind !== "baseline") ||
      (index > 0 && frame.kind === "baseline") ||
      (frame.gapAfter !== null &&
        (typeof frame.gapAfter !== "number" ||
          !Number.isFinite(frame.gapAfter) ||
          frame.gapAfter > frame.at)) ||
      !Array.isArray(frame.upserts) ||
      !frame.upserts.every(isHistoryNode) ||
      !Array.isArray(frame.removed) ||
      !frame.removed.every((key: unknown) => typeof key === "string")
    ) {
      throw new Error("Unsupported or damaged graph history frame");
    }
    previousTime = frame.at;
  }
  return value as unknown as GraphHistory;
}
