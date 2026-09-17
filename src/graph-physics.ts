import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type ForceX,
  type ForceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";

export const GRAPH_PHYSICS_LAYOUTS = [
  "workflow",
  "hanging",
  "growing",
  "radial",
] as const;
export type GraphPhysicsLayout = (typeof GRAPH_PHYSICS_LAYOUTS)[number];

export const GRAPH_PHYSICS_SPACING = {
  springLength: 8,
  repulsion: 120,
  positionStrength: 0.08,
} as const;
const PHYSICS_DEPTH_SPACING = 164;

export interface GraphPhysicsNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fixed?: boolean;
  shape?: "circle";
  anchor?: { x: number; y: number };
  depth?: number;
}

export interface GraphPhysicsLink {
  source: string;
  target: string;
  kind?: string;
  spring?: boolean;
}

export function isGraphSpringEdge(kind: string): boolean {
  return (
    kind === "requirement-start" ||
    kind === "gating" ||
    kind === "sequence" ||
    kind === "requirement-return" ||
    kind === "restart"
  );
}

export interface GraphPhysicsCurve {
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
  waypoints?: { x: number; y: number }[];
}

export interface GraphPhysicsRoute {
  source: string;
  target: string;
  points: { x: number; y: number }[];
}

export function flattenGraphPhysicsCurve(
  curve: GraphPhysicsCurve,
): { x: number; y: number }[] {
  if (curve.waypoints) return curve.waypoints;
  const points = [curve.start];
  const visit = (part: GraphPhysicsCurve, depth: number): void => {
    if (
      depth >= 12 ||
      segmentDistance(part.control, part.start, part.end) < 0.5
    ) {
      points.push(part.end);
      return;
    }
    const first = {
      x: (part.start.x + part.control.x) / 2,
      y: (part.start.y + part.control.y) / 2,
    };
    const second = {
      x: (part.control.x + part.end.x) / 2,
      y: (part.control.y + part.end.y) / 2,
    };
    const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    visit({ start: part.start, control: first, end: middle }, depth + 1);
    visit({ start: middle, control: second, end: part.end }, depth + 1);
  };
  visit(curve, 0);
  return points;
}

function routeSegmentsCross(
  first: { x: number; y: number },
  second: { x: number; y: number },
  third: { x: number; y: number },
  fourth: { x: number; y: number },
): boolean {
  if (
    Math.max(first.x, second.x) < Math.min(third.x, fourth.x) ||
    Math.min(first.x, second.x) > Math.max(third.x, fourth.x) ||
    Math.max(first.y, second.y) < Math.min(third.y, fourth.y) ||
    Math.min(first.y, second.y) > Math.max(third.y, fourth.y)
  )
    return false;
  const delta = { x: second.x - first.x, y: second.y - first.y };
  const other = { x: fourth.x - third.x, y: fourth.y - third.y };
  const determinant = delta.x * other.y - delta.y * other.x;
  if (Math.abs(determinant) < 0.000001) return false;
  const relative = { x: third.x - first.x, y: third.y - first.y };
  const along = (relative.x * other.y - relative.y * other.x) / determinant;
  const across = (relative.x * delta.y - relative.y * delta.x) / determinant;
  return along >= 0 && along <= 1 && across >= 0 && across <= 1;
}

export function countGraphRouteCrossings(
  points: { x: number; y: number }[],
  routes: readonly GraphPhysicsRoute[],
): number {
  let count = 0;
  for (const route of routes) {
    let crossed = false;
    for (let first = 1; first < points.length && !crossed; first += 1)
      for (let second = 1; second < route.points.length; second += 1)
        if (
          routeSegmentsCross(
            points[first - 1],
            points[first],
            route.points[second - 1],
            route.points[second],
          )
        ) {
          crossed = true;
          break;
        }
    if (crossed) count += 1;
  }
  return count;
}

interface RouteCircle {
  id: string;
  x: number;
  y: number;
  radius: number;
}

function segmentDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
              lengthSquared,
          ),
        );
  return Math.hypot(
    point.x - start.x - ratio * deltaX,
    point.y - start.y - ratio * deltaY,
  );
}

