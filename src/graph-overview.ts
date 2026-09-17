import {
  isActiveStatus,
  isCompensationNode,
  type EngineNode,
  type EngineNodeState,
} from "./graph-engine";
import { computeSubtreeLayout, type LayoutNode } from "./graph-layout";

const GRAPH_STATE_VISUALS: Record<
  EngineNodeState,
  { icon: string; color: string; label: string }
> = {
  completed: {
    icon: "lucide-circle-check",
    color: "var(--color-green, #3b9468)",
    label: "Completed",
  },
  awaiting: {
    icon: "lucide-clock",
    color: "var(--color-yellow, #d4a72c)",
    label: "Awaiting",
  },
  blocked: {
    icon: "lucide-octagon-alert",
    color: "var(--color-red, #cc4b4b)",
    label: "Needs attention",
  },
  interrupted: {
    icon: "lucide-octagon-alert",
    color: "var(--color-red, #cc4b4b)",
    label: "Failed",
  },
  "in-progress": {
    icon: "lucide-circle-arrow-right",
    color: "var(--color-blue, #3e83c5)",
    label: "In progress",
  },
  active: {
    icon: "lucide-circle-arrow-right",
    color: "var(--color-blue, #3e83c5)",
    label: "In progress",
  },
  waiting: {
    icon: "lucide-lock",
    color: "var(--text-muted, #888888)",
    label: "Waiting",
  },
  cancelled: {
    icon: "lucide-circle-x",
    color: "var(--text-muted, #888888)",
    label: "Cancelled",
  },
  invalidated: {
    icon: "lucide-circle-off",
    color: "var(--text-muted, #888888)",
    label: "Invalidated",
  },
  idle: {
    icon: "lucide-circle",
    color: "var(--text-muted, #888888)",
    label: "No recorded status",
  },
};

export function getGraphStateVisual(state: EngineNodeState): Readonly<{
  icon: string;
  color: string;
  label: string;
}> {
  return GRAPH_STATE_VISUALS[state];
}

export interface GraphWorkSummary {
  total: number;
  completed: number;
  active: number;
  ready: number;
  awaiting: number;
  blocked: number;
  waiting: number;
  cancelled: number;
  invalidated: number;
  mitigations: number;
  state: EngineNodeState;
}

export function getOverviewChildren<Node extends EngineNode>(
  node: Node,
): Node[] {
  return [
    ...new Set([
      ...node.children,
      ...(node.kind === "group" ? node.members : []),
    ]),
  ].filter((child) => child !== node) as Node[];
}

export function getOverviewDescendants<Node extends EngineNode>(
  node: Node,
): Node[] {
  const seen = new Set<EngineNode>([node]);
  const descendants: Node[] = [];
  const visit = (current: Node): void => {
    for (const child of getOverviewChildren(current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      visit(child);
    }
  };
  visit(node);
  return descendants;
}

export interface OverviewTransitionStep {
  key: string;
  parentKey: string;
  depth: number;
  delay: number;
  duration: number;
}

export function planOverviewTransition<Node extends EngineNode>(
  root: Node,
  changed: ReadonlySet<string>,
  rendered: ReadonlySet<string>,
  keyOf: (node: Node) => string,
  expanding: boolean,
): OverviewTransitionStep[] {
  const rootKey = keyOf(root);
  const seen = new Set([rootKey]);
  const queue = [{ node: root, key: rootKey, depth: 0 }];
  const steps: OverviewTransitionStep[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const child of getOverviewChildren(current.node)) {
      const key = keyOf(child);
      if (seen.has(key)) continue;
      seen.add(key);
      const visible = rendered.has(key);
      const depth = current.depth + (visible ? 1 : 0);
      if (visible && changed.has(key))
        steps.push({
          key,
          parentKey: current.key,
          depth,
          delay: 0,
          duration: 180,
        });
      queue.push({ node: child, key: visible ? key : current.key, depth });
    }
  }
  const maximumDepth = Math.max(1, ...steps.map((step) => step.depth));
  const stagger = Math.min(160, 480 / maximumDepth);
  return steps.map((step) => ({
    ...step,
    delay: (expanding ? step.depth - 1 : maximumDepth - step.depth) * stagger,
  }));
}

