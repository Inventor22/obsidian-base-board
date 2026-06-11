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
type GraphReferenceListKind =
  | "depends_on"
  | "breaks_to"
  | "restarts_to"
  | "graph_hidden_returns";

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
  hiddenReturnKeys: string[];
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

const GRAPH_BUILD_VERSION = "2026.06.10.9";
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
const GRAPH_HIDDEN_RETURNS_PROPERTY = "graph_hidden_returns";
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

    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(
          edge.kind === "requirement-return"
            ? "Hide return line"
            : "Delete line",
        )
        .setIcon("lucide-unlink")
        .onClick(() => {
          void this.deleteGraphEdge(edge);
        });
    });
    menu.showAtMouseEvent(event);
  }

  private async deleteGraphEdge(edge: GraphEdge): Promise<void> {
    this.beginGraphHistory("Delete link");
    if (edge.kind === "requirement-start") {
      await this.updateGraphParent(edge.to, null, edge.from);
    } else if (edge.kind === "requirement-return") {
      await this.addGraphReference(edge.from, "graph_hidden_returns", edge.to);
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

    new Notice(
      edge.kind === "requirement-return" ? "Hid return line" : "Deleted line",
    );
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

  private getUpstreamDependencyNodes(node: GraphNode): GraphNode[] {
    const result: GraphNode[] = [];
    const visitedPaths = new Set<string>([node.file.path]);
    const queue = [...node.predecessors];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visitedPaths.has(current.file.path)) continue;
      visitedPaths.add(current.file.path);
      result.push(current);
      queue.push(...current.predecessors);
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
   * Marks a node as the active frontier (where work is currently happening) and
   * propagates statuses across the graph:
   * - the node itself becomes "In Progress" (blue active state),
   * - upstream dependency-chain nodes become "Completed" (green),
   * - downstream nodes (descendants + gated successors) become "Planned" (gray,
   *   excluded from the kanban active-frontier so this node stays THE frontier).
   *   Downstream failed/invalidated ripple effects are reset too, because once
   *   an upstream node is the active frontier those nodes could not have run
   *   yet (so any red "break" links sourced from them become dormant/muted).
   * - ancestors are only marked "Completed" when every one of their branches is
   *   already complete; an ancestor still containing the in-progress branch is
   *   left unchanged.
   * Upstream and ancestor nodes in a failed/terminal state (blocked,
   *   interrupted, invalidated) are preserved and never overwritten.
   */
  private async makeNodeActive(node: GraphNode): Promise<void> {
    this.beginGraphHistory("Set as active work");
    const newStatusByPath = new Map<string, string>();
    const isPreserved = (candidate: GraphNode): boolean =>
      this.isInterruptedStatus(candidate.status) ||
      this.isInvalidatedStatus(candidate.status) ||
      this.isBlockedStatus(candidate.status);

    for (const downstream of this.getDownstreamGraphNodes(node)) {
      if (downstream.file.path === node.file.path) continue;
      newStatusByPath.set(downstream.file.path, GRAPH_STATUS_PLANNED);
    }

    for (const upstream of this.getUpstreamDependencyNodes(node)) {
      if (isPreserved(upstream)) continue;
      newStatusByPath.set(upstream.file.path, GRAPH_STATUS_COMPLETED);
    }

    newStatusByPath.set(node.file.path, GRAPH_STATUS_ACTIVE);

    const parentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const effectiveStatus = (candidate: GraphNode): string | null =>
      newStatusByPath.get(candidate.file.path) ?? candidate.status;
    const visitedAncestors = new Set<string>([node.file.path]);
    let ancestor = parentByPath.get(node.file.path);
    while (ancestor && !visitedAncestors.has(ancestor.file.path)) {
      visitedAncestors.add(ancestor.file.path);
      const allChildrenComplete =
        ancestor.children.length > 0 &&
        ancestor.children.every((child) =>
          this.isTerminalDependencyStatus(effectiveStatus(child)),
        );
      if (allChildrenComplete && !isPreserved(ancestor)) {
        newStatusByPath.set(ancestor.file.path, GRAPH_STATUS_COMPLETED);
      }
      ancestor = parentByPath.get(ancestor.file.path);
    }

    const nodesByPath = new Map(
      this.visibleNodes.map((candidate) => [candidate.file.path, candidate]),
    );
    let relatedUpdates = 0;
    for (const [path, status] of newStatusByPath) {
      const targetNode = nodesByPath.get(path);
      if (!targetNode) continue;
      if (
        (targetNode.status ?? "").trim().toLowerCase() === status.toLowerCase()
      ) {
        continue;
      }
      await this.setGraphNodeStatus(targetNode, status);
      if (path !== node.file.path) relatedUpdates += 1;
    }

    const restoredBreak = await this.restoreBreakPointToCanonical(
      node,
      parentByPath,
    );

    // Reverse parallel-branch cancellation: resuming work in an iteration
    // un-cancels the concurrent branches that were abandoned by a prior
    // failure. Reset `Cancelled` nodes within this iteration's subtree to
    // `Planned` (skipping any just set above).
    const iterationRoot = this.getIterationAncestor(node, parentByPath);
    let resumedUpdates = 0;
    for (const candidate of [
      iterationRoot,
      ...this.getDownstreamGraphNodes(iterationRoot),
    ]) {
      if (newStatusByPath.has(candidate.file.path)) continue;
      if (!this.isCancelledStatus(candidate.status)) continue;
      await this.setGraphNodeStatus(candidate, GRAPH_STATUS_PLANNED);
      resumedUpdates += 1;
    }

    const parts = [`Set "${node.title}" as active work`];
    if (relatedUpdates > 0) {
      parts.push(
        `updated ${relatedUpdates} related node${relatedUpdates === 1 ? "" : "s"}`,
      );
    }
    if (resumedUpdates > 0) {
      parts.push(
        `resumed ${resumedUpdates} parallel node${resumedUpdates === 1 ? "" : "s"}`,
      );
    }
    if (restoredBreak) parts.push("restored the break point");
    new Notice(parts.join(", "));
    await this.commitGraphHistory();
    this.render();
  }

  /**
   * Marks a single node as complete (`Completed`, green). Unlike "Set as active
   * work" this does not reshuffle the rest of the graph — it just records the
   * node's own completion (an explicit user override that also works on a
   * previously failed node). An already-complete node is a no-op. Undoable.
   */
  private async markNodeComplete(node: GraphNode): Promise<void> {
    if (this.isCompletedStatus(node.status)) {
      new Notice(`"${node.title}" is already complete`);
      return;
    }
    this.beginGraphHistory("Mark as complete");
    await this.setGraphNodeStatus(node, GRAPH_STATUS_COMPLETED);
    new Notice(`Marked "${node.title}" as complete`);
    await this.commitGraphHistory();
    this.render();
  }

  /**
   * Reverses the break re-homing that `markNodeFailed` performs. When a node is
   * made active again, any `breaks_to: <parent>` link it picked up while it was
   * the failure point is moved back to the canonical break point of its sibling
   * group: the terminal node of the gated chain (the child with no gated
   * successor inside the group). Returns true when a link was moved.
   */
  private async restoreBreakPointToCanonical(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
  ): Promise<boolean> {
    const parentNode = parentByPath.get(node.file.path);
    if (!parentNode) return false;
    if (
      !node.breakTargets.some(
        (target) => target.file.path === parentNode.file.path,
      )
    ) {
      return false;
    }

    const group = this.visibleNodes.filter(
      (candidate) =>
        parentByPath.get(candidate.file.path)?.file.path ===
        parentNode.file.path,
    );
    const groupPaths = new Set(group.map((candidate) => candidate.file.path));
    const canonical = group.find(
      (candidate) =>
        !this.getGatedSuccessors(candidate).some((successor) =>
          groupPaths.has(successor.file.path),
        ),
    );
    if (!canonical || canonical.file.path === node.file.path) return false;

    await this.removeGraphReference(node, "breaks_to", parentNode);
    if (
      !canonical.breakTargets.some(
        (target) => target.file.path === parentNode.file.path,
      )
    ) {
      await this.addGraphReference(canonical, "breaks_to", parentNode);
    }
    return true;
  }

  private async setGraphNodeStatus(
    node: GraphNode,
    status: string,
  ): Promise<void> {
    await this.snapshotForUndo(node.file.path);
    const propertyName = this.getGroupByProperty() ?? "status";
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter[propertyName] = status;
      },
    );
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
      setTooltip(this.graphUndoButtonEl, top ? `Undo: ${top.label}` : "Nothing to undo");
    }
    if (this.graphRedoButtonEl) {
      const top = this.graphRedoStack[this.graphRedoStack.length - 1];
      this.graphRedoButtonEl.disabled = !top;
      setTooltip(this.graphRedoButtonEl, top ? `Redo: ${top.label}` : "Nothing to redo");
    }
  }

  /**
   * Marks a node as failed and escalates the failure across the graph.
   *
   * On an escalation-style subprocess (the failed node's parent itself
   * participates in a `breaks_to` chain), this:
   * - sets the node's status to "Failed" (red `interrupted` state),
   * - re-homes the break point of the node's parent group onto the failed node
   *   (removes any sibling's `breaks_to:<parent>` and adds it to the failed
   *   node), so the red break originates from the node that actually failed,
   * - escalates up the parent chain to the root, ensuring a `breaks_to:<parent>`
   *   link exists at every level so the whole chain renders red (the red color
   *   itself is computed at render time via the escalation path, so no node
   *   status above the failed node is changed),
   * - invalidates the gated-successor closure of the break point (the rollout
   *   rings that can no longer run this attempt),
   * - ensures the iteration on the chain has a `restarts_to` next iteration,
   *   creating one to the right if none exists.
   *
   * On a flat (non-escalation) graph it just marks the node failed and
   * invalidates its own gated-successor closure.
   *
   * Nodes already in a genuine failed state are preserved.
   */
  private async markNodeFailed(node: GraphNode): Promise<void> {
    this.beginGraphHistory("Mark as failed");
    const parentByPath = this.getResolvedParentsByPath(this.visibleNodes);
    const parentNode = parentByPath.get(node.file.path) ?? null;
    const isEscalation =
      parentNode !== null && parentNode.breakTargets.length > 0;

    await this.setGraphNodeStatus(node, GRAPH_STATUS_FAILED);
    let structuralChanges = 0;
    let createdIteration = false;
    let cancelledUpdates = 0;

    if (isEscalation && parentNode) {
      // Re-home the break point of the parent group onto the failed node.
      const siblings = this.visibleNodes.filter(
        (candidate) =>
          candidate.file.path !== node.file.path &&
          parentByPath.get(candidate.file.path)?.file.path ===
            parentNode.file.path,
      );
      for (const sibling of siblings) {
        if (
          sibling.breakTargets.some(
            (target) => target.file.path === parentNode.file.path,
          )
        ) {
          await this.removeGraphReference(sibling, "breaks_to", parentNode);
          structuralChanges += 1;
        }
      }
      if (
        !node.breakTargets.some(
          (target) => target.file.path === parentNode.file.path,
        )
      ) {
        await this.addGraphReference(node, "breaks_to", parentNode);
        structuralChanges += 1;
      }

      // Escalate up the parent chain to the root, ensuring a break link exists
      // at each level and creating the next iteration where appropriate. While
      // still inside the failed iteration, cancel in-flight work in parallel
      // sibling branches (the concurrent work abandoned by the restart).
      const visited = new Set<string>([node.file.path]);
      const cancelHandled = new Set<string>([node.file.path]);
      let escalationChild: GraphNode = node;
      let withinIteration = true;
      let current: GraphNode | null = parentNode;
      while (current && !visited.has(current.file.path)) {
        visited.add(current.file.path);

        if (withinIteration) {
          for (const sibling of current.children) {
            if (sibling.file.path === escalationChild.file.path) continue;
            cancelledUpdates += await this.cancelInFlightSubtree(
              sibling,
              cancelHandled,
            );
          }
        }

        const ancestor: GraphNode | null =
          parentByPath.get(current.file.path) ?? null;
        if (!ancestor) break;
        if (
          !current.breakTargets.some(
            (target) => target.file.path === ancestor.file.path,
          )
        ) {
          await this.addGraphReference(current, "breaks_to", ancestor);
          structuralChanges += 1;
        }
        if ((current.nodeType ?? "").toLowerCase() === "iteration") {
          if (await this.ensureNextIteration(current, ancestor)) {
            createdIteration = true;
          }
          // Above the iteration is the feature family (including the restart
          // iteration); stop cancelling parallel branches there.
          withinIteration = false;
        }
        escalationChild = current;
        current = ancestor;
      }
    }

    // Invalidate the gated-successor closure of the break point (the steps that
    // could not run this attempt). On flat graphs use the failed node itself.
    const invalidationRoots = parentNode
      ? this.getGatedSuccessors(parentNode)
      : this.getGatedSuccessors(node);
    const isPreserved = (candidate: GraphNode): boolean =>
      this.isInterruptedStatus(candidate.status) ||
      this.isBlockedStatus(candidate.status);
    const invalidatedPaths = new Set<string>();
    const queue: GraphNode[] = [...invalidationRoots];
    let invalidatedUpdates = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || invalidatedPaths.has(current.file.path)) continue;
      invalidatedPaths.add(current.file.path);
      if (current.file.path === node.file.path) continue;
      if (
        !isPreserved(current) &&
        (current.status ?? "").trim().toLowerCase() !==
          GRAPH_STATUS_INVALIDATED.toLowerCase()
      ) {
        await this.setGraphNodeStatus(current, GRAPH_STATUS_INVALIDATED);
        invalidatedUpdates += 1;
      }
      queue.push(...current.children, ...this.getGatedSuccessors(current));
    }

    const parts = [`Marked "${node.title}" as failed`];
    if (invalidatedUpdates > 0) {
      parts.push(
        `invalidated ${invalidatedUpdates} downstream node${invalidatedUpdates === 1 ? "" : "s"}`,
      );
    }
    if (cancelledUpdates > 0) {
      parts.push(
        `cancelled ${cancelledUpdates} parallel node${cancelledUpdates === 1 ? "" : "s"}`,
      );
    }
    if (structuralChanges > 0) parts.push("escalated the break upstream");
    if (createdIteration) parts.push("started a new iteration");
    new Notice(parts.join(", "));
    await this.commitGraphHistory();
    this.render();
  }

  /**
   * Cancels in-flight/pending work within a node's subtree closure (the node
   * plus its children + gated successors, transitively). Completed, failed,
   * invalidated, blocked, and already-cancelled nodes are left untouched.
   * `handled` dedupes across overlapping sibling subtrees. Returns the count.
   */
  private async cancelInFlightSubtree(
    root: GraphNode,
    handled: Set<string>,
  ): Promise<number> {
    let count = 0;
    for (const candidate of [root, ...this.getDownstreamGraphNodes(root)]) {
      if (handled.has(candidate.file.path)) continue;
      handled.add(candidate.file.path);
      if (!this.isCancellableInFlight(candidate.status)) continue;
      await this.setGraphNodeStatus(candidate, GRAPH_STATUS_CANCELLED);
      count += 1;
    }
    return count;
  }

  private isCancellableInFlight(status: string | null): boolean {
    return (
      !this.isCompletedStatus(status) &&
      !this.isInterruptedStatus(status) &&
      !this.isInvalidatedStatus(status) &&
      !this.isBlockedStatus(status) &&
      !this.isCancelledStatus(status)
    );
  }

  /**
   * Walks up the parent chain from a node to the iteration it belongs to (a
   * node with `type: iteration` or a `restarts_to` link). Falls back to the
   * topmost ancestor when there is no explicit iteration node.
   */
  private getIterationAncestor(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
  ): GraphNode {
    const visited = new Set<string>([node.file.path]);
    let current = node;
    while (true) {
      if (
        (current.nodeType ?? "").toLowerCase() === "iteration" ||
        current.restartTargets.length > 0
      ) {
        return current;
      }
      const parent = parentByPath.get(current.file.path);
      if (!parent || visited.has(parent.file.path)) return current;
      visited.add(parent.file.path);
      current = parent;
    }
  }

  /**
   * Ensures an iteration node has a `restarts_to` successor, creating a fresh
   * iteration to its right (under the same feature parent) when none exists.
   * Returns true when a new iteration was created.
   */
  private async ensureNextIteration(
    iterationNode: GraphNode,
    featureNode: GraphNode,
  ): Promise<boolean> {
    if (iterationNode.restartTargets.length > 0) return false;
    const nextNumber = (this.getIterationNumber(iterationNode) ?? 1) + 1;
    const base = iterationNode.title
      .replace(/\s*iteration\s+\d+\s*$/i, "")
      .trim();
    const title = base
      ? `${base} Iteration ${nextNumber}`
      : `Iteration ${nextNumber}`;
    const newFile = await this.createTemplateNode({
      title,
      displayTitle: title,
      type: "iteration",
      status: GRAPH_STATUS_ACTIVE,
      parent: this.getWikiLink(featureNode.file),
      tags: this.getTags(iterationNode.file),
      x: iterationNode.x + NODE_WIDTH + 136,
      y: iterationNode.y,
    });
    await this.snapshotForUndo(iterationNode.file.path);
    await this.app.fileManager.processFrontMatter(
      iterationNode.file,
      (frontmatter: Record<string, unknown>) => {
        const propertyName = this.getGraphReferenceListPropertyName(
          frontmatter,
          "restarts_to",
        );
        const references = this.getFrontmatterReferenceList(
          frontmatter[propertyName],
        );
        references.push(this.getWikiLink(newFile));
        this.setFrontmatterReferenceList(frontmatter, propertyName, references);
      },
    );
    return true;
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
      "graph_hidden_returns",
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
    return relationKind === "graph_hidden_returns"
      ? GRAPH_HIDDEN_RETURNS_PROPERTY
      : relationKind;
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
      hiddenReturnKeys: [],
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
        hiddenReturnKeys: this.getHiddenReturnKeys(file),
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

    const edges: GraphEdge[] = [];
    for (const node of nodes) {
      const childChains = this.getSiblingChains(node.children);
      for (const chain of childChains) {
        const firstChild = chain[0];
        const lastChild = chain[chain.length - 1];
        if (firstChild) {
          edges.push({ from: node, to: firstChild, kind: "requirement-start" });
        }
        if (
          lastChild &&
          !this.chainHasBreakReturnToParent(node, chain) &&
          !this.isRequirementReturnHidden(lastChild, node)
        ) {
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
      for (const breakTarget of node.breakTargets) {
        edges.push({ from: node, to: breakTarget, kind: "break" });
      }
    }
    return edges;
  }

  private chainHasBreakReturnToParent(
    parent: GraphNode,
    chain: GraphNode[],
  ): boolean {
    const visitedPaths = new Set<string>();
    const queue = [...chain];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visitedPaths.has(node.file.path)) continue;
      visitedPaths.add(node.file.path);

      if (
        node.breakTargets.some(
          (breakTarget) => breakTarget.file.path === parent.file.path,
        )
      ) {
        return true;
      }

      queue.push(...node.children);
      queue.push(...node.successors);
    }

    return false;
  }

  private isRequirementReturnHidden(
    returnNode: GraphNode,
    parentNode: GraphNode,
  ): boolean {
    const parentIdentities = new Set(this.getNodeIdentities(parentNode));
    return returnNode.hiddenReturnKeys.some((key) => parentIdentities.has(key));
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

  private assignNodeStates(nodes: GraphNode[]): void {
    const parentByPath = this.getResolvedParentsByPath(nodes);
    for (const node of nodes) {
      if (this.isInvalidatedStatus(node.status)) {
        node.state = "invalidated";
      } else if (this.isCancelledStatus(node.status)) {
        node.state = "cancelled";
      } else if (this.isInterruptedStatus(node.status)) {
        node.state = "interrupted";
      } else if (this.isActiveStatus(node.status)) {
        node.state = "active";
      } else if (this.isCompletedStatus(node.status)) {
        node.state = "completed";
      } else if (this.isBlockedStatus(node.status)) {
        node.state = "blocked";
      } else if (
        !this.areDependenciesCompleted(node) ||
        !this.areAncestorDependenciesCompleted(node, parentByPath)
      ) {
        node.state = "waiting";
      } else if (this.hasIncompleteChildren(node)) {
        node.state = "completed";
      } else {
        node.state = "active";
      }
    }
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

  private areAncestorDependenciesCompleted(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
  ): boolean {
    const visitedPaths = new Set<string>();
    let parent = parentByPath.get(node.file.path);
    while (parent) {
      if (visitedPaths.has(parent.file.path)) return false;
      visitedPaths.add(parent.file.path);
      if (
        this.isBlockedStatus(parent.status) ||
        this.isInterruptedStatus(parent.status) ||
        this.isInvalidatedStatus(parent.status) ||
        !this.areDependenciesCompleted(parent)
      ) {
        return false;
      }
      parent = parentByPath.get(parent.file.path);
    }
    return true;
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

  private hasIncompleteChildren(node: GraphNode): boolean {
    return node.children.some(
      (child) => !this.isTerminalDependencyStatus(child.status),
    );
  }

  private areDependenciesCompleted(node: GraphNode): boolean {
    return node.predecessors.every((dependency) =>
      this.isTerminalDependencyStatus(dependency.status),
    );
  }

  private isTerminalDependencyStatus(status: string | null): boolean {
    return (
      this.isCompletedStatus(status) ||
      this.isInterruptedStatus(status) ||
      this.isInvalidatedStatus(status) ||
      this.isCancelledStatus(status)
    );
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

  private getHiddenReturnKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(
      frontmatter?.[GRAPH_HIDDEN_RETURNS_PROPERTY],
    );
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
    return "lucide-circle";
  }

  private getNodeTooltip(node: GraphNode): string {
    const lines = [node.title, `Status: ${node.status ?? "(No value)"}`];
    if (node.parentValue) lines.push(`Parent: ${node.parentValue}`);
    if (node.dependsOnKeys.length > 0) {
      lines.push(`Depends on: ${node.dependsOnKeys.join(", ")}`);
    }
    lines.push(`State: ${node.state}`);
    return lines.join("\n");
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