function curveClearsCircle(
  curve: GraphPhysicsCurve,
  circle: RouteCircle,
  depth = 0,
): boolean {
  const distance = segmentDistance(circle, curve.start, curve.end);
  const deviation = segmentDistance(curve.control, curve.start, curve.end);
  if (distance > circle.radius + deviation) return true;
  if (deviation < 0.25 || depth >= 12) return false;
  const first = {
    x: (curve.start.x + curve.control.x) / 2,
    y: (curve.start.y + curve.control.y) / 2,
  };
  const second = {
    x: (curve.control.x + curve.end.x) / 2,
    y: (curve.control.y + curve.end.y) / 2,
  };
  const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  return (
    curveClearsCircle(
      { start: curve.start, control: first, end: middle },
      circle,
      depth + 1,
    ) &&
    curveClearsCircle(
      { start: middle, control: second, end: curve.end },
      circle,
      depth + 1,
    )
  );
}

function routeAroundCircles(
  source: RouteCircle,
  target: RouteCircle,
  obstacles: RouteCircle[],
  preferredSide: number,
  routes: readonly GraphPhysicsRoute[],
): { x: number; y: number }[] {
  const all = [source, target, ...obstacles];
  const padding = Math.max(source.radius, target.radius) * 2;
  const local = obstacles.filter(
    (circle) =>
      circle.x + circle.radius >= Math.min(source.x, target.x) - padding &&
      circle.x - circle.radius <= Math.max(source.x, target.x) + padding &&
      circle.y + circle.radius >= Math.min(source.y, target.y) - padding &&
      circle.y - circle.radius <= Math.max(source.y, target.y) + padding,
  );
  const solve = (circles: RouteCircle[]): { x: number; y: number }[] => {
    const vertices: { x: number; y: number }[] = [source, target];
    const sides = 12;
    for (const circle of circles) {
      const radius = circle.radius / Math.cos(Math.PI / sides) + 1;
      for (let step = 0; step < sides; step += 1) {
        const angle = (step * Math.PI * 2) / sides;
        const point = {
          x: circle.x + Math.cos(angle) * radius,
          y: circle.y + Math.sin(angle) * radius,
        };
        if (
          all.every(
            (other) =>
              Math.hypot(point.x - other.x, point.y - other.y) > other.radius,
          )
        )
          vertices.push(point);
      }
    }
    const graph = new graphlib.Graph<never, never, number>({ directed: false });
    vertices.forEach((_, index) => graph.setNode(String(index)));
    for (let first = 0; first < vertices.length; first += 1) {
      const start = vertices[first];
      for (let second = first + 1; second < vertices.length; second += 1) {
        const end = vertices[second];
        const blocked = all.some((circle) => {
          if (
            (circle === source && (first === 0 || second === 0)) ||
            (circle === target && (first === 1 || second === 1))
          )
            return false;
          if (
            circle.x + circle.radius < Math.min(start.x, end.x) ||
            circle.x - circle.radius > Math.max(start.x, end.x) ||
            circle.y + circle.radius < Math.min(start.y, end.y) ||
            circle.y - circle.radius > Math.max(start.y, end.y)
          )
            return false;
          return segmentDistance(circle, start, end) <= circle.radius;
        });
        if (blocked) continue;
        const side =
          (target.x - source.x) * ((start.y + end.y) / 2 - source.y) -
          (target.y - source.y) * ((start.x + end.x) / 2 - source.x);
        graph.setEdge(
          String(first),
          String(second),
          Math.hypot(end.x - start.x, end.y - start.y) *
            (side * preferredSide < 0 ? 1.015 : 1) +
            countGraphRouteCrossings([start, end], routes) *
              Math.max(
                400,
                Math.hypot(target.x - source.x, target.y - source.y) * 2,
              ),
        );
      }
    }
    const shortest = graphlib.alg.dijkstra(graph, "0", (edge) =>
      graph.edge(edge),
    );
    if (!Number.isFinite(shortest["1"].distance)) return [];
    const path = [vertices[1]];
    let current = "1";
    while (current !== "0") {
      current = shortest[current].predecessor;
      path.push(vertices[Number(current)]);
    }
    return path.reverse();
  };
  const localPath = solve(local);
  return localPath.length > 0 || local.length === obstacles.length
    ? localPath
    : solve(obstacles);
}

