// Pure, deterministic graph layout engine (no Obsidian deps). Computes node
// positions for the graph view's "Organize" feature. The graph view builds a
// lightweight LayoutNode tree from a GraphNode subtree, calls one of these, and
// writes the resulting positions (see GRAPH_ARCHITECTURE_PLAN.md "Graph layout
// engine").
//
// Model: the data has two orthogonal relations — containment (`parent`, the
// tree) and gating (`depends_on`, the execution order). A tidy-tree packing
// over containment gives the shape; the sibling ORDER within each parent is
// either the node's natural order or the gating topological order; the
// orientation maps (depth, cross) → (x, y). "Layered (a/b)" is just this engine
// with gating sibling-order and the two orientations (they are transposes).

export type LayoutOrientation = "top-down" | "left-right";
export type LayoutSiblingOrder = "natural" | "gating";

/** A node in the subtree being organized. `children` is containment. */
export interface LayoutNode {
  id: string;
  children: LayoutNode[];
  /** Gating predecessor ids (`depends_on`); used only for `gating` ordering. */
  dependsOn: string[];
  /** Natural order key (graph_order / kanban_order); lower = earlier. */
  order: number;
  /** Tiebreaker for deterministic ordering. */
  title: string;
}

export interface LayoutOptions {
  orientation: LayoutOrientation;
  siblingOrder: LayoutSiblingOrder;
  /** Spacing between containment depths (the main axis). */
  levelGap: number;
  /** Spacing between leaf slots (the cross axis). */
  columnGap: number;
  /** The position to pin the root at (anchor-on-clicked-node). */
  anchor: { x: number; y: number };
}

export type PositionMap = Map<string, { x: number; y: number }>;

interface InternalNode {
  node: LayoutNode;
  children: InternalNode[];
  depth: number;
  cross: number; // packed cross-axis slot (in column units)
}

function compareNatural(a: LayoutNode, b: LayoutNode): number {
  return a.order - b.order || a.title.localeCompare(b.title);
}

/**
 * Orders a node's children. For `gating`, the order is the topological order of
 * the `depends_on` edges restricted to the sibling set (Kahn's algorithm), with
 * natural order as the tiebreak; cycles fall back to natural order. For
 * `natural`, just the order key + title.
 */
function orderSiblings(
  siblings: LayoutNode[],
  mode: LayoutSiblingOrder,
): LayoutNode[] {
  if (mode === "natural" || siblings.length < 2) {
    return [...siblings].sort(compareNatural);
  }

  const ids = new Set(siblings.map((s) => s.id));
  const byId = new Map(siblings.map((s) => [s.id, s]));
  const indegree = new Map(siblings.map((s) => [s.id, 0]));
  const adjacency = new Map<string, string[]>(siblings.map((s) => [s.id, []]));
  for (const sibling of siblings) {
    for (const dependency of sibling.dependsOn) {
      if (!ids.has(dependency) || dependency === sibling.id) continue;
      adjacency.get(dependency)?.push(sibling.id);
      indegree.set(sibling.id, (indegree.get(sibling.id) ?? 0) + 1);
    }
  }

  const ready = siblings
    .filter((s) => (indegree.get(s.id) ?? 0) === 0)
    .sort(compareNatural);
  const insertSorted = (node: LayoutNode): void => {
    let lo = 0;
    let hi = ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareNatural(ready[mid], node) <= 0) lo = mid + 1;
      else hi = mid;
    }
    ready.splice(lo, 0, node);
  };

  const result: LayoutNode[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift() as LayoutNode;
    result.push(next);
    placed.add(next.id);
    for (const successorId of adjacency.get(next.id) ?? []) {
      const remaining = (indegree.get(successorId) ?? 0) - 1;
      indegree.set(successorId, remaining);
      if (remaining === 0) insertSorted(byId.get(successorId) as LayoutNode);
    }
  }
  // Cycle remainder: append any unplaced siblings in natural order.
  if (result.length < siblings.length) {
    for (const sibling of [...siblings].sort(compareNatural)) {
      if (!placed.has(sibling.id)) result.push(sibling);
    }
  }
  return result;
}

