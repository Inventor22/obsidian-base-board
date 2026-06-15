// Shared graph engine: the single source of truth for the derived work-state
// model and the active-frontier projection. Pure and dependency-free (no
// Obsidian imports) so both the Graph view and the Kanban view derive frontier
// state from the same logic — there is no duplicated frontier derivation.
//
// See GRAPH_ARCHITECTURE_PLAN.md ("Boundaries, signals & lenses", Step D) and
// GRAPH_VIEW_RULES.md §1.2 for the behavioural contract.

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
  normalized = normalized.replace(/\.md$/i, "");
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex >= 0) normalized = normalized.slice(slashIndex + 1);
  return normalized.toLowerCase();
}

export function normalizeReferences(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? (value as unknown[]) : [value];
  return rawValues
    .map((rawValue) => normalizeReference(rawValue))
    .filter((reference): reference is string => reference !== null);
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

/**
 * The set a node derives its group state from: containment `children` for
 * normal nodes, plus `members` (incoming `rollup_to`) for scope/aggregation
 * nodes. A scope thus rolls up the state of everything that belongs to it.
 */
export function getAggregationChildren(node: EngineNode): EngineNode[] {
  const children = node.children.filter((child) => !child.excludedFromFold);
  if (isScopeNode(node)) {
    return children.length > 0 ? [...children, ...node.members] : node.members;
  }
  return children;
}

// ---------------------------------------------------------------------------
//  State derivation (GRAPH_SEMANTICS_SPEC.md — pure recompute)
// ---------------------------------------------------------------------------

/**
 * Recomputes every node's derived `state` in place. Leaf (work-node) statuses
 * are the only stored truth; group states are folded bottom-up. Uses
 * object-reference memoization so the derivation terminates on malformed graphs.
 */
export function deriveStates(nodes: EngineNode[], parentOf: ParentOf): void {
  const memo = new Map<EngineNode, EngineNodeState>();
  const inProgress = new Set<EngineNode>();
  for (const node of nodes) {
    node.state = deriveNodeState(node, parentOf, memo, inProgress);
  }
}

function deriveNodeState(
  node: EngineNode,
  parentOf: ParentOf,
  memo: Map<EngineNode, EngineNodeState>,
  inProgress: Set<EngineNode>,
): EngineNodeState {
  const cached = memo.get(node);
  if (cached) return cached;
  // Cycle guard: a node referenced while it is still being computed resolves to
  // a neutral state so derivation terminates on malformed graphs.
  if (inProgress.has(node)) return "idle";
  inProgress.add(node);

  const aggregationChildren = getAggregationChildren(node);
  const state =
    aggregationChildren.length > 0
      ? deriveGroupState(
          aggregationChildren.map((child) =>
            deriveNodeState(child, parentOf, memo, inProgress),
          ),
        )
      : deriveLeafState(node, parentOf, memo, inProgress);

  inProgress.delete(node);
  memo.set(node, state);
  return state;
}

/**
 * Leaf (work-node) state read from its stored status. A ready leaf with no
 * explicit lifecycle status falls through to the computed active frontier
 * (gating prerequisites satisfied) or `waiting` (prerequisites pending).
 */
function deriveLeafState(
  node: EngineNode,
  parentOf: ParentOf,
  memo: Map<EngineNode, EngineNodeState>,
  inProgress: Set<EngineNode>,
): EngineNodeState {
  if (isInvalidatedStatus(node.status)) return "invalidated";
  if (isCancelledStatus(node.status)) return "cancelled";
  if (isInterruptedStatus(node.status)) return "interrupted";
  if (isActiveStatus(node.status)) return "active";
  if (isAwaitingStatus(node.status)) return "awaiting";
  if (isCompletedStatus(node.status)) return "completed";
  if (isBlockedStatus(node.status)) return "blocked";
  if (!areGatingPrerequisitesTerminal(node, parentOf, memo, inProgress)) {
    return "waiting";
  }
  return "active";
}

/**
 * Group-state fold (GRAPH_SEMANTICS_SPEC.md Layer A) over the children's
 * derived states. Precedence (decreasing):
 * In Progress > Completed > Cancelled/Invalidated > Planned.
 */
function deriveGroupState(childStates: EngineNodeState[]): EngineNodeState {
  if (childStates.length === 0) return "idle";
  const isLive = (state: EngineNodeState): boolean =>
    state === "active" ||
    state === "in-progress" ||
    state === "awaiting" ||
    state === "interrupted" ||
    state === "blocked";
  if (childStates.some(isLive)) return "in-progress";
  if (childStates.every((state) => state === "completed")) return "completed";
  if (childStates.every((state) => state === "cancelled")) return "cancelled";
  if (childStates.every((state) => state === "invalidated")) {
    return "invalidated";
  }
  if (
    childStates.every(
      (state) => state === "cancelled" || state === "invalidated",
    )
  ) {
    return childStates.some((state) => state === "invalidated")
      ? "invalidated"
      : "cancelled";
  }
  // Mixed completed/planned with no live work: not finished, no active frontier
  // — render as waiting (Planned).
  return "waiting";
}

/**
 * True when every gating prerequisite of a node — its own `depends_on`
 * predecessors plus the predecessors of each containment ancestor — is in a
 * terminal DERIVED state. Uses derived states (not stored status) so group
 * prerequisites resolve correctly under the derived model.
 */
function areGatingPrerequisitesTerminal(
  node: EngineNode,
  parentOf: ParentOf,
  memo: Map<EngineNode, EngineNodeState>,
  inProgress: Set<EngineNode>,
): boolean {
  const isTerminal = (state: EngineNodeState): boolean =>
    state === "completed" ||
    state === "interrupted" ||
    state === "invalidated" ||
    state === "cancelled";
  const seen = new Set<EngineNode>();
  let current: EngineNode | null = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const predecessor of current.predecessors) {
      const state = deriveNodeState(predecessor, parentOf, memo, inProgress);
      if (!isTerminal(state)) return false;
    }
    current = parentOf(current);
  }
  return true;
}