export function routeGraphPhysicsEdge(
  source: GraphPhysicsNode,
  target: GraphPhysicsNode,
  kind: string,
  obstacles: GraphPhysicsNode[] = [],
  lane = 0,
  reserved: readonly GraphPhysicsRoute[] = [],
): GraphPhysicsCurve {
  const routes = reserved.filter(
    (route) =>
      !(
        (route.source === source.id && route.target === target.id) ||
        (route.source === target.id && route.target === source.id)
      ),
  );
  const from = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const to = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const delta = { x: to.x - from.x, y: to.y - from.y };
  const distance = Math.max(1, Math.hypot(delta.x, delta.y));
  const normal = { x: -delta.y / distance, y: delta.x / distance };
  const feedback = kind === "requirement-return" || kind === "break";
  const backtrack = kind === "failure-trace" || kind === "completion-trace";
  const baseBend = backtrack
    ? 18 + Math.min(lane, 2) * 6
    : feedback
      ? Math.max(source.height, target.height) + 48 + lane * 24
      : kind === "membership" || kind === "compensation"
        ? 24 + lane * 12
        : lane * 18;
  const direction = kind === "break" ? -1 : 1;
  const boundary = (
    center: { x: number; y: number },
    control: { x: number; y: number },
    radius: number,
  ) => {
    const length = Math.max(
      1,
      Math.hypot(control.x - center.x, control.y - center.y),
    );
    return {
      x: center.x + ((control.x - center.x) * radius) / length,
      y: center.y + ((control.y - center.y) * radius) / length,
    };
  };
  const nearby: RouteCircle[] = obstacles
    .filter((node) => node.id !== source.id && node.id !== target.id)
    .map((node) => ({
      id: node.id,
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
      radius: Math.max(node.width, node.height) / 2 + 10 + (backtrack ? 3 : 0),
    }))
    .sort((first, second) => first.id.localeCompare(second.id));
  const curveAt = (bend: number): GraphPhysicsCurve => {
    const control = {
      x: (from.x + to.x) / 2 + normal.x * bend,
      y: (from.y + to.y) / 2 + normal.y * bend,
    };
    return {
      start: boundary(from, control, source.width / 2 + 2),
      control,
      end: boundary(to, control, target.width / 2 + 2),
    };
  };
  const obstruction = (curve: GraphPhysicsCurve): number => {
    let score = 0;
    for (const node of nearby) {
      if (
        node.x + node.radius <
          Math.min(curve.start.x, curve.control.x, curve.end.x) ||
        node.x - node.radius >
          Math.max(curve.start.x, curve.control.x, curve.end.x) ||
        node.y + node.radius <
          Math.min(curve.start.y, curve.control.y, curve.end.y) ||
        node.y - node.radius >
          Math.max(curve.start.y, curve.control.y, curve.end.y)
      )
        continue;
      if (!curveClearsCircle(curve, node)) score += 1;
    }
    return score;
  };
  let best = curveAt(baseBend * direction);
  let bestScore = obstruction(best);
  let bestCrossings =
    bestScore === 0
      ? countGraphRouteCrossings(flattenGraphPhysicsCurve(best), routes)
      : Infinity;
  if (bestScore === 0 && bestCrossings === 0) return best;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const bend =
      (baseBend + Math.ceil(attempt / 2) * 72) *
      direction *
      (attempt % 2 ? 1 : -1);
    const candidate = curveAt(bend);
    const score = obstruction(candidate);
    const crossings =
      score === 0
        ? countGraphRouteCrossings(flattenGraphPhysicsCurve(candidate), routes)
        : Infinity;
    if (
      score < bestScore ||
      (score === bestScore && crossings < bestCrossings)
    ) {
      best = candidate;
      bestScore = score;
      bestCrossings = crossings;
    }
    if (score === 0 && crossings === 0) return candidate;
  }
  const waypoints = routeAroundCircles(
    { ...from, id: source.id, radius: source.width / 2 + 2 },
    { ...to, id: target.id, radius: target.width / 2 + 2 },
    nearby,
    direction,
    routes,
  );
  if (waypoints.length > 1) {
    waypoints[0] = boundary(from, waypoints[1], source.width / 2 + 2);
    const last = waypoints.length - 1;
    waypoints[last] = boundary(to, waypoints[last - 1], target.width / 2 + 2);
    if (
      bestScore > 0 ||
      countGraphRouteCrossings(waypoints, routes) < bestCrossings
    )
      return { ...best, start: waypoints[0], end: waypoints[last], waypoints };
  }
  return bestScore === 0 ? best : { ...best, waypoints: [] };
}