export interface OverviewScope<Node extends EngineNode> {
  focus: Node | null;
  breadcrumbs: Node[];
  roots: Node[];
  unassigned: Node[];
  included: Node[];
}

export function connectOverviewToRoot<Node extends EngineNode>(
  nodes: Node[],
  visible: Node[],
  root: Node,
): { nodes: Node[]; edges: { from: Node; to: Node }[] } {
  const available = new Set(projectOverview(nodes, new Set()).visible);
  const included = new Set(visible);
  const parents = new Map<Node, Node | null>();
  const queue: Node[] = [];
  if (available.has(root)) {
    included.add(root);
    parents.set(root, null);
    queue.push(root);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const child of getOverviewChildren(current)) {
      if (!available.has(child) || parents.has(child)) continue;
      parents.set(child, current);
      queue.push(child);
    }
  }
  for (const node of visible) {
    let ancestor = parents.get(node);
    while (ancestor) {
      included.add(ancestor);
      ancestor = parents.get(ancestor);
    }
  }
  const edges: { from: Node; to: Node }[] = [];
  for (const from of included)
    for (const to of getOverviewChildren(from))
      if (included.has(to)) edges.push({ from, to });
  return {
    nodes: [...included],
    edges,
  };
}

export function getOverviewBreadcrumbs<Node extends EngineNode>(
  nodes: Node[],
  target: Node,
): Node[] {
  const roots = projectOverview(nodes, new Set()).roots;
  const queue = roots.map((root) => [root]);
  const seen = new Set<Node>();
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    const current = path[path.length - 1];
    if (current === target) return path;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of getOverviewChildren(current)) {
      if (!seen.has(child)) queue.push([...path, child]);
    }
  }
  return [target];
}

export function selectOverviewScope<Node extends EngineNode>(
  nodes: Node[],
  requested?: Node | null,
): OverviewScope<Node> {
  const projection = projectOverview(nodes, new Set());
  const available = new Set(projection.visible);
  let focus = requested ?? null;
  if (requested === undefined) {
    const scopes = projection.roots.filter((node) => node.kind === "group");
    if (scopes.length === 1) {
      let current: Node = scopes[0];
      const seen = new Set<Node>();
      while (!seen.has(current)) {
        seen.add(current);
        const children: Node[] = getOverviewChildren(current).filter((child) =>
          available.has(child),
        );
        if (children.length !== 1 || children[0].kind !== "group") break;
        current = children[0];
      }
      focus = current;
    }
  }
  const unassigned = projection.roots.filter(
    (node) => node.kind !== "group" && getOverviewChildren(node).length === 0,
  );
  const included = focus
    ? [focus, ...getOverviewDescendants(focus)].filter((node) =>
        available.has(node),
      )
    : projection.visible;
  return {
    focus,
    breadcrumbs: focus ? getOverviewBreadcrumbs(nodes, focus) : [],
    roots: focus
      ? getOverviewChildren(focus).filter((node) => available.has(node))
      : projection.roots.filter((node) => !unassigned.includes(node)),
    unassigned,
    included,
  };
}

export function getOverviewCompletion(summary: GraphWorkSummary): number {
  return summary.total > 0
    ? Math.max(0, Math.min(1, summary.completed / summary.total))
    : 0;
}

export function getOverviewSummaryState(
  summary: GraphWorkSummary,
): EngineNodeState {
  if (summary.active > 0) return "in-progress";
  if (summary.awaiting > 0) return "awaiting";
  if (summary.ready > 0) return "active";
  if (summary.total === 0) return "idle";
  if (summary.completed === summary.total) return "completed";
  if (summary.cancelled === summary.total) return "cancelled";
  if (summary.cancelled + summary.invalidated === summary.total)
    return "invalidated";
  return "waiting";
}

export interface OverviewClusterItem<Node extends EngineNode> {
  node: Node;
  trail: Node[];
  role: "summary" | "heading" | "task";
  x: number;
  y: number;
  height: number;
}

