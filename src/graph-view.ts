import {
  App,
  BasesEntry,
  BasesPropertyId,
  BasesView,
  Menu,
  Modal,
  Notice,
  NullValue,
  QueryController,
  setIcon,
  setTooltip,
  Setting,
  TFile,
} from "obsidian";
import type BaseBoardPlugin from "./main";
import { CardDetailModal } from "./card-detail-modal";
import { InputModal } from "./modals";
import { ORDER_PROPERTY, sanitizeFilename } from "./constants";
import { getColumnColor } from "./status-colors";

type GraphRelationKind = "requirement" | "successor";
type GraphLinkCreationKind = GraphRelationKind | "break" | "restart";
type GraphNodeState =
  | "active"
  | "in-progress"
  | "waiting"
  | "completed"
  | "blocked"
  | "interrupted"
  | "invalidated"
  | "cancelled"
  | "idle";
type GraphEdgeKind = "requirement-start" | "requirement-return" | "gating";
type GraphFlowEdgeKind = GraphEdgeKind | "break" | "restart";
type GraphWorkflowTemplate =
  | "feature-simple"
  | "feature-detailed"
  | "iteration"
  | "dev"
  | "rollout-repo"
  | "ring-flagged"
  | "ring-basic";
type GraphAnchorSide = "top" | "right" | "bottom" | "left";
type GraphEdgeEndpoint = "from" | "to";
type GraphReferenceListKind = "depends_on" | "breaks_to" | "restarts_to";

interface GraphEndpointAnchorOverride {
  side: GraphAnchorSide;
  xRatio: number;
  yRatio: number;
}

type GraphNodeAnchorSlot = GraphEndpointAnchorOverride;

interface GraphAnchorPoint {
  x: number;
  y: number;
  side: GraphAnchorSide;
}

type GraphAnchorLane = "normal" | "return" | "restart";

interface GraphTemplateDefinition {
  id: GraphWorkflowTemplate;
  name: string;
  icon: string;
  placeholder: string;
  preview: string[];
}

const GRAPH_NODE_TYPE_OPTIONS = [
  "feature",
  "iteration",
  "dev",
  "rollout",
  "repo",
  "stage",
  "canary",
  "pilot",
  "broad",
  "design",
  "implementation",
  "review",
  "await",
  "enable",
  "verify",
  "task",
] as const;

const GRAPH_TEMPLATE_DEFINITIONS: GraphTemplateDefinition[] = [
  {
    id: "feature-simple",
    name: "Simple feature",
    icon: "lucide-sparkles",
    placeholder: "New feature",
    preview: ["Feature", "  dev", "  rollout"],
  },
  {
    id: "feature-detailed",
    name: "Detailed feature",
    icon: "lucide-sparkles",
    placeholder: "New feature",
    preview: [
      "Feature",
      "  dev",
      "    design",
      "    implementation",
      "    review",
      "  rollout",
      "    repo",
      "      stage",
      "      canary",
      "      pilot",
      "      broad",
    ],
  },
  {
    id: "iteration",
    name: "Iteration",
    icon: "lucide-refresh-cw",
    placeholder: "Iteration 1",
    preview: ["Iteration", "  dev", "  rollout"],
  },
  {
    id: "dev",
    name: "Dev",
    icon: "lucide-code-2",
    placeholder: "dev",
    preview: ["dev", "  design", "  implementation", "  review"],
  },
  {
    id: "rollout-repo",
    name: "Rollout repo",
    icon: "lucide-radio-tower",
    placeholder: "rollout",
    preview: [
      "rollout",
      "  repo",
      "    stage",
      "    canary",
      "    pilot",
      "    broad",
    ],
  },
  {
    id: "ring-flagged",
    name: "Flagged ring",
    icon: "lucide-flag",
    placeholder: "ring",
    preview: [
      "ring",
      "  await build rollout",
      "  enable feature flag",
      "  await feature flag rollout",
      "  verify",
    ],
  },
  {
    id: "ring-basic",
    name: "Basic ring",
    icon: "lucide-check-circle-2",
    placeholder: "ring",
    preview: ["ring", "  await build rollout", "  verify"],
  },
];

interface GraphNode {
  entry: BasesEntry;
  file: TFile;
  title: string;
  status: string | null;
  parentKey: string | null;
  parentValue: string | null;
  dependsOnKeys: string[];
  breaksToKeys: string[];
  restartsToKeys: string[];
  nodeType: string | null;
  workflow: string | null;
  collapsed: boolean;
  descendantCount: number;
  children: GraphNode[];
  successors: GraphNode[];
  predecessors: GraphNode[];
  breakTargets: GraphNode[];
  restartTargets: GraphNode[];
  x: number;
  y: number;
  savedX: number | null;
  savedY: number | null;
  state: GraphNodeState;
}

interface GraphEdge {
  from: GraphNode;
  to: GraphNode;
  kind: GraphFlowEdgeKind;
}

interface GraphHistoryFileChange {
  path: string;
  before: string | null;
  after: string | null;
}

interface GraphHistoryEntry {
  label: string;
  files: GraphHistoryFileChange[];
}

// A parsed transition event read back from a note's history array (Milestone 2:
// history read + projection). Compatible with both the graph-emitted events and
// the legacy kanban/rollout `{ from, to, at, property, source }` records.
interface GraphTransitionEvent {
  id: string | null;
  node: string | null;
  kind: string | null;
  from: string | null;
  to: string | null;
  at: Date | null;
  property: string | null;
  causedBy: string | null;
  source: string | null;
}

interface GraphViewportState {
  scrollLeft: number;
  scrollTop: number;
  zoom: number;
  centerX?: number;
  centerY?: number;
}

interface GraphWorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface GraphCanvasBounds {
  world: GraphWorldBounds;
  width: number;
  height: number;
}

const GRAPH_BUILD_VERSION = "2026.06.11.10";
const GRAPH_HISTORY_LIMIT = 50;
const GRAPH_STATUS_ACTIVE = "In Progress";
const GRAPH_STATUS_COMPLETED = "Completed";
const GRAPH_STATUS_PLANNED = "Planned";
const GRAPH_STATUS_FAILED = "Failed";
const GRAPH_STATUS_INVALIDATED = "Invalidated";
const GRAPH_STATUS_CANCELLED = "Cancelled";
const NODE_WIDTH = 220;
const NODE_MIN_HEIGHT = 92;
const X_STEP = 300;
const Y_STEP = 172;
const ROOT_GAP = 220;
const EDGE_MARGIN = 18;
const NODE_GAP_X = X_STEP - NODE_WIDTH;
const GRAPH_MIN_ZOOM = 0.35;
const GRAPH_MAX_ZOOM = 2.25;
const GRAPH_ZOOM_STEP = 0.0018;
const GRAPH_ZOOM_BUTTON_FACTOR = 1.2;
const GRAPH_PAN_THRESHOLD_PX = 4;
const GRAPH_PAN_MARGIN_X = 720;
const GRAPH_PAN_MARGIN_Y = 320;
const GRAPH_POSITION_PROPERTY_X = "graph_x";
const GRAPH_POSITION_PROPERTY_Y = "graph_y";
const GRAPH_COLLAPSED_PROPERTY = "graph_collapsed";
const CONFIG_KEY_GRAPH_VIEWPORT = "graphViewport";
const CONFIG_KEY_GRAPH_WORLD = "graphWorld";
const GRAPH_EDGE_HANDLE_RADIUS = 7;
const GRAPH_LINK_HANDLE_PROXIMITY_PX = 14;
const GRAPH_TEMPLATE_CHILD_Y_STEP = 150;
const GRAPH_TEMPLATE_CHILD_X_STEP = 260;
const GRAPH_WORLD_CONTENT_PADDING_X = 1600;
const GRAPH_WORLD_CONTENT_PADDING_Y = 1000;
const GRAPH_WORLD_MIN_WIDTH = 3200;
const GRAPH_WORLD_MIN_HEIGHT = 2200;
const GRAPH_WORLD_EDGE_THRESHOLD_X = 900;
const GRAPH_WORLD_EDGE_THRESHOLD_Y = 600;
const GRAPH_WORLD_EXPAND_CHUNK_X = 2200;
const GRAPH_WORLD_EXPAND_CHUNK_Y = 1600;
const GRAPH_WORLD_TEMPLATE_PADDING_X = 960;
const GRAPH_WORLD_TEMPLATE_PADDING_Y = 720;
const GRAPH_WORLD_SAFETY_LIMIT = 1_000_000;
const GRAPH_NODE_ANCHOR_SLOTS: GraphNodeAnchorSlot[] = [
  { side: "top", xRatio: 0.2, yRatio: 0 },
  { side: "top", xRatio: 0.4, yRatio: 0 },
  { side: "top", xRatio: 0.6, yRatio: 0 },
  { side: "top", xRatio: 0.8, yRatio: 0 },
  { side: "right", xRatio: 1, yRatio: 1 / 3 },
  { side: "right", xRatio: 1, yRatio: 2 / 3 },
  { side: "bottom", xRatio: 0.2, yRatio: 1 },
  { side: "bottom", xRatio: 0.4, yRatio: 1 },
  { side: "bottom", xRatio: 0.6, yRatio: 1 },
  { side: "bottom", xRatio: 0.8, yRatio: 1 },
  { side: "left", xRatio: 0, yRatio: 1 / 3 },
  { side: "left", xRatio: 0, yRatio: 2 / 3 },
];

export class GraphView extends BasesView {
  type = "graph";