export function layoutGraphPhysics(
  nodes: GraphPhysicsNode[],
  links: GraphPhysicsLink[],
  viewportWidth = 1392,
  mode: GraphPhysicsLayout = "workflow",
): GraphPhysicsNode[] {
  if (nodes.length === 0) return [];
  if (mode !== "workflow") {
    const seeded = layoutRootedPhysics(nodes, links, mode);
    const initial = new GraphPhysics(seeded, links, {
      ...GRAPH_PHYSICS_SPACING,
      layout: mode,
    });
    const positions = initial.tick(160);
    initial.stop();
    return positions;
  }
  const componentsGraph = new graphlib.Graph<never, never, never>({
    directed: false,
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const id of [...byId.keys()].sort()) componentsGraph.setNode(id);
  for (const link of links) {
    if (
      byId.has(link.source) &&
      byId.has(link.target) &&
      (link.spring ??
        (link.kind === undefined || isGraphSpringEdge(link.kind))) &&
      link.kind !== "membership" &&
      link.kind !== "break"
    )
      componentsGraph.setEdge(link.source, link.target);
  }
  const components = graphlib.alg.components(componentsGraph);
  const componentById = new Map<string, number>();
  components.forEach((ids, index) => {
    for (const id of ids) componentById.set(id, index);
  });
  const children = new Map<number, Set<number>>();
  for (const link of links) {
    if (link.kind !== "membership") continue;
    const parent = componentById.get(link.target);
    const child = componentById.get(link.source);
    if (parent === undefined || child === undefined || parent === child)
      continue;
    const targets = children.get(parent) ?? new Set<number>();
    targets.add(child);
    children.set(parent, targets);
  }
  const fixed = nodes.find((node) => node.fixed);
  const queue = fixed ? [componentById.get(fixed.id)!] : [];
  const order: number[] = [];
  const visited = new Set<number>();
  for (let index = 0; index < queue.length; index += 1) {
    const component = queue[index];
    if (visited.has(component)) continue;
    visited.add(component);
    order.push(component);
    for (const child of [...(children.get(component) ?? [])].sort(
      (first, second) => first - second,
    ))
      if (!visited.has(child)) queue.push(child);
  }
  components.forEach((_, index) => {
    if (!visited.has(index)) order.push(index);
  });
  const positions = new Map<string, { x: number; y: number }>();
  const gap = 32;
  let left = 0;
  let top = 0;
  let rowHeight = 0;
  for (const index of order) {
    const ids = new Set(components[index]);
    const local = layoutPhysicsComponent(
      components[index].map((id) => byId.get(id)!),
      links.filter((link) => ids.has(link.source) && ids.has(link.target)),
    );
    const minimumX = Math.min(...local.map((node) => node.x));
    const minimumY = Math.min(...local.map((node) => node.y));
    const width =
      Math.max(...local.map((node) => node.x + node.width)) - minimumX;
    const height =
      Math.max(...local.map((node) => node.y + node.height)) - minimumY;
    if (left > 0 && left + width > Math.max(320, viewportWidth)) {
      left = 0;
      top += rowHeight + gap;
      rowHeight = 0;
    }
    for (const node of local)
      positions.set(node.id, {
        x: node.x - minimumX + left,
        y: node.y - minimumY + top,
      });
    left += width + gap;
    rowHeight = Math.max(rowHeight, height);
  }
  const fixedPoint = fixed ? positions.get(fixed.id)! : { x: 0, y: 0 };
  const offset = {
    x: (fixed?.x ?? 0) - fixedPoint.x,
    y: (fixed?.y ?? 0) - fixedPoint.y,
  };
  return nodes.map((node) => {
    const position = positions.get(node.id)!;
    const anchor = { x: position.x + offset.x, y: position.y + offset.y };
    return { ...node, ...anchor, anchor };
  });
}

function layoutRootedPhysics(
  nodes: GraphPhysicsNode[],
  links: GraphPhysicsLink[],
  mode: Exclude<GraphPhysicsLayout, "workflow">,
): GraphPhysicsNode[] {
  const sorted = [...nodes].sort((first, second) =>
    first.id.localeCompare(second.id),
  );
  const root = sorted.find((node) => node.fixed) ?? sorted[0];
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: 12, nodesep: 16, edgesep: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  const neighbors = new Map(sorted.map((node) => [node.id, new Set<string>()]));
  for (const node of sorted)
    graph.setNode(node.id, { width: node.width, height: node.height });
  for (const link of links) {
    if (!(
      link.spring ??
      (link.kind === undefined || isGraphSpringEdge(link.kind))
    ))
      continue;
    if (
      !neighbors.has(link.source) ||
      !neighbors.has(link.target) ||
      link.source === link.target
    )
      continue;
    neighbors.get(link.source)!.add(link.target);
    neighbors.get(link.target)!.add(link.source);
  }
  const depths = new Map<string, number>();
  for (const start of [root, ...sorted]) {
    if (depths.has(start.id)) continue;
    depths.set(start.id, 0);
    const queue = [start.id];
    for (let index = 0; index < queue.length; index += 1) {
      const parent = queue[index];
      for (const child of [...neighbors.get(parent)!].sort()) {
        if (depths.has(child)) continue;
        depths.set(child, depths.get(parent)! + 1);
        graph.setEdge(parent, child);
        queue.push(child);
      }
    }
  }
  dagreLayout(graph);
  const rootPoint = graph.node(root.id) as { x: number; y: number };
  const points = sorted.map(
    (node) => graph.node(node.id) as { x: number; y: number },
  );
  const minimumX = Math.min(...points.map((point) => point.x));
  const breadth = Math.max(...points.map((point) => point.x)) - minimumX + 180;
  const origin = { x: root.x + root.width / 2, y: root.y + root.height / 2 };
  return nodes.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number };
    const depth = depths.get(node.id)!;
    const angle = ((point.x - minimumX + 90) / breadth) * Math.PI * 2 - Math.PI;
    const radius = depth * PHYSICS_DEPTH_SPACING;
    const center =
      mode === "radial"
        ? {
            x: origin.x + Math.cos(angle) * radius,
            y: origin.y + Math.sin(angle) * radius,
          }
        : {
            x: origin.x + point.x - rootPoint.x,
            y:
              origin.y +
              (point.y - rootPoint.y) * (mode === "growing" ? -1 : 1),
          };
    return {
      ...node,
      anchor: undefined,
      depth,
      x: center.x - node.width / 2,
      y: center.y - node.height / 2,
    };
  });
}