export function layoutOverviewClusters<Node extends EngineNode>(
  roots: Node[],
  availableNodes: Node[],
  collapsed: ReadonlySet<Node>,
  options: {
    viewportWidth: number;
    width: number;
    summaryHeight: number;
    headingHeight: number;
    taskHeight: number;
    compress?: boolean;
  },
): {
  items: OverviewClusterItem<Node>[];
  edges: { from: Node; to: Node }[];
  width: number;
  height: number;
} {
  const available = new Set(availableNodes);
  const placed = new Set<Node>();
  const clusterWidth = options.width + 60;
  const gap = 28;
  const columns = Math.max(
    1,
    Math.min(
      roots.length || 1,
      Math.floor(
        (Math.max(clusterWidth, options.viewportWidth) + gap) /
          (clusterWidth + gap),
      ),
    ),
  );
  const columnBottoms = new Array<number>(columns).fill(0);
  const items: OverviewClusterItem<Node>[] = [];
  const edges: { from: Node; to: Node }[] = [];
  let clusterIndex = 0;
  for (const root of roots) {
    if (placed.has(root) || !available.has(root)) continue;
    const column = clusterIndex % columns;
    clusterIndex += 1;
    let nextY = columnBottoms[column];
    const visit = (
      original: Node,
      depth: number,
      parent: Node | null,
    ): void => {
      if (placed.has(original) || !available.has(original)) return;
      const trail: Node[] = [];
      let node = original;
      while (
        options.compress !== false &&
        depth > 0 &&
        node.kind === "process" &&
        !collapsed.has(node)
      ) {
        const children = getOverviewChildren(node).filter(
          (child) => available.has(child) && !placed.has(child),
        );
        if (
          children.length !== 1 ||
          getOverviewChildren(children[0]).length === 0 ||
          children[0] === node
        )
          break;
        trail.push(node);
        placed.add(node);
        node = children[0];
      }
      if (placed.has(node)) return;
      placed.add(node);
      const children = getOverviewChildren(node).filter((child) =>
        available.has(child),
      );
      const role =
        children.length === 0
          ? "task"
          : collapsed.has(node)
            ? "summary"
            : "heading";
      const height =
        (role === "summary"
          ? options.summaryHeight
          : role === "heading"
            ? options.headingHeight
            : options.taskHeight) + (trail.length > 0 ? 20 : 0);
      items.push({
        node,
        trail,
        role,
        x: column * (clusterWidth + gap) + Math.min(depth, 3) * 20,
        y: nextY,
        height,
      });
      nextY += height + 16;
      if (parent) edges.push({ from: parent, to: node });
      if (role === "heading")
        for (const child of children) visit(child, depth + 1, node);
    };
    visit(root, 0, null);
    columnBottoms[column] = nextY + gap;
  }
  return {
    items,
    edges,
    width: columns * clusterWidth + (columns - 1) * gap,
    height: Math.max(0, ...columnBottoms),
  };
}