  private plugin: BaseBoardPlugin;
  private scrollEl: HTMLElement;
  private containerEl: HTMLElement;
  private visibleNodes: GraphNode[] = [];
  private graphZoom = 1;
  private suppressNextNodeClick = false;
  private renderedGraphEdges: GraphEdge[] = [];
  private renderedGraphEdgeEls: SVGPathElement[] = [];
  private renderedGraphEdgeHitEls: SVGPathElement[] = [];
  private renderedGraphEdgeHandleEls: {
    from: SVGCircleElement;
    to: SVGCircleElement;
  }[] = [];
  private pendingGraphPositions = new Map<string, { x: number; y: number }>();
  private breakEscalationSourcePaths = new Set<string>();
  private graphParentByPath = new Map<string, GraphNode>();
  private graphHistoryActive = false;
  private graphHistoryLabel = "";
  private graphHistoryBefore = new Map<string, string | null>();
  private graphUndoStack: GraphHistoryEntry[] = [];
  private graphRedoStack: GraphHistoryEntry[] = [];
  private graphUndoButtonEl: HTMLButtonElement | null = null;
  private graphRedoButtonEl: HTMLButtonElement | null = null;
  private graphEndpointAnchorOverrides = new Map<
    string,
    GraphEndpointAnchorOverride
  >();
  private graphViewportState: GraphViewportState | null = null;
  private graphWorldBounds: GraphWorldBounds | null = null;
  private graphPanActive = false;
  private graphPanWorldPersistPending = false;
  private graphPanViewportPersistPending = false;
  private graphPanRenderPending = false;
  private graphViewportPersistTimer: ReturnType<typeof setTimeout> | null =
    null;

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    plugin: BaseBoardPlugin,
  ) {
    super(controller);
    this.plugin = plugin;
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({ cls: "base-board-graph" });
  }

  static getViewOptions(): never[] {
    return [];
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    // A full re-render empties containerEl and detaches the live viewport. If
    // that happens mid-pan, the in-flight pan gesture is orphaned (the camera
    // freezes or runs away while the button is still held). Defer the render
    // until the pan finishes, then replay it once.
    if (this.graphPanActive) {
      this.graphPanRenderPending = true;
      return;
    }
    this.render();
  }

  public render(): void {
    const previousViewportEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-viewport",
    );
    const previousWorldBounds = this.graphWorldBounds;
    const viewportState = previousViewportEl
      ? this.getGraphViewportState(previousViewportEl)
      : (this.graphViewportState ?? this.getSavedGraphViewportState());
    if (previousViewportEl) {
      this.graphViewportState = viewportState;
    }
    if (viewportState) {
      this.graphZoom = this.clampGraphZoom(viewportState.zoom);
    }

    this.containerEl.empty();
    const nodes = this.getGraphNodes();
    this.visibleNodes = nodes;
    if (nodes.length === 0) {
      this.renderPlaceholder("No graph nodes found for this view.");
      return;
    }

    const edges = this.layoutGraph(nodes);
    this.renderToolbar(nodes);
    const viewportEl = this.renderCanvas(nodes, edges);
    const restoredViewportState = this.getViewportStateForWorldChange(
      viewportState,
      previousWorldBounds,
      this.graphWorldBounds,
    );

    window.requestAnimationFrame(() => {
      if (restoredViewportState) {
        if (
          restoredViewportState.centerX !== undefined &&
          restoredViewportState.centerY !== undefined
        ) {
          this.scrollViewportToWorldPoint(
            viewportEl,
            {
              x: restoredViewportState.centerX,
              y: restoredViewportState.centerY,
            },
            viewportEl.clientWidth / 2,
            viewportEl.clientHeight / 2,
          );
        } else {
          viewportEl.scrollLeft = restoredViewportState.scrollLeft;
          viewportEl.scrollTop = restoredViewportState.scrollTop;
        }
      } else {
        this.centerGraphCameraOnNodes(viewportEl, nodes);
      }
      this.graphViewportState = this.getGraphViewportState(viewportEl);
    });
  }

  private renderPlaceholder(text: string): void {
    const placeholderEl = this.containerEl.createDiv({
      cls: "base-board-placeholder",
    });
    setIcon(
      placeholderEl.createSpan({ cls: "base-board-placeholder-icon" }),
      "lucide-git-fork",
    );
    placeholderEl.createEl("p", { text });
  }

  private renderToolbar(nodes: GraphNode[]): void {
    const activeCount = nodes.filter((node) => node.state === "active").length;
    const waitingCount = nodes.filter(
      (node) => node.state === "waiting",
    ).length;
    const completedCount = nodes.filter(
      (node) => node.state === "completed",
    ).length;

    const toolbarEl = this.containerEl.createDiv({
      cls: "base-board-graph-toolbar",
    });
    toolbarEl.createSpan({ cls: "base-board-graph-title", text: "Graph" });
    this.renderToolbarStat(toolbarEl, "Active", activeCount, "active");
    this.renderToolbarStat(toolbarEl, "Waiting", waitingCount, "waiting");
    this.renderToolbarStat(toolbarEl, "Completed", completedCount, "completed");
    this.renderGraphHistoryControls(toolbarEl);
    this.renderGraphZoomControls(toolbarEl);
    toolbarEl.createSpan({
      cls: "base-board-graph-version",
      text: `v${GRAPH_BUILD_VERSION}`,
    });
  }

  private renderGraphHistoryControls(toolbarEl: HTMLElement): void {
    const controlsEl = toolbarEl.createDiv({
      cls: "base-board-graph-zoom-controls base-board-graph-history-controls",
    });
    this.graphUndoButtonEl = this.renderGraphIconButton(
      controlsEl,
      "lucide-undo-2",
      "Undo",
      () => {
        void this.undoGraphHistory();
      },
    );
    this.graphRedoButtonEl = this.renderGraphIconButton(
      controlsEl,
      "lucide-redo-2",
      "Redo",
      () => {
        void this.redoGraphHistory();
      },
    );
    this.updateGraphHistoryButtons();
  }

  private renderGraphIconButton(
    controlsEl: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const buttonEl = controlsEl.createEl("button", {
      cls: "base-board-graph-zoom-button",
      attr: {
        type: "button",
        "aria-label": label,
      },
    });
    setIcon(buttonEl, icon);
    setTooltip(buttonEl, label);
    buttonEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return buttonEl;
  }

  private renderToolbarStat(
    toolbarEl: HTMLElement,
    label: string,
    count: number,
    state: GraphNodeState,
  ): void {
    const statEl = toolbarEl.createSpan({
      cls: `base-board-graph-stat base-board-graph-stat--${state}`,
    });
    statEl.createSpan({ cls: "base-board-graph-stat-label", text: label });
    statEl.createSpan({
      cls: "base-board-graph-stat-value",
      text: String(count),
    });
  }

  private renderGraphZoomControls(toolbarEl: HTMLElement): void {
    const controlsEl = toolbarEl.createDiv({
      cls: "base-board-graph-zoom-controls",
    });
    this.renderGraphZoomButton(
      controlsEl,
      "lucide-zoom-out",
      "Zoom out",
      () => {
        this.zoomGraphByFactor(1 / GRAPH_ZOOM_BUTTON_FACTOR);
      },
    );
    this.renderGraphZoomButton(controlsEl, "lucide-home", "Zoom home", () => {
      this.resetGraphCamera();
    });
    this.renderGraphZoomButton(controlsEl, "lucide-zoom-in", "Zoom in", () => {
      this.zoomGraphByFactor(GRAPH_ZOOM_BUTTON_FACTOR);
    });
  }

  private renderGraphZoomButton(
    controlsEl: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): void {
    const buttonEl = controlsEl.createEl("button", {
      cls: "base-board-graph-zoom-button",
      attr: {
        type: "button",
        "aria-label": label,
      },
    });
    setIcon(buttonEl, icon);
    setTooltip(buttonEl, label);
    buttonEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private renderCanvas(nodes: GraphNode[], edges: GraphEdge[]): HTMLElement {
    const bounds = this.getGraphBounds(nodes);
    this.graphWorldBounds = bounds.world;
    const viewportEl = this.containerEl.createDiv({
      cls: "base-board-graph-viewport",
    });
    viewportEl.addEventListener("scroll", () => {
      this.graphViewportState = this.getGraphViewportState(viewportEl);
    });
    viewportEl.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        this.zoomGraph(event, viewportEl, zoomContentEl, canvasEl);
      },
      { passive: false },
    );
    viewportEl.addEventListener("pointerdown", (event: PointerEvent) => {
      this.startGraphPan(event, viewportEl);
    });

    const zoomContentEl = viewportEl.createDiv({
      cls: "base-board-graph-zoom-content",
    });
    const canvasEl = zoomContentEl.createDiv({
      cls: "base-board-graph-canvas",
    });
    canvasEl.style.width = `${bounds.width}px`;
    canvasEl.style.height = `${bounds.height}px`;
    this.applyGraphZoom(zoomContentEl, canvasEl, bounds);
    canvasEl.addEventListener("contextmenu", (event: MouseEvent) => {
      this.showCanvasCreateMenu(event, canvasEl);
    });

    const svgEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgEl.addClass("base-board-graph-edges");
    svgEl.setAttribute("width", String(bounds.width));
    svgEl.setAttribute("height", String(bounds.height));
    svgEl.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    canvasEl.appendChild(svgEl);
    this.renderEdgeMarkers(svgEl);
    this.renderEdges(svgEl, edges);

    const nodesEl = canvasEl.createDiv({ cls: "base-board-graph-nodes" });
    for (const node of nodes) {
      this.renderNode(nodesEl, node);
    }

    window.requestAnimationFrame(() => {
      this.syncRenderedGraphEdges();
    });

    return viewportEl;
  }

  private renderEdgeMarkers(svgEl: SVGSVGElement): void {
    const defsEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "defs",
    );
    for (const kind of [
      "requirement-start",
      "requirement-return",
      "requirement-return-dormant",
      "gating",
      "break",
      "break-dormant",
      "restart",
    ] as const) {
      const markerEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "marker",
      );
      markerEl.setAttribute("id", `base-board-graph-arrow-${kind}`);
      markerEl.setAttribute("markerWidth", "8");
      markerEl.setAttribute("markerHeight", "8");
      markerEl.setAttribute("refX", "7");
      markerEl.setAttribute("refY", "5");
      markerEl.setAttribute("orient", "auto");
      markerEl.setAttribute("markerUnits", "strokeWidth");
      markerEl.addClass(`base-board-graph-arrow-marker--${kind}`);

      const arrowEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      arrowEl.setAttribute("d", "M 1 2 L 8 5 L 1 8 z");
      markerEl.appendChild(arrowEl);
      defsEl.appendChild(markerEl);
    }
    svgEl.appendChild(defsEl);
  }

  private renderEdges(svgEl: SVGSVGElement, edges: GraphEdge[]): void {
    this.renderedGraphEdges = edges;
    this.renderedGraphEdgeEls = [];
    this.renderedGraphEdgeHitEls = [];
    this.renderedGraphEdgeHandleEls = [];
    this.recomputeBreakEscalation();
    for (const edge of edges) {
      const pathEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      pathEl.addClass("base-board-graph-edge");
      pathEl.addClass(`base-board-graph-edge--${edge.kind}`);
      const markerKind = this.getEdgeMarkerKind(edge);
      if (markerKind !== edge.kind) {
        pathEl.addClass(`base-board-graph-edge--${markerKind}`);
      }
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("d", this.getEdgePath(edge));
      pathEl.setAttribute(
        "marker-end",
        `url(#base-board-graph-arrow-${markerKind})`,
      );
      svgEl.appendChild(pathEl);
      this.renderedGraphEdgeEls.push(pathEl);

      const hitTargetEl = this.renderEdgeHitTarget(svgEl, edge);
      this.renderedGraphEdgeHitEls.push(hitTargetEl);

      const fromHandleEl = this.renderEdgeEndpointHandle(svgEl, edge, "from");
      const toHandleEl = this.renderEdgeEndpointHandle(svgEl, edge, "to");
      this.renderedGraphEdgeHandleEls.push({
        from: fromHandleEl,
        to: toHandleEl,
      });
      this.bindEdgeHoverInteractions(pathEl, hitTargetEl, [
        fromHandleEl,
        toHandleEl,
      ]);
    }
  }

  private renderEdgeHitTarget(
    svgEl: SVGSVGElement,
    edge: GraphEdge,
  ): SVGPathElement {
    const hitTargetEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    hitTargetEl.addClass("base-board-graph-edge-hit-target");
    hitTargetEl.setAttribute("fill", "none");
    hitTargetEl.setAttribute("d", this.getEdgePath(edge));

    const titleEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    titleEl.textContent = "Right-click to delete line";
    hitTargetEl.appendChild(titleEl);

    hitTargetEl.addEventListener("contextmenu", (event: MouseEvent) => {
      this.showGraphEdgeMenu(event, edge);
    });
    svgEl.appendChild(hitTargetEl);
    return hitTargetEl;
  }

  private bindEdgeHoverInteractions(
    pathEl: SVGPathElement,
    hitTargetEl: SVGPathElement,
    handleEls: SVGCircleElement[],
  ): void {
    hitTargetEl.addEventListener("mouseenter", () => {
      pathEl.addClass("base-board-graph-edge--hovered");
      for (const handleEl of handleEls) {
        handleEl.addClass("base-board-graph-edge-handle--edge-hovered");
      }
    });
    hitTargetEl.addEventListener("mouseleave", () => {
      pathEl.removeClass("base-board-graph-edge--hovered");
      for (const handleEl of handleEls) {
        handleEl.removeClass("base-board-graph-edge-handle--edge-hovered");
      }
    });
  }

  private renderEdgeEndpointHandle(
    svgEl: SVGSVGElement,
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): SVGCircleElement {
    const handleEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    handleEl.addClass("base-board-graph-edge-handle");
    handleEl.addClass(`base-board-graph-edge-handle--${endpoint}`);
    handleEl.setAttribute("r", String(GRAPH_EDGE_HANDLE_RADIUS));
    this.positionEdgeEndpointHandle(handleEl, edge, endpoint);

    const titleEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    titleEl.textContent =
      endpoint === "from" ? "Drag line exit" : "Drag line entry";
    handleEl.appendChild(titleEl);

    handleEl.addEventListener("mousedown", (event: MouseEvent) => {
      this.startEdgeEndpointDrag(event, edge, endpoint, svgEl, handleEl);
    });
    handleEl.addEventListener("contextmenu", (event: MouseEvent) => {
      this.showGraphEdgeMenu(event, edge);
    });
    svgEl.appendChild(handleEl);
    return handleEl;
  }

  private positionEdgeEndpointHandle(
    handleEl: SVGCircleElement,
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): void {
    const anchor = this.getEdgeEndpointAnchor(edge, endpoint);
    handleEl.setAttribute("cx", String(anchor.x));
    handleEl.setAttribute("cy", String(anchor.y));
  }

  private startEdgeEndpointDrag(
    event: MouseEvent,
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    svgEl: SVGSVGElement,
    handleEl: SVGCircleElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const edgeIndex = this.renderedGraphEdges.indexOf(edge);
    const pathEl = this.renderedGraphEdgeEls[edgeIndex];
    if (!pathEl) return;

    const originalPath = pathEl.getAttribute("d") ?? this.getEdgePath(edge);
    let didDrag = false;
    let dropNode: GraphNode | null = null;
    let dropNodeEl: HTMLElement | null = null;
    let dropHandleTarget: {
      edge: GraphEdge;
      endpoint: GraphEdgeEndpoint;
      handleEl: SVGCircleElement;
    } | null = null;
    const startClientX = event.clientX;
    const startClientY = event.clientY;

    this.containerEl.addClass("base-board-graph--edge-rewiring");
    pathEl.addClass("base-board-graph-edge--rewiring");
    handleEl.addClass("base-board-graph-edge-handle--dragging");

    const clearDropTarget = () => {
      dropNodeEl?.removeClass("base-board-graph-node--edge-drop-target");
      dropHandleTarget?.handleEl.removeClass(
        "base-board-graph-edge-handle--drop-target",
      );
      dropNodeEl = null;
      dropNode = null;
      dropHandleTarget = null;
    };

    const moveHandler = (moveEvent: MouseEvent) => {
      const deltaClientX = moveEvent.clientX - startClientX;
      const deltaClientY = moveEvent.clientY - startClientY;
      if (
        !didDrag &&
        Math.hypot(deltaClientX, deltaClientY) >= GRAPH_PAN_THRESHOLD_PX
      ) {
        didDrag = true;
      }
      if (!didDrag) return;

      moveEvent.preventDefault();
      const graphPoint = this.getGraphPointFromMouseEvent(moveEvent, svgEl);
      pathEl.setAttribute(
        "d",
        this.getFloatingEdgePath(edge, endpoint, graphPoint),
      );
      handleEl.setAttribute("cx", String(graphPoint.x));
      handleEl.setAttribute("cy", String(graphPoint.y));

      const nextDropHandleTarget = this.getValidEdgeEndpointDropHandle(
        edge,
        endpoint,
        handleEl,
        moveEvent.clientX,
        moveEvent.clientY,
      );
      if (
        nextDropHandleTarget &&
        dropHandleTarget &&
        nextDropHandleTarget.handleEl === dropHandleTarget.handleEl &&
        nextDropHandleTarget.endpoint === dropHandleTarget.endpoint
      ) {
        return;
      }

      clearDropTarget();
      if (nextDropHandleTarget) {
        dropHandleTarget = nextDropHandleTarget;
        dropHandleTarget.handleEl.addClass(
          "base-board-graph-edge-handle--drop-target",
        );
        return;
      }

      const nextDropNode = this.getValidEdgeEndpointDropNode(
        edge,
        endpoint,
        this.getGraphNodeFromPoint(moveEvent.clientX, moveEvent.clientY),
      );
      if (nextDropNode?.file.path === dropNode?.file.path) return;
      if (!nextDropNode) return;
      const nextDropNodeEl = this.getRenderedGraphNodeEl(nextDropNode);
      if (!nextDropNodeEl) return;
      dropNode = nextDropNode;
      dropNodeEl = nextDropNodeEl;
      dropNodeEl.addClass("base-board-graph-node--edge-drop-target");
    };

    const upHandler = (upEvent: MouseEvent) => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      this.containerEl.removeClass("base-board-graph--edge-rewiring");
      pathEl.removeClass("base-board-graph-edge--rewiring");
      handleEl.removeClass("base-board-graph-edge-handle--dragging");
      const targetNode = dropNode;
      const targetHandle = dropHandleTarget;
      clearDropTarget();

      if (!didDrag || (!targetNode && !targetHandle)) {
        pathEl.setAttribute("d", originalPath);
        this.syncRenderedGraphEdges();
        return;
      }

      upEvent.preventDefault();
      this.suppressNextNodeClick = true;
      window.setTimeout(() => {
        this.suppressNextNodeClick = false;
      }, 0);
      if (targetHandle) {
        this.swapGraphEndpointAnchors(
          edge,
          endpoint,
          targetHandle.edge,
          targetHandle.endpoint,
        );
        return;
      }

      if (targetNode) {
        void this.reassignGraphEdgeEndpoint(edge, endpoint, targetNode);
      }
    };

    activeWindow.addEventListener("mousemove", moveHandler);
    activeWindow.addEventListener("mouseup", upHandler);
  }

  private applyGraphZoom(
    zoomContentEl: HTMLElement,
    canvasEl: HTMLElement,
    bounds: { width: number; height: number },
  ): void {
    const viewportEl = zoomContentEl.parentElement?.instanceOf(HTMLElement)
      ? zoomContentEl.parentElement
      : null;
    const panMarginX = this.getGraphPanMarginX(viewportEl);
    const panMarginY = this.getGraphPanMarginY(viewportEl);
    zoomContentEl.style.width = `${
      panMarginX * 2 + bounds.width * this.graphZoom
    }px`;
    zoomContentEl.style.height = `${
      panMarginY * 2 + bounds.height * this.graphZoom
    }px`;
    canvasEl.style.left = `${panMarginX}px`;
    canvasEl.style.top = `${panMarginY}px`;
    canvasEl.style.transform = `scale(${this.graphZoom})`;
  }

  private zoomGraph(
    event: WheelEvent,
    viewportEl: HTMLElement,
    zoomContentEl: HTMLElement,
    canvasEl: HTMLElement,
  ): void {
    event.preventDefault();
    const previousZoom = this.graphZoom;
    const nextZoom = this.clampGraphZoom(
      previousZoom * Math.exp(-event.deltaY * GRAPH_ZOOM_STEP),
    );
    if (Math.abs(nextZoom - previousZoom) < 0.001) return;

    const rect = viewportEl.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const focusPoint = this.getViewportWorldPoint(
      viewportEl,
      pointerX,
      pointerY,
      previousZoom,
    );

    this.graphZoom = nextZoom;
    this.applyGraphZoom(
      zoomContentEl,
      canvasEl,
      this.getCurrentGraphCanvasBounds(),
    );
    this.scrollViewportToWorldPoint(viewportEl, focusPoint, pointerX, pointerY);
    this.graphViewportState = this.getGraphViewportState(viewportEl);
    this.schedulePersistGraphViewportState();
  }

  private zoomGraphByFactor(factor: number): void {
    const viewportEl = this.getGraphViewportEl();
    const zoomContentEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-zoom-content",
    );
    const canvasEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-canvas",
    );
    const world = this.graphWorldBounds;
    if (!viewportEl || !zoomContentEl || !canvasEl || !world) return;

    const previousZoom = this.graphZoom;
    const nextZoom = this.clampGraphZoom(previousZoom * factor);
    if (Math.abs(nextZoom - previousZoom) < 0.001) return;

    const focusX = viewportEl.clientWidth / 2;
    const focusY = viewportEl.clientHeight / 2;
    const focusPoint = this.getViewportWorldPoint(
      viewportEl,
      focusX,
      focusY,
      previousZoom,
    );

    this.graphZoom = nextZoom;
    this.applyGraphZoom(
      zoomContentEl,
      canvasEl,
      this.getCurrentGraphCanvasBounds(),
    );
    this.scrollViewportToWorldPoint(viewportEl, focusPoint, focusX, focusY);
    this.graphViewportState = this.getGraphViewportState(viewportEl);
    this.schedulePersistGraphViewportState();
  }

  private resetGraphCamera(): void {
    const viewportEl = this.getGraphViewportEl();
    const zoomContentEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-zoom-content",
    );
    const canvasEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-canvas",
    );
    const world = this.graphWorldBounds;
    if (!viewportEl || !zoomContentEl || !canvasEl || !world) return;

    this.graphZoom = 1;
    this.applyGraphZoom(
      zoomContentEl,
      canvasEl,
      this.getCurrentGraphCanvasBounds(),
    );
    this.centerGraphCameraOnNodes(viewportEl, this.visibleNodes);
    this.graphViewportState = this.getGraphViewportState(viewportEl);
    this.persistGraphViewportState(this.graphViewportState);
  }

  private centerGraphCameraOnNodes(
    viewportEl: HTMLElement,
    nodes: GraphNode[],
  ): void {
    const bounds = this.getRenderedNodesCanvasBounds(nodes);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    viewportEl.scrollLeft = Math.max(
      0,
      this.getGraphPanMarginX(viewportEl) +
        centerX * this.graphZoom -
        viewportEl.clientWidth / 2,
    );
    viewportEl.scrollTop = Math.max(
      0,
      this.getGraphPanMarginY(viewportEl) +
        centerY * this.graphZoom -
        viewportEl.clientHeight / 2,
    );
  }

  private getRenderedNodesCanvasBounds(nodes: GraphNode[]): GraphWorldBounds {
    if (nodes.length === 0) {
      const world = this.graphWorldBounds;
      if (!world) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      }
      return {
        minX: 0,
        minY: 0,
        maxX: world.maxX - world.minX,
        maxY: world.maxY - world.minY,
      };
    }

    return {
      minX: Math.min(
        ...nodes.map((node) => this.getNodeCanvasPosition(node).x),
      ),
      minY: Math.min(
        ...nodes.map((node) => this.getNodeCanvasPosition(node).y),
      ),
      maxX: Math.max(
        ...nodes.map((node) => {
          const position = this.getNodeCanvasPosition(node);
          return position.x + this.getRenderedGraphNodeSize(node).width;
        }),
      ),
      maxY: Math.max(
        ...nodes.map((node) => {
          const position = this.getNodeCanvasPosition(node);
          return position.y + this.getRenderedGraphNodeSize(node).height;
        }),
      ),
    };
  }

  private clampGraphZoom(zoom: number): number {
    return Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, zoom));
  }

  private getGraphViewportState(viewportEl: HTMLElement): GraphViewportState {
    const center = this.getViewportWorldPoint(
      viewportEl,
      viewportEl.clientWidth / 2,
      viewportEl.clientHeight / 2,
    );
    return {
      scrollLeft: Math.max(0, viewportEl.scrollLeft),
      scrollTop: Math.max(0, viewportEl.scrollTop),
      zoom: this.graphZoom,
      centerX: center.x,
      centerY: center.y,
    };
  }

  private getSavedGraphViewportState(): GraphViewportState | null {
    const raw = this.config?.get(CONFIG_KEY_GRAPH_VIEWPORT);
    if (!raw || typeof raw !== "object") return null;
    const state = raw as Partial<GraphViewportState>;
    if (
      typeof state.scrollLeft !== "number" ||
      typeof state.scrollTop !== "number" ||
      typeof state.zoom !== "number" ||
      !Number.isFinite(state.scrollLeft) ||
      !Number.isFinite(state.scrollTop) ||
      !Number.isFinite(state.zoom)
    ) {
      return null;
    }
    return {
      scrollLeft: Math.max(0, state.scrollLeft),
      scrollTop: Math.max(0, state.scrollTop),
      zoom: this.clampGraphZoom(state.zoom),
      ...(typeof state.centerX === "number" &&
      typeof state.centerY === "number" &&
      Number.isFinite(state.centerX) &&
      Number.isFinite(state.centerY)
        ? { centerX: state.centerX, centerY: state.centerY }
        : {}),
    };
  }

  private persistGraphViewportState(state: GraphViewportState | null): void {
    if (!state) return;
    this.graphViewportState = state;
    // Persisting viewport state calls config.set, which can trigger a full
    // re-render (onDataUpdated) and detach the live viewport. During an active
    // pan that would orphan the pan handler mid-gesture (the camera freezes
    // while the button is still held), so defer the write until the pan ends.
    // finishPan re-invokes this after clearing graphPanActive to flush it.
    if (this.graphPanActive) {
      this.graphPanViewportPersistPending = true;
      return;
    }
    this.config?.set(CONFIG_KEY_GRAPH_VIEWPORT, {
      scrollLeft: Math.round(state.scrollLeft),
      scrollTop: Math.round(state.scrollTop),
      zoom: state.zoom,
      ...(state.centerX !== undefined && state.centerY !== undefined
        ? {
            centerX: Math.round(state.centerX),
            centerY: Math.round(state.centerY),
          }
        : {}),
    });
  }

  private schedulePersistGraphViewportState(): void {
    if (this.graphViewportPersistTimer) {
      window.clearTimeout(this.graphViewportPersistTimer);
    }
    this.graphViewportPersistTimer = window.setTimeout(() => {
      this.persistGraphViewportState(this.graphViewportState);
      this.graphViewportPersistTimer = null;
    }, 400);
  }

  private startGraphPan(event: PointerEvent, viewportEl: HTMLElement): void {
    if (event.button !== 0) return;
    const targetEl = event.target instanceof Element ? event.target : null;
    if (
      targetEl?.closest(
        ".base-board-graph-node, .base-board-graph-link-handle, .base-board-graph-edge-handle, button, input, textarea, select",
      )
    ) {
      return;
    }

    event.preventDefault();
    try {
      viewportEl.setPointerCapture(event.pointerId);
    } catch {
      // Window-level capture listeners below keep panning alive if pointer
      // capture is unavailable or lost.
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let lastClientX = startX;
    let lastClientY = startY;
    let didPan = false;
    let isFinished = false;

    const moveByClientPoint = (
      clientX: number,
      clientY: number,
      moveEvent: Event,
    ) => {
      // If a re-render detached the viewport mid-pan, its clientWidth collapses
      // to 0 and world expansion would run away. End the pan cleanly instead.
      if (!viewportEl.isConnected) {
        finishPan();
        return;
      }
      const deltaX = clientX - startX;
      const deltaY = clientY - startY;
      if (!didPan && Math.hypot(deltaX, deltaY) >= GRAPH_PAN_THRESHOLD_PX) {
        didPan = true;
        this.graphPanActive = true;
        viewportEl.addClass("base-board-graph-viewport--panning");
      }
      if (!didPan) return;
      moveEvent.preventDefault();
      viewportEl.scrollLeft -= clientX - lastClientX;
      viewportEl.scrollTop -= clientY - lastClientY;
      lastClientX = clientX;
      lastClientY = clientY;
      this.expandGraphWorldForViewport(viewportEl);
    };

    const pointerMoveHandler = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      moveByClientPoint(moveEvent.clientX, moveEvent.clientY, moveEvent);
    };

    const mouseMoveHandler = (moveEvent: MouseEvent) => {
      moveByClientPoint(moveEvent.clientX, moveEvent.clientY, moveEvent);
    };

    const finishPan = () => {
      if (isFinished) return;
      isFinished = true;
      viewportEl.removeEventListener("pointermove", pointerMoveHandler);
      viewportEl.removeEventListener("pointerup", pointerUpHandler);
      viewportEl.removeEventListener("pointercancel", pointerCancelHandler);
      viewportEl.removeEventListener("lostpointercapture", lostCaptureHandler);
      activeWindow.removeEventListener("pointermove", pointerMoveHandler, true);
      activeWindow.removeEventListener("pointerup", pointerUpHandler, true);
      activeWindow.removeEventListener(
        "pointercancel",
        pointerCancelHandler,
        true,
      );
      activeWindow.removeEventListener("mousemove", mouseMoveHandler, true);
      activeWindow.removeEventListener("mouseup", mouseUpHandler, true);

      if (viewportEl.hasPointerCapture(event.pointerId)) {
        viewportEl.releasePointerCapture(event.pointerId);
      }

      viewportEl.removeClass("base-board-graph-viewport--panning");
      this.graphPanActive = false;
      if (didPan) {
        this.suppressNextNodeClick = true;
        window.setTimeout(() => {
          this.suppressNextNodeClick = false;
        }, 0);
        if (this.graphPanWorldPersistPending && this.graphWorldBounds) {
          this.graphPanWorldPersistPending = false;
          this.persistGraphWorldBounds(this.graphWorldBounds);
        }
        if (viewportEl.isConnected) {
          this.persistGraphViewportState(
            this.getGraphViewportState(viewportEl),
          );
        }
      }
      this.graphPanWorldPersistPending = false;
      this.graphPanViewportPersistPending = false;
      if (this.graphPanRenderPending) {
        this.graphPanRenderPending = false;
        this.render();
      }
    };

    const pointerUpHandler = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      finishPan();
    };

    const mouseUpHandler = () => {
      finishPan();
    };

    const pointerCancelHandler = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      // Do not finish here: Chromium can emit pointercancel/lost-capture while
      // the mouse button is still physically down. Mouse/pointer up is the
      // authoritative end signal for graph panning.
    };

    const lostCaptureHandler = (lostEvent: PointerEvent) => {
      if (lostEvent.pointerId !== event.pointerId) return;
      // Window-level mousemove/mouseup listeners keep the pan alive after
      // capture loss, so do not treat this as a completed pan.
    };

    viewportEl.addEventListener("pointermove", pointerMoveHandler);
    viewportEl.addEventListener("pointerup", pointerUpHandler);
    viewportEl.addEventListener("pointercancel", pointerCancelHandler);
    viewportEl.addEventListener("lostpointercapture", lostCaptureHandler);
    activeWindow.addEventListener("pointermove", pointerMoveHandler, true);
    activeWindow.addEventListener("pointerup", pointerUpHandler, true);
    activeWindow.addEventListener("pointercancel", pointerCancelHandler, true);
    activeWindow.addEventListener("mousemove", mouseMoveHandler, true);
    activeWindow.addEventListener("mouseup", mouseUpHandler, true);
  }

  private renderNode(parentEl: HTMLElement, node: GraphNode): void {
    const nodeEl = parentEl.createDiv({
      cls: `base-board-graph-node base-board-graph-node--${node.state}`,
    });
    this.positionRenderedGraphNodeEl(nodeEl, node);
    nodeEl.style.setProperty(
      "--graph-node-color",
      getColumnColor(this.config, node.status),
    );
    nodeEl.dataset.filePath = node.file.path;
    nodeEl.setAttr("role", "button");
    nodeEl.setAttr("tabindex", "0");
    setTooltip(nodeEl, this.getNodeTooltip(node));

    const stateEl = nodeEl.createSpan({
      cls: `base-board-graph-node-state base-board-graph-node-state--${node.state}`,
    });
    setIcon(stateEl, this.getStateIcon(node.state));

    if (node.descendantCount > 0) {
      const collapseBtn = nodeEl.createEl("button", {
        cls: "base-board-graph-collapse",
        attr: {
          type: "button",
          title: node.collapsed ? "Expand workflow" : "Collapse workflow",
        },
      });
      setIcon(
        collapseBtn,
        node.collapsed ? "lucide-chevrons-down" : "lucide-chevrons-up",
      );
      collapseBtn.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void this.toggleGraphCollapse(node);
      });
    }

    const titleEl = nodeEl.createDiv({
      cls: "base-board-graph-node-title",
      text: node.title,
    });
    titleEl.setAttr("title", node.title);

    const metaEl = nodeEl.createDiv({ cls: "base-board-graph-node-meta" });
    metaEl.createSpan({
      cls: "base-board-graph-node-status",
      text: node.status ?? "(No value)",
    });
    if (node.nodeType) {
      metaEl.createSpan({
        cls: "base-board-graph-node-deps",
        text: node.workflow ?? node.nodeType,
      });
    }
    if (node.dependsOnKeys.length > 0) {
      metaEl.createSpan({
        cls: "base-board-graph-node-deps",
        text: `${node.predecessors.length}/${node.dependsOnKeys.length} deps`,
      });
    }
    if (node.collapsed && node.descendantCount > 0) {
      metaEl.createSpan({
        cls: "base-board-graph-node-deps",
        text: `${node.descendantCount} hidden`,
      });
    }

    const linkHandleEl = nodeEl.createDiv({
      cls: "base-board-graph-link-handle",
    });
    linkHandleEl.dataset.side = "right";
    window.requestAnimationFrame(() => {
      this.snapNodeLinkHandleToSlot(nodeEl, linkHandleEl, {
        side: "right",
        xRatio: 1,
        yRatio: 0.5,
      });
    });
    setTooltip(linkHandleEl, "Drag to create a link");
    nodeEl.addEventListener("mousemove", (event: MouseEvent) => {
      this.positionNodeLinkHandle(event, nodeEl, linkHandleEl);
    });
    nodeEl.addEventListener("mouseleave", () => {
      linkHandleEl.removeClass("base-board-graph-link-handle--visible");
    });
    linkHandleEl.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.startNodeLinkDrag(event, node, linkHandleEl);
    });

    nodeEl.addEventListener("click", (event: MouseEvent) => {
      if (this.suppressNextNodeClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      new CardDetailModal(this.app, node.file).open();
    });
    nodeEl.addEventListener("mousedown", (event: MouseEvent) => {
      this.startNodeDrag(event, node);
    });
    nodeEl.addEventListener("contextmenu", (event: MouseEvent) => {
      this.showNodeContextMenu(event, node);
    });
    nodeEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      new CardDetailModal(this.app, node.file).open();
    });
  }

  private startNodeDrag(event: MouseEvent, node: GraphNode): void {
    if (event.button !== 0) return;
    const targetEl = event.target instanceof HTMLElement ? event.target : null;
    if (
      targetEl?.closest(
        ".base-board-graph-link-handle, button, input, textarea, select",
      )
    )
      return;

    event.preventDefault();
    event.stopPropagation();

    const isSingleNodeDrag = event.ctrlKey || event.metaKey;
    const movedNodes = isSingleNodeDrag
      ? [node]
      : this.getMovableSubgraph(node);
    const movedPaths = new Set(
      movedNodes.map((movedNode) => movedNode.file.path),
    );
    const movedNodeEls = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>(".base-board-graph-node"),
    ).filter((nodeEl) => movedPaths.has(nodeEl.dataset.filePath ?? ""));
    const viewportEl = this.getGraphViewportEl();
    const originalPositions = new Map(
      movedNodes.map((movedNode) => [
        movedNode.file.path,
        { x: movedNode.x, y: movedNode.y },
      ]),
    );
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let didDrag = false;

    movedNodeEls.forEach((nodeEl) =>
      nodeEl.addClass("base-board-graph-node--dragging"),
    );
    if (isSingleNodeDrag) {
      movedNodeEls.forEach((nodeEl) =>
        nodeEl.addClass("base-board-graph-node--single-dragging"),
      );
    }

    const moveHandler = (moveEvent: MouseEvent) => {
      const deltaClientX = moveEvent.clientX - startClientX;
      const deltaClientY = moveEvent.clientY - startClientY;
      if (
        !didDrag &&
        Math.hypot(deltaClientX, deltaClientY) >= GRAPH_PAN_THRESHOLD_PX
      ) {
        didDrag = true;
      }
      if (!didDrag) return;

      moveEvent.preventDefault();
      const deltaX = deltaClientX / this.graphZoom;
      const deltaY = deltaClientY / this.graphZoom;
      const adjustedDelta = this.getClampedDragDelta(
        movedNodes,
        originalPositions,
        deltaX,
        deltaY,
      );

      for (const movedNode of movedNodes) {
        const original = originalPositions.get(movedNode.file.path);
        if (!original) continue;
        movedNode.x = original.x + adjustedDelta.x;
        movedNode.y = original.y + adjustedDelta.y;
      }

      for (const nodeEl of movedNodeEls) {
        const movedNode = movedNodes.find(
          (candidate) => candidate.file.path === nodeEl.dataset.filePath,
        );
        if (!movedNode) continue;
        this.positionRenderedGraphNodeEl(nodeEl, movedNode);
      }
      this.expandGraphWorldForRect(
        this.getNodesWorldBounds(movedNodes),
        viewportEl,
      );
      this.syncRenderedGraphEdges();
    };

    const upHandler = () => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      movedNodeEls.forEach((nodeEl) =>
        nodeEl.removeClass("base-board-graph-node--dragging"),
      );
      movedNodeEls.forEach((nodeEl) =>
        nodeEl.removeClass("base-board-graph-node--single-dragging"),
      );
      if (!didDrag) return;

      this.suppressNextNodeClick = true;
      window.setTimeout(() => {
        this.suppressNextNodeClick = false;
      }, 0);
      void this.persistGraphNodePositions(movedNodes);
    };

    activeWindow.addEventListener("mousemove", moveHandler);
    activeWindow.addEventListener("mouseup", upHandler);
  }

  private positionNodeLinkHandle(
    event: MouseEvent,
    nodeEl: HTMLElement,
    handleEl: HTMLElement,
  ): void {
    const slot = this.getNearestNodeAnchorSlot(event, nodeEl, true);
    if (!slot) {
      handleEl.removeClass("base-board-graph-link-handle--visible");
      return;
    }
    this.snapNodeLinkHandleToSlot(nodeEl, handleEl, slot);
    handleEl.addClass("base-board-graph-link-handle--visible");
  }

  private getNearestNodeAnchorSlot(
    event: MouseEvent,
    nodeEl: HTMLElement,
    requireBorderProximity: boolean,
  ): GraphNodeAnchorSlot | null {
    const rect = nodeEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const borderDistance = Math.min(x, rect.width - x, y, rect.height - y);
    if (
      requireBorderProximity &&
      borderDistance > GRAPH_LINK_HANDLE_PROXIMITY_PX
    ) {
      return null;
    }

    return GRAPH_NODE_ANCHOR_SLOTS.reduce((nearestSlot, candidateSlot) =>
      this.getNodeAnchorSlotDistance(candidateSlot, rect, x, y) <
      this.getNodeAnchorSlotDistance(nearestSlot, rect, x, y)
        ? candidateSlot
        : nearestSlot,
    );
  }

  private getNodeAnchorSlotDistance(
    slot: GraphNodeAnchorSlot,
    rect: DOMRect,
    x: number,
    y: number,
  ): number {
    const anchorX = rect.width * slot.xRatio;
    const anchorY = rect.height * slot.yRatio;
    return Math.hypot(anchorX - x, anchorY - y);
  }

  private snapNodeLinkHandleToSlot(
    nodeEl: HTMLElement,
    handleEl: HTMLElement,
    slot: GraphNodeAnchorSlot,
  ): void {
    const width = nodeEl.offsetWidth;
    const height = nodeEl.offsetHeight;
    const halfSize = handleEl.offsetWidth / 2;
    const style = activeWindow.getComputedStyle(nodeEl);
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    handleEl.dataset.side = slot.side;
    handleEl.dataset.xRatio = String(slot.xRatio);
    handleEl.dataset.yRatio = String(slot.yRatio);
    handleEl.style.left = `${width * slot.xRatio - borderLeft - halfSize}px`;
    handleEl.style.top = `${height * slot.yRatio - borderTop - halfSize}px`;
  }

  private startNodeLinkDrag(
    event: MouseEvent,
    sourceNode: GraphNode,
    handleEl: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    const svgEl = this.containerEl.querySelector<SVGSVGElement>(
      ".base-board-graph-edges",
    );
    if (!svgEl) return;

    const sourceSlot = this.getNodeAnchorSlotFromHandle(handleEl);
    const sourceNodeEl = this.getRenderedGraphNodeEl(sourceNode);
    if (sourceNodeEl) {
      this.snapNodeLinkHandleToSlot(sourceNodeEl, handleEl, sourceSlot);
    }
    const start = this.getGraphPointFromElementCenter(
      handleEl,
      svgEl,
      sourceSlot.side,
    );
    handleEl.addClass("base-board-graph-link-handle--dragging");
    handleEl.addClass("base-board-graph-link-handle--visible");
    const previewEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    previewEl.addClass("base-board-graph-edge");
    previewEl.addClass("base-board-graph-edge--gating");
    previewEl.addClass("base-board-graph-edge--rewiring");
    previewEl.addClass("base-board-graph-edge--link-preview");
    previewEl.setAttribute("fill", "none");
    previewEl.setAttribute("marker-end", "url(#base-board-graph-arrow-gating)");
    svgEl.appendChild(previewEl);

    let dropNode: GraphNode | null = null;
    let dropNodeEl: HTMLElement | null = null;
    let dropSlot: GraphNodeAnchorSlot | null = null;
    let dropHandleEl: HTMLElement | null = null;

    const clearDropTarget = () => {
      dropNodeEl?.removeClass("base-board-graph-node--edge-drop-target");
      dropHandleEl?.removeClass("base-board-graph-link-handle--drop-target");
      dropHandleEl?.removeClass("base-board-graph-link-handle--visible");
      dropNodeEl = null;
      dropNode = null;
      dropSlot = null;
      dropHandleEl = null;
    };

    const moveHandler = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const candidate = this.getGraphNodeFromPoint(
        moveEvent.clientX,
        moveEvent.clientY,
      );
      const nextDropNode =
        candidate && candidate.file.path !== sourceNode.file.path
          ? candidate
          : null;
      const nextDropNodeEl = nextDropNode
        ? this.getRenderedGraphNodeEl(nextDropNode)
        : null;
      const nextDropSlot = nextDropNodeEl
        ? this.getNearestNodeAnchorSlot(moveEvent, nextDropNodeEl, false)
        : null;
      const end =
        nextDropNode && nextDropSlot
          ? this.getNodeAnchorPointForSlot(nextDropNode, nextDropSlot)
          : {
              ...this.getGraphPointFromMouseEvent(moveEvent, svgEl),
              side: this.getOppositeAnchorSide(sourceSlot.side),
            };
      previewEl.setAttribute(
        "d",
        this.getPerpendicularCurvePath(start, end, 72),
      );

      if (
        nextDropNode?.file.path === dropNode?.file.path &&
        nextDropSlot?.xRatio === dropSlot?.xRatio &&
        nextDropSlot?.yRatio === dropSlot?.yRatio &&
        nextDropSlot?.side === dropSlot?.side
      ) {
        return;
      }
      clearDropTarget();
      if (!nextDropNode || !nextDropNodeEl || !nextDropSlot) return;
      dropNode = nextDropNode;
      dropNodeEl = nextDropNodeEl;
      dropSlot = nextDropSlot;
      dropNodeEl.addClass("base-board-graph-node--edge-drop-target");
      dropHandleEl = this.getNodeLinkHandleEl(dropNodeEl);
      if (dropHandleEl) {
        this.snapNodeLinkHandleToSlot(dropNodeEl, dropHandleEl, dropSlot);
        dropHandleEl.addClass("base-board-graph-link-handle--visible");
        dropHandleEl.addClass("base-board-graph-link-handle--drop-target");
      }
    };

    const upHandler = (upEvent: MouseEvent) => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      handleEl.removeClass("base-board-graph-link-handle--dragging");
      handleEl.removeClass("base-board-graph-link-handle--visible");
      previewEl.remove();
      const targetNode = dropNode;
      const targetSlot = dropSlot;
      clearDropTarget();
      if (!targetNode || !targetSlot) return;
      upEvent.preventDefault();
      upEvent.stopPropagation();
      this.showNewLinkTypeMenu(
        upEvent,
        sourceNode,
        targetNode,
        sourceSlot,
        targetSlot,
      );
    };

    activeWindow.addEventListener("mousemove", moveHandler);
    activeWindow.addEventListener("mouseup", upHandler);
  }

  private getNodeLinkHandleEl(nodeEl: HTMLElement): HTMLElement | null {
    return nodeEl.querySelector<HTMLElement>(".base-board-graph-link-handle");
  }

  private getNodeAnchorSlotFromHandle(
    handleEl: HTMLElement,
  ): GraphNodeAnchorSlot {
    const side = (handleEl.dataset.side ?? "right") as GraphAnchorSide;
    const fallback = this.getFallbackAnchorSlot(side);
    return {
      side,
      xRatio: this.parseAnchorRatio(handleEl.dataset.xRatio, fallback.xRatio),
      yRatio: this.parseAnchorRatio(handleEl.dataset.yRatio, fallback.yRatio),
    };
  }

  private getFallbackAnchorSlot(side: GraphAnchorSide): GraphNodeAnchorSlot {
    if (side === "top") return { side, xRatio: 0.5, yRatio: 0 };
    if (side === "bottom") return { side, xRatio: 0.5, yRatio: 1 };
    if (side === "left") return { side, xRatio: 0, yRatio: 0.5 };
    return { side, xRatio: 1, yRatio: 0.5 };
  }

  private parseAnchorRatio(
    value: string | undefined,
    fallback: number,
  ): number {
    if (value === undefined) return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? this.clampRatio(parsed) : fallback;
  }

  private getNodeAnchorPointForSlot(
    node: GraphNode,
    slot: GraphNodeAnchorSlot,
  ): GraphAnchorPoint {
    const size = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    return {
      side: slot.side,
      x: position.x + size.width * slot.xRatio,
      y: position.y + size.height * slot.yRatio,
    };
  }

  private showNewLinkTypeMenu(
    event: MouseEvent,
    sourceNode: GraphNode,
    targetNode: GraphNode,
    sourceSlot: GraphNodeAnchorSlot,
    targetSlot: GraphNodeAnchorSlot,
  ): void {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Subprocess")
        .setIcon("lucide-git-branch")
        .onClick(() => {
          void this.createGraphLink(
            sourceNode,
            targetNode,
            "requirement",
            sourceSlot,
            targetSlot,
          );
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Dependency / gating")
        .setIcon("lucide-lock")
        .onClick(() => {
          void this.createGraphLink(
            sourceNode,
            targetNode,
            "successor",
            sourceSlot,
            targetSlot,
          );
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Break")
        .setIcon("lucide-unlink")
        .onClick(() => {
          void this.createGraphLink(
            sourceNode,
            targetNode,
            "break",
            sourceSlot,
            targetSlot,
          );
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Restart")
        .setIcon("lucide-refresh-cw")
        .onClick(() => {
          void this.createGraphLink(
            sourceNode,
            targetNode,
            "restart",
            sourceSlot,
            targetSlot,
          );
        });
    });
    menu.showAtMouseEvent(event);
  }

  private async createGraphLink(
    sourceNode: GraphNode,
    targetNode: GraphNode,
    kind: GraphLinkCreationKind,
    sourceSlot: GraphNodeAnchorSlot,
    targetSlot: GraphNodeAnchorSlot,
  ): Promise<void> {
    this.beginGraphHistory("Create link");
    if (kind === "requirement") {
      await this.updateGraphParent(targetNode, sourceNode);
    } else if (kind === "successor") {
      await this.addGraphReference(targetNode, "depends_on", sourceNode);
    } else if (kind === "break") {
      await this.addGraphReference(sourceNode, "breaks_to", targetNode);
    } else {
      await this.addGraphReference(sourceNode, "restarts_to", targetNode);
    }
    this.setCreatedGraphLinkAnchorOverrides(
      sourceNode,
      targetNode,
      kind,
      sourceSlot,
      targetSlot,
    );
    new Notice("Created link");
    await this.commitGraphHistory();
    this.render();
  }

  private setCreatedGraphLinkAnchorOverrides(
    sourceNode: GraphNode,
    targetNode: GraphNode,
    kind: GraphLinkCreationKind,
    sourceSlot: GraphNodeAnchorSlot,
    targetSlot: GraphNodeAnchorSlot,
  ): void {
    const edge: GraphEdge = {
      from: sourceNode,
      to: targetNode,
      kind: this.getCreatedGraphLinkEdgeKind(kind),
    };
    this.graphEndpointAnchorOverrides.set(
      this.getEdgeEndpointOverrideKey(edge, "from"),
      sourceSlot,
    );
    this.graphEndpointAnchorOverrides.set(
      this.getEdgeEndpointOverrideKey(edge, "to"),
      targetSlot,
    );
  }

  private getCreatedGraphLinkEdgeKind(
    kind: GraphLinkCreationKind,
  ): GraphFlowEdgeKind {
    if (kind === "requirement") return "requirement-start";
    if (kind === "successor") return "gating";
    if (kind === "break") return "break";
    return "restart";
  }

  private getMovableSubgraph(node: GraphNode): GraphNode[] {
    const result: GraphNode[] = [];
    const visitedPaths = new Set<string>();
    const queue: GraphNode[] = [node];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visitedPaths.has(current.file.path)) continue;
      visitedPaths.add(current.file.path);
      result.push(current);
      queue.push(...current.children);
      queue.push(...current.successors);
    }

    return result;
  }

  private getClampedDragDelta(
    movedNodes: GraphNode[],
    originalPositions: Map<string, { x: number; y: number }>,
    deltaX: number,
    deltaY: number,
  ): { x: number; y: number } {
    let minAllowedX = Number.NEGATIVE_INFINITY;
    let minAllowedY = Number.NEGATIVE_INFINITY;
    let maxAllowedX = Number.POSITIVE_INFINITY;
    let maxAllowedY = Number.POSITIVE_INFINITY;
    for (const node of movedNodes) {
      const original = originalPositions.get(node.file.path);
      if (!original) continue;
      minAllowedX = Math.max(
        minAllowedX,
        -GRAPH_WORLD_SAFETY_LIMIT - original.x,
      );
      minAllowedY = Math.max(
        minAllowedY,
        -GRAPH_WORLD_SAFETY_LIMIT - original.y,
      );
      maxAllowedX = Math.min(
        maxAllowedX,
        GRAPH_WORLD_SAFETY_LIMIT - original.x,
      );
      maxAllowedY = Math.min(
        maxAllowedY,
        GRAPH_WORLD_SAFETY_LIMIT - original.y,
      );
    }
    return {
      x: Math.max(minAllowedX, Math.min(maxAllowedX, deltaX)),
      y: Math.max(minAllowedY, Math.min(maxAllowedY, deltaY)),
    };
  }

  private syncRenderedGraphEdges(): void {
    this.renderedGraphEdges.forEach((edge, index) => {
      const edgeEl = this.renderedGraphEdgeEls[index];
      if (!edgeEl) return;
      edgeEl.setAttribute("d", this.getEdgePath(edge));
      const hitEl = this.renderedGraphEdgeHitEls[index];
      if (hitEl) hitEl.setAttribute("d", this.getEdgePath(edge));
      const handleEls = this.renderedGraphEdgeHandleEls[index];
      if (!handleEls) return;
      this.positionEdgeEndpointHandle(handleEls.from, edge, "from");
      this.positionEdgeEndpointHandle(handleEls.to, edge, "to");
    });
  }

  private getGraphPointFromMouseEvent(
    event: MouseEvent,
    svgEl: SVGSVGElement,
  ): { x: number; y: number } {
    const rect = svgEl.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / this.graphZoom,
      y: (event.clientY - rect.top) / this.graphZoom,
    };
  }

  private getGraphPointFromElement(
    event: MouseEvent,
    element: HTMLElement,
  ): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / this.graphZoom,
      y: (event.clientY - rect.top) / this.graphZoom,
    };
  }

  private getGraphPointFromElementCenter(
    element: HTMLElement,
    svgEl: SVGSVGElement,
    side: GraphAnchorSide,
  ): GraphAnchorPoint {
    const elementRect = element.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    return {
      side,
      x:
        (elementRect.left + elementRect.width / 2 - svgRect.left) /
        this.graphZoom,
      y:
        (elementRect.top + elementRect.height / 2 - svgRect.top) /
        this.graphZoom,
    };
  }

  private getGraphNodeFromPoint(
    clientX: number,
    clientY: number,
  ): GraphNode | null {
    const nodeEl = activeDocument
      .elementsFromPoint(clientX, clientY)
      .map((element) =>
        element.instanceOf(Element)
          ? element.closest<HTMLElement>(".base-board-graph-node")
          : null,
      )
      .find((element): element is HTMLElement => element !== null);
    const filePath = nodeEl?.dataset.filePath;
    if (!filePath) return null;
    return (
      this.visibleNodes.find((node) => node.file.path === filePath) ?? null
    );
  }

  private getValidEdgeEndpointDropHandle(
    sourceEdge: GraphEdge,
    sourceEndpoint: GraphEdgeEndpoint,
    sourceHandleEl: SVGCircleElement,
    clientX: number,
    clientY: number,
  ): {
    edge: GraphEdge;
    endpoint: GraphEdgeEndpoint;
    handleEl: SVGCircleElement;
  } | null {
    const sourceNode = this.getEdgeEndpointNode(sourceEdge, sourceEndpoint);
    for (const element of activeDocument.elementsFromPoint(clientX, clientY)) {
      if (!element.instanceOf(SVGCircleElement)) continue;
      if (element === sourceHandleEl) continue;
      if (!element.hasClass("base-board-graph-edge-handle")) continue;
      const target = this.getRenderedGraphEdgeHandleTarget(element);
      if (!target) continue;
      if (target.edge === sourceEdge && target.endpoint === sourceEndpoint) {
        continue;
      }
      const targetNode = this.getEdgeEndpointNode(target.edge, target.endpoint);
      if (targetNode.file.path !== sourceNode.file.path) continue;
      return target;
    }
    return null;
  }

  private getRenderedGraphEdgeHandleTarget(handleEl: SVGCircleElement): {
    edge: GraphEdge;
    endpoint: GraphEdgeEndpoint;
    handleEl: SVGCircleElement;
  } | null {
    for (
      let index = 0;
      index < this.renderedGraphEdgeHandleEls.length;
      index++
    ) {
      const edge = this.renderedGraphEdges[index];
      const handleEls = this.renderedGraphEdgeHandleEls[index];
      if (!edge || !handleEls) continue;
      if (handleEls.from === handleEl) {
        return { edge, endpoint: "from", handleEl };
      }
      if (handleEls.to === handleEl) {
        return { edge, endpoint: "to", handleEl };
      }
    }
    return null;
  }

  private getEdgeEndpointNode(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): GraphNode {
    return endpoint === "from" ? edge.from : edge.to;
  }

  private getRenderedGraphNodeEl(node: GraphNode): HTMLElement | null {
    return (
      Array.from(
        this.containerEl.querySelectorAll<HTMLElement>(
          ".base-board-graph-node",
        ),
      ).find((nodeEl) => nodeEl.dataset.filePath === node.file.path) ?? null
    );
  }

  private getValidEdgeEndpointDropNode(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    candidate: GraphNode | null,
  ): GraphNode | null {
    if (!candidate) return null;
    if (this.isCurrentEdgeEndpoint(edge, endpoint, candidate)) return null;
    if (this.wouldEdgeEndpointCreateSelfRelation(edge, endpoint, candidate)) {
      return null;
    }
    if (this.wouldEdgeEndpointCreateParentCycle(edge, endpoint, candidate)) {
      return null;
    }
    return candidate;
  }

  private isCurrentEdgeEndpoint(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    candidate: GraphNode,
  ): boolean {
    return endpoint === "from"
      ? candidate.file.path === edge.from.file.path
      : candidate.file.path === edge.to.file.path;
  }

  private wouldEdgeEndpointCreateSelfRelation(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    candidate: GraphNode,
  ): boolean {
    const candidatePath = candidate.file.path;
    if (edge.kind === "requirement-start") {
      return endpoint === "from"
        ? candidatePath === edge.to.file.path
        : candidatePath === edge.from.file.path;
    }
    if (edge.kind === "requirement-return") {
      return endpoint === "from"
        ? candidatePath === edge.to.file.path
        : candidatePath === edge.from.file.path;
    }
    return endpoint === "from"
      ? candidatePath === edge.to.file.path
      : candidatePath === edge.from.file.path;
  }

  private wouldEdgeEndpointCreateParentCycle(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    candidate: GraphNode,
  ): boolean {
    if (edge.kind === "requirement-start") {
      return endpoint === "from"
        ? this.isGraphDescendant(candidate, edge.to)
        : this.isGraphDescendant(edge.from, candidate);
    }
    if (edge.kind === "requirement-return") {
      return endpoint === "from"
        ? this.isGraphDescendant(edge.to, candidate)
        : this.isGraphDescendant(candidate, edge.from);
    }
    return false;
  }

  private isGraphDescendant(
    possibleDescendant: GraphNode,
    ancestor: GraphNode,
  ): boolean {
    const visitedPaths = new Set<string>();
    const queue = [...ancestor.children];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visitedPaths.has(node.file.path)) continue;
      if (node.file.path === possibleDescendant.file.path) return true;
      visitedPaths.add(node.file.path);
      queue.push(...node.children);
    }
    return false;
  }

  private swapGraphEndpointAnchors(
    sourceEdge: GraphEdge,
    sourceEndpoint: GraphEdgeEndpoint,
    targetEdge: GraphEdge,
    targetEndpoint: GraphEdgeEndpoint,
  ): void {
    const sourceNode = this.getEdgeEndpointNode(sourceEdge, sourceEndpoint);
    const targetNode = this.getEdgeEndpointNode(targetEdge, targetEndpoint);
    if (sourceNode.file.path !== targetNode.file.path) return;

    const sourceAnchor = this.getEdgeEndpointAnchor(sourceEdge, sourceEndpoint);
    const targetAnchor = this.getEdgeEndpointAnchor(targetEdge, targetEndpoint);
    this.graphEndpointAnchorOverrides.set(
      this.getEdgeEndpointOverrideKey(sourceEdge, sourceEndpoint),
      this.getGraphEndpointAnchorOverride(sourceNode, targetAnchor),
    );
    this.graphEndpointAnchorOverrides.set(
      this.getEdgeEndpointOverrideKey(targetEdge, targetEndpoint),
      this.getGraphEndpointAnchorOverride(targetNode, sourceAnchor),
    );

    this.syncRenderedGraphEdges();
    new Notice("Swapped line anchors");
  }

  private showGraphEdgeMenu(event: MouseEvent, edge: GraphEdge): void {
    event.preventDefault();
    event.stopPropagation();

    // Requirement-return edges are derived from containment and have no
    // structural edit action, so they expose no context menu.
    if (edge.kind === "requirement-return") return;

    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Delete line")
        .setIcon("lucide-unlink")
        .onClick(() => {
          void this.deleteGraphEdge(edge);
        });
    });
    menu.showAtMouseEvent(event);
  }

  private async deleteGraphEdge(edge: GraphEdge): Promise<void> {
    // Requirement-return edges are derived from containment; there is nothing
    // to delete on them.
    if (edge.kind === "requirement-return") return;
    this.beginGraphHistory("Delete link");
    if (edge.kind === "requirement-start") {
      await this.updateGraphParent(edge.to, null, edge.from);
    } else if (edge.kind === "gating") {
      await this.removeGraphReference(edge.to, "depends_on", edge.from);
    } else {
      await this.removeGraphReference(
        edge.from,
        edge.kind === "break" ? "breaks_to" : "restarts_to",
        edge.to,
      );
    }

    this.graphEndpointAnchorOverrides.delete(
      this.getEdgeEndpointOverrideKey(edge, "from"),
    );
    this.graphEndpointAnchorOverrides.delete(
      this.getEdgeEndpointOverrideKey(edge, "to"),
    );

    new Notice("Deleted line");
    await this.commitGraphHistory();
    this.render();
  }

  private async deleteGraphNode(node: GraphNode): Promise<void> {
    const cleanedReferences = await this.cleanupReferencesToGraphNodes([node]);
    await this.app.fileManager.trashFile(node.file);
    this.graphEndpointAnchorOverrides.clear();
    new Notice(
      cleanedReferences > 0
        ? `Moved "${node.title}" to trash and cleaned ${cleanedReferences} reference${cleanedReferences === 1 ? "" : "s"}`
        : `Moved "${node.title}" to trash`,
    );
    this.render();
  }

  private async deleteDownstreamGraphNodes(node: GraphNode): Promise<void> {
    const subtreeNodes = [node, ...this.getDownstreamGraphNodes(node)];

    const cleanedReferences =
      await this.cleanupReferencesToGraphNodes(subtreeNodes);
    await Promise.all(
      subtreeNodes.map((subtreeNode) =>
        this.app.fileManager.trashFile(subtreeNode.file),
      ),
    );
    this.graphEndpointAnchorOverrides.clear();
    new Notice(
      `Moved ${subtreeNodes.length} node${subtreeNodes.length === 1 ? "" : "s"} to trash${cleanedReferences > 0 ? ` and cleaned ${cleanedReferences} reference${cleanedReferences === 1 ? "" : "s"}` : ""}`,
    );
    this.render();
  }

  private getDownstreamGraphNodes(node: GraphNode): GraphNode[] {
    const result: GraphNode[] = [];
    const visitedPaths = new Set<string>([node.file.path]);
    const queue = [...node.children, ...this.getGatedSuccessors(node)];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visitedPaths.has(current.file.path)) continue;
      visitedPaths.add(current.file.path);
      result.push(current);
      queue.push(...current.children, ...this.getGatedSuccessors(current));
    }

    return result;
  }

  private getGatedSuccessors(node: GraphNode): GraphNode[] {
    const restartTargetPaths = new Set(
      node.restartTargets.map((target) => target.file.path),
    );
    return node.successors.filter(
      (successor) => !restartTargetPaths.has(successor.file.path),
    );
  }

  /**
   * Collects every node that must be Completed for `node` to be the active
   * work. This is the dependency closure across BOTH:
   * - `depends_on` predecessors of the node, and
   * - the predecessors of every **ancestor** (to work inside a container, that
   *   container's own dependencies must be done — e.g. activating a leaf inside
   *   `rollout` requires `rollout`'s dependency `dev` to be complete), and
   * - the full **containment subtree** of each prerequisite (a prerequisite
   *   container like `dev` is only "done" when its children are done too),
   * applied transitively. Ancestors themselves are NOT included (they are
   *   in-progress containers, rendered complete by the container rule once their
   *   dependencies are satisfied), and gated successors are NOT followed (that
   *   would sweep the active node's own branch back in via `dev → rollout`).
   */
  private getUpstreamDependencyNodes(node: GraphNode): GraphNode[] {
    const parentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const result: GraphNode[] = [];
    const resultPaths = new Set<string>([node.file.path]);
    const queue: GraphNode[] = [];

    // Enqueue a node's direct predecessors plus the predecessors of all its
    // ancestors (containment implies the container's dependencies are needed).
    const enqueueWithAncestorDeps = (target: GraphNode): void => {
      const seen = new Set<string>();
      let current: GraphNode | null = target;
      while (current && !seen.has(current.file.path)) {
        seen.add(current.file.path);
        for (const predecessor of current.predecessors) queue.push(predecessor);
        current = parentByPath.get(current.file.path) ?? null;
      }
    };

    enqueueWithAncestorDeps(node);

    while (queue.length > 0) {
      const prerequisite = queue.shift();
      if (!prerequisite || resultPaths.has(prerequisite.file.path)) continue;
      resultPaths.add(prerequisite.file.path);
      result.push(prerequisite);
      // A prerequisite container is only complete when its children are too.
      for (const descendant of this.getContainmentDescendants(prerequisite)) {
        if (resultPaths.has(descendant.file.path)) continue;
        resultPaths.add(descendant.file.path);
        result.push(descendant);
      }
      // Recurse into the prerequisite's own dependency closure.
      enqueueWithAncestorDeps(prerequisite);
    }

    return result;
  }

  /** Descendants reached by following `children` only (containment, not gating). */
  private getContainmentDescendants(node: GraphNode): GraphNode[] {
    const result: GraphNode[] = [];
    const visited = new Set<string>([node.file.path]);
    const queue: GraphNode[] = [...node.children];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.file.path)) continue;
      visited.add(current.file.path);
      result.push(current);
      queue.push(...current.children);
    }
    return result;
  }

  /**
   * Collects everything sequenced AFTER the active node that must reset to
   * Planned: the node's own downstream closure (children + gated successors)
   * PLUS the downstream closure of every ANCESTOR's gated successors (e.g. the
   * later rollout rings after the containing `stage`). Being active inside a
   * container means that container's successors have not run yet. Mirror of
   * `getUpstreamDependencyNodes`. Excludes the active node itself.
   */
  private getDownstreamResetNodes(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
  ): GraphNode[] {
    const result: GraphNode[] = [];
    const seen = new Set<string>([node.file.path]);
    const include = (candidate: GraphNode): void => {
      for (const downstream of [
        candidate,
        ...this.getDownstreamGraphNodes(candidate),
      ]) {
        if (seen.has(downstream.file.path)) continue;
        seen.add(downstream.file.path);
        result.push(downstream);
      }
    };

    for (const downstream of this.getDownstreamGraphNodes(node)) {
      if (seen.has(downstream.file.path)) continue;
      seen.add(downstream.file.path);
      result.push(downstream);
    }

    const ancestorSeen = new Set<string>([node.file.path]);
    let ancestor: GraphNode | null = parentByPath.get(node.file.path) ?? null;
    while (ancestor && !ancestorSeen.has(ancestor.file.path)) {
      ancestorSeen.add(ancestor.file.path);
      for (const successor of this.getGatedSuccessors(ancestor)) {
        include(successor);
      }
      ancestor = parentByPath.get(ancestor.file.path) ?? null;
    }

    return result;
  }

  /**
   * Returns true when a `break` edge represents a failure that actually
   * happened, i.e. its source node is in a genuinely-failed state
   * (`interrupted`/`failed` or `blocked`). An `invalidated`/`skipped` source is
   * NOT triggered: an invalidated node never ran, so its own break links stay
   * dormant (muted green) rather than cascading red down the invalidated chain.
   */
  private isBreakEdgeTriggered(edge: GraphEdge): boolean {
    const status = edge.from.status;
    return this.isInterruptedStatus(status) || this.isBlockedStatus(status);
  }

  private isGenuinelyFailedStatus(status: string | null): boolean {
    return this.isInterruptedStatus(status) || this.isBlockedStatus(status);
  }

  /**
   * Recomputes which nodes sit on a failure escalation path. A break that
   * climbs the parent chain (source's `breaks_to` points at its parent) renders
   * red when a genuinely-failed node exists at or below it on that chain, so a
   * single failure escalates red all the way up to the feature root.
   */
  private recomputeBreakEscalation(): void {
    this.graphParentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const escalation = new Set<string>();
    for (const candidate of this.visibleNodes) {
      if (!this.isGenuinelyFailedStatus(candidate.status)) continue;
      const visited = new Set<string>();
      let current: GraphNode | null = candidate;
      while (current && !visited.has(current.file.path)) {
        visited.add(current.file.path);
        escalation.add(current.file.path);
        current = this.graphParentByPath.get(current.file.path) ?? null;
      }
    }
    this.breakEscalationSourcePaths = escalation;
  }

  private isBreakEdgeEscalated(edge: GraphEdge): boolean {
    if (!this.breakEscalationSourcePaths.has(edge.from.file.path)) return false;
    const parent = this.graphParentByPath.get(edge.from.file.path);
    return parent?.file.path === edge.to.file.path;
  }

  private getEdgeMarkerKind(edge: GraphEdge): string {
    if (edge.kind === "break") {
      if (this.isBreakEdgeTriggered(edge) || this.isBreakEdgeEscalated(edge)) {
        return "break";
      }
      return "break-dormant";
    }
    // A requirement-return edge means "completion flowing back up from child to
    // parent". It is only a true (green) completion line when the child
    // (edge.from) is genuinely Completed; otherwise it renders dormant/muted.
    if (edge.kind === "requirement-return") {
      return this.isCompletedStatus(edge.from.status)
        ? "requirement-return"
        : "requirement-return-dormant";
    }
    return edge.kind;
  }

  /**
   * Work-node operation: Set Active (GRAPH_SEMANTICS_SPEC.md). The node becomes
   * the `Active` (blue) frontier; everything *before* it in execution order
   * becomes `Completed`; everything *after* becomes `Planned`. Only leaf
   * (work-node) statuses are written — group states and link colors are
   * derived on render (Layers A/B). Group nodes are not directly actionable.
   */
  private async makeNodeActive(node: GraphNode): Promise<void> {
    if (node.children.length > 0) {
      new Notice(
        `"${node.title}" is a group — its state derives from its children. Set a work node inside it active instead.`,
      );
      return;
    }
    this.beginGraphHistory("Set as active work");
    const target = this.buildExecutionPartitionTargets(node, {
      before: GRAPH_STATUS_COMPLETED,
      self: GRAPH_STATUS_ACTIVE,
      after: GRAPH_STATUS_PLANNED,
    });
    const updated = await this.applyLeafStatuses(target, node.file.path);
    new Notice(
      this.describeWorkNodeOp(`Set "${node.title}" as active work`, updated),
    );
    await this.commitGraphHistory();
    this.render();
  }

  // --- Pure recompute work-node operations (GRAPH_SEMANTICS_SPEC.md) ----------
  // The only stored truth is the set of work-node (leaf) statuses. Each work
  // operation partitions the graph by EXECUTION ORDER relative to the acted-on
  // leaf X — "before X" (its dependency closure incl. ancestor deps) and
  // "after X" (its downstream closure incl. the work sequenced after its
  // ancestors) — and writes a status to each leaf in those partitions. Group
  // states (Layer A) and link colors (Layer B) are derived on render, never
  // written. This replaces the old imperative status mutation + break re-homing
  // + parallel cancellation + iteration spawning.

  /** Leaf (work) nodes among a set; group nodes derive and are never written. */
  private getLeafNodes(nodes: GraphNode[]): GraphNode[] {
    return nodes.filter((candidate) => candidate.children.length === 0);
  }

  /**
   * Builds the target leaf statuses for a work operation from the execution
   * order partition of `node`: `before` leaves, `node` itself, and `after`
   * leaves. Later assignments win, so the acted-on node always takes `self`.
   */
  private buildExecutionPartitionTargets(
    node: GraphNode,
    statuses: { before: string; self: string; after: string },
  ): Map<string, { node: GraphNode; status: string; reason?: string }> {
    const parentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const beforeLeaves = this.getLeafNodes(
      this.getUpstreamDependencyNodes(node),
    );
    const afterLeaves = this.getLeafNodes(
      this.getDownstreamResetNodes(node, parentByPath),
    );
    const target = new Map<
      string,
      { node: GraphNode; status: string; reason?: string }
    >();
    for (const leaf of beforeLeaves) {
      target.set(leaf.file.path, { node: leaf, status: statuses.before });
    }
    for (const leaf of afterLeaves) {
      target.set(leaf.file.path, { node: leaf, status: statuses.after });
    }
    target.set(node.file.path, { node, status: statuses.self });
    return target;
  }

  /**
   * Writes computed target statuses to leaf nodes (only when the value
   * actually changes) and returns the count of *related* leaves updated
   * (excluding `primaryPath`). Group nodes in the map are skipped — their state
   * derives from their children and is never persisted.
   */
  private async applyLeafStatuses(
    target: Map<string, { node: GraphNode; status: string; reason?: string }>,
    primaryPath: string,
  ): Promise<number> {
    let related = 0;
    for (const { node, status, reason } of target.values()) {
      if (node.children.length > 0) continue;
      if ((node.status ?? "").trim().toLowerCase() === status.toLowerCase()) {
        continue;
      }
      await this.setGraphNodeStatus(node, status, reason);
      if (node.file.path !== primaryPath) related += 1;
    }
    return related;
  }

  private describeWorkNodeOp(headline: string, related: number): string {
    if (related <= 0) return headline;
    return `${headline}, updated ${related} related node${related === 1 ? "" : "s"}`;
  }

  /**
   * Work-node operation: Set Completed (GRAPH_SEMANTICS_SPEC.md). The node and
   * everything before it in execution order become `Completed`; nodes after it
   * are left untouched. An already-complete node is a no-op. Undoable.
   */
  private async markNodeComplete(node: GraphNode): Promise<void> {
    if (node.children.length > 0) {
      new Notice(
        `"${node.title}" is a group — its completion derives from its children.`,
      );
      return;
    }
    if (this.isCompletedStatus(node.status)) {
      new Notice(`"${node.title}" is already complete`);
      return;
    }
    this.beginGraphHistory("Mark as complete");
    const beforeLeaves = this.getLeafNodes(
      this.getUpstreamDependencyNodes(node),
    );
    const target = new Map<
      string,
      { node: GraphNode; status: string; reason?: string }
    >();
    for (const leaf of beforeLeaves) {
      target.set(leaf.file.path, {
        node: leaf,
        status: GRAPH_STATUS_COMPLETED,
      });
    }
    target.set(node.file.path, { node, status: GRAPH_STATUS_COMPLETED });
    const updated = await this.applyLeafStatuses(target, node.file.path);
    new Notice(
      this.describeWorkNodeOp(`Marked "${node.title}" as complete`, updated),
    );
    await this.commitGraphHistory();
    this.render();
  }

  /**
   * Group operation: Prune / Cancel sub-graph (GRAPH_SEMANTICS_SPEC.md). The one
   * allowed group-level action. Every leaf in the group's containment subtree
   * becomes `Cancelled` (the group then *derives* `Cancelled`), and everything
   * sequenced *after* the group in execution order becomes `Invalidated`. This
   * is NOT a failure: no red break escalation, no retry. The `Cancelled` status
   * is reused; each cancelled leaf records `reason: "pruned-manual"` in its
   * event log so history/replay can distinguish a deliberate prune from
   * automatic parallel-branch cancellation.
   */
  private async pruneGroup(node: GraphNode): Promise<void> {
    if (node.children.length === 0) {
      new Notice(`"${node.title}" is a work node, not a group to prune.`);
      return;
    }
    this.beginGraphHistory("Prune group");
    const parentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const subtreeLeaves = this.getLeafNodes(
      this.getContainmentDescendants(node),
    );
    const subtreePaths = new Set(subtreeLeaves.map((leaf) => leaf.file.path));
    const afterLeaves = this.getLeafNodes(
      this.getDownstreamResetNodes(node, parentByPath),
    );

    const target = new Map<
      string,
      { node: GraphNode; status: string; reason?: string }
    >();
    for (const leaf of subtreeLeaves) {
      target.set(leaf.file.path, {
        node: leaf,
        status: GRAPH_STATUS_CANCELLED,
        reason: "pruned-manual",
      });
    }
    for (const leaf of afterLeaves) {
      if (subtreePaths.has(leaf.file.path)) continue;
      target.set(leaf.file.path, {
        node: leaf,
        status: GRAPH_STATUS_INVALIDATED,
      });
    }

    const updated = await this.applyLeafStatuses(target, node.file.path);
    new Notice(this.describeWorkNodeOp(`Pruned "${node.title}"`, updated));
    await this.commitGraphHistory();
    this.render();
  }

  private async setGraphNodeStatus(
    node: GraphNode,
    status: string,
    reason?: string,
  ): Promise<void> {
    await this.snapshotForUndo(node.file.path);
    const propertyName = this.getGroupByProperty() ?? "status";
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        const from = this.normalizeText(frontmatter[propertyName]);
        frontmatter[propertyName] = status;
        const nodeId = this.ensureNodeId(frontmatter, node);
        this.appendGraphTransitionEvent(
          frontmatter,
          propertyName,
          nodeId,
          from,
          status,
          reason,
        );
      },
    );
  }

  /**
   * Ensures the note carries a stable frontmatter `id` (backfilling one from the
   * title when missing) and returns it. Stable ids are the join key for the
   * transition event log (Milestone 1 of GRAPH_ARCHITECTURE_PLAN.md).
   */
  private ensureNodeId(
    frontmatter: Record<string, unknown>,
    node: GraphNode,
  ): string {
    const existing = frontmatter.id;
    if (typeof existing === "string" && existing.trim().length > 0) {
      return existing.trim();
    }
    const generated = this.getGeneratedId(node.title);
    frontmatter.id = generated;
    return generated;
  }

  /**
   * Appends an append-only transition event to the note's history array
   * (Milestone 1: event sourcing, write-only). The record keeps the existing
   * `{ from, to, at, property, source }` shape so the Timeline view stays
   * compatible, and adds event-sourcing fields (`id`, `node`, `kind`,
   * `causedBy`) that future milestones (history projection, replay, agent trust
   * record) consume. No-op when transition history is disabled.
   */
  private appendGraphTransitionEvent(
    frontmatter: Record<string, unknown>,
    propertyName: string,
    nodeId: string,
    from: string | null,
    to: string,
    reason?: string,
  ): void {
    const settings = this.plugin.data_.transitionHistory;
    if (!settings.enabled) return;
    const historyProperty = settings.propertyName.trim();
    if (!historyProperty) return;

    const existing = frontmatter[historyProperty];
    const history: unknown[] = [];
    if (Array.isArray(existing)) {
      for (const item of existing as unknown[]) history.push(item);
    } else if (existing !== undefined && existing !== null) {
      history.push(existing);
    }

    const event: Record<string, unknown> = {
      id: this.getGeneratedEventId(),
      node: nodeId,
      kind: this.getGraphEventKind(to),
      from,
      to,
      at: new Date().toISOString(),
      property: propertyName,
      causedBy: "human",
      source: "baseboard-graph",
    };
    if (reason) event.reason = reason;

    frontmatter[historyProperty] = [...history, event];
  }

  /** Maps a target status string to a GraphEvent `kind` (see GRAPH_ARCHITECTURE_PLAN.md). */
  private getGraphEventKind(status: string): string {
    if (this.isActiveStatus(status)) return "activated";
    if (this.isCompletedStatus(status)) return "completed";
    if (this.isInterruptedStatus(status)) return "failed";
    if (this.isInvalidatedStatus(status)) return "invalidated";
    if (this.isCancelledStatus(status)) return "cancelled";
    const normalized = status.trim().toLowerCase();
    if (normalized === "awaiting") return "awaiting";
    if (normalized === "planned") return "planned";
    return "transition";
  }

  private getGeneratedEventId(): string {
    const time = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `evt-${time}-${rand}`;
  }

  // --- Undo / redo -----------------------------------------------------------
  // Mutating graph actions (set active, mark failed, create/delete/rewire
  // links) are wrapped in an armed history transaction. While armed, the
  // low-level frontmatter/file writers snapshot each touched file's prior
  // content via `snapshotForUndo`, and `commitGraphHistory` records the diff so
  // it can be reversed. Node drag/collapse writes are intentionally not armed.

  private beginGraphHistory(label: string): void {
    this.graphHistoryActive = true;
    this.graphHistoryLabel = label;
    this.graphHistoryBefore = new Map();
  }

  private async snapshotForUndo(path: string): Promise<void> {
    if (!this.graphHistoryActive) return;
    if (this.graphHistoryBefore.has(path)) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    const content =
      file instanceof TFile ? await this.app.vault.read(file) : null;
    this.graphHistoryBefore.set(path, content);
  }

  private async commitGraphHistory(): Promise<void> {
    if (!this.graphHistoryActive) return;
    this.graphHistoryActive = false;
    const before = this.graphHistoryBefore;
    this.graphHistoryBefore = new Map();
    if (before.size === 0) return;

    const files: GraphHistoryFileChange[] = [];
    for (const [path, beforeContent] of before) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const afterContent =
        file instanceof TFile ? await this.app.vault.read(file) : null;
      if (beforeContent === afterContent) continue;
      files.push({ path, before: beforeContent, after: afterContent });
    }
    if (files.length === 0) return;

    this.graphUndoStack.push({ label: this.graphHistoryLabel, files });
    if (this.graphUndoStack.length > GRAPH_HISTORY_LIMIT) {
      this.graphUndoStack.shift();
    }
    this.graphRedoStack = [];
  }

  private async applyGraphHistoryState(
    files: GraphHistoryFileChange[],
    useBefore: boolean,
  ): Promise<void> {
    for (const change of files) {
      const content = useBefore ? change.before : change.after;
      const existing = this.app.vault.getAbstractFileByPath(change.path);
      if (content === null) {
        if (existing instanceof TFile) {
          await this.app.fileManager.trashFile(existing);
        }
      } else if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(change.path, content);
      }
    }
  }

  private async undoGraphHistory(): Promise<void> {
    const entry = this.graphUndoStack.pop();
    if (!entry) return;
    await this.applyGraphHistoryState(entry.files, true);
    this.graphRedoStack.push(entry);
    this.graphEndpointAnchorOverrides.clear();
    new Notice(`Undid: ${entry.label}`);
    this.render();
  }

  private async redoGraphHistory(): Promise<void> {
    const entry = this.graphRedoStack.pop();
    if (!entry) return;
    await this.applyGraphHistoryState(entry.files, false);
    this.graphUndoStack.push(entry);
    this.graphEndpointAnchorOverrides.clear();
    new Notice(`Redid: ${entry.label}`);
    this.render();
  }

  private updateGraphHistoryButtons(): void {
    if (this.graphUndoButtonEl) {
      const top = this.graphUndoStack[this.graphUndoStack.length - 1];
      this.graphUndoButtonEl.disabled = !top;
      setTooltip(
        this.graphUndoButtonEl,
        top ? `Undo: ${top.label}` : "Nothing to undo",
      );
    }
    if (this.graphRedoButtonEl) {
      const top = this.graphRedoStack[this.graphRedoStack.length - 1];
      this.graphRedoButtonEl.disabled = !top;
      setTooltip(
        this.graphRedoButtonEl,
        top ? `Redo: ${top.label}` : "Nothing to redo",
      );
    }
  }

  /**
   * Work-node operation: Set Failed (GRAPH_SEMANTICS_SPEC.md). The node becomes
   * `Failed` (red); everything *before* it in execution order becomes
   * `Completed` (it ran); everything *after* becomes `Invalidated` (the rest of
   * its ring and all subsequent rings are now unreachable). Only leaf statuses
   * are written. The red break link from the failed leaf up its containment
   * chain, and group states, are *derived* on render (Layers A/B) — no
   * `breaks_to` is written and no iteration is spawned (iteration creation is a
   * deliberate policy action, not a side-effect of failure).
   */
  private async markNodeFailed(node: GraphNode): Promise<void> {
    if (node.children.length > 0) {
      new Notice(
        `"${node.title}" is a group and cannot be failed directly. Fail a work node inside it, or prune the group.`,
      );
      return;
    }
    this.beginGraphHistory("Mark as failed");
    const target = this.buildExecutionPartitionTargets(node, {
      before: GRAPH_STATUS_COMPLETED,
      self: GRAPH_STATUS_FAILED,
      after: GRAPH_STATUS_INVALIDATED,
    });
    const updated = await this.applyLeafStatuses(target, node.file.path);
    new Notice(
      this.describeWorkNodeOp(`Marked "${node.title}" as failed`, updated),
    );
    await this.commitGraphHistory();
    this.render();
  }

  private async cleanupReferencesToGraphNodes(
    nodes: GraphNode[],
  ): Promise<number> {
    const identities = new Set<string>();
    for (const node of nodes) {
      for (const identity of this.getNodeIdentities(node)) {
        identities.add(identity);
      }
    }
    const deletedPaths = new Set(nodes.map((node) => node.file.path));
    const candidates = this.visibleNodes.filter(
      (candidate) => !deletedPaths.has(candidate.file.path),
    );
    let cleanedReferences = 0;

    await Promise.all(
      candidates.map((candidate) =>
        this.app.fileManager.processFrontMatter(
          candidate.file,
          (frontmatter: Record<string, unknown>) => {
            cleanedReferences += this.removeGraphNodeReferencesFromFrontmatter(
              frontmatter,
              identities,
            );
          },
        ),
      ),
    );

    return cleanedReferences;
  }

  private removeGraphNodeReferencesFromFrontmatter(
    frontmatter: Record<string, unknown>,
    identities: Set<string>,
  ): number {
    let removedCount = 0;

    if (
      "parent" in frontmatter &&
      this.frontmatterReferenceMatchesIdentities(frontmatter.parent, identities)
    ) {
      delete frontmatter.parent;
      removedCount++;
    }

    for (const relationKind of [
      "depends_on",
      "breaks_to",
      "restarts_to",
    ] as const) {
      const propertyName = this.getGraphReferenceListPropertyName(
        frontmatter,
        relationKind,
      );
      if (!(propertyName in frontmatter)) continue;
      const references = this.getFrontmatterReferenceList(
        frontmatter[propertyName],
      );
      const nextReferences = references.filter(
        (reference) => !this.referenceMatchesIdentities(reference, identities),
      );
      const removed = references.length - nextReferences.length;
      if (removed === 0) continue;
      removedCount += removed;
      this.setFrontmatterReferenceList(
        frontmatter,
        propertyName,
        nextReferences,
      );
    }

    return removedCount;
  }

  private frontmatterReferenceMatchesIdentities(
    value: unknown,
    identities: Set<string>,
  ): boolean {
    return this.getFrontmatterReferenceList(value).some((reference) =>
      this.referenceMatchesIdentities(reference, identities),
    );
  }

  private referenceMatchesIdentities(
    reference: string,
    identities: Set<string>,
  ): boolean {
    const normalizedReference = this.normalizeReference(reference);
    return normalizedReference !== null && identities.has(normalizedReference);
  }

  private async reassignGraphEdgeEndpoint(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    targetNode: GraphNode,
  ): Promise<void> {
    this.beginGraphHistory("Rewire link");
    if (edge.kind === "requirement-start") {
      if (endpoint === "from") {
        await this.updateGraphParent(edge.to, targetNode);
      } else {
        await Promise.all([
          this.updateGraphParent(edge.to, null, edge.from),
          this.updateGraphParent(targetNode, edge.from),
        ]);
      }
    } else if (edge.kind === "requirement-return") {
      if (endpoint === "from") {
        await Promise.all([
          this.updateGraphParent(edge.from, null, edge.to),
          this.updateGraphParent(targetNode, edge.to),
        ]);
      } else {
        await this.updateGraphParent(edge.from, targetNode);
      }
    } else if (edge.kind === "gating") {
      if (endpoint === "from") {
        await this.replaceGraphReference(
          edge.to,
          "depends_on",
          edge.from,
          targetNode,
        );
      } else {
        await Promise.all([
          this.removeGraphReference(edge.to, "depends_on", edge.from),
          this.addGraphReference(targetNode, "depends_on", edge.from),
        ]);
      }
    } else {
      const relationKind = edge.kind === "break" ? "breaks_to" : "restarts_to";
      if (endpoint === "from") {
        await Promise.all([
          this.removeGraphReference(edge.from, relationKind, edge.to),
          this.addGraphReference(targetNode, relationKind, edge.to),
        ]);
      } else {
        await this.replaceGraphReference(
          edge.from,
          relationKind,
          edge.to,
          targetNode,
        );
      }
    }

    new Notice(`Rewired line to ${targetNode.title}`);
    await this.commitGraphHistory();
    this.render();
  }

  private async updateGraphParent(
    childNode: GraphNode,
    parentNode: GraphNode | null,
    expectedParentNode?: GraphNode,
  ): Promise<void> {
    await this.snapshotForUndo(childNode.file.path);
    await this.app.fileManager.processFrontMatter(
      childNode.file,
      (frontmatter: Record<string, unknown>) => {
        const propertyName = this.getGraphParentPropertyName(frontmatter);
        const currentValue = frontmatter[propertyName];
        if (
          expectedParentNode &&
          !this.frontmatterReferenceMatchesNode(
            currentValue,
            expectedParentNode,
          )
        ) {
          return;
        }

        if (parentNode) {
          frontmatter[propertyName] = this.getWikiLink(parentNode.file);
        } else {
          delete frontmatter[propertyName];
        }
      },
    );
  }

  private async replaceGraphReference(
    node: GraphNode,
    relationKind: GraphReferenceListKind,
    oldTargetNode: GraphNode,
    newTargetNode: GraphNode,
  ): Promise<void> {
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        const propertyName = this.getGraphReferenceListPropertyName(
          frontmatter,
          relationKind,
        );
        const references = this.getFrontmatterReferenceList(
          frontmatter[propertyName],
        );
        let replaced = false;
        const nextReferences = references.map((reference) => {
          if (this.referenceMatchesNode(reference, oldTargetNode)) {
            replaced = true;
            return this.getWikiLink(newTargetNode.file);
          }
          return reference;
        });
        if (!replaced)
          nextReferences.push(this.getWikiLink(newTargetNode.file));
        this.setFrontmatterReferenceList(
          frontmatter,
          propertyName,
          nextReferences,
        );
      },
    );
  }

  private async addGraphReference(
    node: GraphNode,
    relationKind: GraphReferenceListKind,
    targetNode: GraphNode,
  ): Promise<void> {
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        const propertyName = this.getGraphReferenceListPropertyName(
          frontmatter,
          relationKind,
        );
        const references = this.getFrontmatterReferenceList(
          frontmatter[propertyName],
        );
        if (
          !references.some((reference) =>
            this.referenceMatchesNode(reference, targetNode),
          )
        ) {
          references.push(this.getWikiLink(targetNode.file));
        }
        this.setFrontmatterReferenceList(frontmatter, propertyName, references);
      },
    );
  }

  private async removeGraphReference(
    node: GraphNode,
    relationKind: GraphReferenceListKind,
    targetNode: GraphNode,
  ): Promise<void> {
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        const propertyName = this.getGraphReferenceListPropertyName(
          frontmatter,
          relationKind,
        );
        const references = this.getFrontmatterReferenceList(
          frontmatter[propertyName],
        ).filter(
          (reference) => !this.referenceMatchesNode(reference, targetNode),
        );
        this.setFrontmatterReferenceList(frontmatter, propertyName, references);
      },
    );
  }

  private getGraphParentPropertyName(
    frontmatter: Record<string, unknown>,
  ): string {
    return "parent";
  }

  private getGraphReferenceListPropertyName(
    frontmatter: Record<string, unknown>,
    relationKind: GraphReferenceListKind,
  ): string {
    return relationKind;
  }

  private getFrontmatterReferenceList(value: unknown): string[] {
    const values = Array.isArray(value) ? (value as unknown[]) : [value];
    return values.filter(
      (reference): reference is string =>
        typeof reference === "string" && reference.trim().length > 0,
    );
  }

  private setFrontmatterReferenceList(
    frontmatter: Record<string, unknown>,
    propertyName: string,
    references: string[],
  ): void {
    const dedupedReferences = this.dedupeReferences(references);
    if (dedupedReferences.length === 0) {
      delete frontmatter[propertyName];
      return;
    }
    frontmatter[propertyName] = dedupedReferences;
  }

  private dedupeReferences(references: string[]): string[] {
    const seenKeys = new Set<string>();
    const result: string[] = [];
    for (const reference of references) {
      const key =
        this.normalizeReference(reference) ?? reference.trim().toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      result.push(reference);
    }
    return result;
  }

  private frontmatterReferenceMatchesNode(
    value: unknown,
    node: GraphNode,
  ): boolean {
    return this.getFrontmatterReferenceList(value).some((reference) =>
      this.referenceMatchesNode(reference, node),
    );
  }

  private referenceMatchesNode(reference: string, node: GraphNode): boolean {
    const normalizedReference = this.normalizeReference(reference);
    if (!normalizedReference) return false;
    return this.getNodeIdentities(node).includes(normalizedReference);
  }

  private async persistGraphNodePositions(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      this.pendingGraphPositions.set(node.file.path, {
        x: Math.round(node.x),
        y: Math.round(node.y),
      });
    }

    await Promise.all(
      nodes.map((node) =>
        this.app.fileManager.processFrontMatter(
          node.file,
          (frontmatter: Record<string, unknown>) => {
            frontmatter[GRAPH_POSITION_PROPERTY_X] = Math.round(node.x);
            frontmatter[GRAPH_POSITION_PROPERTY_Y] = Math.round(node.y);
          },
        ),
      ),
    );
  }

  private async toggleGraphCollapse(node: GraphNode): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter[GRAPH_COLLAPSED_PROPERTY] = !node.collapsed;
      },
    );
    this.render();
  }

  private showCanvasCreateMenu(event: MouseEvent, canvasEl: HTMLElement): void {
    const targetEl = event.target instanceof Element ? event.target : null;
    if (
      targetEl?.closest(
        ".base-board-graph-node, .base-board-graph-edge-hit-target, .base-board-graph-edge-handle, button, input, textarea, select",
      )
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const point = this.canvasToWorldPoint(
      this.getGraphPointFromElement(event, canvasEl),
    );
    const menu = new Menu();
    this.addGraphCreateMenuItems(menu, null, point);

    menu.showAtMouseEvent(event);
  }

  private addGraphCreateMenuItems(
    menu: Menu,
    sourceNode: GraphNode | null,
    point?: { x: number; y: number },
  ): void {
    menu.addItem((item) => {
      item
        .setTitle("Add node")
        .setIcon("lucide-plus")
        .onClick(() => {
          this.showAddNodeModal(sourceNode, point);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Add template")
        .setIcon("lucide-layout-template")
        .onClick(() => {
          this.showAddTemplateModal(sourceNode, point);
        });
    });
  }

  private showAddNodeModal(
    sourceNode: GraphNode | null,
    point?: { x: number; y: number },
  ): void {
    new GraphNodeModal(
      this.app,
      sourceNode ? "Add child node" : "Add node",
      (value) => {
        if (sourceNode) {
          void this.createChildNode(sourceNode, value.title, value.type);
        } else if (point) {
          void this.createStandaloneNode(value.type, value.title, point);
        }
      },
    ).open();
  }

  private showAddTemplateModal(
    sourceNode: GraphNode | null,
    point?: { x: number; y: number },
  ): void {
    const templates = sourceNode
      ? this.getScopedTemplateDefinitions(sourceNode)
      : GRAPH_TEMPLATE_DEFINITIONS;
    new GraphTemplateModal(this.app, templates, (template) => {
      if (sourceNode) {
        this.promptInsertTemplate(sourceNode, template.id);
      } else if (point) {
        this.promptInsertRootTemplate(template.id, point);
      }
    }).open();
  }

  private async createStandaloneNode(
    type: string,
    title: string,
    point: { x: number; y: number },
  ): Promise<void> {
    const safeTitle = title.trim();
    if (!safeTitle) return;
    this.expandGraphWorldForRect(
      this.getTemplateInsertionWorldBounds(point),
      this.getGraphViewportEl(),
    );
    await this.createTemplateNode({
      title: safeTitle,
      type,
      workflow: this.getWorkflowForNodeType(type),
      status: type === "feature" ? "In Progress" : "To Do",
      tags: this.visibleNodes[0] ? this.getTags(this.visibleNodes[0].file) : [],
      x: point.x,
      y: point.y,
    });
    new Notice(`Created ${safeTitle}`);
  }

  private async createChildNode(
    sourceNode: GraphNode,
    title: string,
    type: string,
  ): Promise<void> {
    const safeTitle = title.trim();
    if (!safeTitle) return;
    await this.createTemplateNode({
      title: safeTitle,
      type,
      workflow: this.getWorkflowForNodeType(type),
      status: type === "feature" ? "In Progress" : "To Do",
      parent: this.getWikiLink(sourceNode.file),
      tags: this.getTags(sourceNode.file),
    });
    new Notice(`Created ${safeTitle}`);
  }

  private promptInsertRootTemplate(
    template: GraphWorkflowTemplate,
    point: { x: number; y: number },
  ): void {
    const title = this.getRootTemplatePromptTitle(template);
    const placeholder = this.getRootTemplatePlaceholder(template);
    new InputModal(
      this.app,
      title,
      placeholder,
      (value) => {
        void this.insertRootTemplate(template, value, point);
      },
      placeholder,
    ).open();
  }

  private getRootTemplatePromptTitle(template: GraphWorkflowTemplate): string {
    return this.getTemplatePromptTitle(template);
  }

  private getRootTemplatePlaceholder(template: GraphWorkflowTemplate): string {
    if (template === "iteration") return "Iteration 1";
    if (template === "dev") return "dev";
    if (template === "rollout-repo") return "rollout";
    if (template === "ring-flagged" || template === "ring-basic") {
      return "ring";
    }
    return "New feature";
  }

  private async insertRootTemplate(
    template: GraphWorkflowTemplate,
    rawTitle: string,
    point: { x: number; y: number },
  ): Promise<void> {
    const title = rawTitle.trim();
    if (!title) return;
    this.expandGraphWorldForRect(
      this.getTemplateInsertionWorldBounds(point),
      this.getGraphViewportEl(),
    );
    try {
      if (template === "feature-simple" || template === "feature-detailed") {
        await this.insertFeatureTemplate(null, title, {
          detailed: template === "feature-detailed",
          point,
        });
      } else if (template === "iteration") {
        await this.insertIterationTemplate(null, title, { point });
      } else if (template === "dev") {
        await this.insertDevTemplate(null, title, { point });
      } else if (template === "rollout-repo") {
        await this.insertRolloutRepoTemplate(null, title, { point });
      } else if (template === "ring-flagged") {
        await this.insertRingStepsTemplate(null, title, true, { point });
      } else {
        await this.insertRingStepsTemplate(null, title, false, { point });
      }
    } catch (error) {
      console.error("Failed to insert graph template", error);
      new Notice(`Failed to insert ${title}`);
      return;
    }
    new Notice(`Inserted ${title}`);
  }

  private showNodeContextMenu(event: MouseEvent, sourceNode: GraphNode): void {
    event.preventDefault();
    event.stopPropagation();

    const menu = new Menu();
    this.addGraphCreateMenuItems(menu, sourceNode);
    menu.addSeparator();
    // Work-node operations are only valid on leaf (work) nodes. Group nodes
    // derive their state from their children (GRAPH_SEMANTICS_SPEC.md); their
    // one allowed action is Prune (Cancel sub-graph).
    if (sourceNode.children.length === 0) {
      menu.addItem((item) => {
        item
          .setTitle("Set as active work")
          .setIcon("lucide-play")
          .onClick(() => {
            void this.makeNodeActive(sourceNode);
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Mark as complete")
          .setIcon("lucide-check")
          .onClick(() => {
            void this.markNodeComplete(sourceNode);
          });
      });
      menu.addItem((item) => {
        item
          .setTitle("Mark as failed")
          .setIcon("lucide-ban")
          .onClick(() => {
            void this.markNodeFailed(sourceNode);
          });
      });
    } else {
      menu.addItem((item) => {
        item
          .setTitle("Prune (cancel sub-graph)")
          .setIcon("lucide-scissors")
          .onClick(() => {
            void this.pruneGroup(sourceNode);
          });
      });
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Show state history")
        .setIcon("lucide-history")
        .onClick(() => {
          this.showNodeHistory(sourceNode);
        });
    });
    menu.addSeparator();
    const subtreeCount = 1 + this.getDownstreamGraphNodes(sourceNode).length;
    menu.addItem((item) => {
      item
        .setTitle(`Delete node and descendants (${subtreeCount})`)
        .setIcon("lucide-trash")
        .onClick(() => {
          void this.deleteDownstreamGraphNodes(sourceNode);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete node")
        .setIcon("lucide-trash-2")
        .onClick(() => {
          void this.deleteGraphNode(sourceNode);
        });
    });

    menu.showAtMouseEvent(event);
  }

  private getScopedTemplateDefinitions(
    node: GraphNode,
  ): GraphTemplateDefinition[] {
    const nodeType = node.nodeType?.toLowerCase() ?? "";
    const workflow = node.workflow?.toLowerCase() ?? "";
    const title = node.title.toLowerCase();

    if (nodeType === "feature") {
      return this.getGraphTemplateDefinitionsById(["iteration"]);
    }
    if (nodeType === "iteration") {
      return this.getGraphTemplateDefinitionsById(["dev", "rollout-repo"]);
    }
    if (nodeType === "dev" || workflow === "dev" || workflow === "loop") {
      return this.getGraphTemplateDefinitionsById(["dev"]);
    }
    if (nodeType === "rollout" || workflow === "rollout") {
      return this.getGraphTemplateDefinitionsById(["rollout-repo"]);
    }
    if (
      ["stage", "canary", "pilot", "broad"].some((ring) => title.includes(ring))
    ) {
      return this.getGraphTemplateDefinitionsById([
        "ring-flagged",
        "ring-basic",
      ]);
    }

    return GRAPH_TEMPLATE_DEFINITIONS;
  }

  private getGraphTemplateDefinitionsById(
    ids: GraphWorkflowTemplate[],
  ): GraphTemplateDefinition[] {
    return ids
      .map((id) =>
        GRAPH_TEMPLATE_DEFINITIONS.find((template) => template.id === id),
      )
      .filter(
        (template): template is GraphTemplateDefinition =>
          template !== undefined,
      );
  }

  private promptInsertTemplate(
    sourceNode: GraphNode,
    template: GraphWorkflowTemplate,
  ): void {
    const title = this.getTemplatePromptTitle(template);
    const placeholder = this.getTemplatePlaceholder(template, sourceNode);
    new InputModal(
      this.app,
      title,
      placeholder,
      (value) => {
        void this.insertWorkflowTemplate(sourceNode, template, value);
      },
      placeholder,
    ).open();
  }

  private getTemplatePromptTitle(template: GraphWorkflowTemplate): string {
    if (template === "feature-simple") return "Insert simple feature";
    if (template === "feature-detailed") return "Insert detailed feature";
    if (template === "dev") return "Insert dev template";
    if (template === "rollout-repo") return "Insert rollout repo";
    if (template === "ring-flagged") return "Insert flagged ring steps";
    if (template === "ring-basic") return "Insert basic ring steps";
    return "Insert next iteration";
  }

  private getTemplatePlaceholder(
    template: GraphWorkflowTemplate,
    sourceNode: GraphNode,
  ): string {
    if (template === "feature-simple" || template === "feature-detailed") {
      return `${sourceNode.title} feature`;
    }
    if (template === "dev") return `${sourceNode.title} dev`;
    if (template === "rollout-repo") return `${sourceNode.title} repo`;
    if (template === "ring-flagged" || template === "ring-basic") {
      return sourceNode.title;
    }
    return `${sourceNode.title} Iteration ${this.getNextIterationNumber(sourceNode)}`;
  }

  private getNextIterationNumber(sourceNode: GraphNode): number {
    const iterationNumbers = sourceNode.children
      .map((child) => this.getIterationNumber(child))
      .filter((value): value is number => value !== null);
    return iterationNumbers.length > 0 ? Math.max(...iterationNumbers) + 1 : 1;
  }

  private getIterationNumber(node: GraphNode): number | null {
    const frontmatter = this.getFrontmatter(node.file);
    const rawNumber = frontmatter?.iteration_number;
    if (typeof rawNumber === "number" && Number.isFinite(rawNumber)) {
      return rawNumber;
    }
    if (typeof rawNumber === "string") {
      const parsed = Number.parseInt(rawNumber, 10);
      if (Number.isFinite(parsed)) return parsed;
    }

    const match = node.title.match(/\biteration\s+(\d+)\b/i);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  private async insertWorkflowTemplate(
    sourceNode: GraphNode,
    template: GraphWorkflowTemplate,
    rawTitle: string,
  ): Promise<void> {
    const title = rawTitle.trim();
    if (!title) return;

    if (template === "feature-simple" || template === "feature-detailed") {
      await this.insertFeatureTemplate(sourceNode, title, {
        detailed: template === "feature-detailed",
      });
    } else if (template === "iteration") {
      await this.insertIterationTemplate(sourceNode, title);
    } else if (template === "dev") {
      await this.insertDevTemplate(sourceNode, title);
    } else if (template === "rollout-repo") {
      await this.insertRolloutRepoTemplate(sourceNode, title);
    } else if (template === "ring-flagged") {
      await this.insertRingStepsTemplate(sourceNode, title, true);
    } else {
      await this.insertRingStepsTemplate(sourceNode, title, false);
    }

    new Notice(`Inserted ${title}`);
  }

  private async insertFeatureTemplate(
    sourceNode: GraphNode | null,
    title: string,
    options: { detailed: boolean; point?: { x: number; y: number } },
  ): Promise<void> {
    const origin = this.getTemplateOrigin(sourceNode, options.point);
    const feature = await this.createTemplateNode({
      title,
      type: "feature",
      status: "In Progress",
      parent: sourceNode ? this.getWikiLink(sourceNode.file) : undefined,
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      x: origin.x,
      y: origin.y,
    });

    const featureNode = this.getSyntheticTemplateNode(
      feature,
      title,
      "feature",
    );
    const dev = await this.createTemplateNode({
      title: `${title} - dev`,
      displayTitle: "dev",
      type: "dev",
      workflow: "dev",
      status: "To Do",
      parent: this.getWikiLink(feature),
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, -0.5, 1),
    });

    if (options.detailed) {
      await this.insertDevTemplate(
        this.getSyntheticTemplateNode(
          dev,
          `${title} - dev`,
          "dev",
          "dev",
          this.getTemplateChildPosition(origin, -0.5, 1),
        ),
        `${title} - dev`,
      );
    }

    const rollout = await this.createTemplateNode({
      title: `${title} - rollout`,
      displayTitle: "rollout",
      type: "rollout",
      workflow: "rollout",
      status: "To Do",
      parent: this.getWikiLink(feature),
      dependsOn: [this.getWikiLink(dev)],
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, 0.5, 1),
    });

    if (options.detailed) {
      await this.insertRolloutRepoTemplate(
        this.getSyntheticTemplateNode(
          rollout,
          `${title} - rollout`,
          "rollout",
          "rollout",
          this.getTemplateChildPosition(origin, 0.5, 1),
        ),
        `${title} - repo`,
      );
    }

    featureNode.children = [];
  }

  private async insertIterationTemplate(
    sourceNode: GraphNode | null,
    title: string,
    options: { point?: { x: number; y: number } } = {},
  ): Promise<TFile> {
    const origin = this.getTemplateOrigin(sourceNode, options.point);
    const iterationNumber = sourceNode
      ? this.getNextIterationNumber(sourceNode)
      : 1;
    const iteration = await this.createTemplateNode({
      title,
      type: "iteration",
      status: "To Do",
      parent: sourceNode ? this.getWikiLink(sourceNode.file) : undefined,
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      x: origin.x,
      y: origin.y,
    });
    await this.app.fileManager.processFrontMatter(
      iteration,
      (frontmatter: Record<string, unknown>) => {
        frontmatter.iteration_number = iterationNumber;
      },
    );

    const dev = await this.createTemplateNode({
      title: `${title} - dev`,
      displayTitle: "dev",
      type: "dev",
      workflow: "dev",
      status: "To Do",
      parent: this.getWikiLink(iteration),
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, -0.5, 1),
    });

    await this.createTemplateNode({
      title: `${title} - rollout`,
      displayTitle: "rollout",
      type: "rollout",
      workflow: "rollout",
      status: "To Do",
      parent: this.getWikiLink(iteration),
      dependsOn: [this.getWikiLink(dev)],
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, 0.5, 1),
    });

    return iteration;
  }

  private async insertDevTemplate(
    sourceNode: GraphNode | null,
    title: string,
    options: { point?: { x: number; y: number } } = {},
  ): Promise<void> {
    const origin = this.getTemplateOrigin(sourceNode, options.point);
    const parentNode =
      sourceNode &&
      (sourceNode.nodeType?.toLowerCase() === "dev" ||
        sourceNode.workflow?.toLowerCase() === "dev")
        ? sourceNode
        : this.getSyntheticTemplateNode(
            await this.createTemplateNode({
              title,
              displayTitle: title,
              type: "dev",
              workflow: "dev",
              status: "To Do",
              parent: sourceNode
                ? this.getWikiLink(sourceNode.file)
                : undefined,
              tags: sourceNode
                ? this.getTags(sourceNode.file)
                : this.getRootTags(),
              x: origin.x,
              y: origin.y,
            }),
            title,
            "dev",
            "dev",
            origin,
          );

    const design = await this.createTemplateNode({
      title: `${title} - design`,
      displayTitle: "design",
      type: "design",
      status: "To Do",
      parent: this.getWikiLink(parentNode.file),
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, -1, 1),
    });
    const implementation = await this.createTemplateNode({
      title: `${title} - implementation`,
      displayTitle: "implementation",
      type: "implementation",
      status: "To Do",
      parent: this.getWikiLink(parentNode.file),
      dependsOn: [this.getWikiLink(design)],
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, 0, 1),
    });
    await this.createTemplateNode({
      title: `${title} - review`,
      displayTitle: "review",
      type: "review",
      status: "To Do",
      parent: this.getWikiLink(parentNode.file),
      dependsOn: [this.getWikiLink(implementation)],
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, 1, 1),
    });
  }

  private async insertRolloutRepoTemplate(
    sourceNode: GraphNode | null,
    title: string,
    options: { point?: { x: number; y: number } } = {},
  ): Promise<TFile> {
    const origin = this.getTemplateOrigin(sourceNode, options.point);
    const rolloutNode =
      sourceNode &&
      (sourceNode.nodeType?.toLowerCase() === "rollout" ||
        sourceNode.workflow?.toLowerCase() === "rollout")
        ? sourceNode
        : this.getSyntheticTemplateNode(
            await this.createTemplateNode({
              title,
              displayTitle: title,
              type: "rollout",
              workflow: "rollout",
              status: "To Do",
              parent: sourceNode
                ? this.getWikiLink(sourceNode.file)
                : undefined,
              tags: sourceNode
                ? this.getTags(sourceNode.file)
                : this.getRootTags(),
              x: origin.x,
              y: origin.y,
            }),
            title,
            "rollout",
            "rollout",
            origin,
          );

    const repo = await this.createTemplateNode({
      title: `${title} - repo`,
      displayTitle: "repo",
      type: "repo",
      status: "To Do",
      parent: this.getWikiLink(rolloutNode.file),
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, 0, 1),
    });

    let previousRing: TFile | null = null;
    const rings = ["stage", "canary", "pilot", "broad"];
    for (let index = 0; index < rings.length; index++) {
      const ring = rings[index];
      const ringFile = await this.createTemplateNode({
        title: `${title} - ${ring}`,
        displayTitle: ring,
        type: ring,
        status: "To Do",
        parent: this.getWikiLink(repo),
        dependsOn: previousRing ? [this.getWikiLink(previousRing)] : undefined,
        tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
        ...this.getTemplateChildPosition(origin, index - 1.5, 2),
      });
      previousRing = ringFile;
    }

    return repo;
  }

  private async insertRingStepsTemplate(
    sourceNode: GraphNode | null,
    title: string,
    includeFlag: boolean,
    options: { point?: { x: number; y: number } } = {},
  ): Promise<void> {
    const origin = this.getTemplateOrigin(sourceNode, options.point);
    const ringNode = sourceNode
      ? sourceNode
      : this.getSyntheticTemplateNode(
          await this.createTemplateNode({
            title,
            displayTitle: title,
            type: "ring",
            status: "To Do",
            tags: this.getRootTags(),
            x: origin.x,
            y: origin.y,
          }),
          title,
          "ring",
          null,
          origin,
        );

    const awaitBuild = await this.createTemplateNode({
      title: `${title} - await build rollout`,
      displayTitle: "await build rollout",
      type: "await",
      status: "To Do",
      parent: this.getWikiLink(ringNode.file),
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, includeFlag ? -1.5 : -0.5, 1),
    });

    let previous = awaitBuild;
    if (includeFlag) {
      const enableFlag = await this.createTemplateNode({
        title: `${title} - enable feature flag`,
        displayTitle: "enable feature flag",
        type: "enable",
        status: "To Do",
        parent: this.getWikiLink(ringNode.file),
        dependsOn: [this.getWikiLink(previous)],
        tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
        ...this.getTemplateChildPosition(origin, -0.5, 1),
      });
      previous = await this.createTemplateNode({
        title: `${title} - await feature flag rollout`,
        displayTitle: "await feature flag rollout",
        type: "await",
        status: "To Do",
        parent: this.getWikiLink(ringNode.file),
        dependsOn: [this.getWikiLink(enableFlag)],
        tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
        ...this.getTemplateChildPosition(origin, 0.5, 1),
      });
    }

    await this.createTemplateNode({
      title: `${title} - verify`,
      displayTitle: "verify",
      type: "verify",
      status: "To Do",
      parent: this.getWikiLink(ringNode.file),
      dependsOn: [this.getWikiLink(previous)],
      tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
      ...this.getTemplateChildPosition(origin, includeFlag ? 1.5 : 0.5, 1),
    });
  }

  private getSyntheticTemplateNode(
    file: TFile,
    title: string,
    nodeType: string,
    workflow: string | null = null,
    position: { x: number; y: number } = { x: 0, y: 0 },
  ): GraphNode {
    return {
      entry: {} as BasesEntry,
      file,
      title,
      status: "To Do",
      parentKey: null,
      parentValue: null,
      dependsOnKeys: [],
      breaksToKeys: [],
      restartsToKeys: [],
      nodeType,
      workflow,
      collapsed: false,
      descendantCount: 0,
      children: [],
      successors: [],
      predecessors: [],
      breakTargets: [],
      restartTargets: [],
      x: position.x,
      y: position.y,
      savedX: null,
      savedY: null,
      state: "idle",
    };
  }

  private getWorkflowForNodeType(type: string): string | undefined {
    if (type === "dev" || type === "rollout") return type;
    return undefined;
  }

  private getTemplateOrigin(
    sourceNode: GraphNode | null,
    point: { x: number; y: number } | undefined,
  ): { x: number; y: number } {
    const origin =
      point ??
      (!sourceNode
        ? { x: 0, y: 0 }
        : {
            x: sourceNode.x,
            y:
              sourceNode.y +
              this.getRenderedGraphNodeSize(sourceNode).height +
              GRAPH_TEMPLATE_CHILD_Y_STEP,
          });
    this.expandGraphWorldForRect(
      this.getTemplateInsertionWorldBounds(origin),
      this.getGraphViewportEl(),
    );
    return origin;
  }

  private getTemplateChildPosition(
    origin: { x: number; y: number },
    horizontalSlot: number,
    depth: number,
  ): { x: number; y: number } {
    return {
      x: origin.x + horizontalSlot * GRAPH_TEMPLATE_CHILD_X_STEP,
      y: origin.y + depth * GRAPH_TEMPLATE_CHILD_Y_STEP,
    };
  }

  private getRootTags(): string[] {
    return this.visibleNodes[0] ? this.getTags(this.visibleNodes[0].file) : [];
  }

  private async createTemplateNode(options: {
    title: string;
    displayTitle?: string;
    type: string;
    status: string;
    parent?: string;
    workflow?: string;
    dependsOn?: string[];
    tags?: string[];
    x?: number;
    y?: number;
  }): Promise<TFile> {
    const safeTitle = sanitizeFilename(options.title.trim());
    const displayTitle = (options.displayTitle ?? options.title).trim();
    const folder = this.visibleNodes[0]?.file.parent?.path ?? "";
    const filePath = await this.getAvailableFilePath(folder, safeTitle);
    const lines = [
      "---",
      `title: ${this.formatYamlScalar(displayTitle)}`,
      `status: ${this.formatYamlScalar(options.status)}`,
      `type: ${this.formatYamlScalar(options.type)}`,
      `kanban_order: ${this.getNextOrder(options.status)}`,
      `graph_order: ${this.getNextOrder(options.status)}`,
      `created: ${new Date().toISOString()}`,
      `id: ${this.getGeneratedId(options.title)}`,
    ];
    if (options.workflow) {
      lines.push(`workflow: ${this.formatYamlScalar(options.workflow)}`);
    }
    if (options.parent) {
      lines.push(`parent: ${this.formatYamlScalar(options.parent)}`);
    }
    if (typeof options.x === "number" && Number.isFinite(options.x)) {
      lines.push(`graph_x: ${Math.round(options.x)}`);
    }
    if (typeof options.y === "number" && Number.isFinite(options.y)) {
      lines.push(`graph_y: ${Math.round(options.y)}`);
    }
    if (options.dependsOn && options.dependsOn.length > 0) {
      lines.push("depends_on:");
      for (const dependency of options.dependsOn) {
        lines.push(`  - ${this.formatYamlScalar(dependency)}`);
      }
    }
    if (options.tags && options.tags.length > 0) {
      lines.push("tags:");
      for (const tag of options.tags) {
        lines.push(`  - ${this.formatYamlScalar(tag)}`);
      }
    }
    lines.push("---", "", `# ${displayTitle}`, "", "## Notes", "");
    await this.snapshotForUndo(filePath);
    await this.app.vault.create(filePath, lines.join("\n"));
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      throw new Error(
        `Created graph node was not a markdown file: ${filePath}`,
      );
    }
    return file;
  }

  private promptCreateRelatedNode(
    sourceNode: GraphNode,
    relation: GraphRelationKind,
  ): void {
    const title =
      relation === "requirement" ? "Add requirement" : "Add gated successor";
    const placeholder =
      relation === "requirement" ? "Debug exception" : "Canary rollout";
    new InputModal(this.app, title, placeholder, (value) => {
      void this.createRelatedNode(sourceNode, relation, value);
    }).open();
  }

  private async createRelatedNode(
    sourceNode: GraphNode,
    relation: GraphRelationKind,
    title: string,
  ): Promise<void> {
    const safeTitle = sanitizeFilename(title.trim());
    if (!safeTitle) return;

    const folder = sourceNode.file.parent?.path ?? "";
    const filePath = await this.getAvailableFilePath(folder, safeTitle);
    const status = this.getDefaultNewNodeStatus();
    const frontmatterLines = this.getNewNodeFrontmatter(
      sourceNode,
      relation,
      title.trim(),
      status,
    );
    const content = [
      "---",
      ...frontmatterLines,
      "---",
      "",
      `# ${title.trim()}`,
      "",
      "## Notes",
      "",
    ].join("\n");

    await this.app.vault.create(filePath, content);
    new Notice(`Created ${title.trim()}`);
  }

  private getNewNodeFrontmatter(
    sourceNode: GraphNode,
    relation: GraphRelationKind,
    title: string,
    status: string,
  ): string[] {
    const parentValue =
      relation === "requirement"
        ? this.getWikiLink(sourceNode.file)
        : (sourceNode.parentValue ?? null);
    const lines = [
      "type: task",
      `status: ${this.formatYamlScalar(status)}`,
      `kanban_order: ${this.getNextOrder(status)}`,
      `created: ${new Date().toISOString()}`,
      `id: ${this.getGeneratedId(title)}`,
    ];

    if (parentValue) {
      lines.push(`parent: ${this.formatYamlScalar(parentValue)}`);
    }
    if (relation === "successor") {
      lines.push("depends_on:");
      lines.push(
        `  - ${this.formatYamlScalar(this.getWikiLink(sourceNode.file))}`,
      );
    }

    const tags = this.getTags(sourceNode.file);
    if (tags.length > 0) {
      lines.push("tags:");
      for (const tag of tags) {
        lines.push(`  - ${this.formatYamlScalar(tag)}`);
      }
    }

    return lines;
  }

  private getGraphNodes(): GraphNode[] {
    const entries: BasesEntry[] = this.data?.data ?? [];
    const nodes: GraphNode[] = [];
    for (const entry of entries) {
      const file = entry.file;
      if (!(file instanceof TFile)) continue;
      nodes.push({
        entry,
        file,
        title: this.getTitle(entry, file),
        status: this.getCurrentStatus(file),
        parentKey: this.getParentKey(file),
        parentValue: this.getParentDisplayValue(file),
        dependsOnKeys: this.getDependsOnKeys(file),
        breaksToKeys: this.getBreaksToKeys(file),
        restartsToKeys: this.getRestartsToKeys(file),
        nodeType: this.getNodeType(file),
        workflow: this.getWorkflow(file),
        collapsed: this.isGraphCollapsed(file),
        descendantCount: 0,
        children: [],
        successors: [],
        predecessors: [],
        breakTargets: [],
        restartTargets: [],
        x: 0,
        y: 0,
        savedX: this.getSavedGraphPosition(file, GRAPH_POSITION_PROPERTY_X),
        savedY: this.getSavedGraphPosition(file, GRAPH_POSITION_PROPERTY_Y),
        state: "idle",
      });
    }

    const nodesByIdentity = new Map<string, GraphNode>();
    for (const node of nodes) {
      for (const identity of this.getNodeIdentities(node)) {
        nodesByIdentity.set(identity, node);
      }
    }

    for (const node of nodes) {
      if (node.parentKey) {
        const parent = nodesByIdentity.get(node.parentKey);
        if (parent && parent.file.path !== node.file.path) {
          parent.children.push(node);
        }
      }
      for (const dependencyKey of node.dependsOnKeys) {
        const dependency = nodesByIdentity.get(dependencyKey);
        if (!dependency || dependency.file.path === node.file.path) continue;
        dependency.successors.push(node);
        node.predecessors.push(dependency);
      }
      for (const restartKey of node.restartsToKeys) {
        const restartTarget = nodesByIdentity.get(restartKey);
        if (!restartTarget || restartTarget.file.path === node.file.path) {
          continue;
        }
        node.restartTargets.push(restartTarget);
        node.successors.push(restartTarget);
      }
      for (const breakKey of node.breaksToKeys) {
        const breakTarget = nodesByIdentity.get(breakKey);
        if (!breakTarget || breakTarget.file.path === node.file.path) {
          continue;
        }
        node.breakTargets.push(breakTarget);
      }
    }

    for (const node of nodes) {
      node.children.sort((first, second) => this.compareNodes(first, second));
      node.successors.sort((first, second) => this.compareNodes(first, second));
      node.predecessors.sort((first, second) =>
        this.compareNodes(first, second),
      );
    }

    for (const node of nodes) {
      node.descendantCount = this.getDescendantCount(node);
    }

    this.assignNodeStates(nodes);
    return this.getVisibleGraphNodes(nodes);
  }

  private getVisibleGraphNodes(nodes: GraphNode[]): GraphNode[] {
    const hiddenPaths = new Set<string>();
    for (const node of nodes) {
      if (!node.collapsed) continue;
      this.collectCollapsedDescendantPaths(node, hiddenPaths);
    }

    const visibleNodes = nodes.filter(
      (node) => !hiddenPaths.has(node.file.path),
    );
    const visiblePaths = new Set(visibleNodes.map((node) => node.file.path));
    for (const node of visibleNodes) {
      node.children = node.children.filter((child) =>
        visiblePaths.has(child.file.path),
      );
      node.successors = node.successors.filter((successor) =>
        visiblePaths.has(successor.file.path),
      );
      node.predecessors = node.predecessors.filter((predecessor) =>
        visiblePaths.has(predecessor.file.path),
      );
      node.breakTargets = node.breakTargets.filter((target) =>
        visiblePaths.has(target.file.path),
      );
      node.restartTargets = node.restartTargets.filter((target) =>
        visiblePaths.has(target.file.path),
      );
    }

    return visibleNodes;
  }

  private collectCollapsedDescendantPaths(
    node: GraphNode,
    hiddenPaths: Set<string>,
  ): void {
    for (const child of node.children) {
      if (hiddenPaths.has(child.file.path)) continue;
      hiddenPaths.add(child.file.path);
      this.collectCollapsedDescendantPaths(child, hiddenPaths);
    }
  }

  private getDescendantCount(node: GraphNode): number {
    const visitedPaths = new Set<string>();
    const visit = (current: GraphNode): number => {
      let count = 0;
      for (const child of current.children) {
        if (visitedPaths.has(child.file.path)) continue;
        visitedPaths.add(child.file.path);
        count += 1 + visit(child);
      }
      return count;
    };
    return visit(node);
  }

  private layoutGraph(nodes: GraphNode[]): GraphEdge[] {
    const positionedPaths = new Set<string>();
    const roots = nodes
      .filter((node) => !this.getResolvedParent(node, nodes))
      .sort((first, second) => this.compareNodes(first, second));
    let nextY = 48;
    for (const chain of this.getSiblingChains(roots)) {
      let chainBottom = nextY + NODE_MIN_HEIGHT;
      const chainWidth = this.getChainWidth(chain);
      let nextCenterX = 48 + chainWidth / 2;
      for (let index = 0; index < chain.length; index++) {
        const root = chain[index];
        const rootWidth = this.getSubtreeWidth(root);
        const rootBottom = this.layoutNodeTree(
          root,
          nextCenterX,
          nextY,
          positionedPaths,
        );
        chainBottom = Math.max(chainBottom, rootBottom);
        nextCenterX += rootWidth / 2 + NODE_GAP_X;
        const nextRoot = chain[index + 1];
        if (nextRoot) {
          nextCenterX += this.getSubtreeWidth(nextRoot) / 2;
        }
      }
      nextY = chainBottom + ROOT_GAP;
    }

    for (const node of nodes) {
      if (positionedPaths.has(node.file.path)) continue;
      nextY =
        this.layoutNodeTree(
          node,
          48 + this.getSubtreeWidth(node) / 2,
          nextY,
          positionedPaths,
        ) + ROOT_GAP;
    }

    this.applySavedGraphPositions(nodes);

    // Break edges are DERIVED (GRAPH_SEMANTICS_SPEC.md Layer B): a genuinely
    // failed leaf draws a red break link to its parent group that escalates up
    // the containment chain. These are synthesized from the failed state rather
    // than stored as `breaks_to`, so they appear/disappear as the failure is
    // set/cleared. `brokenParentPaths` are the groups whose canonical return
    // link the active break replaces, so their return link is suppressed.
    const parentByPath = this.getResolvedParentsByPath(nodes);
    const breakEdgeKeys = new Set<string>();
    const derivedBreakEdges: GraphEdge[] = [];
    const brokenParentPaths = new Set<string>();
    for (const node of nodes) {
      if (!this.isGenuinelyFailedStatus(node.status)) continue;
      let child: GraphNode = node;
      let parent = parentByPath.get(child.file.path) ?? null;
      const seen = new Set<string>([child.file.path]);
      while (parent && !seen.has(parent.file.path)) {
        seen.add(parent.file.path);
        brokenParentPaths.add(parent.file.path);
        const key = `${child.file.path}->${parent.file.path}`;
        if (!breakEdgeKeys.has(key)) {
          breakEdgeKeys.add(key);
          derivedBreakEdges.push({ from: child, to: parent, kind: "break" });
        }
        child = parent;
        parent = parentByPath.get(child.file.path) ?? null;
      }
    }

    const edges: GraphEdge[] = [];
    for (const node of nodes) {
      const childChains = this.getSiblingChains(node.children);
      for (const chain of childChains) {
        const firstChild = chain[0];
        const lastChild = chain[chain.length - 1];
        if (firstChild) {
          edges.push({ from: node, to: firstChild, kind: "requirement-start" });
        }
        if (lastChild && !brokenParentPaths.has(node.file.path)) {
          edges.push({
            from: lastChild,
            to: node,
            kind: "requirement-return",
          });
        }
      }
      for (const successor of node.successors) {
        const isRestart = node.restartTargets.some(
          (target) => target.file.path === successor.file.path,
        );
        edges.push({
          from: node,
          to: successor,
          kind: isRestart ? "restart" : "gating",
        });
      }
      // Authored `breaks_to` links only render when the source is genuinely
      // failed (a real triggered break). Dormant authored breaks are not drawn —
      // in the derived model an inactive break is not a real link and must not
      // compete with the canonical return (GRAPH_SEMANTICS_SPEC.md Layer B).
      // Containment escalation is covered by the derived break edges above.
      if (this.isGenuinelyFailedStatus(node.status)) {
        for (const breakTarget of node.breakTargets) {
          const key = `${node.file.path}->${breakTarget.file.path}`;
          if (breakEdgeKeys.has(key)) continue;
          breakEdgeKeys.add(key);
          edges.push({ from: node, to: breakTarget, kind: "break" });
        }
      }
    }
    edges.push(...derivedBreakEdges);
    return edges;
  }

  private layoutNodeTree(
    node: GraphNode,
    centerX: number,
    y: number,
    positionedPaths: Set<string>,
  ): number {
    if (!positionedPaths.has(node.file.path)) {
      node.x = centerX - NODE_WIDTH / 2;
      node.y = y;
      positionedPaths.add(node.file.path);
    }

    const children = node.children.filter(
      (child) => !positionedPaths.has(child.file.path),
    );
    if (children.length === 0) return y + NODE_MIN_HEIGHT;

    let childY = y + Y_STEP;
    const chains = this.getSiblingChains(children);
    for (const chain of chains) {
      let chainBottom = childY + NODE_MIN_HEIGHT;
      const chainWidth = this.getChainWidth(chain);
      let nextCenterX = centerX - chainWidth / 2;
      for (let index = 0; index < chain.length; index++) {
        const child = chain[index];
        const childWidth = this.getSubtreeWidth(child);
        nextCenterX += childWidth / 2;
        const childBottom = this.layoutNodeTree(
          child,
          nextCenterX,
          childY,
          positionedPaths,
        );
        chainBottom = Math.max(chainBottom, childBottom);
        nextCenterX += childWidth / 2 + NODE_GAP_X;
      }
      childY = chainBottom + EDGE_MARGIN * 2;
    }

    return Math.max(childY, y + NODE_MIN_HEIGHT);
  }

  private getSubtreeWidth(
    node: GraphNode,
    visited = new Set<string>(),
  ): number {
    if (visited.has(node.file.path)) return NODE_WIDTH;
    const nextVisited = new Set(visited);
    nextVisited.add(node.file.path);
    const childChains = this.getSiblingChains(node.children);
    if (childChains.length === 0) return NODE_WIDTH;
    const childWidth = Math.max(
      ...childChains.map((chain) => this.getChainWidth(chain, nextVisited)),
    );
    return Math.max(NODE_WIDTH, childWidth);
  }

  private applySavedGraphPositions(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (node.savedX !== null) node.x = node.savedX;
      if (node.savedY !== null) node.y = node.savedY;
    }
  }

  private getChainWidth(
    chain: GraphNode[],
    visited = new Set<string>(),
  ): number {
    if (chain.length === 0) return NODE_WIDTH;
    return chain.reduce((width, node, index) => {
      const nodeWidth = this.getSubtreeWidth(node, visited);
      return width + nodeWidth + (index > 0 ? NODE_GAP_X : 0);
    }, 0);
  }

  private getSiblingChains(children: GraphNode[]): GraphNode[][] {
    const childPaths = new Set(children.map((child) => child.file.path));
    const consumedPaths = new Set<string>();
    const chainStarts = children.filter((child) =>
      child.predecessors.every(
        (predecessor) => !childPaths.has(predecessor.file.path),
      ),
    );
    const starts = chainStarts.length > 0 ? chainStarts : children;
    const chains: GraphNode[][] = [];

    for (const start of starts) {
      if (consumedPaths.has(start.file.path)) continue;
      const chain: GraphNode[] = [];
      let current: GraphNode | undefined = start;
      while (current && !consumedPaths.has(current.file.path)) {
        chain.push(current);
        consumedPaths.add(current.file.path);
        current = current.successors.find(
          (successor) =>
            childPaths.has(successor.file.path) &&
            !consumedPaths.has(successor.file.path),
        );
      }
      chains.push(chain);
    }

    for (const child of children) {
      if (!consumedPaths.has(child.file.path)) chains.push([child]);
    }
    return chains;
  }

  /**
   * Derives every node's visual state (GRAPH_SEMANTICS_SPEC.md Layer A). Leaf
   * (work) nodes take their state from their own stored status — the only
   * source of truth. Group (container) nodes derive their state bottom-up from
   * their children and never read their own stored status. Pure recompute, run
   * on every render; no status is mutated here.
   */
  private assignNodeStates(nodes: GraphNode[]): void {
    const parentByPath = this.getResolvedParentsByPath(nodes);
    const memo = new Map<string, GraphNodeState>();
    const inProgress = new Set<string>();
    for (const node of nodes) {
      node.state = this.deriveNodeState(node, parentByPath, memo, inProgress);
    }
  }

  private deriveNodeState(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
    memo: Map<string, GraphNodeState>,
    inProgress: Set<string>,
  ): GraphNodeState {
    const cached = memo.get(node.file.path);
    if (cached) return cached;
    // Cycle guard: a node referenced while it is still being computed resolves
    // to a neutral state so derivation terminates on malformed graphs.
    if (inProgress.has(node.file.path)) return "idle";
    inProgress.add(node.file.path);

    const state =
      node.children.length > 0
        ? this.deriveGroupState(
            node.children.map((child) =>
              this.deriveNodeState(child, parentByPath, memo, inProgress),
            ),
          )
        : this.deriveLeafState(node, parentByPath, memo, inProgress);

    inProgress.delete(node.file.path);
    memo.set(node.file.path, state);
    return state;
  }

  /**
   * Leaf (work-node) state read from its stored status. A ready leaf with no
   * explicit lifecycle status falls through to the computed active frontier
   * (gating prerequisites satisfied) or `waiting` (prerequisites pending).
   */
  private deriveLeafState(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
    memo: Map<string, GraphNodeState>,
    inProgress: Set<string>,
  ): GraphNodeState {
    if (this.isInvalidatedStatus(node.status)) return "invalidated";
    if (this.isCancelledStatus(node.status)) return "cancelled";
    if (this.isInterruptedStatus(node.status)) return "interrupted";
    if (this.isActiveStatus(node.status)) return "active";
    if (this.isCompletedStatus(node.status)) return "completed";
    if (this.isBlockedStatus(node.status)) return "blocked";
    if (
      !this.areGatingPrerequisitesTerminal(node, parentByPath, memo, inProgress)
    ) {
      return "waiting";
    }
    return "active";
  }

  /**
   * Group-state fold (GRAPH_SEMANTICS_SPEC.md Layer A) over the children's
   * derived states. Precedence (decreasing):
   * In Progress > Completed > Cancelled/Invalidated > Planned.
   */
  private deriveGroupState(childStates: GraphNodeState[]): GraphNodeState {
    if (childStates.length === 0) return "idle";
    const isLive = (state: GraphNodeState): boolean =>
      state === "active" ||
      state === "in-progress" ||
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
    // Mixed completed/planned with no live work: not finished, no active
    // frontier — render as waiting (Planned).
    return "waiting";
  }

  /**
   * True when every gating prerequisite of a node — its own `depends_on`
   * predecessors plus the predecessors of each containment ancestor — is in a
   * terminal DERIVED state. Uses derived states (not stored status) so group
   * prerequisites resolve correctly under the derived model.
   */
  private areGatingPrerequisitesTerminal(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
    memo: Map<string, GraphNodeState>,
    inProgress: Set<string>,
  ): boolean {
    const isTerminal = (state: GraphNodeState): boolean =>
      state === "completed" ||
      state === "interrupted" ||
      state === "invalidated" ||
      state === "cancelled";
    const seen = new Set<string>();
    let current: GraphNode | null = node;
    while (current && !seen.has(current.file.path)) {
      seen.add(current.file.path);
      for (const predecessor of current.predecessors) {
        const state = this.deriveNodeState(
          predecessor,
          parentByPath,
          memo,
          inProgress,
        );
        if (!isTerminal(state)) return false;
      }
      current = parentByPath.get(current.file.path) ?? null;
    }
    return true;
  }

  private getResolvedParentsByPath(nodes: GraphNode[]): Map<string, GraphNode> {
    const nodesByIdentity = new Map<string, GraphNode>();
    for (const node of nodes) {
      for (const identity of this.getNodeIdentities(node)) {
        nodesByIdentity.set(identity, node);
      }
    }

    const parentByPath = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (!node.parentKey) continue;
      const parent = nodesByIdentity.get(node.parentKey);
      if (!parent || parent.file.path === node.file.path) continue;
      parentByPath.set(node.file.path, parent);
    }
    return parentByPath;
  }

  private getResolvedParent(
    node: GraphNode,
    nodes: GraphNode[],
  ): GraphNode | null {
    if (!node.parentKey) return null;
    const nodesByIdentity = new Map<string, GraphNode>();
    for (const candidate of nodes) {
      for (const identity of this.getNodeIdentities(candidate)) {
        nodesByIdentity.set(identity, candidate);
      }
    }
    return nodesByIdentity.get(node.parentKey) ?? null;
  }

  private getEdgePath(edge: GraphEdge): string {
    return this.getPerpendicularCurvePath(
      this.getEdgeEndpointAnchor(edge, "from"),
      this.getEdgeEndpointAnchor(edge, "to"),
      this.getEdgeMinHandleLength(edge),
    );
  }

  private getEdgeEndpointAnchor(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): GraphAnchorPoint {
    const override = this.graphEndpointAnchorOverrides.get(
      this.getEdgeEndpointOverrideKey(edge, endpoint),
    );
    if (override) {
      return this.getGraphEndpointAnchorFromOverride(
        this.getEdgeEndpointNode(edge, endpoint),
        override,
      );
    }

    return this.getDefaultEdgeEndpointAnchor(edge, endpoint);
  }

  private getDefaultEdgeEndpointAnchor(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): GraphAnchorPoint {
    if (edge.kind === "requirement-start") {
      return endpoint === "from"
        ? this.getSemanticAnchorPoint(edge.from, "bottom", 0.5)
        : this.getSemanticAnchorPoint(edge.to, "top", 0.5);
    }

    if (edge.kind === "gating") {
      const fromCenter = this.getNodeCenter(edge.from);
      const toCenter = this.getNodeCenter(edge.to);
      const isMostlyHorizontal =
        Math.abs(toCenter.x - fromCenter.x) >=
        Math.abs(toCenter.y - fromCenter.y) * 0.75;
      if (isMostlyHorizontal) {
        const fromIsLeft = fromCenter.x <= toCenter.x;
        return endpoint === "from"
          ? this.getSemanticAnchorPoint(
              edge.from,
              fromIsLeft ? "right" : "left",
              2 / 3,
            )
          : this.getSemanticAnchorPoint(
              edge.to,
              fromIsLeft ? "left" : "right",
              2 / 3,
            );
      }

      return endpoint === "from"
        ? this.getSemanticAnchorPoint(
            edge.from,
            fromCenter.y <= toCenter.y ? "bottom" : "top",
            0.5,
          )
        : this.getSemanticAnchorPoint(
            edge.to,
            fromCenter.y <= toCenter.y ? "top" : "bottom",
            0.5,
          );
    }

    const lane = this.getEdgeAnchorLane(edge);
    if (endpoint === "from") {
      return this.getNodeAnchorPoint(edge.from, edge.to, "out", lane);
    }
    return this.getNodeAnchorPoint(edge.to, edge.from, "in", lane);
  }

  private getSemanticAnchorPoint(
    node: GraphNode,
    side: GraphAnchorSide,
    ratio: number,
  ): GraphAnchorPoint {
    const nodeSize = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    const clampedRatio = this.clampRatio(ratio);
    if (side === "top") {
      return {
        side,
        x: position.x + nodeSize.width * clampedRatio,
        y: position.y,
      };
    }
    if (side === "bottom") {
      return {
        side,
        x: position.x + nodeSize.width * clampedRatio,
        y: position.y + nodeSize.height,
      };
    }
    if (side === "left") {
      return {
        side,
        x: position.x,
        y: position.y + nodeSize.height * clampedRatio,
      };
    }
    return {
      side,
      x: position.x + nodeSize.width,
      y: position.y + nodeSize.height * clampedRatio,
    };
  }

  private getEdgeEndpointOverrideKey(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
  ): string {
    return [edge.kind, edge.from.file.path, edge.to.file.path, endpoint].join(
      "::",
    );
  }

  private getGraphEndpointAnchorOverride(
    node: GraphNode,
    anchor: GraphAnchorPoint,
  ): GraphEndpointAnchorOverride {
    const nodeSize = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    return {
      side: anchor.side,
      xRatio: this.clampRatio((anchor.x - position.x) / nodeSize.width),
      yRatio: this.clampRatio((anchor.y - position.y) / nodeSize.height),
    };
  }

  private getGraphEndpointAnchorFromOverride(
    node: GraphNode,
    override: GraphEndpointAnchorOverride,
  ): GraphAnchorPoint {
    const nodeSize = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    return {
      side: override.side,
      x: position.x + nodeSize.width * override.xRatio,
      y: position.y + nodeSize.height * override.yRatio,
    };
  }

  private clampRatio(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  }

  private getEdgeAnchorLane(edge: GraphEdge): GraphAnchorLane {
    if (edge.kind === "requirement-return" || edge.kind === "break") {
      return "return";
    }
    if (edge.kind === "restart") return "restart";
    return "normal";
  }

  private getEdgeMinHandleLength(edge: GraphEdge): number {
    if (edge.kind === "restart") return 112;
    if (edge.kind === "break") return 128;
    return 72;
  }

  private getFloatingEdgePath(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    point: { x: number; y: number },
  ): string {
    if (endpoint === "from") {
      const end = this.getEdgeEndpointAnchor(edge, "to");
      const start = {
        ...point,
        side: this.getOppositeAnchorSide(end.side),
      };
      return this.getPerpendicularCurvePath(
        start,
        end,
        this.getEdgeMinHandleLength(edge),
      );
    }

    const start = this.getEdgeEndpointAnchor(edge, "from");
    const end = {
      ...point,
      side: this.getOppositeAnchorSide(start.side),
    };
    return this.getPerpendicularCurvePath(
      start,
      end,
      this.getEdgeMinHandleLength(edge),
    );
  }

  private getOppositeAnchorSide(side: GraphAnchorSide): GraphAnchorSide {
    if (side === "top") return "bottom";
    if (side === "bottom") return "top";
    if (side === "left") return "right";
    return "left";
  }

  private getPerpendicularCurvePath(
    start: GraphAnchorPoint,
    end: GraphAnchorPoint,
    minHandleLength: number,
  ): string {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const handleLength = Math.max(minHandleLength, distance * 0.34);
    const startNormal = this.getAnchorNormal(start.side);
    const endNormal = this.getAnchorNormal(end.side);
    const controlStart = {
      x: start.x + startNormal.x * handleLength,
      y: start.y + startNormal.y * handleLength,
    };
    const controlEnd = {
      x: end.x + endNormal.x * handleLength,
      y: end.y + endNormal.y * handleLength,
    };
    return `M ${start.x} ${start.y} C ${controlStart.x} ${controlStart.y}, ${controlEnd.x} ${controlEnd.y}, ${end.x} ${end.y}`;
  }

  private getAnchorNormal(side: GraphAnchorSide): { x: number; y: number } {
    if (side === "top") return { x: 0, y: -1 };
    if (side === "right") return { x: 1, y: 0 };
    if (side === "bottom") return { x: 0, y: 1 };
    return { x: -1, y: 0 };
  }

  private getNodeAnchorPoint(
    node: GraphNode,
    towardNode: GraphNode,
    direction: "in" | "out",
    lane: GraphAnchorLane,
  ): GraphAnchorPoint {
    const side = this.getNearestAnchorSide(node, towardNode);
    const nodeSize = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    const towardCenter = this.getNodeCenter(towardNode);
    const nodeCenter = this.getNodeCenter(node);
    const horizontalBias = this.getHorizontalAnchorLaneBias(
      node,
      towardNode,
      direction,
      lane,
    );
    const verticalBias = this.getVerticalAnchorLaneBias(
      direction,
      towardCenter.y >= nodeCenter.y,
    );

    if (side === "top") {
      return {
        side,
        x: position.x + nodeSize.width * horizontalBias,
        y: position.y,
      };
    }
    if (side === "bottom") {
      return {
        side,
        x: position.x + nodeSize.width * horizontalBias,
        y: position.y + nodeSize.height,
      };
    }
    if (side === "right") {
      return {
        side,
        x: position.x + nodeSize.width,
        y: position.y + nodeSize.height * verticalBias,
      };
    }
    return {
      side,
      x: position.x,
      y: position.y + nodeSize.height * verticalBias,
    };
  }

  private getHorizontalAnchorLaneBias(
    node: GraphNode,
    towardNode: GraphNode,
    direction: "in" | "out",
    lane: GraphAnchorLane,
  ): number {
    const parentRelation = this.getParentChildRelation(node, towardNode);
    if (parentRelation) {
      const childCenter = this.getNodeCenter(parentRelation.child);
      const parentCenter = this.getNodeCenter(parentRelation.parent);
      const childIsLeftOfParent = childCenter.x < parentCenter.x;
      if (lane === "return") return childIsLeftOfParent ? 0.38 : 0.62;
      if (lane === "restart") return childIsLeftOfParent ? 0.46 : 0.54;
      return childIsLeftOfParent ? 0.18 : 0.82;
    }

    const nodeCenter = this.getNodeCenter(node);
    const towardCenter = this.getNodeCenter(towardNode);
    return this.getDirectionalAnchorLaneBias(
      direction,
      towardCenter.x >= nodeCenter.x,
    );
  }

  private getParentChildRelation(
    node: GraphNode,
    towardNode: GraphNode,
  ): { parent: GraphNode; child: GraphNode } | null {
    if (node.parentKey) {
      for (const identity of this.getNodeIdentities(towardNode)) {
        if (identity === node.parentKey) {
          return { parent: towardNode, child: node };
        }
      }
    }
    if (towardNode.parentKey) {
      for (const identity of this.getNodeIdentities(node)) {
        if (identity === towardNode.parentKey) {
          return { parent: node, child: towardNode };
        }
      }
    }
    return null;
  }

  private getVerticalAnchorLaneBias(
    direction: "in" | "out",
    towardPositiveAxis: boolean,
  ): number {
    return this.getDirectionalAnchorLaneBias(direction, towardPositiveAxis);
  }

  private getDirectionalAnchorLaneBias(
    direction: "in" | "out",
    towardPositiveAxis: boolean,
  ): number {
    if (direction === "in") return towardPositiveAxis ? 0.4 : 0.6;
    return towardPositiveAxis ? 0.72 : 0.28;
  }

  private getNearestAnchorSide(
    node: GraphNode,
    towardNode: GraphNode,
  ): GraphAnchorSide {
    const nodeCenter = this.getNodeCenter(node);
    const towardCenter = this.getNodeCenter(towardNode);
    const deltaX = towardCenter.x - nodeCenter.x;
    const deltaY = towardCenter.y - nodeCenter.y;
    const nodeSize = this.getRenderedGraphNodeSize(node);
    if (
      Math.abs(deltaX) / nodeSize.width >
      Math.abs(deltaY) / nodeSize.height
    ) {
      return deltaX >= 0 ? "right" : "left";
    }
    return deltaY >= 0 ? "bottom" : "top";
  }

  private getNodeCenter(node: GraphNode): { x: number; y: number } {
    const nodeSize = this.getRenderedGraphNodeSize(node);
    const position = this.getNodeCanvasPosition(node);
    return {
      x: position.x + nodeSize.width / 2,
      y: position.y + nodeSize.height / 2,
    };
  }

  private getRenderedGraphNodeSize(node: GraphNode): {
    width: number;
    height: number;
  } {
    const nodeEl = this.getRenderedGraphNodeEl(node);
    return {
      width: nodeEl?.offsetWidth ?? NODE_WIDTH,
      height: nodeEl?.offsetHeight ?? NODE_MIN_HEIGHT,
    };
  }

  private getNodeCanvasPosition(node: GraphNode): { x: number; y: number } {
    return this.worldToCanvasPoint({ x: node.x, y: node.y });
  }

  private positionRenderedGraphNodeEl(
    nodeEl: HTMLElement,
    node: GraphNode,
  ): void {
    const position = this.getNodeCanvasPosition(node);
    nodeEl.style.left = `${position.x}px`;
    nodeEl.style.top = `${position.y}px`;
  }

  private positionRenderedGraphNodes(): void {
    for (const node of this.visibleNodes) {
      const nodeEl = this.getRenderedGraphNodeEl(node);
      if (!nodeEl) continue;
      this.positionRenderedGraphNodeEl(nodeEl, node);
    }
  }

  private worldToCanvasPoint(point: { x: number; y: number }): {
    x: number;
    y: number;
  } {
    const world = this.graphWorldBounds;
    if (!world) return point;
    return {
      x: point.x - world.minX,
      y: point.y - world.minY,
    };
  }

  private canvasToWorldPoint(point: { x: number; y: number }): {
    x: number;
    y: number;
  } {
    const world = this.graphWorldBounds;
    if (!world) return point;
    return {
      x: point.x + world.minX,
      y: point.y + world.minY,
    };
  }

  private getViewportWorldPoint(
    viewportEl: HTMLElement,
    viewportX: number,
    viewportY: number,
    zoom = this.graphZoom,
  ): { x: number; y: number } {
    return this.canvasToWorldPoint({
      x:
        (viewportEl.scrollLeft +
          viewportX -
          this.getGraphPanMarginX(viewportEl)) /
        zoom,
      y:
        (viewportEl.scrollTop +
          viewportY -
          this.getGraphPanMarginY(viewportEl)) /
        zoom,
    });
  }

  private scrollViewportToWorldPoint(
    viewportEl: HTMLElement,
    worldPoint: { x: number; y: number },
    viewportX: number,
    viewportY: number,
  ): void {
    const canvasPoint = this.worldToCanvasPoint(worldPoint);
    viewportEl.scrollLeft = Math.max(
      0,
      this.getGraphPanMarginX(viewportEl) +
        canvasPoint.x * this.graphZoom -
        viewportX,
    );
    viewportEl.scrollTop = Math.max(
      0,
      this.getGraphPanMarginY(viewportEl) +
        canvasPoint.y * this.graphZoom -
        viewportY,
    );
  }

  private getGraphBounds(nodes: GraphNode[]): GraphCanvasBounds {
    const contentBounds = this.getContentWorldBounds(nodes);
    const savedBounds = this.getSavedGraphWorldBounds();
    const baseBounds = savedBounds
      ? this.mergeGraphWorldBounds(savedBounds, contentBounds)
      : contentBounds;
    const world = this.expandGraphWorldBounds(
      baseBounds,
      contentBounds,
      GRAPH_WORLD_CONTENT_PADDING_X,
      GRAPH_WORLD_CONTENT_PADDING_Y,
    );

    if (!savedBounds || !this.areGraphWorldBoundsEqual(savedBounds, world)) {
      this.persistGraphWorldBounds(world);
    }

    return this.getCanvasBoundsFromWorld(world);
  }

  private getContentWorldBounds(nodes: GraphNode[]): GraphWorldBounds {
    if (nodes.length === 0) {
      return this.normalizeGraphWorldBounds({
        minX: 0,
        minY: 0,
        maxX: NODE_WIDTH,
        maxY: NODE_MIN_HEIGHT,
      });
    }

    return this.normalizeGraphWorldBounds({
      minX: Math.min(...nodes.map((node) => node.x)),
      minY: Math.min(...nodes.map((node) => node.y)),
      maxX: Math.max(...nodes.map((node) => node.x + NODE_WIDTH)),
      maxY: Math.max(...nodes.map((node) => node.y + NODE_MIN_HEIGHT)),
    });
  }

  private getNodesWorldBounds(nodes: GraphNode[]): GraphWorldBounds {
    if (nodes.length === 0) {
      return this.getContentWorldBounds(this.visibleNodes);
    }

    return this.normalizeGraphWorldBounds({
      minX: Math.min(...nodes.map((node) => node.x)),
      minY: Math.min(...nodes.map((node) => node.y)),
      maxX: Math.max(
        ...nodes.map(
          (node) => node.x + this.getRenderedGraphNodeSize(node).width,
        ),
      ),
      maxY: Math.max(
        ...nodes.map(
          (node) => node.y + this.getRenderedGraphNodeSize(node).height,
        ),
      ),
    });
  }

  private getTemplateInsertionWorldBounds(origin: {
    x: number;
    y: number;
  }): GraphWorldBounds {
    return this.normalizeGraphWorldBounds({
      minX: origin.x - GRAPH_WORLD_TEMPLATE_PADDING_X,
      minY: origin.y - GRAPH_WORLD_TEMPLATE_PADDING_Y,
      maxX: origin.x + GRAPH_WORLD_TEMPLATE_PADDING_X,
      maxY:
        origin.y +
        GRAPH_TEMPLATE_CHILD_Y_STEP * 3 +
        GRAPH_WORLD_TEMPLATE_PADDING_Y,
    });
  }

  private getSavedGraphWorldBounds(): GraphWorldBounds | null {
    const raw = this.config?.get(CONFIG_KEY_GRAPH_WORLD);
    if (!raw || typeof raw !== "object") return null;
    const bounds = raw as Partial<GraphWorldBounds>;
    if (
      typeof bounds.minX !== "number" ||
      typeof bounds.minY !== "number" ||
      typeof bounds.maxX !== "number" ||
      typeof bounds.maxY !== "number" ||
      !Number.isFinite(bounds.minX) ||
      !Number.isFinite(bounds.minY) ||
      !Number.isFinite(bounds.maxX) ||
      !Number.isFinite(bounds.maxY) ||
      bounds.minX >= bounds.maxX ||
      bounds.minY >= bounds.maxY
    ) {
      return null;
    }

    return this.normalizeGraphWorldBounds(bounds as GraphWorldBounds);
  }

  private persistGraphWorldBounds(bounds: GraphWorldBounds): void {
    // Persisting world bounds calls config.set, which can trigger a full
    // re-render (onDataUpdated) and detach the live viewport. During an active
    // pan that would orphan the pan handler's viewport reference and send the
    // camera running off screen, so defer persistence until the pan finishes.
    if (this.graphPanActive) {
      this.graphPanWorldPersistPending = true;
      return;
    }
    this.config?.set(CONFIG_KEY_GRAPH_WORLD, {
      minX: Math.round(bounds.minX),
      minY: Math.round(bounds.minY),
      maxX: Math.round(bounds.maxX),
      maxY: Math.round(bounds.maxY),
    });
  }

  private getViewportStateForWorldChange(
    state: GraphViewportState | null,
    previousWorld: GraphWorldBounds | null,
    nextWorld: GraphWorldBounds | null,
  ): GraphViewportState | null {
    if (!state || !previousWorld || !nextWorld) return state;
    return {
      scrollLeft: Math.max(
        0,
        state.scrollLeft + (previousWorld.minX - nextWorld.minX) * state.zoom,
      ),
      scrollTop: Math.max(
        0,
        state.scrollTop + (previousWorld.minY - nextWorld.minY) * state.zoom,
      ),
      zoom: state.zoom,
      ...(state.centerX !== undefined && state.centerY !== undefined
        ? { centerX: state.centerX, centerY: state.centerY }
        : {}),
    };
  }

  private expandGraphWorldForViewport(viewportEl: HTMLElement): void {
    const world = this.graphWorldBounds;
    if (!world) return;
    // A detached or zero-size viewport reports clientWidth/Height of 0, which
    // makes the visible rect collapse and forces unbounded edge expansion.
    if (!viewportEl.isConnected || viewportEl.clientWidth === 0) return;
    const panMarginX = this.getGraphPanMarginX(viewportEl);
    const panMarginY = this.getGraphPanMarginY(viewportEl);

    const visibleLeft = (viewportEl.scrollLeft - panMarginX) / this.graphZoom;
    const visibleTop = (viewportEl.scrollTop - panMarginY) / this.graphZoom;
    const visibleRight =
      (viewportEl.scrollLeft + viewportEl.clientWidth - panMarginX) /
      this.graphZoom;
    const visibleBottom =
      (viewportEl.scrollTop + viewportEl.clientHeight - panMarginY) /
      this.graphZoom;
    let nextWorld = world;

    if (visibleLeft < GRAPH_WORLD_EDGE_THRESHOLD_X) {
      nextWorld = {
        ...nextWorld,
        minX: nextWorld.minX - GRAPH_WORLD_EXPAND_CHUNK_X,
      };
    }
    if (
      nextWorld.maxX - nextWorld.minX - visibleRight <
      GRAPH_WORLD_EDGE_THRESHOLD_X
    ) {
      nextWorld = {
        ...nextWorld,
        maxX: nextWorld.maxX + GRAPH_WORLD_EXPAND_CHUNK_X,
      };
    }
    if (visibleTop < GRAPH_WORLD_EDGE_THRESHOLD_Y) {
      nextWorld = {
        ...nextWorld,
        minY: nextWorld.minY - GRAPH_WORLD_EXPAND_CHUNK_Y,
      };
    }
    if (
      nextWorld.maxY - nextWorld.minY - visibleBottom <
      GRAPH_WORLD_EDGE_THRESHOLD_Y
    ) {
      nextWorld = {
        ...nextWorld,
        maxY: nextWorld.maxY + GRAPH_WORLD_EXPAND_CHUNK_Y,
      };
    }

    this.applyGraphWorldBounds(nextWorld, viewportEl);
  }

  private expandGraphWorldForRect(
    rect: GraphWorldBounds,
    viewportEl: HTMLElement | null,
  ): void {
    const world = this.graphWorldBounds ?? this.getSavedGraphWorldBounds();
    if (!world) return;
    const nextWorld = this.expandGraphWorldBounds(
      world,
      rect,
      GRAPH_WORLD_EDGE_THRESHOLD_X,
      GRAPH_WORLD_EDGE_THRESHOLD_Y,
    );
    this.applyGraphWorldBounds(nextWorld, viewportEl);
  }

  private applyGraphWorldBounds(
    bounds: GraphWorldBounds,
    viewportEl: HTMLElement | null,
  ): void {
    const previousWorld = this.graphWorldBounds;
    const viewportCenter = viewportEl
      ? this.getViewportWorldPoint(
          viewportEl,
          viewportEl.clientWidth / 2,
          viewportEl.clientHeight / 2,
        )
      : null;
    const nextWorld = this.normalizeGraphWorldBounds(bounds);
    if (
      previousWorld &&
      this.areGraphWorldBoundsEqual(previousWorld, nextWorld)
    ) {
      return;
    }

    this.graphWorldBounds = nextWorld;
    this.persistGraphWorldBounds(nextWorld);

    this.resizeRenderedGraphCanvas();
    this.positionRenderedGraphNodes();
    this.syncRenderedGraphEdges();

    if (viewportEl) {
      if (viewportCenter) {
        this.scrollViewportToWorldPoint(
          viewportEl,
          viewportCenter,
          viewportEl.clientWidth / 2,
          viewportEl.clientHeight / 2,
        );
      }
      this.graphViewportState = this.getGraphViewportState(viewportEl);
      this.schedulePersistGraphViewportState();
    }
  }

  private resizeRenderedGraphCanvas(): void {
    const world = this.graphWorldBounds;
    if (!world) return;
    const bounds = this.getCanvasBoundsFromWorld(world);
    const viewportEl = this.getGraphViewportEl();
    const zoomContentEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-zoom-content",
    );
    const canvasEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-canvas",
    );
    const svgEl = this.containerEl.querySelector<SVGSVGElement>(
      ".base-board-graph-edges",
    );
    if (!viewportEl || !zoomContentEl || !canvasEl || !svgEl) return;

    canvasEl.style.width = `${bounds.width}px`;
    canvasEl.style.height = `${bounds.height}px`;
    svgEl.setAttribute("width", String(bounds.width));
    svgEl.setAttribute("height", String(bounds.height));
    svgEl.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    this.applyGraphZoom(zoomContentEl, canvasEl, bounds);
  }

  private getGraphViewportEl(): HTMLElement | null {
    return this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-viewport",
    );
  }

  private getGraphPanMarginX(viewportEl: HTMLElement | null): number {
    return Math.max(GRAPH_PAN_MARGIN_X, viewportEl?.clientWidth ?? 0);
  }

  private getGraphPanMarginY(viewportEl: HTMLElement | null): number {
    return Math.max(GRAPH_PAN_MARGIN_Y, viewportEl?.clientHeight ?? 0);
  }

  private getCurrentGraphCanvasBounds(): GraphCanvasBounds {
    return this.getCanvasBoundsFromWorld(
      this.graphWorldBounds ?? this.getContentWorldBounds(this.visibleNodes),
    );
  }

  private getCanvasBoundsFromWorld(world: GraphWorldBounds): GraphCanvasBounds {
    const normalizedWorld = this.normalizeGraphWorldBounds(world);
    return {
      world: normalizedWorld,
      width: Math.max(1, normalizedWorld.maxX - normalizedWorld.minX),
      height: Math.max(1, normalizedWorld.maxY - normalizedWorld.minY),
    };
  }

  private expandGraphWorldBounds(
    bounds: GraphWorldBounds,
    target: GraphWorldBounds,
    paddingX: number,
    paddingY: number,
  ): GraphWorldBounds {
    return this.normalizeGraphWorldBounds({
      minX: Math.min(bounds.minX, target.minX - paddingX),
      minY: Math.min(bounds.minY, target.minY - paddingY),
      maxX: Math.max(bounds.maxX, target.maxX + paddingX),
      maxY: Math.max(bounds.maxY, target.maxY + paddingY),
    });
  }

  private mergeGraphWorldBounds(
    first: GraphWorldBounds,
    second: GraphWorldBounds,
  ): GraphWorldBounds {
    return this.normalizeGraphWorldBounds({
      minX: Math.min(first.minX, second.minX),
      minY: Math.min(first.minY, second.minY),
      maxX: Math.max(first.maxX, second.maxX),
      maxY: Math.max(first.maxY, second.maxY),
    });
  }

  private normalizeGraphWorldBounds(
    bounds: GraphWorldBounds,
  ): GraphWorldBounds {
    let minX = Math.max(
      -GRAPH_WORLD_SAFETY_LIMIT,
      Math.floor(Math.min(bounds.minX, bounds.maxX)),
    );
    let maxX = Math.min(
      GRAPH_WORLD_SAFETY_LIMIT,
      Math.ceil(Math.max(bounds.minX, bounds.maxX)),
    );
    let minY = Math.max(
      -GRAPH_WORLD_SAFETY_LIMIT,
      Math.floor(Math.min(bounds.minY, bounds.maxY)),
    );
    let maxY = Math.min(
      GRAPH_WORLD_SAFETY_LIMIT,
      Math.ceil(Math.max(bounds.minY, bounds.maxY)),
    );

    if (maxX - minX < GRAPH_WORLD_MIN_WIDTH) {
      const centerX = (minX + maxX) / 2;
      minX = Math.floor(centerX - GRAPH_WORLD_MIN_WIDTH / 2);
      maxX = Math.ceil(centerX + GRAPH_WORLD_MIN_WIDTH / 2);
    }
    if (maxY - minY < GRAPH_WORLD_MIN_HEIGHT) {
      const centerY = (minY + maxY) / 2;
      minY = Math.floor(centerY - GRAPH_WORLD_MIN_HEIGHT / 2);
      maxY = Math.ceil(centerY + GRAPH_WORLD_MIN_HEIGHT / 2);
    }

    if (minX < -GRAPH_WORLD_SAFETY_LIMIT) {
      maxX += -GRAPH_WORLD_SAFETY_LIMIT - minX;
      minX = -GRAPH_WORLD_SAFETY_LIMIT;
    }
    if (maxX > GRAPH_WORLD_SAFETY_LIMIT) {
      minX -= maxX - GRAPH_WORLD_SAFETY_LIMIT;
      maxX = GRAPH_WORLD_SAFETY_LIMIT;
    }
    if (minY < -GRAPH_WORLD_SAFETY_LIMIT) {
      maxY += -GRAPH_WORLD_SAFETY_LIMIT - minY;
      minY = -GRAPH_WORLD_SAFETY_LIMIT;
    }
    if (maxY > GRAPH_WORLD_SAFETY_LIMIT) {
      minY -= maxY - GRAPH_WORLD_SAFETY_LIMIT;
      maxY = GRAPH_WORLD_SAFETY_LIMIT;
    }

    return { minX, minY, maxX, maxY };
  }

  private areGraphWorldBoundsEqual(
    first: GraphWorldBounds,
    second: GraphWorldBounds,
  ): boolean {
    return (
      Math.round(first.minX) === Math.round(second.minX) &&
      Math.round(first.minY) === Math.round(second.minY) &&
      Math.round(first.maxX) === Math.round(second.maxX) &&
      Math.round(first.maxY) === Math.round(second.maxY)
    );
  }

  private getTitle(entry: BasesEntry, file: TFile): string {
    const titleProp = this.config.get("cardTitleProperty") as
      | string
      | undefined;
    if (titleProp) {
      const propId = titleProp.startsWith("note.")
        ? titleProp
        : `note.${titleProp}`;
      const value = entry.getValue(propId as BasesPropertyId);
      if (value && !(value instanceof NullValue) && value.isTruthy()) {
        return value.toString();
      }
    }

    const frontmatter = this.getFrontmatter(file);
    const title = frontmatter?.title;
    if (typeof title === "string" && title.trim()) return title;
    return this.getLocalFallbackTitle(file, frontmatter);
  }

  private getLocalFallbackTitle(
    file: TFile,
    frontmatter: Record<string, unknown> | undefined,
  ): string {
    if (frontmatter?.parent && file.basename.includes(" - ")) {
      return file.basename.split(" - ").pop() ?? file.basename;
    }
    return file.basename;
  }

  private getCurrentStatus(file: TFile): string | null {
    const groupByProp = this.getGroupByProperty() ?? "status";
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeText(frontmatter?.[groupByProp]);
  }

  private getGroupByProperty(): string | null {
    const cfg = this.config as {
      groupBy?: { property?: string };
      get?: (key: string) => unknown;
    };
    const groupBy = cfg?.groupBy;
    if (groupBy?.property) {
      const raw = groupBy.property;
      return raw.startsWith("note.") ? raw.slice(5) : raw;
    }

    const fromGet = cfg?.get?.("groupBy") as { property?: string } | undefined;
    if (fromGet?.property) {
      const raw = fromGet.property;
      return raw.startsWith("note.") ? raw.slice(5) : raw;
    }
    return null;
  }

  private getParentKey(file: TFile): string | null {
    return this.normalizeReference(this.getParentRawValue(file));
  }

  private getParentDisplayValue(file: TFile): string | null {
    const value = this.getParentRawValue(file);
    const firstValue = Array.isArray(value) ? (value as unknown[])[0] : value;
    return typeof firstValue === "string" && firstValue.trim()
      ? firstValue.trim()
      : null;
  }

  private getParentRawValue(file: TFile): unknown {
    const frontmatter = this.getFrontmatter(file);
    return frontmatter?.parent;
  }

  private getNodeType(file: TFile): string | null {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeText(frontmatter?.type);
  }

  private getWorkflow(file: TFile): string | null {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeText(frontmatter?.workflow);
  }

  private isGraphCollapsed(file: TFile): boolean {
    const frontmatter = this.getFrontmatter(file);
    return frontmatter?.[GRAPH_COLLAPSED_PROPERTY] === true;
  }

  private getDependsOnKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(frontmatter?.depends_on);
  }

  private getBreaksToKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(frontmatter?.breaks_to);
  }

  private getRestartsToKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(frontmatter?.restarts_to);
  }

  private getTags(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    const rawTags = frontmatter?.tags;
    if (Array.isArray(rawTags)) {
      return rawTags.filter((tag): tag is string => typeof tag === "string");
    }
    if (typeof rawTags === "string") {
      return rawTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    }
    return [];
  }

  private normalizeReferences(value: unknown): string[] {
    const rawValues = Array.isArray(value) ? (value as unknown[]) : [value];
    return rawValues
      .map((rawValue) => this.normalizeReference(rawValue))
      .filter((reference): reference is string => reference !== null);
  }

  private normalizeReference(value: unknown): string | null {
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

  private normalizeText(value: unknown): string | null {
    if (value === undefined || value === null || value instanceof NullValue) {
      return null;
    }
    if (Array.isArray(value)) return this.normalizeText(value[0]);
    if (typeof value === "object") {
      if ("value" in value) {
        return this.normalizeText((value as Record<string, unknown>).value);
      }
      return null;
    }
    if (typeof value === "string") {
      const text = value.trim();
      return text.length > 0 ? text : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }

  private getNodeIdentities(node: GraphNode): string[] {
    const frontmatter = this.getFrontmatter(node.file);
    const id = frontmatter?.id;
    return [
      node.file.path.replace(/\.md$/i, "").toLowerCase(),
      node.file.basename.toLowerCase(),
      node.title.toLowerCase(),
      typeof id === "string" ? id.toLowerCase() : "",
    ].filter((identity) => identity.length > 0);
  }

  private getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? frontmatter
      : undefined;
  }

  private compareNodes(first: GraphNode, second: GraphNode): number {
    const orderDifference =
      this.getOrder(first.file) - this.getOrder(second.file);
    if (orderDifference !== 0) return orderDifference;
    return first.title.localeCompare(second.title);
  }

  private getOrder(file: TFile): number {
    const frontmatter = this.getFrontmatter(file);
    const graphOrder = frontmatter?.graph_order;
    if (typeof graphOrder === "number") return graphOrder;
    const kanbanOrder = frontmatter?.[ORDER_PROPERTY];
    return typeof kanbanOrder === "number"
      ? kanbanOrder
      : Number.POSITIVE_INFINITY;
  }

  private getSavedGraphPosition(
    file: TFile,
    propertyName: string,
  ): number | null {
    const frontmatter = this.getFrontmatter(file);
    const pendingPosition = this.pendingGraphPositions.get(file.path);
    if (pendingPosition) {
      const savedX = frontmatter?.[GRAPH_POSITION_PROPERTY_X];
      const savedY = frontmatter?.[GRAPH_POSITION_PROPERTY_Y];
      if (savedX === pendingPosition.x && savedY === pendingPosition.y) {
        this.pendingGraphPositions.delete(file.path);
      } else {
        return propertyName === GRAPH_POSITION_PROPERTY_X
          ? pendingPosition.x
          : pendingPosition.y;
      }
    }

    const value = frontmatter?.[propertyName];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private isCompletedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "completed" || normalizedStatus === "done";
  }

  private isInterruptedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "interrupted" || normalizedStatus === "failed";
  }

  private isInvalidatedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "invalidated" || normalizedStatus === "skipped";
  }

  private isCancelledStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "cancelled" || normalizedStatus === "canceled";
  }

  private isBlockedStatus(status: string | null): boolean {
    return status?.trim().toLowerCase() === "blocked";
  }

  private isActiveStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return (
      normalizedStatus === "in progress" ||
      normalizedStatus === "doing" ||
      normalizedStatus === "active"
    );
  }

  private getStateIcon(state: GraphNodeState): string {
    if (state === "completed") return "lucide-check";
    if (state === "interrupted") return "lucide-ban";
    if (state === "invalidated") return "lucide-circle-off";
    if (state === "cancelled") return "lucide-x-circle";
    if (state === "waiting") return "lucide-lock";
    if (state === "blocked") return "lucide-octagon-alert";
    if (state === "active") return "lucide-play";
    if (state === "in-progress") return "lucide-circle-dot";
    return "lucide-circle";
  }

  private getNodeTooltip(node: GraphNode): string {
    const lines = [node.title, `Status: ${node.status ?? "(No value)"}`];
    if (node.parentValue) lines.push(`Parent: ${node.parentValue}`);
    if (node.dependsOnKeys.length > 0) {
      lines.push(`Depends on: ${node.dependsOnKeys.join(", ")}`);
    }
    lines.push(`State: ${node.state}`);
    const events = this.getNodeTransitionEvents(node.file);
    if (events.length > 0) {
      const sequence = this.getTransitionSequenceLabel(events);
      lines.push(`History (${events.length}): ${sequence}`);
    }
    return lines.join("\n");
  }

  // --- Transition history: read + projection (Milestone 2) -------------------
  // The transition event log (written in Milestone 1) is read back here so the
  // current status can be *derived* from it (a fold) and the per-node history
  // can be displayed. The status value itself is unchanged — this is a new
  // read source, not a new source of truth.

  /**
   * Reads and parses a note's transition events from the configured history
   * array (default `status_history`), ascending by time. Only events for the
   * groupBy (status) property are included, matching how Timeline/Kanban read
   * history; legacy records without a `property` field are included too.
   */
  private getNodeTransitionEvents(file: TFile): GraphTransitionEvent[] {
    const propertyName =
      this.plugin.data_.transitionHistory.propertyName.trim() ||
      "status_history";
    const raw = this.getFrontmatter(file)?.[propertyName];
    if (!Array.isArray(raw)) return [];

    const groupByProp = this.getGroupByProperty() ?? "status";
    const events: GraphTransitionEvent[] = [];
    for (const record of raw as unknown[]) {
      if (!record || typeof record !== "object") continue;
      const entry = record as Record<string, unknown>;
      const property =
        typeof entry.property === "string" ? entry.property : null;
      if (property !== null && property !== groupByProp) continue;
      const atText = typeof entry.at === "string" ? entry.at : null;
      const at = atText ? new Date(atText) : null;
      events.push({
        id: typeof entry.id === "string" ? entry.id : null,
        node: typeof entry.node === "string" ? entry.node : null,
        kind: typeof entry.kind === "string" ? entry.kind : null,
        from: this.normalizeText(entry.from),
        to: this.normalizeText(entry.to),
        at: at && !Number.isNaN(at.getTime()) ? at : null,
        property,
        causedBy: typeof entry.causedBy === "string" ? entry.causedBy : null,
        source: typeof entry.source === "string" ? entry.source : null,
      });
    }
    return events.sort((first, second) => {
      const firstTime = first.at?.getTime() ?? 0;
      const secondTime = second.at?.getTime() ?? 0;
      return firstTime - secondTime;
    });
  }

  /**
   * Projects the current status from the event log (the `to` of the latest
   * transition). Returns null when there is no history. This is the fold that
   * later milestones can promote to the source of truth.
   */
  private getProjectedStatus(events: GraphTransitionEvent[]): string | null {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event && event.to !== null) return event.to;
    }
    return null;
  }

  /** Compact "A → B → C" label of the transition sequence (last ~5 steps). */
  private getTransitionSequenceLabel(events: GraphTransitionEvent[]): string {
    const stops: string[] = [];
    const first = events[0];
    if (first) stops.push(first.from ?? "(none)");
    for (const event of events) stops.push(event.to ?? "(none)");
    const trimmed = stops.length > 6 ? ["…", ...stops.slice(-5)] : stops;
    return trimmed.join(" → ");
  }

  /** Opens the per-node state-history view (Milestone 2). */
  private showNodeHistory(node: GraphNode): void {
    const events = this.getNodeTransitionEvents(node.file);
    const projected = this.getProjectedStatus(events);
    new GraphHistoryModal(
      this.app,
      node.title,
      node.status,
      projected,
      events,
    ).open();
  }

  private getDefaultNewNodeStatus(): string {
    const groupByProp = this.getGroupByProperty() ?? "status";
    if (groupByProp !== "status") return "To Do";
    return "To Do";
  }

  private getNextOrder(status: string): number {
    const matchingNodes = this.visibleNodes.filter(
      (node) => node.status?.toLowerCase() === status.toLowerCase(),
    );
    const orders = matchingNodes
      .map((node) => this.getOrder(node.file))
      .filter((order) => Number.isFinite(order));
    return orders.length > 0 ? Math.max(...orders) + 1 : 0;
  }

  private async getAvailableFilePath(
    folder: string,
    title: string,
  ): Promise<string> {
    const normalizedFolder = this.normalizeFolderPath(folder);
    const basePath = normalizedFolder
      ? `${normalizedFolder}/${title}.md`
      : `${title}.md`;
    if (!this.app.vault.getAbstractFileByPath(basePath)) return basePath;

    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = normalizedFolder
        ? `${normalizedFolder}/${title} ${suffix}.md`
        : `${title} ${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    throw new Error(`Unable to find available file path for ${title}`);
  }

  private normalizeFolderPath(folder: string): string {
    const trimmed = folder.trim();
    if (trimmed === "/" || trimmed === "\\") return "";
    return trimmed.replace(/[\\/]+$/g, "");
  }

  private getWikiLink(file: TFile): string {
    return `[[${file.basename}]]`;
  }

  private getGeneratedId(title: string): string {
    const slug = sanitizeFilename(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${slug || "task"}-${suffix}`;
  }

  private formatYamlScalar(value: string): string {
    return JSON.stringify(value);
  }
}