/** Builds the internal tree with ordered children + containment depth. */
function buildInternal(
  node: LayoutNode,
  depth: number,
  order: LayoutSiblingOrder,
  seen: Set<string>,
): InternalNode {
  seen.add(node.id);
  const orderedChildren = orderSiblings(node.children, order).filter(
    (child) => !seen.has(child.id),
  );
  return {
    node,
    depth,
    cross: 0,
    children: orderedChildren.map((child) =>
      buildInternal(child, depth + 1, order, seen),
    ),
  };
}

/** Leaf-slot packing: leaves get sequential cross slots; parents are centered. */
function packCross(root: InternalNode): void {
  let nextLeaf = 0;
  const walk = (node: InternalNode): void => {
    if (node.children.length === 0) {
      node.cross = nextLeaf;
      nextLeaf += 1;
      return;
    }
    for (const child of node.children) walk(child);
    const first = node.children[0].cross;
    const last = node.children[node.children.length - 1].cross;
    node.cross = (first + last) / 2;
  };
  walk(root);
}

/**
 * Computes a tidy-tree layout for a containment subtree. `siblingOrder: gating`
 * + `orientation` give the two "layered" modes (they are transposes). The root
 * is pinned at `opts.anchor`; descendants cascade down (top-down) or right
 * (left-right).
 */
export function computeSubtreeLayout(
  root: LayoutNode,
  opts: LayoutOptions,
): PositionMap {
  const internalRoot = buildInternal(root, 0, opts.siblingOrder, new Set());
  packCross(internalRoot);

  const raw: PositionMap = new Map();
  const place = (node: InternalNode): void => {
    const main = node.depth * opts.levelGap;
    const cross = node.cross * opts.columnGap;
    const point =
      opts.orientation === "top-down"
        ? { x: cross, y: main }
        : { x: main, y: cross };
    raw.set(node.node.id, point);
    for (const child of node.children) place(child);
  };
  place(internalRoot);

  // Pin the root at the anchor so the rest of the graph does not jump.
  const rootPoint = raw.get(root.id) ?? { x: 0, y: 0 };
  const dx = opts.anchor.x - rootPoint.x;
  const dy = opts.anchor.y - rootPoint.y;
  const positions: PositionMap = new Map();
  for (const [id, point] of raw) {
    positions.set(id, {
      x: Math.round(point.x + dx),
      y: Math.round(point.y + dy),
    });
  }
  return positions;
}

// --- Transforms (operate on an existing position map) ----------------------

function bounds(positions: PositionMap): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/** Flip vertically about the selection's horizontal mid-line. */
export function mirrorVertical(positions: PositionMap): PositionMap {
  const { minY, maxY } = bounds(positions);
  const sum = minY + maxY;
  const out: PositionMap = new Map();
  for (const [id, p] of positions)
    out.set(id, { x: p.x, y: Math.round(sum - p.y) });
  return out;
}

/** Flip horizontally about the selection's vertical mid-line. */
export function mirrorHorizontal(positions: PositionMap): PositionMap {
  const { minX, maxX } = bounds(positions);
  const sum = minX + maxX;
  const out: PositionMap = new Map();
  for (const [id, p] of positions)
    out.set(id, { x: Math.round(sum - p.x), y: p.y });
  return out;
}

/**
 * Transpose (swap x/y) about the selection's top-left, converting top-down ↔
 * left-right while keeping the bounding box anchored at the same corner.
 */
export function transpose(positions: PositionMap): PositionMap {
  const { minX, minY } = bounds(positions);
  const out: PositionMap = new Map();
  for (const [id, p] of positions) {
    out.set(id, {
      x: Math.round(minX + (p.y - minY)),
      y: Math.round(minY + (p.x - minX)),
    });
  }
  return out;
}