export function projectOverview<Node extends EngineNode>(
  nodes: Node[],
  collapsed: ReadonlySet<Node>,
): { roots: Node[]; visible: Node[] } {
  const candidates = nodes;
  const available = new Set<EngineNode>(candidates);
  const incoming = new Set<EngineNode>();
  for (const node of candidates) {
    for (const child of getOverviewChildren(node)) {
      if (available.has(child)) incoming.add(child);
    }
  }
  const roots = candidates.filter((node) => !incoming.has(node));
  const covered = new Set<EngineNode>();
  const cover = (node: Node): void => {
    if (covered.has(node)) return;
    covered.add(node);
    for (const child of getOverviewChildren(node)) {
      if (available.has(child)) cover(child);
    }
  };
  for (const root of roots) cover(root);
  for (const node of candidates) {
    if (covered.has(node)) continue;
    roots.push(node);
    cover(node);
  }
  const visible = new Set<EngineNode>();
  const visit = (node: Node): void => {
    if (visible.has(node)) return;
    visible.add(node);
    if (collapsed.has(node)) return;
    for (const child of getOverviewChildren(node)) {
      if (available.has(child)) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return { roots, visible: candidates.filter((node) => visible.has(node)) };
}

export function summarizeGraphWork(node: EngineNode): GraphWorkSummary {
  const summary: GraphWorkSummary = {
    total: 0,
    completed: 0,
    active: 0,
    ready: 0,
    awaiting: 0,
    blocked: 0,
    waiting: 0,
    cancelled: 0,
    invalidated: 0,
    mitigations: 0,
    state: "idle",
  };
  for (const candidate of [node, ...getOverviewDescendants(node)]) {
    if (candidate.kind === "impact") continue;
    if (isCompensationNode(candidate)) {
      if (
        candidate.state === "active" ||
        candidate.state === "awaiting" ||
        candidate.state === "blocked" ||
        candidate.state === "interrupted"
      ) {
        summary.mitigations += 1;
      }
      continue;
    }
    if (candidate.kind !== "work" || candidate.children.length > 0) continue;
    summary.total += 1;
    switch (candidate.state) {
      case "completed":
        summary.completed += 1;
        break;
      case "awaiting":
        summary.awaiting += 1;
        break;
      case "blocked":
      case "interrupted":
        summary.blocked += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      case "invalidated":
        summary.invalidated += 1;
        break;
      case "active": {
        const status = candidate.status?.trim().toLowerCase();
        if (
          isActiveStatus(candidate.status) ||
          status === "flighting" ||
          status === "in review"
        ) {
          summary.active += 1;
        } else {
          summary.ready += 1;
        }
        break;
      }
      default:
        summary.waiting += 1;
    }
  }
  summary.state =
    summary.blocked > 0 || summary.mitigations > 0
      ? "blocked"
      : summary.active > 0
        ? "in-progress"
        : summary.awaiting > 0
          ? "awaiting"
          : summary.ready > 0
            ? "active"
            : summary.total === 0
              ? "idle"
              : summary.completed === summary.total
                ? "completed"
                : summary.cancelled === summary.total
                  ? "cancelled"
                  : summary.invalidated + summary.cancelled === summary.total
                    ? "invalidated"
                    : "waiting";
  return summary;
}

export function layoutGraphOverview<Node extends EngineNode>(
  nodes: Node[],
  collapsed: ReadonlySet<Node>,
  dimensions: { width: number; height: number },
): {
  positions: Map<Node, { x: number; y: number }>;
  edges: { from: Node; to: Node }[];
} {
  const projection = projectOverview(nodes, collapsed);
  const visible = new Set(projection.visible);
  const indices = new Map(nodes.map((node, index) => [node, index]));
  const placed = new Set<Node>();
  const edges: { from: Node; to: Node }[] = [];
  const buildNode = (node: Node): LayoutNode => {
    placed.add(node);
    const children: LayoutNode[] = [];
    if (!collapsed.has(node)) {
      for (const child of getOverviewChildren(node)) {
        if (!visible.has(child) || placed.has(child)) continue;
        edges.push({ from: node, to: child });
        children.push(buildNode(child));
      }
    }
    return {
      id: String(indices.get(node)),
      title: node.title,
      order: indices.get(node) ?? 0,
      dependsOn: [],
      children,
    };
  };
  const roots: LayoutNode[] = [];
  for (const root of projection.roots) {
    if (!placed.has(root)) roots.push(buildNode(root));
  }
  const layout = computeSubtreeLayout(
    {
      id: "overview-root",
      title: "",
      order: 0,
      dependsOn: [],
      children: roots,
    },
    {
      orientation: "top-down",
      siblingOrder: "natural",
      levelGap: dimensions.height + 56,
      columnGap: dimensions.width + 48,
      anchor: { x: 0, y: -dimensions.height - 56 },
    },
  );
  const positions = new Map<Node, { x: number; y: number }>();
  for (const node of projection.visible) {
    const position = layout.get(String(indices.get(node)));
    if (position) positions.set(node, position);
  }
  return { positions, edges };
}