class GraphNodeModal extends Modal {
  private titleValue = "";
  private typeValue = "";
  private submitButtonEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private modalTitle: string,
    private onSubmit: (value: { title: string; type: string }) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("base-board-graph-node-modal");
    contentEl.createEl("h3", { text: this.modalTitle });

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setPlaceholder("Node name");
      text.onChange((value) => {
        this.titleValue = value.trim();
        this.updateSubmitState();
      });
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          this.submit();
        });
      }, 50);
    });

    new Setting(contentEl).setName("Type").addDropdown((dropdown) => {
      dropdown.addOption("", "Select type");
      for (const type of GRAPH_NODE_TYPE_OPTIONS) {
        dropdown.addOption(type, type);
      }
      dropdown.onChange((value) => {
        this.typeValue = value;
        this.updateSubmitState();
      });
    });

    new Setting(contentEl).addButton((button) => {
      button
        .setButtonText("Add")
        .setCta()
        .onClick(() => this.submit());
      this.submitButtonEl = button.buttonEl;
      this.updateSubmitState();
    });
  }

  private updateSubmitState(): void {
    if (!this.submitButtonEl) return;
    this.submitButtonEl.disabled = !this.titleValue || !this.typeValue;
  }

  private submit(): void {
    if (!this.titleValue || !this.typeValue) return;
    this.onSubmit({ title: this.titleValue, type: this.typeValue });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class GraphTemplateModal extends Modal {
  private selectedTemplate: GraphTemplateDefinition;
  private previewEl: HTMLElement | null = null;

  constructor(
    app: App,
    private templates: GraphTemplateDefinition[],
    private onChoose: (template: GraphTemplateDefinition) => void,
  ) {
    super(app);
    this.selectedTemplate = templates[0] ?? GRAPH_TEMPLATE_DEFINITIONS[0];
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("base-board-graph-template-modal");
    contentEl.createEl("h3", { text: "Add template" });

    const bodyEl = contentEl.createDiv({
      cls: "base-board-graph-template-modal-body",
    });
    const listEl = bodyEl.createDiv({ cls: "base-board-graph-template-list" });
    this.previewEl = bodyEl.createDiv({
      cls: "base-board-graph-template-preview",
    });

    for (const template of this.templates) {
      const optionEl = listEl.createEl("button", {
        cls: "base-board-graph-template-option",
        attr: { type: "button" },
      });
      setIcon(
        optionEl.createSpan({ cls: "base-board-graph-template-option-icon" }),
        template.icon,
      );
      optionEl.createSpan({ text: template.name });
      optionEl.addEventListener("mouseenter", () =>
        this.renderPreview(template),
      );
      optionEl.addEventListener("focus", () => this.renderPreview(template));
      optionEl.addEventListener("click", () => {
        this.onChoose(template);
        this.close();
      });
    }

    this.renderPreview(this.selectedTemplate);
  }

  private renderPreview(template: GraphTemplateDefinition): void {
    this.selectedTemplate = template;
    if (!this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.createDiv({
      cls: "base-board-graph-template-preview-title",
      text: template.name,
    });
    const treeEl = this.previewEl.createEl("pre", {
      cls: "base-board-graph-template-preview-tree",
      text: template.preview.join("\n"),
    });
    treeEl.setAttr("aria-label", `${template.name} preview`);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class GraphHistoryModal extends Modal {
  constructor(
    app: App,
    private nodeTitle: string,
    private currentStatus: string | null,
    private projectedStatus: string | null,
    private events: GraphTransitionEvent[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("base-board-graph-history-modal");
    contentEl.createEl("h3", { text: `State history — ${this.nodeTitle}` });

    const current = this.currentStatus ?? "(No value)";
    const projected = this.projectedStatus ?? "(No value)";
    const matches =
      (this.currentStatus ?? "").trim().toLowerCase() ===
      (this.projectedStatus ?? "").trim().toLowerCase();

    const summaryEl = contentEl.createDiv({
      cls: "base-board-graph-history-summary",
    });
    summaryEl.createEl("p", { text: `Current status: ${current}` });
    summaryEl.createEl("p", {
      text: `Projected from log: ${projected}${
        this.events.length === 0
          ? " (no history yet)"
          : matches
            ? " ✓ matches"
            : " ⚠ differs (log is partial)"
      }`,
    });

    if (this.events.length === 0) {
      contentEl.createEl("p", {
        cls: "base-board-graph-history-empty",
        text: "No transition events recorded for this node yet.",
      });
      return;
    }

    const listEl = contentEl.createEl("ol", {
      cls: "base-board-graph-history-list",
    });
    for (const event of this.events) {
      const itemEl = listEl.createEl("li", {
        cls: "base-board-graph-history-item",
      });
      const when = event.at ? event.at.toLocaleString() : "(unknown time)";
      const from = event.from ?? "(none)";
      const to = event.to ?? "(none)";
      itemEl.createSpan({
        cls: "base-board-graph-history-transition",
        text: `${from} → ${to}`,
      });
      const metaParts = [when];
      if (event.kind) metaParts.push(event.kind);
      if (event.causedBy) metaParts.push(event.causedBy);
      if (event.source) metaParts.push(event.source);
      itemEl.createSpan({
        cls: "base-board-graph-history-meta",
        text: metaParts.join(" · "),
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