function layoutPhysicsComponent(
  nodes: GraphPhysicsNode[],
  links: GraphPhysicsLink[],
): GraphPhysicsNode[] {
  if (nodes.length === 0) return [];
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    ranksep: 12,
    nodesep: 16,
    edgesep: 16,
    ranker: "network-simplex",
    acyclicer: "greedy",
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of [...nodes].sort((first, second) =>
    first.id.localeCompare(second.id),
  ))
    graph.setNode(node.id, { width: node.width, height: node.height });
  for (const link of [...links].sort((first, second) =>
    JSON.stringify(first).localeCompare(JSON.stringify(second)),
  )) {
    if (
      !graph.hasNode(link.source) ||
      !graph.hasNode(link.target) ||
      link.source === link.target ||
      link.spring === false ||
      (link.kind !== undefined &&
        ![
          "requirement-start",
          "gating",
          "sequence",
          "restart",
          "membership",
          "association",
          ...(link.spring ? ["compensation"] : []),
        ].includes(link.kind))
    )
      continue;
    const membership = link.kind === "membership";
    graph.setEdge(
      membership ? link.target : link.source,
      membership ? link.source : link.target,
      {
        weight: membership || link.kind === "association" ? 0.2 : 2,
        minlen: 1,
      },
      link.kind ?? "gating",
    );
  }
  dagreLayout(graph);
  const fixed = nodes.find((node) => node.fixed);
  const fixedPoint = fixed
    ? (graph.node(fixed.id) as { x: number; y: number })
    : null;
  const offset =
    fixed && fixedPoint
      ? {
          x: fixed.x - fixedPoint.x + fixed.width / 2,
          y: fixed.y - fixedPoint.y + fixed.height / 2,
        }
      : { x: 0, y: 0 };
  return nodes.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number };
    const anchor = {
      x: Math.round(point.x - node.width / 2 + offset.x),
      y: Math.round(point.y - node.height / 2 + offset.y),
    };
    return { ...node, ...anchor, anchor };
  });
}

