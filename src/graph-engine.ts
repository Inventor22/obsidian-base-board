// Shared, read-only interpretation of recorded work. Relationships and
// descendant summaries never replace a node's explicitly recorded status.

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export type EngineNodeState =
  | "active"
  | "in-progress"
  | "awaiting"
  | "waiting"
  | "completed"
  | "blocked"
  | "interrupted"
  | "invalidated"
  | "cancelled"
  | "idle";

export type EngineNodeKind = "work" | "process" | "group" | "impact";

export const ENGINE_NODE_KINDS: readonly EngineNodeKind[] = [
  "work",
  "process",
  "group",
  "impact",
];

/**
 * The structural contract the derivation needs from a node. The Graph view's
 * `GraphNode` and the Kanban view's `FrontierNode` both satisfy it, so the
 * engine operates on either. Parent resolution is injected (`parentOf`) because
 * the Graph view resolves parents through a separate identity map while the
 * frontier graph stores the parent inline.
 */
export interface EngineNode {
  title: string;
  status: string | null;
  kindExplicit: EngineNodeKind | null;
  kind: EngineNodeKind;
  state: EngineNodeState;
  children: EngineNode[];
  members: EngineNode[];
  predecessors: EngineNode[];
  rollupTargets: EngineNode[];
  compensatesKeys?: string[];
  compensatesTargets?: EngineNode[];
  // Out-of-band nodes (e.g. a dormant/triggered compensation) opt out of their
  // parent's group-state fold: they are not part of the normal forward rollup.
  excludedFromFold?: boolean;
}

export type ParentOf = (node: EngineNode) => EngineNode | null;

export interface HygieneItem {
  title: string;
  reason: string;
}

// ---------------------------------------------------------------------------
//  Status predicates (the canonical status → semantic mapping)
// ---------------------------------------------------------------------------

function normalizeStatus(status: string | null): string | undefined {
  return status?.trim().toLowerCase();
}

export function isCompletedStatus(status: string | null): boolean {
  const s = normalizeStatus(status);
  return s === "completed" || s === "done";
}

export function isInterruptedStatus(status: string | null): boolean {
  const s = normalizeStatus(status);
  return s === "interrupted" || s === "failed";
}

export function isInvalidatedStatus(status: string | null): boolean {
  const s = normalizeStatus(status);
  return s === "invalidated" || s === "skipped";
}

export function isCancelledStatus(status: string | null): boolean {
  const s = normalizeStatus(status);
  return s === "cancelled" || s === "canceled";
}

export function isAwaitingStatus(status: string | null): boolean {
  return normalizeStatus(status) === "awaiting";
}

export function isBlockedStatus(status: string | null): boolean {
  return normalizeStatus(status) === "blocked";
}

export function isActiveStatus(status: string | null): boolean {
  const s = normalizeStatus(status);
  return s === "in progress" || s === "doing" || s === "active";
}

export function isPlannedStatus(status: string | null): boolean {
  return normalizeStatus(status) === "planned";
}

// ---------------------------------------------------------------------------
//  Reference normalization (wiki-link / path → identity key)
// ---------------------------------------------------------------------------

export function normalizeReference(value: unknown): string | null {
  const firstValue = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof firstValue !== "string") return null;
  let normalized = firstValue.trim();
  if (!normalized) return null;

  const linkMatch = normalized.match(/^\[\[([^|\]]+)(?:\|[^\]]+)?\]\]$/);
  if (linkMatch) normalized = linkMatch[1];
  normalized = normalized.split("#")[0].replace(/\.md$/i, "");
  return normalized.toLowerCase();
}

export function normalizeReferences(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? (value as unknown[]) : [value];
  return rawValues
    .map((rawValue) => normalizeReference(rawValue))
    .filter((reference): reference is string => reference !== null);
}

