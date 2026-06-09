# Graph Infinite Canvas Plan

Trigger phrase for a future Copilot chat: **Implement the infinite canvas feature**.

## Goal

Make the Graph view feel like an infinite canvas. It does not need to be literally unbounded; implement a practical expandable world that grows as the user pans, zooms, drags nodes, or inserts templates near the current bounds.

## Current Graph Context

- Main implementation: `src/graph-view.ts`.
- Graph build marker: `GRAPH_BUILD_VERSION` in `src/graph-view.ts`; bump it after behavior changes.
- Current graph viewport persistence uses `CONFIG_KEY_GRAPH_VIEWPORT = "graphViewport"` and stores `scrollLeft`, `scrollTop`, and `zoom` in the Bases view config.
- Current pan padding constants:
  - `GRAPH_PAN_MARGIN_X`
  - `GRAPH_PAN_MARGIN_Y`
- Current graph bounds are computed by `getGraphBounds(nodes)` from visible node positions and fixed padding.
- Node positions are persisted as frontmatter:
  - `graph_x`
  - `graph_y`
- The canvas is rendered as a scrollable `.base-board-graph-viewport` containing `.base-board-graph-zoom-content` and `.base-board-graph-canvas`.
- Zoom is applied by scaling `.base-board-graph-canvas` using `this.graphZoom`.

## Desired Behavior

1. The user should be able to pan in any direction for a long time without feeling blocked by graph bounds.
2. Dragging nodes near a canvas edge should expand the usable graph world instead of clamping movement too early.
3. Inserting nodes/templates near an edge should expand the world so the inserted structure has room.
4. Existing viewport persistence should continue to work after expansion.
5. The user should not lose camera position when the graph world expands.
6. Existing edge routing, node dragging, template placement, and delete behavior should keep working.

## Recommended Design

Use a practical infinite canvas model:

- Persist a graph world rectangle in view config, for example:
  - `graphWorld.minX`
  - `graphWorld.minY`
  - `graphWorld.maxX`
  - `graphWorld.maxY`
- Keep `graph_x` and `graph_y` as world coordinates.
- Render world coordinates by subtracting the world origin:
  - rendered left = `node.x - world.minX`
  - rendered top = `node.y - world.minY`
- SVG edge coordinates should use the same rendered coordinate space as nodes.
- Keep all internal persisted node coordinates in stable world coordinates.
- Expand the world rectangle when content or viewport approaches an edge.

## Implementation Steps

1. Add a `GraphWorldBounds` interface:

   ```ts
   interface GraphWorldBounds {
     minX: number;
     minY: number;
     maxX: number;
     maxY: number;
   }
   ```

2. Add a config key near `CONFIG_KEY_GRAPH_VIEWPORT`:

   ```ts
   const CONFIG_KEY_GRAPH_WORLD = "graphWorld";
   ```

3. Replace `getGraphBounds(nodes)` with a world-aware model:

   - Compute content bounds from node world coordinates.
   - Merge those bounds with saved world bounds.
   - Add generous padding around content and viewport.
   - Return both world bounds and rendered dimensions.

4. Introduce helpers:

   ```ts
   private getSavedGraphWorldBounds(): GraphWorldBounds | null
   private persistGraphWorldBounds(bounds: GraphWorldBounds): void
   private getContentWorldBounds(nodes: GraphNode[]): GraphWorldBounds
   private expandGraphWorldBounds(bounds: GraphWorldBounds, pointOrRect): GraphWorldBounds
   private worldToCanvasPoint(point): { x: number; y: number }
   private canvasToWorldPoint(point): { x: number; y: number }
   ```

5. Update node rendering:

   - `renderNode` should position nodes using canvas coordinates derived from world coordinates.
   - Node drag should update world coordinates (`node.x`, `node.y`) and then render using `worldToCanvasPoint`.
   - `persistGraphNodePositions` should continue writing world `graph_x` / `graph_y`.

6. Update edge routing:

   - `getNodeCenter`, `getNodeAnchorPoint`, `getSemanticAnchorPoint`, and related anchor helpers must return canvas coordinates or clearly separate world/canvas coordinates.
   - Prefer a clear convention: all SVG path coordinates are canvas coordinates; persisted node positions are world coordinates.

7. Update viewport restore logic:

   - When world bounds expand left/up, adjust `scrollLeft` / `scrollTop` so the visible camera does not jump.
   - Continue persisting `graphViewport` after scroll, pan, and zoom.

8. Update panning:

   - During `startGraphPan`, if the viewport approaches an edge of the current world, expand the world bounds and preserve camera position.

9. Update node dragging:

   - When a dragged node approaches or crosses world bounds, expand bounds and avoid clamping until very large practical limits.
   - Revisit `getClampedDragDelta`; it currently clamps against `EDGE_MARGIN`. For infinite canvas, clamp only against a broad safety limit or remove the positive-only constraint.

10. Update template insertion:

    - Template placement uses graph/world coordinates. Ensure insertion near edges expands world bounds before or immediately after creation.

11. Add a small escape hatch later if desired:

    - Right-click empty space or toolbar action: `Fit graph` / `Recenter graph`.
    - This can be a follow-up if the initial implementation is large.

## Validation Checklist

After implementing:

```powershell
npm run build
npm run deploy -- "C:\Users\Dustin\Documents\Github\Obsidian\obsidian-msft"
```

Then in Obsidian:

1. Reload or toggle Base Board.
2. Confirm Graph toolbar shows the bumped `GRAPH_BUILD_VERSION`.
3. Pan far right/down/up/left and confirm the canvas keeps expanding or feels unbounded.
4. Drag a node toward each edge and confirm it remains draggable and persists its new position.
5. Insert a template near an edge and confirm all template nodes appear locally with room.
6. Leave the Graph view and return; confirm the camera position and zoom persist.
7. Delete nodes/subtrees and confirm the camera does not jump.
8. Verify edge paths still align with node anchor points.

## Notes And Risks

- This is a cross-cutting graph change. It touches render bounds, pan/zoom, node dragging, edge coordinate math, template placement, and viewport persistence.
- Avoid changing graph relationship metadata as part of this work.
- Keep persisted node positions as stable world coordinates.
- Do not use a literally enormous SVG by default; grow bounds incrementally.
- If the first pass is too risky, start by increasing padding and removing positive-only drag clamping, then follow with persisted world bounds.