export interface GraphPhysicsOptions {
  repulsion?: number;
  springLength?: number;
  energy?: number;
  positionStrength?: number;
  layout?: GraphPhysicsLayout;
}

interface PhysicsParticle extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fixed: boolean;
  shape?: "circle";
  anchor?: { x: number; y: number };
  depth?: number;
}

interface PhysicsSpring extends SimulationLinkDatum<PhysicsParticle> {
  feedback: boolean;
}

export class GraphPhysics {
  private readonly particles: PhysicsParticle[];
  private readonly byId: Map<string, PhysicsParticle>;
  private readonly simulation: Simulation<PhysicsParticle, PhysicsSpring>;
  readonly linkCount: number;

  constructor(
    nodes: GraphPhysicsNode[],
    links: GraphPhysicsLink[],
    options: GraphPhysicsOptions = {},
  ) {
    this.particles = [...nodes]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((node) => {
        if (
          !node.id ||
          ![node.x, node.y, node.width, node.height].every(Number.isFinite) ||
          node.width <= 0 ||
          node.height <= 0
        ) {
          throw new Error("Invalid graph physics node");
        }
        return {
          ...node,
          x: node.x + node.width / 2,
          y: node.y + node.height / 2,
          fixed: node.fixed === true,
          fx: node.fixed ? node.x + node.width / 2 : null,
          fy: node.fixed ? node.y + node.height / 2 : null,
          radius:
            node.shape === "circle"
              ? Math.max(node.width, node.height) / 2 + 6
              : Math.hypot(node.width, node.height) / 2 + 10,
        };
      });
    this.byId = new Map(
      this.particles.map((particle) => [particle.id, particle]),
    );
    if (this.byId.size !== this.particles.length)
      throw new Error("Duplicate graph physics identity");
    const pairs = new Map<string, PhysicsSpring>();
    for (const link of links) {
      if (
        !(
          link.spring ??
          (link.kind === undefined || isGraphSpringEdge(link.kind))
        ) ||
        link.source === link.target ||
        !this.byId.has(link.source) ||
        !this.byId.has(link.target)
      )
        continue;
      const pair = [link.source, link.target].sort();
      const key = JSON.stringify(pair);
      const previous = pairs.get(key);
      pairs.set(key, {
        source: pair[0],
        target: pair[1],
        feedback:
          link.kind === "requirement-return" && previous?.feedback !== false,
      });
    }
    const springs = [...pairs]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([, link]) => link);
    this.linkCount = springs.length;
    const count = Math.max(1, this.particles.length);
    const centerX =
      this.particles.reduce((total, node) => total + node.x, 0) / count;
    const centerY =
      this.particles.reduce((total, node) => total + node.y, 0) / count;
    const springLength = Math.max(0, options.springLength ?? 70);
    const repulsion = Math.max(0, options.repulsion ?? 1200);
    this.simulation = forceSimulation<PhysicsParticle>(this.particles)
      .stop()
      .alpha(options.energy ?? 1)
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .force(
        "links",
        forceLink<PhysicsParticle, PhysicsSpring>(springs)
          .id((node) => node.id)
          .distance((link) => {
            const source = link.source as PhysicsParticle;
            const target = link.target as PhysicsParticle;
            const minimum = source.radius + target.radius + springLength;
            return link.feedback
              ? Math.max(
                  minimum,
                  Math.hypot(target.x - source.x, target.y - source.y) * 0.75,
                )
              : minimum;
          })
          .strength((link) => (link.feedback ? 0.08 : 0.18)),
      )
      .force(
        "repulsion",
        forceManyBody<PhysicsParticle>().strength(-repulsion).distanceMax(1800),
      )
      .force(
        "collision",
        forceCollide<PhysicsParticle>((node) => node.radius)
          .strength(1)
          .iterations(3),
      )
      .force(
        "center-x",
        forceX<PhysicsParticle>((node) =>
          node.anchor ? node.anchor.x + node.width / 2 : centerX,
        ).strength(options.positionStrength ?? 0.04),
      )
      .force(
        "center-y",
        forceY<PhysicsParticle>((node) =>
          node.anchor ? node.anchor.y + node.height / 2 : centerY,
        ).strength(options.positionStrength ?? 0.04),
      );
    const mode = options.layout ?? "workflow";
    if (mode !== "workflow") {
      const root = this.particles.find((node) => node.fixed);
      const originX = root?.x ?? centerX;
      const originY = root?.y ?? centerY;
      this.simulation.force(
        "center-x",
        forceX<PhysicsParticle>(originX).strength(0.008),
      );
      if (mode === "radial") {
        this.simulation
          .force("center-y", forceY<PhysicsParticle>(originY).strength(0.008))
          .force(
            "radial",
            forceRadial<PhysicsParticle>(
              (node) => (node.depth ?? 1) * PHYSICS_DEPTH_SPACING,
              originX,
              originY,
            ).strength(0.045),
          );
      } else {
        const direction = mode === "growing" ? -1 : 1;
        this.simulation.force(
          "center-y",
          forceY<PhysicsParticle>(
            (node) =>
              originY + direction * (node.depth ?? 1) * PHYSICS_DEPTH_SPACING,
          ).strength(0.065),
        );
      }
    }
  }

  get settled(): boolean {
    return this.simulation.alpha() < this.simulation.alphaMin();
  }

  get energy(): number {
    return this.simulation.alpha();
  }

  tick(iterations = 1): GraphPhysicsNode[] {
    this.simulation.tick(iterations);
    return this.positions();
  }

  positions(): GraphPhysicsNode[] {
    return this.particles.map((node) => ({
      id: node.id,
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
      ...(node.fixed ? { fixed: true } : {}),
      ...(node.shape ? { shape: node.shape } : {}),
      ...(node.anchor ? { anchor: node.anchor } : {}),
      ...(node.depth !== undefined ? { depth: node.depth } : {}),
    }));
  }

  reheat(): void {
    this.simulation.alpha(0.8);
  }

  pin(id: string, xPosition: number, yPosition: number): void {
    const particle = this.byId.get(id);
    if (
      !particle ||
      particle.fixed ||
      !Number.isFinite(xPosition) ||
      !Number.isFinite(yPosition)
    )
      return;
    particle.x = particle.fx = xPosition + particle.width / 2;
    particle.y = particle.fy = yPosition + particle.height / 2;
    particle.vx = particle.vy = 0;
    this.reheat();
  }

  release(id: string, rebaseGuide = true): void {
    const particle = this.byId.get(id);
    if (!particle || particle.fixed) return;
    if (particle.anchor && rebaseGuide) {
      particle.anchor = {
        x: particle.x - particle.width / 2,
        y: particle.y - particle.height / 2,
      };
      const horizontal =
        this.simulation.force<ForceX<PhysicsParticle>>("center-x");
      const vertical =
        this.simulation.force<ForceY<PhysicsParticle>>("center-y");
      if (horizontal) horizontal.x(horizontal.x());
      if (vertical) vertical.y(vertical.y());
    }
    particle.fx = particle.fy = null;
    this.reheat();
  }

  stop(): void {
    this.simulation.stop();
  }
}