export function indexNodeIdentities<Node>(
  nodes: readonly Node[],
  identitiesOf: (node: Node) => readonly string[],
): Map<string, Node | null> {
  const index = new Map<string, Node | null>();
  for (const node of nodes) {
    for (const identity of identitiesOf(node)) {
      if (!index.has(identity)) index.set(identity, node);
      else if (index.get(identity) !== node) index.set(identity, null);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
//  Kind inference (GRAPH_ARCHITECTURE_PLAN.md "Node model — three axes")
// ---------------------------------------------------------------------------

export function inferNodeKind(node: EngineNode): EngineNodeKind {
  if (node.members.length > 0) return "group";
  if (node.children.length > 0) return "process";
  return "work";
}

export function assignNodeKinds(nodes: EngineNode[]): void {
  for (const node of nodes) {
    node.kind = node.kindExplicit ?? inferNodeKind(node);
  }
}

/** Aggregation/scope nodes: pure rollup containers (no work state machine). */
export function isScopeNode(node: EngineNode): boolean {
  return node.kind === "group";
}

/** Impact nodes are observational: visible in the graph, inert to work flow. */
export function isImpactNode(node: EngineNode): boolean {
  return node.kind === "impact";
}

export function isCompensationNode(node: EngineNode): boolean {
  return (
    (node.compensatesKeys?.length ?? 0) > 0 ||
    (node.compensatesTargets?.length ?? 0) > 0
  );
}

/**
 * The set a node derives its group state from: containment `children` for
 * normal nodes, plus `members` (incoming `rollup_to`) for scope/aggregation
 * nodes. A scope thus rolls up the state of everything that belongs to it.
 */
export function getAggregationChildren(node: EngineNode): EngineNode[] {
  const participates = (child: EngineNode): boolean =>
    !child.excludedFromFold &&
    !isCompensationNode(child) &&
    !isImpactNode(child);
  const children = node.children.filter(participates);
  if (isScopeNode(node)) {
    const members = node.members.filter(participates);
    return children.length > 0 ? [...children, ...members] : members;
  }
  return children;
}

// ---------------------------------------------------------------------------
//  State derivation (GRAPH_SEMANTICS_SPEC.md — pure recompute)
// ---------------------------------------------------------------------------

export function getRecordedState(status: string | null): EngineNodeState {
  if (isInvalidatedStatus(status)) return "invalidated";
  if (isCancelledStatus(status)) return "cancelled";
  if (isInterruptedStatus(status)) return "interrupted";
  if (isActiveStatus(status)) return "active";
  if (isAwaitingStatus(status)) return "awaiting";
  if (isCompletedStatus(status)) return "completed";
  if (isBlockedStatus(status)) return "blocked";
  return status ? "waiting" : "idle";
}

export function deriveStates(nodes: EngineNode[], _parentOf?: ParentOf): void {
  for (const node of nodes) node.state = getRecordedState(node.status);
}

export function getFailureScope(
  nodes: EngineNode[],
  parentOf: ParentOf,
): Set<EngineNode> {
  const scope = new Set<EngineNode>();
  for (const node of nodes) {
    if (isImpactNode(node)) continue;
    if (!isInterruptedStatus(node.status) && !isBlockedStatus(node.status))
      continue;
    const seen = new Set<EngineNode>([node]);
    let current = parentOf(node);
    while (current && !seen.has(current)) {
      if (isImpactNode(current)) break;
      seen.add(current);
      scope.add(current);
      if (isScopeNode(current)) break;
      current = parentOf(current);
    }
  }
  return scope;
}

/**
 * The work breadcrumb for a node: the containment chain from the node up to
 * (and including) the topmost non-group ancestor — the feature/work-root. Stops
 * *below* the scope/aggregation layer (a `group` ancestor). Returned top→down.
 */
export function getNodeLineage(node: EngineNode, parentOf: ParentOf): string[] {
  const chain: string[] = [node.title];
  const seen = new Set<EngineNode>([node]);
  let parent = parentOf(node);
  while (parent && !seen.has(parent)) {
    if (parent.kind === "group") break;
    chain.push(parent.title);
    seen.add(parent);
    parent = parentOf(parent);
  }
  return chain.reverse();
}

/**
 * Every scope (`group`) node a node belongs to, reached upward through both
 * containment (`parent`) and membership (`rollup_to`). This is what the lens
 * picker uses to scope the frontier to a chosen portfolio: a leaf is "in" a
 * scope iff that scope appears in its scope ancestors. Excludes the node
 * itself. See GRAPH_ARCHITECTURE_PLAN.md "Lenses".
 */
export function getScopeAncestors(
  node: EngineNode,
  parentOf: ParentOf,
): EngineNode[] {
  const scopes = new Set<EngineNode>();
  const seen = new Set<EngineNode>();
  const stack: EngineNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as EngineNode;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current !== node && current.kind === "group") scopes.add(current);
    const parent = parentOf(current);
    if (parent) stack.push(parent);
    for (const scope of current.rollupTargets) stack.push(scope);
  }
  return [...scopes];
}

/**
 * Finds work/process nodes disconnected from the hierarchy: containment roots
 * that are not rolled up into any scope (e.g. leftover Kanban-era items).
 */
export function getHygiene(
  nodes: EngineNode[],
  parentOf: ParentOf,
): HygieneItem[] {
  const items: HygieneItem[] = [];
  for (const node of nodes) {
    if (node.kind === "group") continue;
    if (isImpactNode(node)) continue;
    if (parentOf(node)) continue; // placed under a parent
    if (node.rollupTargets.length > 0) continue; // rolled up into a scope
    items.push({
      title: node.title,
      reason:
        node.children.length === 0
          ? "orphan work item — no parent and no scope"
          : "feature/root not linked to any scope",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
//  Frontier graph builder (used by the Kanban projection)
// ---------------------------------------------------------------------------

/** The minimal per-note frontmatter the frontier graph needs. */
export interface FrontierRawNode {
  key: string;
  title: string;
  identities: string[];
  status: string | null;
  kindExplicit: EngineNodeKind | null;
  parentKey: string | null;
  dependsOnKeys: string[];
  rollupToKeys: string[];
  compensatesKeys: string[];
}

export interface FrontierNode extends EngineNode {
  key: string;
  title: string;
  identities: string[];
  parentKey: string | null;
  dependsOnKeys: string[];
  rollupToKeys: string[];
  compensatesKeys: string[];
  parent: FrontierNode | null;
  children: FrontierNode[];
  members: FrontierNode[];
  predecessors: FrontierNode[];
  rollupTargets: FrontierNode[];
  compensatesTargets: FrontierNode[];
}

/**
 * Builds the frontier graph from raw per-note rows: links containment
 * (`parent`), gating (`depends_on`), and membership (`rollup_to`), then assigns
 * kinds and derives states. The result is the same model the Graph view draws.
 */
export function buildFrontierGraph(raw: FrontierRawNode[]): FrontierNode[] {
  const nodes: FrontierNode[] = raw.map((row) => ({
    ...row,
    kind: "work",
    state: "idle",
    parent: null,
    children: [],
    members: [],
    predecessors: [],
    rollupTargets: [],
    compensatesTargets: [],
  }));

  const byIdentity = indexNodeIdentities(nodes, (node) => node.identities);

  for (const node of nodes) {
    if (node.parentKey) {
      const parent = byIdentity.get(node.parentKey);
      if (parent && parent !== node) {
        parent.children.push(node);
        node.parent = parent;
      }
    }
    for (const dependencyKey of node.dependsOnKeys) {
      const dependency = byIdentity.get(dependencyKey);
      if (dependency && dependency !== node) node.predecessors.push(dependency);
    }
    for (const rollupKey of node.rollupToKeys) {
      const scope = byIdentity.get(rollupKey);
      if (scope && scope !== node) {
        scope.members.push(node);
        node.rollupTargets.push(scope);
      }
    }
    for (const compensationKey of node.compensatesKeys) {
      const target = byIdentity.get(compensationKey);
      if (target && target !== node) node.compensatesTargets.push(target);
    }
  }

  assignNodeKinds(nodes);
  deriveStates(nodes, (node) => (node as FrontierNode).parent);
  return nodes;
}

export function getFrontierLineage(node: FrontierNode): string[] {
  return getNodeLineage(
    node,
    (candidate) => (candidate as FrontierNode).parent,
  );
}