// ---------------------------------------------------------------------------
//  Frontier, lineage, hygiene
// ---------------------------------------------------------------------------

/**
 * A leaf is on the frontier when it is actionable now: a work leaf (not a
 * group/container) whose derived state is the live edge — active/awaiting/
 * blocked/interrupted — never completed/cancelled/invalidated/waiting.
 */
export function isFrontierLeaf(node: EngineNode): boolean {
  if (node.children.length > 0) return false;
  if (node.kind === "group") return false;
  return (
    node.state === "active" ||
    node.state === "awaiting" ||
    node.state === "blocked" ||
    node.state === "interrupted"
  );
}

export function getFrontier(nodes: EngineNode[]): EngineNode[] {
  return nodes.filter((node) => isFrontierLeaf(node));
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
}

export interface FrontierNode extends EngineNode {
  key: string;
  title: string;
  identities: string[];
  parentKey: string | null;
  dependsOnKeys: string[];
  rollupToKeys: string[];
  parent: FrontierNode | null;
  children: FrontierNode[];
  members: FrontierNode[];
  predecessors: FrontierNode[];
  rollupTargets: FrontierNode[];
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
  }));

  const byIdentity = new Map<string, FrontierNode>();
  for (const node of nodes) {
    for (const identity of node.identities) byIdentity.set(identity, node);
  }

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
  }

  assignNodeKinds(nodes);
  deriveStates(nodes, (node) => (node as FrontierNode).parent);
  return nodes;
}

export function getFrontierNodes(nodes: FrontierNode[]): FrontierNode[] {
  return nodes.filter((node) => isFrontierLeaf(node));
}

export function getFrontierLineage(node: FrontierNode): string[] {
  return getNodeLineage(
    node,
    (candidate) => (candidate as FrontierNode).parent,
  );
}
