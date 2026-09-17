import { describe, expect, it } from "vitest";
import {
  GraphPhysics,
  countGraphRouteCrossings,
  flattenGraphPhysicsCurve,
  GRAPH_PHYSICS_SPACING,
  layoutGraphPhysics,
  routeGraphPhysicsEdge,
  type GraphPhysicsLink,
  type GraphPhysicsLayout,
  type GraphPhysicsNode,
} from "../src/graph-physics";

function node(id: string, x = 0, y = 0): GraphPhysicsNode {
  return { id, x, y, width: 220, height: 136 };
}

function distance(nodes: GraphPhysicsNode[]): number {
  return Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y);
}

describe("experimental graph physics", () => {
  it("seeds a connected sequence component without dropping its ordering links", () => {
    const nodes = ["root", "stage", "canary", "pilot", "broad"].map(
      (id, index) => ({
        id,
        x: 0,
        y: 0,
        width: 144,
        height: 144,
        fixed: index === 0,
      }),
    );
    const links = [
      { source: "root", target: "stage", kind: "association", spring: true },
      { source: "stage", target: "canary", kind: "sequence", spring: true },
      { source: "canary", target: "pilot", kind: "sequence", spring: true },
      { source: "pilot", target: "broad", kind: "sequence", spring: true },
    ];
    const positions = layoutGraphPhysics(nodes, links, 1440);
    expect(positions).toHaveLength(nodes.length);
    expect(
      positions.every(
        (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
      ),
    ).toBe(true);
    expect(positions.find((node) => node.id === "root")).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("routes around an existing unrelated edge instead of crossing it", () => {
    const nodes = [
      { id: "north-west", x: 0, y: 0, width: 144, height: 144 },
      { id: "south-east", x: 500, y: 500, width: 144, height: 144 },
      { id: "south-west", x: 0, y: 500, width: 144, height: 144 },
      { id: "north-east", x: 500, y: 0, width: 144, height: 144 },
    ];
    const first = routeGraphPhysicsEdge(nodes[0], nodes[1], "gating", nodes);
    const reserved = [
      {
        source: nodes[0].id,
        target: nodes[1].id,
        points: flattenGraphPhysicsCurve(first),
      },
    ];
    const direct = routeGraphPhysicsEdge(nodes[2], nodes[3], "gating", nodes);
    expect(
      countGraphRouteCrossings(flattenGraphPhysicsCurve(direct), reserved),
    ).toBe(1);
    const routed = routeGraphPhysicsEdge(
      nodes[2],
      nodes[3],
      "gating",
      nodes,
      0,
      reserved,
    );
    const points = flattenGraphPhysicsCurve(routed);
    expect(points.length).toBeGreaterThan(1);
    expect(countGraphRouteCrossings(points, reserved)).toBe(0);
    expect(
      routeGraphPhysicsEdge(
        nodes[2],
        nodes[3],
        "gating",
        [...nodes].reverse(),
        0,
        reserved,
      ),
    ).toEqual(routed);
  });

  it("keeps paired forward and return tracks together while avoiding other paths", () => {
    const parent = { id: "parent", x: 0, y: 0, width: 144, height: 144 };
    const child = { ...parent, id: "child", x: 200 };
    const forward = routeGraphPhysicsEdge(parent, child, "gating");
    const expected = routeGraphPhysicsEdge(child, parent, "failure-trace");
    expect(
      routeGraphPhysicsEdge(child, parent, "failure-trace", [], 0, [
        {
          source: parent.id,
          target: child.id,
          points: flattenGraphPhysicsCurve(forward),
        },
      ]),
    ).toEqual(expected);
  });

  it.each(["workflow", "hanging", "growing", "radial"] as GraphPhysicsLayout[])(
    "shortens visible spring gaps in %s without changing node size or root position",
    (mode) => {
      const nodes: GraphPhysicsNode[] = [
        {
          id: "root",
          x: 0,
          y: 0,
          width: 160,
          height: 160,
          fixed: true,
          shape: "circle",
        },
        { id: "work", x: 320, y: 0, width: 144, height: 144, shape: "circle" },
        { id: "step", x: 620, y: 0, width: 144, height: 144, shape: "circle" },
      ];
      const links = [
        { source: "root", target: "work", kind: "membership", spring: true },
        { source: "work", target: "step", kind: "gating", spring: true },
      ];
      const seeded = layoutGraphPhysics(nodes, links, 1100, mode);
      const previous = new GraphPhysics(seeded, links, {
        layout: mode,
        repulsion: 240,
        springLength: 24,
        positionStrength: 0.12,
      });
      const compact = new GraphPhysics(seeded, links, {
        ...GRAPH_PHYSICS_SPACING,
        layout: mode,
      });
      const gaps = (positions: GraphPhysicsNode[]) =>
        links.map((link) => {
          const source = positions.find((entry) => entry.id === link.source)!;
          const target = positions.find((entry) => entry.id === link.target)!;
          return (
            Math.hypot(
              target.x + target.width / 2 - source.x - source.width / 2,
              target.y + target.height / 2 - source.y - source.height / 2,
            ) -
            (source.width + target.width) / 2
          );
        });
      const previousGaps = gaps(previous.tick(350));
      const positions = compact.tick(350);
      const shorterGaps = gaps(positions);
      expect(shorterGaps.every((gap) => gap >= 10)).toBe(true);
      expect(shorterGaps.reduce((sum, gap) => sum + gap, 0)).toBeLessThan(
        previousGaps.reduce((sum, gap) => sum + gap, 0),
      );
      expect(positions.find((entry) => entry.id === "root")).toMatchObject({
        x: 0,
        y: 0,
        width: 160,
        height: 160,
      });
      expect(
        positions
          .filter((entry) => entry.id !== "root")
          .every((entry) => entry.width === 144 && entry.height === 144),
      ).toBe(true);
      expect(compact.linkCount).toBe(2);
      previous.stop();
      compact.stop();
    },
  );

  it("starts a paused hanging graph with its branches close to the root", () => {
    const nodes: GraphPhysicsNode[] = [
      {
        ...node("root"),
        width: 160,
        height: 160,
        fixed: true,
        shape: "circle",
      },
    ];
    const links: GraphPhysicsLink[] = [];
    for (let branch = 0; branch < 4; branch += 1) {
      const id = `branch-${branch}`;
      nodes.push({ ...node(id), width: 160, height: 160, shape: "circle" });
      links.push({ source: "root", target: id, spring: true });
      for (let child = 0; child < 6; child += 1) {
        const childId = `${id}-child-${child}`;
        nodes.push({
          ...node(childId),
          width: 144,
          height: 144,
          shape: "circle",
        });
        links.push({ source: id, target: childId, spring: true });
      }
    }
    const positions = layoutGraphPhysics(nodes, links, 1100, "hanging");
    for (const branch of positions.filter((entry) =>
      /^branch-\d$/.test(entry.id),
    ))
      expect(Math.hypot(branch.x, branch.y)).toBeLessThan(800);
    expect(positions.find((entry) => entry.id === "root")).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it.each(["hanging", "growing", "radial"] as GraphPhysicsLayout[])(
    "keeps %s rooted, deterministic, and driven by spring connections",
    (mode) => {
      const nodes: GraphPhysicsNode[] = [
        {
          ...node("root"),
          width: 160,
          height: 160,
          fixed: true,
          shape: "circle",
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          ...node(`child-${index}`),
          width: 144,
          height: 144,
          shape: "circle" as const,
        })),
      ];
      const links = nodes.slice(1).map((child) => ({
        source: "root",
        target: child.id,
        kind: "membership",
        spring: true,
      }));
      const seeded = layoutGraphPhysics(nodes, links, 1100, mode);
      const reversed = layoutGraphPhysics(
        [...nodes].reverse(),
        [...links].reverse(),
        1100,
        mode,
      );
      expect(
        [...seeded].sort((first, second) => first.id.localeCompare(second.id)),
      ).toEqual(
        reversed.sort((first, second) => first.id.localeCompare(second.id)),
      );
      const physics = new GraphPhysics(seeded, links, {
        ...GRAPH_PHYSICS_SPACING,
        layout: mode,
      });
      const result = physics.tick(350);
      expect(result.find((entry) => entry.id === "root")).toMatchObject({
        x: 0,
        y: 0,
        depth: 0,
      });
      const children = result.filter((entry) => entry.id !== "root");
      if (mode === "hanging")
        expect(children.every((child) => child.y + 72 > 80)).toBe(true);
      if (mode === "growing")
        expect(children.every((child) => child.y + 72 < 80)).toBe(true);
      if (mode === "radial") {
        expect(children.some((child) => child.x + 72 < 80)).toBe(true);
        expect(children.some((child) => child.x + 72 > 80)).toBe(true);
        expect(children.some((child) => child.y + 72 < 80)).toBe(true);
        expect(children.some((child) => child.y + 72 > 80)).toBe(true);
      }
      for (let first = 0; first < result.length; first += 1)
        for (let second = first + 1; second < result.length; second += 1) {
          const left = result[first];
          const right = result[second];
          expect(
            Math.hypot(
              left.x + left.width / 2 - right.x - right.width / 2,
              left.y + left.height / 2 - right.y - right.height / 2,
            ),
          ).toBeGreaterThanOrEqual((left.width + right.width) / 2);
        }
      expect(physics.linkCount).toBe(6);
      physics.stop();
    },
  );

  it("rebases the layout guide on release instead of snapping back to its original slot", () => {
    const original = {
      ...node("rollback", 1200, 600),
      anchor: { x: 1200, y: 600 },
    };
    const physics = new GraphPhysics([original], [], {
      positionStrength: 0.12,
    });
    physics.pin("rollback", 240, 180);
    physics.release("rollback");
    expect(physics.tick(300)[0]).toMatchObject({
      x: 240,
      y: 180,
      anchor: { x: 240, y: 180 },
    });
    expect(original.anchor).toEqual({ x: 1200, y: 600 });
    physics.stop();
  });

  it("preserves the old guide when a drag is cancelled", () => {
    const physics = new GraphPhysics(
      [
        { ...node("root"), fixed: true },
        { ...node("child", 800, 300), anchor: { x: 800, y: 300 } },
      ],
      [{ source: "root", target: "child" }],
    );
    const original = physics.tick(300).find((entry) => entry.id === "child")!;
    physics.pin("child", 200, 100);
    physics.pin("child", original.x, original.y);
    physics.release("child", false);
    expect(
      physics.positions().find((entry) => entry.id === "child"),
    ).toMatchObject({
      x: original.x,
      y: original.y,
      anchor: { x: 800, y: 300 },
    });
    physics.stop();
  });

  it("uses explicit ownership classification for springs rather than relation names alone", () => {
    const nodes = [node("root"), node("child", 600), node("rollback", 900)];
    const physics = new GraphPhysics(nodes, [
      { source: "root", target: "child", kind: "membership", spring: true },
      {
        source: "child",
        target: "rollback",
        kind: "compensation",
        spring: true,
      },
      {
        source: "rollback",
        target: "root",
        kind: "association",
        spring: false,
      },
    ]);
    expect(physics.linkCount).toBe(2);
    expect(
      physics.tick(200).find((entry) => entry.id === "rollback")!.x,
    ).toBeLessThan(900);
    physics.stop();
  });

  it("keeps backtracking feedback close to the forward link on a separate track", () => {
    const parent = { id: "parent", x: 0, y: 0, width: 144, height: 144 };
    const child = { ...parent, id: "child", x: 196 };
    const forward = routeGraphPhysicsEdge(parent, child, "gating");
    for (const kind of ["failure-trace", "completion-trace"]) {
      const returned = routeGraphPhysicsEdge(child, parent, kind);
      expect(Math.abs(returned.control.y - forward.control.y)).toBeGreaterThan(
        10,
      );
      expect(Math.abs(returned.control.y - forward.control.y)).toBeLessThan(32);
      expect(returned.start.x).toBeGreaterThan(returned.end.x);
      expect(
        Math.hypot(returned.start.x - 268, returned.start.y - 72),
      ).toBeCloseTo(74);
      expect(Math.hypot(returned.end.x - 72, returned.end.y - 72)).toBeCloseTo(
        74,
      );
    }
  });

  it("packs independent workstreams instead of stacking all their ranks vertically", () => {
    const nodes: GraphPhysicsNode[] = [
      {
        id: "scope",
        x: 0,
        y: 0,
        width: 160,
        height: 160,
        fixed: true,
        shape: "circle",
      },
    ];
    const links: GraphPhysicsLink[] = [];
    for (let stream = 0; stream < 12; stream += 1) {
      const parent = `stream-${stream}`;
      nodes.push({
        id: parent,
        x: 0,
        y: 0,
        width: 160,
        height: 160,
        shape: "circle",
      });
      links.push({ source: parent, target: "scope", kind: "membership" });
      for (let step = 0; step < 3; step += 1) {
        const id = `${parent}-step-${step}`;
        nodes.push({
          id,
          x: 0,
          y: 0,
          width: 144,
          height: 144,
          shape: "circle",
        });
        links.push({ source: parent, target: id, kind: "requirement-start" });
        links.push({ source: id, target: parent, kind: "requirement-return" });
      }
    }
    const positions = layoutGraphPhysics(nodes, links, 1392);
    const width =
      Math.max(...positions.map((node) => node.x + node.width)) -
      Math.min(...positions.map((node) => node.x));
    const height =
      Math.max(...positions.map((node) => node.y + node.height)) -
      Math.min(...positions.map((node) => node.y));
    expect(width).toBeLessThanOrEqual(1392);
    expect(height).toBeLessThan(2600);
    expect(width * height).toBeLessThan(3_500_000);
    expect(positions.find((node) => node.id === "scope")).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("routes return and failure arcs separately and outside intervening circles", () => {
    const circles = [0, 180, 360].map((x, index) => ({
      id: `step-${index}`,
      x,
      y: 0,
      width: 144,
      height: 144,
    }));
    const completion = routeGraphPhysicsEdge(
      circles[2],
      circles[0],
      "requirement-return",
      circles,
    );
    const failure = routeGraphPhysicsEdge(
      circles[2],
      circles[0],
      "break",
      circles,
    );
    expect(completion.control.y).toBeLessThan(0);
    expect(failure.control.y).toBeGreaterThan(144);
    for (const curve of [completion, failure]) {
      expect(Math.hypot(curve.start.x - 432, curve.start.y - 72)).toBeCloseTo(
        74,
      );
      expect(Math.hypot(curve.end.x - 72, curve.end.y - 72)).toBeCloseTo(74);
      for (let sample = 0; sample <= 100; sample += 1) {
        const time = sample / 100;
        const inverse = 1 - time;
        const x =
          inverse * inverse * curve.start.x +
          2 * inverse * time * curve.control.x +
          time * time * curve.end.x;
        const y =
          inverse * inverse * curve.start.y +
          2 * inverse * time * curve.control.y +
          time * time * curve.end.y;
        expect(Math.hypot(x - 252, y - 72)).toBeGreaterThan(72);
      }
    }
    expect(
      routeGraphPhysicsEdge(
        circles[2],
        circles[0],
        "requirement-return",
        circles,
        1,
      ),
    ).not.toEqual(completion);
  });

  it("bends a forward link around a circle instead of crossing its label", () => {
    const circles = [0, 180, 360].map((x, index) => ({
      id: `step-${index}`,
      x,
      y: 0,
      width: 144,
      height: 144,
    }));
    const curve = routeGraphPhysicsEdge(
      circles[0],
      circles[2],
      "gating",
      circles,
    );
    for (let sample = 0; sample <= 100; sample += 1) {
      const time = sample / 100;
      const inverse = 1 - time;
      const x =
        inverse * inverse * curve.start.x +
        2 * inverse * time * curve.control.x +
        time * time * curve.end.x;
      const y =
        inverse * inverse * curve.start.y +
        2 * inverse * time * curve.control.y +
        time * time * curve.end.y;
      expect(Math.hypot(x - 252, y - 72)).toBeGreaterThan(82);
    }
  });

  it("avoids a wall of nodes when every short curve is obstructed", () => {
    const source = { id: "source", x: 0, y: 0, width: 144, height: 144 };
    const target = { ...source, id: "target", x: 900 };
    const obstacles = [-300, -150, 0, 150, 300].map((y, index) => ({
      ...source,
      id: `obstacle-${index}`,
      x: 420,
      y,
    }));
    const curve = routeGraphPhysicsEdge(source, target, "gating", obstacles);
    expect(curve.waypoints!.length).toBeGreaterThan(2);
    for (let segment = 1; segment < curve.waypoints!.length; segment += 1) {
      const start = curve.waypoints![segment - 1];
      const end = curve.waypoints![segment];
      for (let sample = 0; sample <= 100; sample += 1) {
        const time = sample / 100;
        const x = start.x + (end.x - start.x) * time;
        const y = start.y + (end.y - start.y) * time;
        for (const obstacle of obstacles)
          expect(
            Math.hypot(x - obstacle.x - 72, y - obstacle.y - 72),
          ).toBeGreaterThan(82);
      }
    }
  });

  it("detects small obstacles between sample points on long links", () => {
    const source = { id: "source", x: 0, y: 0, width: 144, height: 144 };
    const target = { ...source, id: "target", x: 12000 };
    const obstacle = { ...source, id: "middle", x: 6280 };
    const curve = routeGraphPhysicsEdge(source, target, "gating", [obstacle]);
    for (let sample = 0; sample <= 12000; sample += 1) {
      const time = sample / 12000;
      const inverse = 1 - time;
      const x =
        inverse * inverse * curve.start.x +
        2 * inverse * time * curve.control.x +
        time * time * curve.end.x;
      const y =
        inverse * inverse * curve.start.y +
        2 * inverse * time * curve.control.y +
        time * time * curve.end.y;
      expect(Math.hypot(x - obstacle.x - 72, y - 72)).toBeGreaterThan(82);
    }
  });

  it("lays out circular workflow steps in order and retains a compact return loop", () => {
    const nodes = ["rollout", "enable", "verify"].map((id) => ({
      id,
      x: 0,
      y: 0,
      width: 144,
      height: 144,
      shape: "circle" as const,
      fixed: id === "rollout",
    }));
    const links = [
      { source: "rollout", target: "enable", kind: "requirement-start" },
      { source: "enable", target: "verify", kind: "gating" },
      { source: "verify", target: "rollout", kind: "requirement-return" },
    ];
    const seeded = layoutGraphPhysics(nodes, links);
    expect(
      layoutGraphPhysics([...nodes].reverse(), [...links].reverse()).sort(
        (first, second) => first.id.localeCompare(second.id),
      ),
    ).toEqual(
      [...seeded].sort((first, second) => first.id.localeCompare(second.id)),
    );
    const physics = new GraphPhysics(seeded, links, {
      springLength: 24,
      repulsion: 240,
      positionStrength: 0.12,
    });
    const result = physics.tick(300);
    const rollout = result.find((entry) => entry.id === "rollout")!;
    const enable = result.find((entry) => entry.id === "enable")!;
    const verify = result.find((entry) => entry.id === "verify")!;
    expect(rollout).toMatchObject({ x: 0, y: 0 });
    expect(enable.x).toBeGreaterThan(rollout.x + 144);
    expect(verify.x).toBeGreaterThan(enable.x + 144);
    expect(verify.x + 144).toBeLessThan(650);
    expect(Math.abs(verify.y)).toBeLessThan(144);
    physics.stop();
  });

  it("does not apply force through association or feedback links", () => {
    const nodes = [node("first"), node("second", 900)];
    const independent = new GraphPhysics(nodes, []);
    const associated = new GraphPhysics(nodes, [
      { source: "first", target: "second", kind: "membership" },
      { source: "first", target: "second", kind: "break" },
      { source: "first", target: "second", kind: "compensation" },
    ]);
    expect(associated.linkCount).toBe(0);
    expect(associated.tick(200)).toEqual(independent.tick(200));
    associated.stop();
    independent.stop();
  });

  it("pulls distant linked nodes together with springs", () => {
    const nodes = [node("first"), node("second", 1500)];
    const physics = new GraphPhysics(nodes, [
      { source: "first", target: "second" },
    ]);
    const result = physics.tick(180);
    expect(distance(result)).toBeLessThan(600);
    expect(distance(result)).toBeGreaterThan(220);
    physics.stop();
  });

  it("repels overlapping disconnected cards and prevents intersections", () => {
    const physics = new GraphPhysics(
      Array.from({ length: 12 }, (_, index) => node(`node-${index}`)),
      [],
    );
    const result = physics.tick(240);
    for (let first = 0; first < result.length; first += 1) {
      expect([result[first].x, result[first].y].every(Number.isFinite)).toBe(
        true,
      );
      for (let second = first + 1; second < result.length; second += 1) {
        const overlapX = Math.abs(result[first].x - result[second].x) < 220;
        const overlapY = Math.abs(result[first].y - result[second].y) < 136;
        expect(overlapX && overlapY).toBe(false);
      }
    }
    physics.stop();
  });

  it("does not double spring strength for return edges or duplicate links", () => {
    const physics = new GraphPhysics(
      [node("first"), node("second", 500)],
      [
        { source: "first", target: "second" },
        { source: "second", target: "first" },
        { source: "first", target: "second" },
        { source: "first", target: "first" },
        { source: "missing", target: "second" },
      ],
    );
    expect(physics.linkCount).toBe(1);
    physics.stop();
  });

  it("keeps a small mixed connected/disconnected graph within readable desktop scale", () => {
    const nodes = [
      { ...node("group"), height: 64 },
      { ...node("first", 20, 80), height: 88 },
      { ...node("second", 20, 184), height: 88 },
      { ...node("third", 20, 288), height: 88 },
      { ...node("separate", 308), height: 88 },
    ];
    const physics = new GraphPhysics(
      nodes,
      ["first", "second", "third"].map((target) => ({
        source: "group",
        target,
      })),
    );
    const result = physics.tick(300);
    const width =
      Math.max(...result.map((entry) => entry.x + entry.width)) -
      Math.min(...result.map((entry) => entry.x));
    expect(width).toBeLessThan(1050);
    physics.stop();
  });

  it("supports temporary dragging pins and releases them back into the simulation", () => {
    const physics = new GraphPhysics(
      [node("first"), node("second", 500)],
      [{ source: "first", target: "second" }],
    );
    physics.pin("first", 100, 250);
    expect(
      physics.tick(40).find((entry) => entry.id === "first"),
    ).toMatchObject({ x: 100, y: 250 });
    physics.release("first");
    const released = physics.tick(40).find((entry) => entry.id === "first")!;
    expect(Math.hypot(released.x - 100, released.y - 250)).toBeGreaterThan(1);
    physics.stop();
  });

  it("is repeatable from identical inputs and does not mutate source positions or links", () => {
    const nodes = [
      node("first"),
      node("second", 400, 150),
      node("third", 0, 250),
    ];
    const links = [{ source: "first", target: "second" }];
    const original = JSON.stringify({ nodes, links });
    const first = new GraphPhysics(nodes, links);
    const second = new GraphPhysics([...nodes].reverse(), links);
    expect(first.tick(100)).toEqual(second.tick(100));
    expect(JSON.stringify({ nodes, links })).toBe(original);
    first.stop();
    second.stop();
  });

  it("keeps a fixed root stationary through forces, reheat, and drag cleanup", () => {
    const root = { ...node("root", 120, 80), fixed: true };
    const child = node("child", 1500, 500);
    const physics = new GraphPhysics(
      [root, child],
      [{ source: "root", target: "child" }],
    );
    const result = physics.tick(300);
    expect(result.find((entry) => entry.id === "root")).toEqual(root);
    expect(result.find((entry) => entry.id === "child")).not.toEqual(child);
    physics.pin("root", 800, 900);
    physics.release("root");
    physics.reheat();
    expect(physics.tick(100).find((entry) => entry.id === "root")).toEqual(
      root,
    );
    physics.stop();
  });

  it("preserves a fixed root when restoring cached positions", () => {
    const root = { ...node("root", -100, 200), fixed: true };
    const links = [{ source: "root", target: "child" }];
    const physics = new GraphPhysics([root, node("child", 700)], links);
    const restored = new GraphPhysics(physics.tick(300), links);
    restored.pin("child", 400, -200);
    restored.release("child");
    expect(restored.tick(100).find((entry) => entry.id === "root")).toEqual(
      root,
    );
    physics.stop();
    restored.stop();
  });

  it("cools to a stop and reheats without starting a background timer", () => {
    const physics = new GraphPhysics([node("only")], []);
    physics.tick(400);
    expect(physics.settled).toBe(true);
    const positions = physics.positions();
    physics.reheat();
    expect(physics.settled).toBe(false);
    expect(physics.positions()).toEqual(positions);
    physics.stop();
  });

  it("restores a cooled simulation without restarting motion on unrelated renders", () => {
    const original = new GraphPhysics([node("first"), node("second", 500)], []);
    const settled = original.tick(400);
    const restored = new GraphPhysics(settled, [], { energy: original.energy });
    expect(restored.settled).toBe(true);
    expect(restored.positions()).toEqual(settled);
    original.stop();
    restored.stop();
  });

  it("handles an empty graph and rejects invalid simulation geometry", () => {
    const physics = new GraphPhysics([], []);
    expect(physics.tick()).toEqual([]);
    physics.stop();
    expect(() => new GraphPhysics([node("same"), node("same")], [])).toThrow(
      "Duplicate",
    );
    expect(() => new GraphPhysics([node("invalid", Number.NaN)], [])).toThrow(
      "Invalid",
    );
  });
});
