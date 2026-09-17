import {
  App,
  BasesEntry,
  BasesPropertyId,
  BasesView,
  Menu,
  MenuItem,
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
import {
  compareOrderValues,
  generateOrderKey,
  isOrderKey,
  readOrderValue,
  type OrderValue,
} from "./order";
import { getColumnColor } from "./status-colors";
import { buildTransitionEvent } from "./transition-history";
import {
  GraphPhysics,
  GRAPH_PHYSICS_LAYOUTS,
  GRAPH_PHYSICS_SPACING,
  isGraphSpringEdge,
  layoutGraphPhysics,
  routeGraphPhysicsEdge,
  type GraphPhysicsNode,
  type GraphPhysicsLayout,
} from "./graph-physics";
import {
  type EngineNodeState,
  type EngineNodeKind,
  assignNodeKinds as engineAssignNodeKinds,
  deriveStates as engineDeriveStates,
  isFrontierLeaf as engineIsFrontierLeaf,
  getNodeLineage as engineGetNodeLineage,
  getHygiene as engineGetHygiene,
  getFailureScope as engineGetFailureScope,
  isCompensationNode as engineIsCompensationNode,
  isImpactNode as engineIsImpactNode,
  isScopeNode as engineIsScopeNode,
  isCompletedStatus as engineIsCompletedStatus,
  isInterruptedStatus as engineIsInterruptedStatus,
  isInvalidatedStatus as engineIsInvalidatedStatus,
  isCancelledStatus as engineIsCancelledStatus,
  isAwaitingStatus as engineIsAwaitingStatus,
  isBlockedStatus as engineIsBlockedStatus,
  isActiveStatus as engineIsActiveStatus,
  normalizeReference as engineNormalizeReference,
  normalizeReferences as engineNormalizeReferences,
} from "./graph-engine";
import {
  computeSubtreeLayout,
  mirrorVertical,
  mirrorHorizontal,
  type LayoutNode,
  type LayoutOrientation,
  type LayoutSiblingOrder,
  type PositionMap,
} from "./graph-layout";
import {
  connectOverviewToRoot,
  getGraphStateVisual,
  getOverviewCompletion,
  getOverviewSummaryState,
  getOverviewDescendants,
  layoutOverviewClusters,
  projectOverview,
  selectOverviewScope,
  summarizeGraphWork,
  type GraphWorkSummary,
  type OverviewClusterItem,
} from "./graph-overview";
import {
  adjacentGraphHistoryChange,
  changedGraphHistoryKeys,
  compareGraphSnapshots,
  graphAtTime,
  isGraphHistoryGap,
  scopeGraphHistory,
  scopeGraphSnapshot,
  stepGraphHistoryDay,
  type GraphHistory,
  type GraphHistoryNode,
} from "./graph-history";

type GraphPresentation = "overview" | "canvas" | "physics";

interface GraphPhysicsCache {
  positions: Map<string, { x: number; y: number }>;
  guides: Map<string, { x: number; y: number }>;
  signature: string;
  energy: number;
}

type GraphRelationKind = "requirement" | "successor";
type GraphLinkCreationKind =
  GraphRelationKind | "break" | "restart" | "membership";
// State + kind unions are owned by the shared engine (graph-engine.ts) so the
// Graph and Kanban views derive frontier state from one source of truth.
type GraphNodeState = EngineNodeState;
type GraphEdgeKind = "requirement-start" | "requirement-return" | "gating";
type GraphFlowEdgeKind =
  | GraphEdgeKind
  | "break"
  | "restart"
  | "membership"
  | "compensation"
  | "association";
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
  "depends_on" | "breaks_to" | "restarts_to" | "rollup_to" | "compensates";
// Node model axes (see GRAPH_ARCHITECTURE_PLAN.md "Node model — three axes").
// Kind = behaviour (the only axis the engine branches on); `type` = open label;
// agency = who executes the work and how autonomously.
type GraphNodeKind = EngineNodeKind;
type GraphExecutor = "human" | "agent" | "mixed";
type GraphAutonomy = "propose" | "execute" | "autopilot";
const GRAPH_NODE_KINDS: readonly GraphNodeKind[] = [
  "work",
  "process",
  "group",
  "impact",
];
const GRAPH_EXECUTORS: readonly GraphExecutor[] = ["human", "agent", "mixed"];
const GRAPH_AUTONOMY_LEVELS: readonly GraphAutonomy[] = [
  "propose",
  "execute",
  "autopilot",
];

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

// Curated choices for the manual "Add node" picker: the behavioural KIND, not
// a domain label (those template labels are produced by templates). A node's
// concrete name/label is the title plus an optional free `type` descriptor.
const GRAPH_ADD_NODE_KIND_OPTIONS: { value: GraphNodeKind; label: string }[] = [
  { value: "work", label: "Work item" },
  { value: "process", label: "Subprocess" },
  { value: "group", label: "Group / scope" },
  { value: "impact", label: "Impact / metric" },
];

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
      "  disable feature flag (compensates enable)",
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
  entry: BasesEntry | null;
  file: TFile;
  title: string;
  status: string | null;
  parentKey: string | null;
  parentValue: string | null;
  dependsOnKeys: string[];
  breaksToKeys: string[];
  restartsToKeys: string[];
  rollupToKeys: string[];
  // Compensation (saga). `compensates` points from a rollback/mitigation node to
  // the effecting node it undoes. A node is "effecting" either by inference
  // (something compensates it) or by an explicit `effecting: true` flag — the
  // latter lets the graph detect a *missing* compensation (Phase 3 attention).
  // See GRAPH_ARCHITECTURE_PLAN.md "Compensation (saga)".
  compensatesKeys: string[];
  // Explicit `effecting: true`: this node performs a side-effect that should be
  // undone if its scope fails. Drives the undeclared-compensation attention.
  effecting: boolean;
  nodeType: string | null;
  workflow: string | null;
  collapsed: boolean;
  descendantCount: number;
  children: GraphNode[];
  successors: GraphNode[];
  predecessors: GraphNode[];
  breakTargets: GraphNode[];
  restartTargets: GraphNode[];
  rollupTargets: GraphNode[];
  members: GraphNode[];
  // Compensation (saga): resolved targets this node undoes, and the reverse
  // (this node's effect is undone by these compensations).
  compensatesTargets: GraphNode[];
  compensatedBy: GraphNode[];
  // Attention signal (Phase 3): a completed effecting node sits in a failed
  // scope with no declared compensation — a cue to propose/declare one. Derived.
  needsCompensation: boolean;
  // A compensation is out-of-band: it opts out of its parent's group fold and
  // the forward sequence (it is a failure-triggered branch, not a step).
  excludedFromFold: boolean;
  // Node-model axes (GRAPH_ARCHITECTURE_PLAN.md). `kind` = behavioural
  // archetype (inferred unless explicit); `executor`/`autonomy` = agency
  // (inherited down containment, nearest-explicit-wins). `*Explicit` is the
  // node's own stored value (null = unset).
  kindExplicit: GraphNodeKind | null;
  kind: GraphNodeKind;
  executorExplicit: GraphExecutor | null;
  executor: GraphExecutor;
  autonomyExplicit: GraphAutonomy | null;
  autonomy: GraphAutonomy;
  // Subgraph lock (Step B). `lockedExplicit` is this node's own stored
  // `graph_locked` (null = unset); `effectiveLocked` is the resolved value
  // (nearest self-or-ancestor with an explicit lock wins).
  lockedExplicit: boolean | null;
  effectiveLocked: boolean;
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
  backtrack?: boolean;
  returnState?: "completed" | "cancelled" | "waiting";
  spring?: boolean;
}

// A single active-frontier item, projected for the read-only frontier panel
// (and, later, the Kanban projection). `lineage` is the work breadcrumb from
// the feature/work-root down to the node (excludes the scope/aggregation layer).
interface GraphFrontierItem {
  lineage: string[];
  status: string | null;
  state: GraphNodeState;
}

// A graph-hygiene finding: a node disconnected from the hierarchy.
interface GraphHygieneItem {
  title: string;
  reason: string;
}

interface GraphHistoryFileChange {
  path: string;
  before: string | null;
  after: string | null;
}

// A layout (node-position) change. Positions live in the graph view config
// (not note frontmatter), so they ride the same Undo/Redo as file edits via
// this dedicated entry kind. `before` is null for a node that had no stored
// position (it was using a legacy/auto position).
interface GraphPositionChange {
  before: Record<string, { x: number; y: number } | null>;
  after: Record<string, { x: number; y: number }>;
}

interface GraphHistoryEntry {
  label: string;
  files: GraphHistoryFileChange[];
  positions?: GraphPositionChange;
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

const GRAPH_BUILD_VERSION = "2026.09.16.9";
const GRAPH_HISTORY_LIMIT = 50;
const GRAPH_STATUS_ACTIVE = "In Progress";
const GRAPH_STATUS_COMPLETED = "Completed";
const GRAPH_STATUS_PLANNED = "Planned";
const GRAPH_STATUS_FAILED = "Failed";
const GRAPH_STATUS_INVALIDATED = "Invalidated";
const GRAPH_STATUS_CANCELLED = "Cancelled";
const GRAPH_STATUS_AWAITING = "Awaiting";
const NODE_WIDTH = 220;
const NODE_MIN_HEIGHT = 92;
const OVERVIEW_NODE_HEIGHT = 136;
const OVERVIEW_HEADING_HEIGHT = 64;
const OVERVIEW_TASK_HEIGHT = 88;
const PHYSICS_NODE_DIAMETER = 144;
const PHYSICS_SUMMARY_DIAMETER = 160;
const OVERVIEW_ALL = "@all";
const OVERVIEW_UNASSIGNED = "@unassigned";
const X_STEP = 300;
const Y_STEP = 172;
const ROOT_GAP = 220;
const EDGE_MARGIN = 18;
const NODE_GAP_X = X_STEP - NODE_WIDTH;
const GRAPH_MIN_ZOOM = 0.0001;
const GRAPH_MAX_ZOOM = 2.25;
const GRAPH_ZOOM_STEP = 0.0018;
const GRAPH_ZOOM_BUTTON_FACTOR = 1.2;
const GRAPH_PAN_THRESHOLD_PX = 4;
const GRAPH_PAN_MARGIN_X = 720;
const GRAPH_PAN_MARGIN_Y = 320;
const GRAPH_POSITION_PROPERTY_X = "graph_x";
const GRAPH_POSITION_PROPERTY_Y = "graph_y";
const GRAPH_COLLAPSED_PROPERTY = "graph_collapsed";
const GRAPH_LOCKED_PROPERTY = "graph_locked";
const GRAPH_EFFECTING_PROPERTY = "effecting";
const CONFIG_KEY_GRAPH_VIEWPORT = "graphViewport";
const CONFIG_KEY_GRAPH_WORLD = "graphWorld";
const CONFIG_KEY_GRAPH_NODE_POSITIONS = "graphNodePositions";
const CONFIG_KEY_GRAPH_PRESENTATION = "graphPresentation";
const CONFIG_KEY_GRAPH_PHYSICS_LAYOUT = "graphPhysicsLayout";
const CONFIG_KEY_GRAPH_ROOT = "graphRoot";
const CONFIG_KEY_GRAPH_OVERVIEW_EXPANDED = "graphOverviewExpanded";
const CONFIG_KEY_GRAPH_OVERVIEW_VIEWPORT = "graphOverviewViewport";
const CONFIG_KEY_GRAPH_OVERVIEW_WORLD = "graphOverviewWorld";
const CONFIG_KEY_GRAPH_OVERVIEW_FOCUS = "graphOverviewFocus";
const CONFIG_KEY_GRAPH_RECORDING = "graphRecordingId";
const GRAPH_EDGE_HANDLE_RADIUS = 7;
const GRAPH_LINK_HANDLE_PROXIMITY_PX = 14;
// While dragging a link endpoint, reveal a node's anchor slots when the cursor
// is over the node or within this many px of its boundary.
const GRAPH_ANCHOR_REVEAL_PX = 32;
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

// ---------------------------------------------------------------------------
//  Signal scheduler (Step C). A failure at a leaf propagates up the containment
//  hierarchy as a signal; each node kind applies a bounce policy (pass / absorb
//  / transform) that decides how far the signal escalates. Registered handlers
//  then react to the propagated scope — compensation is the first such
//  behaviour, the undeclared-effecting attention cue the second. This
//  generalises the M3 failure escalation into a pluggable mechanism.
//  See GRAPH_ARCHITECTURE_PLAN.md "Boundaries, signals & lenses" (Step C).
// ---------------------------------------------------------------------------

interface GraphSignalContext {
  nodes: GraphNode[];
  parentByPath: Map<string, GraphNode>;
  // Paths reached by an escalating failure signal: every containment ancestor
  // of a genuinely-failed leaf, up to the nearest absorbing boundary.
  failureScope: Set<string>;
}

interface GraphSignalHandler {
  readonly id: string;
  apply(context: GraphSignalContext): void;
}

export class GraphView extends BasesView {
  type = "graph";

  private plugin: BaseBoardPlugin;
  private scrollEl: HTMLElement;
  private containerEl: HTMLElement;
  private graphContentEl: HTMLElement | null = null;
  private temporalBarEl: HTMLElement | null = null;
  private temporalRangeEl: HTMLInputElement | null = null;
  private temporalDateEl: HTMLTimeElement | null = null;
  private temporalEventsEl: HTMLElement | null = null;
  private temporalStatusEl: HTMLElement | null = null;
  private temporalChangesEl: HTMLElement | null = null;
  private temporalControls = new Map<string, HTMLButtonElement>();
  private temporalHistory: GraphHistory | null = null;
  private temporalCursor: number | null = null;
  private temporalRenderedCursor: number | null = null;
  private temporalRecordingId: string | null = null;
  private temporalSession = crypto.randomUUID();
  private temporalRecordingEnabled = false;
  private temporalRecordingError: string | null = null;
  private temporalDisposed = false;
  private temporalFileKeys = new Map<TFile, string>();
  private temporalSnapshots = new Map<string, GraphHistoryNode>();
  private temporalLiveNodes: GraphHistoryNode[] = [];
  private temporalChangedKeys = new Set<string>();
  private temporalAddedKeys = new Set<string>();
  private temporalUpdatedCount = 0;
  private temporalRemovedNodes: GraphHistoryNode[] = [];
  private temporalExpandedKeys = new Set<string>();
  private temporalScopeKey: string | null = null;
  private temporalReturnScopeKey = OVERVIEW_ALL;
  private temporalScopeCache: {
    source: GraphHistory;
    key: string;
    history: GraphHistory;
  } | null = null;
  private temporalPositionScopes = new Map<
    string,
    Map<string, { x: number; y: number }>
  >();
  private temporalPositions = new Map<string, { x: number; y: number }>();
  private temporalReturnCamera: GraphViewportState | null = null;
  private temporalRestoreCamera: GraphViewportState | null = null;
  private temporalRenderFrame: number | null = null;
  private visibleNodes: GraphNode[] = [];
  private graphNodes: GraphNode[] = [];
  private overviewScopeKey = OVERVIEW_ALL;
  private overviewScopeNodes: GraphNode[] = [];
  private overviewBreadcrumbs: { key: string; title: string }[] = [];
  private overviewUnassigned: GraphNode[] = [];
  private overviewItems = new Map<string, OverviewClusterItem<GraphNode>>();
  private overviewEdges: GraphEdge[] = [];
  private overviewMissingScope = false;
  private overviewResetCamera = false;
  private overviewFirstLayout = true;
  private overviewResizeObserver: ResizeObserver | null = null;
  private overviewResizeFrame: number | null = null;
  private overviewMeasuredWidth = 0;
  private graphWorkSummaries = new Map<string, GraphWorkSummary>();
  private renderedPresentation: GraphPresentation | null = null;
  private overviewAnchor: { path: string; x: number; y: number } | null = null;
  private graphZoom = 1;
  private physicsSimulation: GraphPhysics | null = null;
  private physicsFrame: number | null = null;
  private physicsPaused = false;
  private physicsToggleEl: HTMLButtonElement | null = null;
  private physicsRootKey: string | null = null;
  private physicsContextPaths = new Set<string>();
  private physicsCaches = new Map<string, GraphPhysicsCache>();
  private physicsActiveCache: GraphPhysicsCache | null = null;
  private physicsElements = new Map<string, HTMLElement>();
  private physicsNodes = new Map<string, GraphNode>();
  private physicsSizes = new Map<string, { width: number; height: number }>();
  private physicsLayoutAnchors = new Map<string, { x: number; y: number }>();
  private physicsDepths = new Map<string, number>();
  private physicsRouteNodes: GraphPhysicsNode[] = [];
  private physicsViewportEl: HTMLElement | null = null;
  private physicsCamera: GraphViewportState | null = null;
  private physicsWorld: GraphWorldBounds | null = null;
  private physicsDraggingId: string | null = null;
  private physicsDragCleanup: ((cancelled: boolean) => void) | null = null;
  private physicsRenderPending = false;
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
    this.physicsPaused =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (typeof ResizeObserver !== "undefined") {
      this.overviewResizeObserver = new ResizeObserver((entries) => {
        const width = Math.round(entries[0]?.contentRect.width ?? 0);
        if (width === this.overviewMeasuredWidth || width === 0) return;
        this.overviewMeasuredWidth = width;
        if (!this.visibleNodes.length || !this.isGraphOverview()) return;
        if (this.overviewResizeFrame !== null)
          window.cancelAnimationFrame(this.overviewResizeFrame);
        this.overviewResizeFrame = window.requestAnimationFrame(() => {
          this.overviewResizeFrame = null;
          if (this.temporalDisposed) return;
          if (this.graphPanActive) this.graphPanRenderPending = true;
          else this.render();
        });
      });
      this.overviewResizeObserver.observe(this.containerEl);
    }
  }

  static getViewOptions(): never[] {
    return [];
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    this.temporalRecordingEnabled =
      this.data !== undefined && this.data !== null;
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

  onunload(): void {
    this.temporalDisposed = true;
    this.physicsDragCleanup?.(true);
    this.stopGraphPhysics();
    this.overviewResizeObserver?.disconnect();
    if (this.overviewResizeFrame !== null)
      window.cancelAnimationFrame(this.overviewResizeFrame);
    if (this.temporalRenderFrame !== null)
      window.cancelAnimationFrame(this.temporalRenderFrame);
    if (this.graphViewportPersistTimer)
      window.clearTimeout(this.graphViewportPersistTimer);
    if (this.temporalRecordingId && !this.temporalRecordingError) {
      void this.plugin
        .finishGraphObservation(
          this.temporalRecordingId,
          Date.now(),
          this.temporalSession,
        )
        .catch((error: unknown) => {
          console.error(
            "Base Board: graph recording could not be saved",
            error,
          );
          new Notice(
            "Graph history could not be saved. Check the console for details.",
          );
        });
    }
  }

  private getGraphContentEl(): HTMLElement {
    if (!this.graphContentEl) {
      this.graphContentEl = this.containerEl.createDiv({
        cls: "base-board-graph-content",
      });
    }
    return this.graphContentEl;
  }

  public render(): void {
    if (this.physicsDraggingId) {
      this.physicsRenderPending = true;
      return;
    }
    this.stopGraphPhysics();
    const presentation = this.getGraphPresentation();
    const modeChanged = presentation !== this.renderedPresentation;
    if (modeChanged) {
      if (this.graphViewportPersistTimer)
        window.clearTimeout(this.graphViewportPersistTimer);
      this.graphViewportPersistTimer = null;
      this.graphViewportState =
        this.temporalRestoreCamera ?? this.getSavedGraphViewportState();
      this.temporalRestoreCamera = null;
      this.graphWorldBounds = this.getSavedGraphWorldBounds();
      this.graphZoom = this.graphViewportState?.zoom ?? 1;
      this.renderedPresentation = presentation;
    }
    const previousViewportEl = modeChanged
      ? null
      : this.containerEl.querySelector<HTMLElement>(
          ".base-board-graph-viewport",
        );
    const previousCameraReady =
      previousViewportEl?.dataset.graphCameraReady === "true";
    const previousWorldBounds = this.graphWorldBounds;
    const viewportState =
      previousViewportEl && previousCameraReady
        ? this.getGraphViewportState(previousViewportEl)
        : (this.graphViewportState ?? this.getSavedGraphViewportState());
    if (previousViewportEl && previousCameraReady) {
      this.graphViewportState = viewportState;
    }
    if (viewportState) {
      this.graphZoom = this.clampGraphZoom(viewportState.zoom);
    }

    this.getGraphContentEl().empty();
    this.containerEl.toggleClass(
      "base-board-graph--overview",
      this.isGraphOverview(),
    );
    this.containerEl.toggleClass(
      "base-board-graph--physics",
      this.isGraphPhysics(),
    );
    const nodes = this.getGraphNodes();
    this.visibleNodes = nodes;
    this.temporalRenderedCursor = this.temporalCursor;
    this.containerEl.toggleClass(
      "base-board-graph--historical",
      this.temporalCursor !== null,
    );
    if (nodes.length === 0) {
      this.renderToolbar(nodes);
      if (this.isGraphOverview()) this.renderOverviewNavigation();
      this.renderPlaceholder(
        this.overviewMissingScope
          ? "This branch is not present in this graph snapshot."
          : this.isGraphOverview()
            ? "No work in this scope."
            : this.temporalCursor === null
              ? "No graph nodes found for this view."
              : "No items in this recorded graph.",
      );
      this.renderTemporalNavigation();
      return;
    }

    const edges = this.isGraphPhysics()
      ? this.layoutPhysicsGraph(nodes)
      : this.isGraphOverview()
        ? this.layoutOverview()
        : this.layoutGraph(nodes);
    this.renderToolbar(nodes);
    if (this.isGraphOverview()) this.renderOverviewNavigation();
    const viewportEl = this.renderCanvas(nodes, edges);
    this.renderTemporalNavigation();
    const restoredViewportState = this.getViewportStateForWorldChange(
      viewportState,
      previousWorldBounds,
      this.graphWorldBounds,
    );

    window.requestAnimationFrame(() => {
      if (!viewportEl.isConnected) return;
      const zoomContentEl = viewportEl.querySelector<HTMLElement>(
        ".base-board-graph-zoom-content",
      );
      const canvasEl = viewportEl.querySelector<HTMLElement>(
        ".base-board-graph-canvas",
      );
      if (zoomContentEl && canvasEl) {
        this.applyGraphZoom(
          zoomContentEl,
          canvasEl,
          this.getCurrentGraphCanvasBounds(),
        );
      }
      const anchor = this.overviewAnchor;
      this.overviewAnchor = null;
      const anchorNode = anchor
        ? nodes.find((node) => node.file.path === anchor.path)
        : null;
      if (this.overviewResetCamera) {
        this.overviewResetCamera = false;
        this.graphZoom = 1;
        if (zoomContentEl && canvasEl)
          this.applyGraphZoom(
            zoomContentEl,
            canvasEl,
            this.getCurrentGraphCanvasBounds(),
          );
        this.centerGraphCameraOnNodes(viewportEl, nodes);
      } else if (anchor && anchorNode) {
        this.scrollViewportToWorldPoint(
          viewportEl,
          {
            x: anchorNode.x + NODE_WIDTH / 2,
            y: anchorNode.y + 16,
          },
          anchor.x,
          anchor.y,
        );
      } else if (restoredViewportState) {
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
      viewportEl.dataset.graphCameraReady = "true";
      this.graphViewportState = this.getGraphViewportState(viewportEl);
      if (this.isGraphPhysics())
        this.startGraphPhysics(viewportEl, nodes, edges);
    });
  }

  private renderPlaceholder(text: string): void {
    const placeholderEl = this.getGraphContentEl().createDiv({
      cls: "base-board-placeholder",
    });
    setIcon(
      placeholderEl.createSpan({ cls: "base-board-placeholder-icon" }),
      "lucide-git-fork",
    );
    placeholderEl.createEl("p", { text });
  }

  private renderToolbar(nodes: GraphNode[]): void {
    const work = (
      this.isGraphOverview() ? this.overviewScopeNodes : this.graphNodes
    ).filter((node) => node.kind === "work" && node.children.length === 0);
    const activeCount = work.filter(
      (node) => this.graphWorkSummaries.get(node.file.path)?.active === 1,
    ).length;
    const readyCount = work.filter(
      (node) => this.graphWorkSummaries.get(node.file.path)?.ready === 1,
    ).length;
    const waitingCount = work.filter(
      (node) => node.state === "awaiting",
    ).length;
    const blockedCount = work.filter(
      (node) => node.state === "blocked" || node.state === "interrupted",
    ).length;
    const completedCount = work.filter(
      (node) => node.state === "completed",
    ).length;

    const toolbarEl = this.getGraphContentEl().createDiv({
      cls: "base-board-graph-toolbar",
    });
    toolbarEl.createSpan({ cls: "base-board-graph-title", text: "Graph" });
    this.renderGraphPresentationControls(toolbarEl);
    this.renderToolbarStat(
      toolbarEl,
      "In progress",
      activeCount,
      "in-progress",
    );
    if (readyCount > 0)
      this.renderToolbarStat(toolbarEl, "Ready", readyCount, "active");
    this.renderToolbarStat(toolbarEl, "Awaiting", waitingCount, "awaiting");
    this.renderToolbarStat(toolbarEl, "Blocked", blockedCount, "blocked");
    this.renderToolbarStat(toolbarEl, "Completed", completedCount, "completed");
    this.renderGraphFrontierButton(toolbarEl);
    if (!this.isGraphOverview()) this.renderGraphHistoryControls(toolbarEl);
    if (this.isGraphPhysics()) this.renderPhysicsControls(toolbarEl);
    this.renderGraphZoomControls(toolbarEl);
    toolbarEl.createSpan({
      cls: "base-board-graph-version",
      text: `v${GRAPH_BUILD_VERSION}`,
    });
  }

  private getGraphPresentation(): GraphPresentation {
    if (this.temporalCursor !== null) return "overview";
    const mode = this.config?.get(CONFIG_KEY_GRAPH_PRESENTATION);
    return mode === "canvas" || mode === "physics" ? mode : "overview";
  }

  private isGraphOverview(): boolean {
    return this.getGraphPresentation() !== "canvas";
  }

  private isGraphPhysics(): boolean {
    return this.getGraphPresentation() === "physics";
  }

  private getConfiguredGraphRoot(nodes = this.graphNodes): GraphNode | null {
    const reference = this.normalizeReference(
      this.config?.get(CONFIG_KEY_GRAPH_ROOT),
    );
    return reference
      ? (nodes.find((node) =>
          this.getNodeIdentities(node).includes(reference),
        ) ?? null)
      : null;
  }

  private setGraphRoot(node: GraphNode | null): void {
    if (this.temporalCursor !== null) return;
    const id = node ? this.getFrontmatter(node.file)?.id : null;
    this.config?.set(
      CONFIG_KEY_GRAPH_ROOT,
      node
        ? typeof id === "string" && id.trim()
          ? id
          : node.file.path.replace(/\.md$/i, "")
        : null,
    );
    this.physicsCaches.clear();
    this.overviewResetCamera = true;
    this.overviewAnchor = null;
    if (node)
      this.config?.set(
        CONFIG_KEY_GRAPH_OVERVIEW_FOCUS,
        this.getTemporalNodeKey(node),
      );
    this.render();
  }

  private renderGraphPresentationControls(toolbarEl: HTMLElement): void {
    const modes = toolbarEl.createDiv({ cls: "base-board-graph-presentation" });
    for (const [mode, label, icon] of [
      ["overview", "Overview", "lucide-network"],
      ["canvas", "Free layout", "lucide-move"],
      ["physics", "Physics layout (experimental)", "lucide-orbit"],
    ] as const) {
      const button = this.renderGraphIconButton(modes, icon, label, () => {
        if (this.getGraphPresentation() === mode) return;
        this.persistGraphViewportState(this.graphViewportState);
        this.overviewAnchor = null;
        this.config?.set(CONFIG_KEY_GRAPH_PRESENTATION, mode);
        this.render();
      });
      button.setAttribute(
        "aria-pressed",
        String(this.getGraphPresentation() === mode),
      );
      if (this.temporalCursor !== null && mode !== "overview")
        button.disabled = true;
    }
    if (this.isGraphOverview()) {
      const levels = toolbarEl.createDiv({
        cls: "base-board-graph-zoom-controls",
      });
      this.renderGraphIconButton(
        levels,
        "lucide-fold-vertical",
        "Collapse all workstreams",
        () => {
          const paths = new Set(
            this.overviewScopeNodes.map((node) => node.file.path),
          );
          if (this.temporalCursor !== null) {
            for (const node of this.overviewScopeNodes)
              this.temporalExpandedKeys.delete(this.getTemporalNodeKey(node));
          } else {
            const expanded = this.graphNodes.filter(
              (node) => !node.collapsed && !paths.has(node.file.path),
            );
            this.config?.set(
              CONFIG_KEY_GRAPH_OVERVIEW_EXPANDED,
              expanded.map((node) => node.file.path),
            );
          }
          this.render();
          this.resetGraphCamera();
        },
      );
      this.renderGraphIconButton(
        levels,
        "lucide-unfold-vertical",
        "Expand all workstreams",
        () => {
          const containers = this.overviewScopeNodes.filter(
            (node) => node.descendantCount > 0,
          );
          if (this.temporalCursor !== null) {
            for (const node of containers)
              this.temporalExpandedKeys.add(this.getTemporalNodeKey(node));
          } else {
            this.config?.set(CONFIG_KEY_GRAPH_OVERVIEW_EXPANDED, [
              ...new Set(
                [
                  ...this.graphNodes.filter((node) => !node.collapsed),
                  ...containers,
                ].map((node) => node.file.path),
              ),
            ]);
          }
          this.render();
        },
      );
    }
  }

  private layoutOverview(): GraphEdge[] {
    for (const item of this.overviewItems.values()) {
      const node = item.node;
      let point = { x: item.x, y: item.y };
      if (this.temporalCursor !== null) {
        const key = this.getTemporalNodeKey(node);
        const previous = this.temporalPositions.get(key);
        if (previous) point = previous;
        else {
          const occupied = [...this.temporalPositions.values()];
          while (
            occupied.some(
              (other) =>
                Math.abs(other.x - point.x) < NODE_WIDTH + 24 &&
                Math.abs(other.y - point.y) < OVERVIEW_NODE_HEIGHT + 44,
            )
          )
            point.y += OVERVIEW_NODE_HEIGHT + 64;
          this.temporalPositions.set(key, point);
        }
      }
      node.x = point.x;
      node.y = point.y;
    }
    return this.overviewEdges;
  }

  private layoutPhysicsGraph(nodes: GraphNode[]): GraphEdge[] {
    const edges = this.buildPhysicsEdges(nodes);
    const mode = this.getGraphPhysicsLayout();
    const seeded = layoutGraphPhysics(
      nodes.map((node) => ({
        id: this.getTemporalNodeKey(node),
        x: 0,
        y: 0,
        ...this.getPhysicsNodeSize(node),
        shape: "circle",
        fixed: this.getTemporalNodeKey(node) === this.physicsRootKey,
      })),
      edges.map((edge) => ({
        source: this.getTemporalNodeKey(edge.from),
        target: this.getTemporalNodeKey(edge.to),
        kind: edge.kind,
        spring: edge.spring,
      })),
      (this.containerEl.clientWidth || this.scrollEl.clientWidth || 1440) - 48,
      mode,
    );
    this.physicsLayoutAnchors = new Map(
      seeded.map((node) => [node.id, { x: node.x, y: node.y }]),
    );
    this.physicsDepths = new Map(
      seeded.map((node) => [node.id, node.depth ?? 0]),
    );
    const cacheKey = this.getPhysicsCacheKey();
    const cache = this.physicsCaches.get(cacheKey) ?? {
      positions: new Map<string, { x: number; y: number }>(),
      guides: new Map<string, { x: number; y: number }>(),
      signature: "",
      energy: 1,
    };
    this.physicsCaches.set(cacheKey, cache);
    this.physicsActiveCache = cache;
    for (const node of nodes) {
      const key = this.getTemporalNodeKey(node);
      if (key === this.physicsRootKey) {
        node.x = 0;
        node.y = 0;
        continue;
      }
      const previous = cache.positions.get(key);
      const guide = cache.guides.get(key);
      if (guide) this.physicsLayoutAnchors.set(key, guide);
      const point = previous ?? this.physicsLayoutAnchors.get(key);
      if (point) {
        node.x = point.x;
        node.y = point.y;
      }
    }
    return edges;
  }

  private getGraphPhysicsLayout(): GraphPhysicsLayout {
    const saved = this.config?.get(CONFIG_KEY_GRAPH_PHYSICS_LAYOUT);
    return GRAPH_PHYSICS_LAYOUTS.find((mode) => mode === saved) ?? "workflow";
  }

  private getPhysicsCacheKey(): string {
    const mode = this.getGraphPhysicsLayout();
    return mode === "workflow"
      ? this.overviewScopeKey
      : `${mode}:${this.overviewScopeKey}`;
  }

  private setGraphPhysicsLayout(mode: GraphPhysicsLayout): void {
    if (this.temporalCursor !== null || mode === this.getGraphPhysicsLayout())
      return;
    this.stopGraphPhysics();
    this.physicsCamera = null;
    this.physicsWorld = null;
    this.overviewAnchor = null;
    this.overviewResetCamera = true;
    this.config?.set(CONFIG_KEY_GRAPH_PHYSICS_LAYOUT, mode);
    this.render();
  }

  private buildPhysicsEdges(nodes: GraphNode[]): GraphEdge[] {
    const edges = this.buildGraphFlowEdges(nodes);
    const visible = new Map(nodes.map((node) => [node.file.path, node]));
    const parents = this.getResolvedParentsByPath(this.graphNodes);
    const root = this.getConfiguredGraphRoot(nodes);
    const owners = new Map<string, GraphNode>();
    for (const node of nodes) {
      if (node === root) continue;
      const parent = parents.get(node.file.path);
      const owner =
        parent ??
        node.rollupTargets.find((scope) => visible.has(scope.file.path));
      if (
        owner &&
        visible.has(owner.file.path) &&
        owner.file.path !== node.file.path
      )
        owners.set(node.file.path, visible.get(owner.file.path)!);
    }
    const adjacency = new Map(
      nodes.map((node) => [node.file.path, new Set<string>()]),
    );
    const connect = (edge: GraphEdge): void => {
      adjacency.get(edge.from.file.path)?.add(edge.to.file.path);
      adjacency.get(edge.to.file.path)?.add(edge.from.file.path);
    };
    for (const edge of edges) {
      const fromOwner = owners.get(edge.from.file.path);
      const toOwner = owners.get(edge.to.file.path);
      const owning =
        fromOwner?.file.path === edge.to.file.path ||
        toOwner?.file.path === edge.from.file.path;
      const sameBranch =
        fromOwner !== undefined && fromOwner.file.path === toOwner?.file.path;
      edge.spring =
        isGraphSpringEdge(edge.kind) ||
        ((edge.kind === "membership" || edge.kind === "association") &&
          owning) ||
        (edge.kind === "compensation" && (owning || sameBranch));
      if (edge.spring) connect(edge);
    }
    const reached = new Set<string>();
    const visit = (path: string): void => {
      if (reached.has(path)) return;
      reached.add(path);
      for (const neighbor of adjacency.get(path) ?? []) visit(neighbor);
    };
    if (root) visit(root.file.path);
    else
      for (const node of nodes)
        if (!owners.has(node.file.path)) visit(node.file.path);
    let attached = true;
    while (attached) {
      attached = false;
      for (const node of nodes) {
        const owner = owners.get(node.file.path);
        if (
          reached.has(node.file.path) ||
          !owner ||
          !reached.has(owner.file.path)
        )
          continue;
        const edge: GraphEdge = {
          from: owner,
          to: node,
          kind: "association",
          spring: true,
        };
        edges.push(edge);
        connect(edge);
        visit(node.file.path);
        attached = true;
      }
    }
    return edges;
  }

  private getPhysicsNodeSize(node: GraphNode): {
    width: number;
    height: number;
  } {
    const diameter =
      node.kind === "group" || node.descendantCount > 0
        ? PHYSICS_SUMMARY_DIAMETER
        : PHYSICS_NODE_DIAMETER;
    return { width: diameter, height: diameter };
  }

  private renderPhysicsControls(toolbarEl: HTMLElement): void {
    const layouts = toolbarEl.createDiv({
      cls: "base-board-graph-presentation base-board-graph-physics-layouts",
      attr: { role: "group", "aria-label": "Physics layout" },
    });
    const selected = this.getGraphPhysicsLayout();
    this.containerEl.dataset.physicsLayout = selected;
    for (const [mode, label, icon] of [
      ["workflow", "Workflow layout", "lucide-git-branch"],
      ["hanging", "Hanging layout", "lucide-arrow-down"],
      ["growing", "Growing layout", "lucide-sprout"],
      ["radial", "Radial layout", "lucide-orbit"],
    ] as const) {
      const button = this.renderGraphIconButton(layouts, icon, label, () =>
        this.setGraphPhysicsLayout(mode),
      );
      button.setAttribute("aria-pressed", String(mode === selected));
    }
    const controls = toolbarEl.createDiv({
      cls: "base-board-graph-zoom-controls base-board-graph-physics-controls",
    });
    this.physicsToggleEl = this.renderGraphIconButton(
      controls,
      "lucide-pause",
      "Pause physics",
      () => {
        if (
          !this.physicsPaused &&
          this.physicsSimulation &&
          !this.physicsSimulation.settled
        ) {
          this.physicsPaused = true;
          this.cancelPhysicsFrame();
        } else {
          this.physicsPaused = false;
          this.physicsSimulation?.reheat();
          this.animateGraphPhysics();
        }
        this.updatePhysicsControls();
      },
    );
    this.renderGraphIconButton(
      controls,
      "lucide-rotate-ccw",
      "Reset physics layout",
      () => {
        this.stopGraphPhysics();
        this.physicsCaches.delete(this.getPhysicsCacheKey());
        this.physicsPaused = false;
        this.overviewResetCamera = true;
        this.render();
      },
    );
    this.updatePhysicsControls();
  }

  private updatePhysicsControls(): void {
    const running =
      !this.physicsPaused &&
      this.physicsSimulation !== null &&
      !this.physicsSimulation.settled;
    this.containerEl.dataset.physicsState = this.physicsPaused
      ? "paused"
      : running
        ? "running"
        : "settled";
    const label = running ? "Pause physics" : "Resume physics";
    if (this.physicsToggleEl) {
      setIcon(this.physicsToggleEl, running ? "lucide-pause" : "lucide-play");
      this.physicsToggleEl.setAttribute("aria-label", label);
      this.physicsToggleEl.setAttribute("title", label);
      this.physicsToggleEl.disabled = this.visibleNodes.length === 0;
      setTooltip(this.physicsToggleEl, label);
    }
  }

  private startGraphPhysics(
    viewport: HTMLElement,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    if (
      !this.isGraphPhysics() ||
      this.temporalDisposed ||
      !viewport.isConnected
    )
      return;
    const cache = this.physicsActiveCache;
    if (!cache) return;
    const mode = this.getGraphPhysicsLayout();
    const bodies = nodes.map((node): GraphPhysicsNode => ({
      id: this.getTemporalNodeKey(node),
      x: node.x,
      y: node.y,
      ...this.getPhysicsNodeSize(node),
      shape: "circle",
      anchor:
        mode === "workflow"
          ? this.physicsLayoutAnchors.get(this.getTemporalNodeKey(node))
          : undefined,
      depth: this.physicsDepths.get(this.getTemporalNodeKey(node)),
      fixed: this.getTemporalNodeKey(node) === this.physicsRootKey,
    }));
    const links = edges
      .filter((edge) => edge.spring)
      .map((edge) => ({
        source: this.getTemporalNodeKey(edge.from),
        target: this.getTemporalNodeKey(edge.to),
        kind: edge.kind,
        spring: true,
      }));
    const signature = JSON.stringify({
      layout: mode,
      nodes: bodies
        .map((node) => [
          node.id,
          node.width,
          node.height,
          node.fixed,
          node.depth,
        ])
        .sort(),
      links: links.map((link) => [link.source, link.target, link.kind]).sort(),
    });
    if (signature !== cache.signature) cache.energy = 1;
    cache.signature = signature;
    this.physicsNodes = new Map(
      nodes.map((node) => [this.getTemporalNodeKey(node), node]),
    );
    this.physicsSizes = new Map(
      nodes.map((node) => [node.file.path, this.getPhysicsNodeSize(node)]),
    );
    const elements = new Map(
      [...viewport.querySelectorAll<HTMLElement>(".base-board-graph-node")].map(
        (element) => [element.dataset.filePath, element],
      ),
    );
    this.physicsElements.clear();
    for (const node of nodes) {
      const element = elements.get(node.file.path);
      if (element)
        this.physicsElements.set(this.getTemporalNodeKey(node), element);
    }
    this.physicsViewportEl = viewport;
    this.physicsSimulation = new GraphPhysics(bodies, links, {
      ...GRAPH_PHYSICS_SPACING,
      energy: cache.energy,
      layout: mode,
    });
    this.animateGraphPhysics();
    this.updatePhysicsControls();
  }

  private applyPhysicsPositions(positions: GraphPhysicsNode[]): void {
    for (const position of positions) {
      const node = this.physicsNodes.get(position.id);
      if (!node) continue;
      node.x = position.x;
      node.y = position.y;
      this.physicsActiveCache?.positions.set(position.id, {
        x: node.x,
        y: node.y,
      });
      if (position.anchor)
        this.physicsActiveCache?.guides.set(position.id, {
          ...position.anchor,
        });
    }
    const viewport = this.physicsViewportEl;
    if (viewport)
      this.expandGraphWorldForRect(
        this.getNodesWorldBounds([...this.physicsNodes.values()]),
        viewport,
      );
    for (const [id, node] of this.physicsNodes) {
      const element = this.physicsElements.get(id);
      if (element) this.positionRenderedGraphNodeEl(element, node);
    }
    this.syncRenderedGraphEdges();
    if (this.physicsSimulation && this.physicsActiveCache)
      this.physicsActiveCache.energy = this.physicsSimulation.energy;
  }

  private animateGraphPhysics(): void {
    if (
      this.physicsFrame !== null ||
      this.physicsPaused ||
      !this.physicsSimulation ||
      this.physicsSimulation.settled
    )
      return;
    const simulation = this.physicsSimulation;
    const advance = (): void => {
      this.physicsFrame = null;
      if (
        this.temporalDisposed ||
        this.physicsPaused ||
        this.physicsSimulation !== simulation ||
        !this.isGraphPhysics() ||
        !this.physicsViewportEl?.isConnected
      )
        return;
      this.applyPhysicsPositions(simulation.tick());
      if (!simulation.settled)
        this.physicsFrame = window.requestAnimationFrame(advance);
      else this.updatePhysicsControls();
    };
    this.physicsFrame = window.requestAnimationFrame(advance);
  }

  private cancelPhysicsFrame(): void {
    if (this.physicsFrame !== null)
      window.cancelAnimationFrame(this.physicsFrame);
    this.physicsFrame = null;
  }

  private stopGraphPhysics(): void {
    this.cancelPhysicsFrame();
    this.containerEl.removeClass("base-board-graph--tracing");
    if (this.physicsSimulation && this.physicsActiveCache)
      this.physicsActiveCache.energy = this.physicsSimulation.energy;
    this.physicsSimulation?.stop();
    this.physicsSimulation = null;
    this.physicsActiveCache = null;
    this.physicsViewportEl = null;
    this.physicsToggleEl = null;
    this.physicsElements.clear();
    this.physicsNodes.clear();
    this.physicsSizes.clear();
    this.physicsDepths.clear();
    this.physicsRouteNodes = [];
  }

  private prepareScopedOverview(nodes: GraphNode[]): GraphNode[] {
    const root = this.getConfiguredGraphRoot(nodes);
    const saved = this.config?.get(CONFIG_KEY_GRAPH_OVERVIEW_FOCUS);
    const requested =
      this.temporalCursor !== null
        ? this.temporalScopeKey
        : typeof saved === "string"
          ? saved
          : root
            ? this.getTemporalNodeKey(root)
            : undefined;
    const target =
      typeof requested === "string" &&
      requested !== OVERVIEW_ALL &&
      requested !== OVERVIEW_UNASSIGNED
        ? nodes.find((node) => this.getTemporalNodeKey(node) === requested)
        : undefined;
    this.overviewMissingScope =
      typeof requested === "string" &&
      requested !== OVERVIEW_ALL &&
      requested !== OVERVIEW_UNASSIGNED &&
      !target;
    const context = selectOverviewScope(
      nodes,
      requested === undefined ? undefined : (target ?? null),
    );
    const scopeKey =
      requested ??
      (context.focus ? this.getTemporalNodeKey(context.focus) : OVERVIEW_ALL);
    if (this.overviewFirstLayout && this.temporalCursor === null) {
      this.overviewFirstLayout = false;
      this.overviewResetCamera = true;
    }
    if (scopeKey !== this.overviewScopeKey && this.temporalCursor === null)
      this.overviewResetCamera = true;
    this.overviewScopeKey = scopeKey;
    this.overviewUnassigned = context.unassigned;
    if (!this.overviewMissingScope) {
      this.overviewBreadcrumbs =
        scopeKey === OVERVIEW_UNASSIGNED
          ? [{ key: OVERVIEW_UNASSIGNED, title: "Unassigned" }]
          : context.breadcrumbs.map((node) => ({
              key: this.getTemporalNodeKey(node),
              title: node.title,
            }));
    } else if (
      !this.overviewBreadcrumbs.some((entry) => entry.key === scopeKey)
    ) {
      const record = this.temporalLiveNodes.find(
        (node) => node.key === scopeKey,
      );
      this.overviewBreadcrumbs = [
        { key: scopeKey, title: record?.title ?? "Unavailable branch" },
      ];
    }
    this.overviewScopeNodes = this.overviewMissingScope
      ? []
      : scopeKey === OVERVIEW_UNASSIGNED
        ? context.unassigned
        : context.included;
    let roots = this.overviewMissingScope
      ? []
      : scopeKey === OVERVIEW_UNASSIGNED
        ? context.unassigned
        : context.roots;
    let available = [...this.overviewScopeNodes];
    if (target && roots.length === 0 && !this.overviewMissingScope)
      roots = [target];
    if (scopeKey === OVERVIEW_ALL && context.unassigned.length > 0) {
      const virtual = this.createUnassignedOverviewNode(context.unassigned);
      this.graphWorkSummaries.set(
        virtual.file.path,
        summarizeGraphWork(virtual),
      );
      roots = [...roots, virtual];
      available.push(virtual);
    }
    const layout = layoutOverviewClusters(
      roots,
      available,
      new Set(available.filter((node) => node.collapsed)),
      {
        viewportWidth: Math.max(
          320,
          (this.containerEl.clientWidth || this.scrollEl.clientWidth || 1100) -
            48,
        ),
        width: NODE_WIDTH,
        summaryHeight: OVERVIEW_NODE_HEIGHT,
        headingHeight: OVERVIEW_HEADING_HEIGHT,
        taskHeight: OVERVIEW_TASK_HEIGHT,
        compress: !this.isGraphPhysics(),
      },
    );
    this.overviewItems = new Map(
      layout.items.map((item) => [item.node.file.path, item]),
    );
    this.overviewEdges = layout.edges.map(({ from, to }) => ({
      from,
      to,
      kind: "requirement-start",
    }));
    this.physicsRootKey = null;
    this.physicsContextPaths.clear();
    const physicsOrigin = root ?? context.focus;
    if (this.isGraphPhysics() && physicsOrigin && !this.overviewMissingScope) {
      this.physicsRootKey = root ? this.getTemporalNodeKey(root) : null;
      const anchored = connectOverviewToRoot(
        nodes,
        layout.items.map((item) => item.node),
        physicsOrigin,
      );
      const connectors = anchored.nodes.filter(
        (node) =>
          node === physicsOrigin || !this.overviewItems.has(node.file.path),
      );
      for (const item of this.overviewItems.values()) {
        item.x += NODE_WIDTH + 100;
        if (item.trail.length) {
          item.height -= 20;
          item.trail = [];
        }
      }
      let connectorIndex = 1;
      for (const node of connectors) {
        this.physicsContextPaths.add(node.file.path);
        this.overviewItems.set(node.file.path, {
          node,
          trail: [],
          role: node === physicsOrigin ? "summary" : "heading",
          x: 0,
          y:
            node === physicsOrigin
              ? 0
              : OVERVIEW_NODE_HEIGHT +
                connectorIndex++ * (OVERVIEW_HEADING_HEIGHT + 80),
          height:
            node === physicsOrigin
              ? OVERVIEW_NODE_HEIGHT
              : OVERVIEW_HEADING_HEIGHT,
        });
      }
      this.overviewEdges = anchored.edges.map(({ from, to }) =>
        from.children.includes(to)
          ? { from, to, kind: "requirement-start" }
          : { from: to, to: from, kind: "membership" },
      );
      return anchored.nodes;
    }
    return layout.items.map((item) => item.node);
  }

  private createUnassignedOverviewNode(unassigned: GraphNode[]): GraphNode {
    const file = new TFile();
    file.path = OVERVIEW_UNASSIGNED;
    file.name = "Unassigned";
    file.basename = "Unassigned";
    file.extension = "";
    file.stat = { ctime: 0, mtime: 0, size: 0 };
    return {
      ...unassigned[0],
      entry: null,
      file,
      title: "Unassigned",
      status: null,
      parentKey: null,
      parentValue: null,
      dependsOnKeys: [],
      breaksToKeys: [],
      restartsToKeys: [],
      rollupToKeys: [],
      compensatesKeys: [],
      effecting: false,
      nodeType: null,
      workflow: null,
      collapsed: true,
      descendantCount: unassigned.length,
      children: unassigned,
      members: [],
      successors: [],
      predecessors: [],
      breakTargets: [],
      restartTargets: [],
      rollupTargets: [],
      compensatesTargets: [],
      compensatedBy: [],
      needsCompensation: false,
      excludedFromFold: false,
      kindExplicit: "group",
      kind: "group",
      executorExplicit: null,
      executor: "human",
      autonomyExplicit: null,
      autonomy: "propose",
      lockedExplicit: null,
      effectiveLocked: false,
      x: 0,
      y: 0,
      savedX: null,
      savedY: null,
      state: "idle",
    };
  }

  private focusOverview(key: string): void {
    if (this.overviewScopeKey === key) return;
    if (this.graphViewportPersistTimer)
      window.clearTimeout(this.graphViewportPersistTimer);
    this.graphViewportPersistTimer = null;
    this.overviewResetCamera = true;
    this.overviewAnchor = null;
    if (this.temporalCursor !== null) {
      this.temporalPositionScopes.set(
        this.overviewScopeKey,
        this.temporalPositions,
      );
      this.temporalPositions =
        this.temporalPositionScopes.get(key) ??
        new Map<string, { x: number; y: number }>();
      this.temporalScopeKey = key;
    } else this.config?.set(CONFIG_KEY_GRAPH_OVERVIEW_FOCUS, key);
    this.temporalChangedKeys.clear();
    this.temporalAddedKeys.clear();
    this.temporalUpdatedCount = 0;
    this.temporalRemovedNodes = [];
    this.render();
  }

  private renderOverviewNavigation(): void {
    const navigation = this.getGraphContentEl().createEl("nav", {
      cls: "base-board-graph-breadcrumbs",
      attr: { "aria-label": "Graph scope" },
    });
    const all = this.renderGraphIconButton(
      navigation,
      "lucide-house",
      "All work",
      () => this.focusOverview(OVERVIEW_ALL),
    );
    if (this.overviewScopeKey === OVERVIEW_ALL)
      all.setAttribute("aria-current", "page");
    const root = this.getConfiguredGraphRoot();
    const rootKey = root ? this.getTemporalNodeKey(root) : null;
    const breadcrumbs = root
      ? [
          { key: rootKey!, title: root.title },
          ...this.overviewBreadcrumbs.filter((crumb) => crumb.key !== rootKey),
        ]
      : this.overviewBreadcrumbs;
    for (const crumb of breadcrumbs) {
      const separator = navigation.createSpan({
        cls: "base-board-graph-breadcrumb-separator",
        attr: { "aria-hidden": "true" },
      });
      setIcon(separator, "lucide-chevron-right");
      const button = navigation.createEl("button", {
        cls: "base-board-graph-breadcrumb",
        text: crumb.title,
        attr: { type: "button", title: crumb.title },
      });
      if (crumb.key === this.overviewScopeKey)
        button.setAttribute("aria-current", "page");
      if (crumb.key === rootKey) {
        button.setAttribute("aria-label", `${crumb.title}, graph root`);
        const mark = button.createSpan({
          cls: "base-board-graph-root-mark",
          attr: { "aria-hidden": "true" },
        });
        setIcon(mark, "lucide-pin");
        button.prepend(mark);
      }
      button.addEventListener("click", () => this.focusOverview(crumb.key));
    }
    const branches = this.renderGraphIconButton(
      navigation,
      "lucide-list-tree",
      "Choose scope or workstream",
      () => {
        const menu = new Menu();
        for (const node of this.graphNodes.filter(
          (candidate) =>
            candidate.kind === "group" || candidate.descendantCount > 0,
        )) {
          menu.addItem((item) =>
            item
              .setTitle(node.title)
              .setIcon(
                node.kind === "group" ? "lucide-folder" : "lucide-git-branch",
              )
              .onClick(() => this.focusOverview(this.getTemporalNodeKey(node))),
          );
        }
        const bounds = branches.getBoundingClientRect();
        menu.showAtPosition({ x: bounds.left, y: bounds.bottom });
      },
    );
    const rootPicker = this.renderGraphIconButton(
      navigation,
      "lucide-pin",
      "Choose graph root",
      () => {
        const menu = new Menu();
        for (const node of this.graphNodes.filter(
          (candidate) =>
            candidate.kind === "group" || candidate.descendantCount > 0,
        )) {
          menu.addItem((item) =>
            item
              .setTitle(node.title)
              .setIcon("lucide-pin")
              .setChecked(node === root)
              .onClick(() => this.setGraphRoot(node)),
          );
        }
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Clear fixed root")
            .setIcon("lucide-pin-off")
            .onClick(() => this.setGraphRoot(null)),
        );
        const bounds = rootPicker.getBoundingClientRect();
        menu.showAtPosition({ x: bounds.left, y: bounds.bottom });
      },
    );
    rootPicker.disabled = this.temporalCursor !== null;
    if (this.overviewUnassigned.length > 0) {
      const unassigned = this.renderGraphIconButton(
        navigation,
        "lucide-inbox",
        `Unassigned: ${this.overviewUnassigned.length} items`,
        () => this.focusOverview(OVERVIEW_UNASSIGNED),
      );
      unassigned.addClass("base-board-graph-unassigned-button");
      unassigned.createSpan({
        text: String(this.overviewUnassigned.length),
        attr: { "aria-hidden": "true" },
      });
      const attention = this.overviewUnassigned.filter(
        (node) => node.state === "blocked" || node.state === "interrupted",
      ).length;
      if (attention)
        this.renderGraphVisual(
          unassigned,
          "base-board-graph-unassigned-attention",
          `${attention} unassigned items need attention`,
          "lucide-octagon-alert",
          getGraphStateVisual("blocked").color,
          String(attention),
        );
    }
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

  private getTemporalNodeKey(node: GraphNode): string {
    if (node.file.path === OVERVIEW_UNASSIGNED) return OVERVIEW_UNASSIGNED;
    return (
      this.temporalSnapshots.get(node.file.path)?.key ??
      this.temporalFileKeys.get(node.file) ??
      `path:${node.file.path}`
    );
  }

  private observeTemporalGraph(nodes: GraphNode[]): void {
    if (
      this.temporalRecordingEnabled &&
      !this.temporalRecordingId &&
      !this.temporalRecordingError &&
      !this.temporalDisposed
    ) {
      try {
        const saved = this.config?.get(CONFIG_KEY_GRAPH_RECORDING);
        if (
          saved !== undefined &&
          (typeof saved !== "string" || !/^graph-[a-z0-9-]+$/.test(saved))
        ) {
          throw new Error("Invalid graph recording identity in view settings");
        }
        this.temporalRecordingId =
          typeof saved === "string" ? saved : `graph-${crypto.randomUUID()}`;
        if (saved === undefined)
          this.config?.set(
            CONFIG_KEY_GRAPH_RECORDING,
            this.temporalRecordingId,
          );
        this.temporalHistory = this.plugin.getRecordedGraphHistory(
          this.temporalRecordingId,
        );
      } catch (error) {
        this.reportTemporalError(error);
      }
    }
    const known = this.temporalHistory
      ? (graphAtTime(
          this.temporalHistory,
          this.temporalHistory.observedThrough,
        ) ?? [])
      : [];
    const knownByPath = new Map(known.map((node) => [node.path, node]));
    const knownByIdentity = new Map<string, GraphHistoryNode>();
    for (const node of known)
      for (const identity of node.identities)
        knownByIdentity.set(identity, node);
    const snapshot = nodes.map((node): GraphHistoryNode => {
      const id = this.getFrontmatter(node.file)?.id;
      const previous =
        knownByPath.get(node.file.path) ??
        (typeof id === "string" && id.trim()
          ? knownByIdentity.get(id.trim().toLowerCase())
          : undefined);
      const key =
        this.temporalFileKeys.get(node.file) ??
        previous?.key ??
        (typeof id === "string" && id.trim()
          ? `id:${id.trim()}`
          : `path:${node.file.path}`);
      this.temporalFileKeys.set(node.file, key);
      return {
        key,
        path: node.file.path,
        title: node.title,
        identities: this.getNodeIdentities(node),
        status: node.status,
        parentKey: node.parentKey,
        parentValue: node.parentValue,
        dependsOnKeys: node.dependsOnKeys,
        breaksToKeys: node.breaksToKeys,
        restartsToKeys: node.restartsToKeys,
        rollupToKeys: node.rollupToKeys,
        compensatesKeys: node.compensatesKeys,
        effecting: node.effecting,
        nodeType: node.nodeType,
        workflow: node.workflow,
        kindExplicit: node.kindExplicit,
        executorExplicit: node.executorExplicit,
        autonomyExplicit: node.autonomyExplicit,
        lockedExplicit: node.lockedExplicit,
        order: this.getOrder(node.file),
      };
    });
    this.temporalLiveNodes = snapshot;
    if (
      !this.temporalRecordingEnabled ||
      !this.temporalRecordingId ||
      this.temporalRecordingError ||
      this.temporalDisposed
    )
      return;
    try {
      const recordingId = this.temporalRecordingId;
      void this.plugin
        .recordGraphHistory(
          recordingId,
          snapshot,
          Date.now(),
          this.temporalSession,
        )
        .then(() => {
          if (this.temporalDisposed) return;
          this.temporalHistory =
            this.plugin.getRecordedGraphHistory(recordingId);
          this.renderTemporalNavigation();
        })
        .catch((error: unknown) => this.reportTemporalError(error));
    } catch (error) {
      this.reportTemporalError(error);
    }
  }

  private reportTemporalError(error: unknown): void {
    this.temporalRecordingError =
      error instanceof Error ? error.message : String(error);
    console.error("Base Board: graph history is unavailable", error);
    this.renderTemporalNavigation();
  }

  private setTemporalTime(at: number | null): void {
    if (at !== null && !Number.isFinite(at)) return;
    const history = this.temporalHistory;
    if (!history?.frames.length) return;
    const next =
      at === null
        ? null
        : Math.max(history.frames[0].at, Math.min(this.getTemporalEnd(), at));
    if (next === this.temporalCursor) return;
    if (this.temporalCursor === null && next !== null) {
      this.temporalScopeKey = this.isGraphOverview()
        ? this.overviewScopeKey
        : OVERVIEW_ALL;
      this.temporalReturnScopeKey = this.overviewScopeKey;
      if (!this.isGraphOverview()) this.overviewResetCamera = true;
      this.temporalPositionScopes.clear();
      const viewport = this.getGraphViewportEl();
      this.temporalReturnCamera = viewport
        ? this.getGraphViewportState(viewport)
        : this.graphViewportState;
      this.temporalExpandedKeys = new Set(
        this.graphNodes
          .filter((node) => !node.collapsed)
          .map((node) => this.getTemporalNodeKey(node)),
      );
      this.temporalPositions = new Map(
        (this.isGraphOverview() ? this.visibleNodes : []).map((node) => [
          this.getTemporalNodeKey(node),
          { x: node.x, y: node.y },
        ]),
      );
    }
    const previous =
      this.temporalRenderedCursor === null
        ? this.temporalLiveNodes
        : (graphAtTime(history, this.temporalRenderedCursor) ?? []);
    const current =
      next === null
        ? this.temporalLiveNodes
        : (graphAtTime(history, next) ?? []);
    const focusKey = this.temporalScopeKey ?? this.overviewScopeKey;
    const scopedBefore = scopeGraphSnapshot(previous, focusKey);
    const scopedAfter = scopeGraphSnapshot(current, focusKey);
    const changes = compareGraphSnapshots(scopedBefore, scopedAfter);
    this.temporalChangedKeys = changedGraphHistoryKeys(
      scopedBefore,
      scopedAfter,
    );
    this.temporalAddedKeys = new Set(changes.added.map((node) => node.key));
    this.temporalUpdatedCount = changes.updated.length;
    this.temporalRemovedNodes = changes.removed;
    this.temporalCursor = next;
    if (next === null) {
      if (this.temporalScopeKey !== this.temporalReturnScopeKey) {
        this.temporalChangedKeys.clear();
        this.temporalAddedKeys.clear();
        this.temporalUpdatedCount = 0;
        this.temporalRemovedNodes = [];
      }
      this.overviewScopeKey = this.temporalReturnScopeKey;
      this.temporalScopeKey = null;
      this.overviewResetCamera = false;
      this.temporalRestoreCamera = this.temporalReturnCamera;
      this.renderedPresentation = null;
      this.temporalSnapshots.clear();
      this.temporalPositions.clear();
      this.temporalPositionScopes.clear();
    }
    if (this.temporalRenderFrame !== null)
      window.cancelAnimationFrame(this.temporalRenderFrame);
    this.temporalRenderFrame = window.requestAnimationFrame(() => {
      this.temporalRenderFrame = null;
      if (!this.temporalDisposed) this.render();
    });
  }

  private getTemporalEnd(): number {
    return Math.max(Date.now(), this.temporalHistory?.observedThrough ?? 0);
  }

  private stepTemporalDay(direction: -1 | 1): void {
    const history = this.temporalHistory;
    if (!history?.frames.length) return;
    this.setTemporalTime(
      stepGraphHistoryDay(
        this.temporalCursor ?? this.getTemporalEnd(),
        direction,
        history.frames[0].at,
        this.getTemporalEnd(),
      ),
    );
  }

  private stepTemporalChange(direction: -1 | 1): void {
    const history = this.getScopedTemporalHistory();
    if (!history) return;
    const next = adjacentGraphHistoryChange(
      history,
      this.temporalCursor ?? this.getTemporalEnd(),
      direction,
    );
    if (next !== null) this.setTemporalTime(next);
  }

  private getScopedTemporalHistory(): GraphHistory | null {
    const history = this.temporalHistory;
    if (!history) return null;
    const key = this.getTemporalFocusKey();
    const cached = this.temporalScopeCache;
    if (
      cached &&
      cached.key === key &&
      cached.source.frames === history.frames
    ) {
      return { ...cached.history, observedThrough: history.observedThrough };
    }
    const scoped = scopeGraphHistory(history, key);
    this.temporalScopeCache = { key, source: history, history: scoped };
    return scoped;
  }

  private getTemporalFocusKey(): string {
    return this.temporalCursor !== null
      ? (this.temporalScopeKey ?? this.overviewScopeKey)
      : this.isGraphOverview()
        ? this.overviewScopeKey
        : OVERVIEW_ALL;
  }

  private renderTemporalNavigation(): void {
    if (this.temporalDisposed) return;
    if (!this.temporalBarEl) {
      this.temporalBarEl = this.containerEl.createDiv({
        cls: "base-board-graph-history",
        attr: { "aria-label": "Recorded graph history" },
      });
      const controls = this.temporalBarEl.createDiv({
        cls: "base-board-graph-history-controls",
      });
      for (const [key, icon, label, action] of [
        [
          "previous-change",
          "lucide-skip-back",
          "Previous recorded change",
          () => this.stepTemporalChange(-1),
        ],
        [
          "previous-day",
          "lucide-chevron-left",
          "Previous day",
          () => this.stepTemporalDay(-1),
        ],
        [
          "next-day",
          "lucide-chevron-right",
          "Next day",
          () => this.stepTemporalDay(1),
        ],
        [
          "next-change",
          "lucide-skip-forward",
          "Next recorded change",
          () => this.stepTemporalChange(1),
        ],
        [
          "present",
          "lucide-radio",
          "Return to present",
          () => this.setTemporalTime(null),
        ],
        [
          "retry",
          "lucide-refresh-cw",
          "Retry graph recording",
          () => {
            this.temporalRecordingError = null;
            this.render();
          },
        ],
      ] as const)
        this.temporalControls.set(
          key,
          this.renderGraphIconButton(controls, icon, label, action),
        );
      this.temporalDateEl = controls.createEl("time", {
        cls: "base-board-graph-history-date",
      });
      this.temporalStatusEl = controls.createSpan({
        cls: "base-board-graph-history-status",
        attr: { role: "img" },
      });
      const track = this.temporalBarEl.createDiv({
        cls: "base-board-graph-history-track",
      });
      this.temporalEventsEl = track.createDiv({
        cls: "base-board-graph-history-events",
        attr: { "aria-hidden": "true" },
      });
      this.temporalRangeEl = track.createEl("input", {
        attr: { type: "range", step: "1", "aria-label": "Graph history time" },
      });
      this.temporalRangeEl.addEventListener("input", () => {
        if (this.temporalRangeEl)
          this.setTemporalTime(Number(this.temporalRangeEl.value));
      });
      this.temporalBarEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight" &&
          event.key !== "Home" &&
          event.key !== "End"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "End") this.setTemporalTime(null);
        else if (event.key === "Home")
          this.setTemporalTime(this.temporalHistory?.frames[0]?.at ?? null);
        else if (event.shiftKey)
          this.stepTemporalChange(event.key === "ArrowLeft" ? -1 : 1);
        else this.stepTemporalDay(event.key === "ArrowLeft" ? -1 : 1);
      });
      this.temporalBarEl.addEventListener(
        "wheel",
        (event: WheelEvent) => {
          if (!this.temporalHistory || event.ctrlKey || event.metaKey) return;
          const delta =
            Math.abs(event.deltaX) > Math.abs(event.deltaY)
              ? event.deltaX
              : event.deltaY;
          if (!delta) return;
          event.preventDefault();
          event.stopPropagation();
          const duration =
            this.getTemporalEnd() - this.temporalHistory.frames[0].at;
          const scale = Math.max(1, duration / 600);
          this.setTemporalTime(
            (this.temporalCursor ?? this.getTemporalEnd()) +
              delta * scale * (event.deltaMode === 1 ? 16 : 1),
          );
        },
        { passive: false },
      );
      this.temporalChangesEl = this.temporalBarEl.createDiv({
        cls: "base-board-graph-history-changes",
      });
    }
    const history = this.getScopedTemporalHistory();
    const range = this.temporalRangeEl;
    if (
      !range ||
      !this.temporalDateEl ||
      !this.temporalStatusEl ||
      !this.temporalEventsEl ||
      !this.temporalChangesEl
    )
      return;
    const from = history?.frames[0]?.at ?? Date.now();
    const through = this.getTemporalEnd();
    const selected = this.temporalCursor ?? through;
    range.min = String(from);
    range.max = String(Math.max(from + 1, through));
    range.value = String(selected);
    range.disabled = !history || Boolean(this.temporalRecordingError);
    range.setAttribute(
      "aria-valuetext",
      `${this.getTemporalFocusKey() === OVERVIEW_ALL ? "All work" : (this.overviewBreadcrumbs[this.overviewBreadcrumbs.length - 1]?.title ?? "Selected scope")}; ${this.temporalCursor === null ? "Present" : "Recorded snapshot"}: ${new Date(selected).toLocaleString()}`,
    );
    this.temporalDateEl.textContent = new Date(selected).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    this.temporalDateEl.dateTime = new Date(selected).toISOString();
    const inGap = history ? isGraphHistoryGap(history, selected) : false;
    const status = this.temporalRecordingError
      ? `Graph recording error: ${this.temporalRecordingError}`
      : !history
        ? "Waiting for the first graph observation"
        : inGap
          ? "Observation gap: showing the last known graph, not a verified snapshot of this time"
          : `Recording began ${new Date(from).toLocaleString()}. Observed graph metadata only; note contents and unobserved changes are not recorded.`;
    setIcon(
      this.temporalStatusEl,
      this.temporalRecordingError || inGap
        ? "lucide-octagon-alert"
        : this.temporalCursor === null
          ? "lucide-radio"
          : "lucide-history",
    );
    this.temporalStatusEl.setAttribute("aria-label", status);
    this.temporalStatusEl.setAttribute("title", status);
    setTooltip(this.temporalStatusEl, status);
    this.temporalBarEl.toggleClass("base-board-graph-history--gap", inGap);
    this.temporalBarEl.toggleClass(
      "base-board-graph-history--error",
      Boolean(this.temporalRecordingError),
    );
    for (const [key, button] of this.temporalControls) {
      if (key === "retry") {
        button.hidden = !this.temporalRecordingError;
        button.disabled = false;
        continue;
      }
      if (key === "present") {
        button.disabled = this.temporalCursor === null;
        continue;
      }
      button.disabled =
        !history ||
        Boolean(this.temporalRecordingError) ||
        ((key === "previous-day" || key === "previous-change") &&
          selected <= from) ||
        (key === "next-day" && selected >= through) ||
        (key === "next-change" &&
          history !== null &&
          adjacentGraphHistoryChange(history, selected, 1) === null);
    }
    this.temporalEventsEl.empty();
    if (history) {
      const stride = Math.max(1, Math.ceil(history.frames.length / 240));
      history.frames.forEach((frame, index) => {
        if (frame.gapAfter !== null && frame.at > frame.gapAfter) {
          const gap = this.temporalEventsEl!.createSpan({
            cls: "base-board-graph-history-gap",
          });
          gap.style.left = `${((frame.gapAfter - from) / Math.max(1, through - from)) * 100}%`;
          gap.style.width = `${((frame.at - frame.gapAfter) / Math.max(1, through - from)) * 100}%`;
        }
        if (index % stride !== 0 && index !== history.frames.length - 1) return;
        const marker = this.temporalEventsEl!.createSpan({
          cls: `base-board-graph-history-event base-board-graph-history-event--${frame.kind}`,
        });
        marker.style.left = `${((frame.at - from) / Math.max(1, through - from)) * 100}%`;
        marker.style.height = `${Math.min(16, 4 + frame.upserts.length + frame.removed.length)}px`;
      });
    }
    this.temporalChangesEl.empty();
    for (const [icon, label, value] of [
      [
        "lucide-circle-plus",
        "Items added since the previously selected time",
        this.temporalAddedKeys.size,
      ],
      [
        "lucide-pencil",
        "Items changed since the previously selected time",
        this.temporalUpdatedCount,
      ],
      [
        "lucide-circle-minus",
        `Items that left this graph: ${this.temporalRemovedNodes.map((node) => node.title).join(", ")}`,
        this.temporalRemovedNodes.length,
      ],
    ] as const) {
      if (value)
        this.renderGraphVisual(
          this.temporalChangesEl,
          "base-board-graph-history-change",
          label,
          icon,
          undefined,
          String(value),
        );
    }
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
    const visual = getGraphStateVisual(state);
    this.renderGraphVisual(
      toolbarEl,
      `base-board-graph-stat base-board-graph-stat--${state}`,
      `${label}: ${count}`,
      visual.icon,
      visual.color,
      String(count),
    );
  }

  private renderGraphVisual(
    parentEl: HTMLElement,
    className: string,
    label: string,
    icon: string,
    color?: string,
    value?: string,
  ): HTMLElement {
    const element = parentEl.createSpan({
      cls: `${className} base-board-graph-icon-value`,
      attr: { role: "img", "aria-label": label, title: label },
    });
    if (color) element.style.setProperty("--graph-status-color", color);
    const iconEl = element.createSpan({
      cls: "base-board-graph-status-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(iconEl, icon);
    if (value !== undefined) {
      element.createSpan({
        cls: "base-board-graph-stat-value",
        text: value,
        attr: { "aria-hidden": "true" },
      });
    }
    setTooltip(element, label);
    return element;
  }

  private renderGraphFrontierButton(toolbarEl: HTMLElement): void {
    const controlsEl = toolbarEl.createDiv({
      cls: "base-board-graph-zoom-controls",
    });
    this.renderGraphIconButton(
      controlsEl,
      "lucide-target",
      "Active frontier & hygiene",
      () => {
        this.showGraphFrontier();
      },
    );
  }

  // --- Frontier / lineage / hygiene (read-only projection of the graph) -------
  // The "active frontier" is the set of actionable work leaves at the live edge
  // of each branch — the nodes that will project onto the Kanban. This panel is
  // a read-only validation surface for that derivation + the work breadcrumb.

  /**
   * A leaf is on the frontier when it is actionable now: a work leaf (not a
   * group/container) whose gating prerequisites are satisfied and which is not
   * terminal — i.e. its derived state is the live edge (active/awaiting/blocked/
   * failed), never completed/cancelled/invalidated/waiting.
   */
  private isFrontierLeaf(node: GraphNode): boolean {
    return engineIsFrontierLeaf(node);
  }

  private getGraphFrontier(): GraphNode[] {
    return (
      this.isGraphOverview() ? this.overviewScopeNodes : this.graphNodes
    ).filter((node) => this.isFrontierLeaf(node));
  }

  /**
   * The work breadcrumb for a node: the containment chain from the node up to
   * (and including) the topmost non-group ancestor — the feature/work-root.
   * Stops *below* the scope/aggregation layer (a `group` ancestor), since the
   * scope context is the lens's job, not the breadcrumb's. Returned top→down.
   */
  private getNodeLineage(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
  ): string[] {
    return engineGetNodeLineage(
      node,
      (candidate) =>
        parentByPath.get((candidate as GraphNode).file.path) ?? null,
    );
  }

  /**
   * Finds work/process nodes disconnected from the hierarchy: containment roots
   * that are not rolled up into any scope (e.g. leftover Kanban-era items). Used
   * to drive folding the vault's disparate items into the proper structure.
   */
  private getGraphHygiene(): GraphHygieneItem[] {
    const parentByPath = this.getResolvedParentsByPath(this.graphNodes);
    return engineGetHygiene(
      this.isGraphOverview() ? this.overviewScopeNodes : this.graphNodes,
      (candidate) =>
        parentByPath.get((candidate as GraphNode).file.path) ?? null,
    );
  }

  private showGraphFrontier(): void {
    const parentByPath = this.getResolvedParentsByPath(this.graphNodes);
    const frontier: GraphFrontierItem[] = this.getGraphFrontier()
      .map((node) => ({
        lineage: this.getNodeLineage(node, parentByPath),
        status: node.status,
        state: node.state,
      }))
      .sort((first, second) =>
        first.lineage.join(" › ").localeCompare(second.lineage.join(" › ")),
      );
    new GraphFrontierModal(this.app, frontier, this.getGraphHygiene()).open();
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
    const viewportEl = this.getGraphContentEl().createDiv({
      cls: "base-board-graph-viewport",
    });
    viewportEl.addEventListener("scroll", () => {
      if (viewportEl.dataset.graphCameraReady !== "true") return;
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
      if (this.isGraphOverview()) event.preventDefault();
      else this.showCanvasCreateMenu(event, canvasEl);
    });

    const svgEl = activeDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svgEl.addClass("base-board-graph-edges");
    if (this.isGraphOverview()) svgEl.setAttribute("aria-hidden", "true");
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
    const physicsStates: GraphNodeState[] = [
      "completed",
      "in-progress",
      "active",
      "awaiting",
      "blocked",
      "interrupted",
      "cancelled",
      "invalidated",
      "waiting",
      "idle",
    ];
    const physicsColors = new Map(
      physicsStates.map((state) => [
        `physics-${state}`,
        getGraphStateVisual(state === "cancelled" ? "interrupted" : state)
          .color,
      ]),
    );
    for (const kind of [
      "requirement-start",
      "requirement-return",
      "requirement-return-dormant",
      "gating",
      "break",
      "break-dormant",
      "restart",
      "membership",
      "compensation",
      "association",
      "flow-inactive",
      ...physicsColors.keys(),
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
      const color = physicsColors.get(kind);
      if (color) arrowEl.style.fill = color;
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
    this.updatePhysicsRouteNodes();
    this.recomputeBreakEscalation();
    for (const edge of edges) {
      const pathEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      pathEl.addClass("base-board-graph-edge");
      pathEl.addClass(`base-board-graph-edge--${edge.kind}`);
      if (edge.backtrack) pathEl.addClass("base-board-graph-edge--backtrack");
      const markerKind = this.getEdgeMarkerKind(edge);
      if (markerKind !== edge.kind) {
        pathEl.addClass(`base-board-graph-edge--${markerKind}`);
      }
      pathEl.dataset.from = edge.from.file.path;
      pathEl.dataset.to = edge.to.file.path;
      pathEl.dataset.kind = edge.kind;
      pathEl.dataset.backtrack = String(edge.backtrack === true);
      if (this.isGraphPhysics()) {
        pathEl.dataset.physicsSpring = String(edge.spring === true);
        if (edge.spring) pathEl.addClass("base-board-graph-edge--spring");
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
    titleEl.textContent = this.isGraphPhysics()
      ? `${edge.from.title} to ${edge.to.title}: ${edge.kind}`
      : "Right-click to delete line";
    hitTargetEl.appendChild(titleEl);

    hitTargetEl.addEventListener("contextmenu", (event: MouseEvent) => {
      if (this.isGraphPhysics()) {
        event.preventDefault();
        event.stopPropagation();
      } else this.showGraphEdgeMenu(event, edge);
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
    // Derived compensation edges are not directly rewirable.
    if (
      edge.backtrack ||
      edge.kind === "compensation" ||
      edge.kind === "association"
    )
      return;
    // Structural edges inside a locked subgraph are not draggable.
    if (this.isEdgeStructurallyLocked(edge)) return;
    event.preventDefault();
    event.stopPropagation();

    const edgeIndex = this.renderedGraphEdges.indexOf(edge);
    const pathEl = this.renderedGraphEdgeEls[edgeIndex];
    if (!pathEl) return;

    const currentNode = this.getEdgeEndpointNode(edge, endpoint);
    const originalPath = pathEl.getAttribute("d") ?? this.getEdgePath(edge);
    let didDrag = false;
    let dropNode: GraphNode | null = null;
    let dropNodeEl: HTMLElement | null = null;
    let dropHandleTarget: {
      edge: GraphEdge;
      endpoint: GraphEdgeEndpoint;
      handleEl: SVGCircleElement;
    } | null = null;
    let anchorTarget: { node: GraphNode; slot: GraphNodeAnchorSlot } | null =
      null;
    let anchorSlotNodePath: string | null = null;
    const anchorSlotEls: SVGCircleElement[] = [];
    const startClientX = event.clientX;
    const startClientY = event.clientY;

    // Snapshot node element positions once so near-border detection during the
    // drag does not repeatedly query the DOM.
    const nodeElsByPath = new Map<string, HTMLElement>();
    this.containerEl
      .querySelectorAll<HTMLElement>(".base-board-graph-node")
      .forEach((nodeEl) => {
        if (nodeEl.dataset.filePath) {
          nodeElsByPath.set(nodeEl.dataset.filePath, nodeEl);
        }
      });

    this.containerEl.addClass("base-board-graph--edge-rewiring");
    pathEl.addClass("base-board-graph-edge--rewiring");
    handleEl.addClass("base-board-graph-edge-handle--dragging");

    const clearAnchorSlots = () => {
      for (const slotEl of anchorSlotEls) slotEl.remove();
      anchorSlotEls.length = 0;
      anchorSlotNodePath = null;
    };
    const clearDropTarget = () => {
      dropNodeEl?.removeClass("base-board-graph-node--edge-drop-target");
      dropHandleTarget?.handleEl.removeClass(
        "base-board-graph-edge-handle--drop-target",
      );
      dropNodeEl = null;
      dropNode = null;
      dropHandleTarget = null;
    };
    const showAnchorSlots = (
      node: GraphNode,
      nearestSlot: GraphNodeAnchorSlot,
    ) => {
      if (anchorSlotNodePath !== node.file.path) {
        clearAnchorSlots();
        anchorSlotNodePath = node.file.path;
        for (const slot of GRAPH_NODE_ANCHOR_SLOTS) {
          const point = this.getNodeAnchorPointForSlot(node, slot);
          const slotEl = activeDocument.createElementNS(
            "http://www.w3.org/2000/svg",
            "circle",
          );
          slotEl.addClass("base-board-graph-anchor-slot");
          slotEl.setAttribute("r", String(GRAPH_EDGE_HANDLE_RADIUS - 1));
          slotEl.setAttribute("cx", String(point.x));
          slotEl.setAttribute("cy", String(point.y));
          slotEl.dataset.side = slot.side;
          slotEl.dataset.xRatio = String(slot.xRatio);
          slotEl.dataset.yRatio = String(slot.yRatio);
          svgEl.appendChild(slotEl);
          anchorSlotEls.push(slotEl);
        }
      }
      for (const slotEl of anchorSlotEls) {
        const isActive =
          slotEl.dataset.side === nearestSlot.side &&
          slotEl.dataset.xRatio === String(nearestSlot.xRatio) &&
          slotEl.dataset.yRatio === String(nearestSlot.yRatio);
        if (isActive) {
          slotEl.addClass("base-board-graph-anchor-slot--active");
        } else {
          slotEl.removeClass("base-board-graph-anchor-slot--active");
        }
      }
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

      // 1) Overlapping another edge's handle on the same node → swap anchors.
      const nextDropHandleTarget = this.getValidEdgeEndpointDropHandle(
        edge,
        endpoint,
        handleEl,
        moveEvent.clientX,
        moveEvent.clientY,
      );
      if (nextDropHandleTarget) {
        anchorTarget = null;
        clearAnchorSlots();
        if (!(
          dropHandleTarget &&
          nextDropHandleTarget.handleEl === dropHandleTarget.handleEl &&
          nextDropHandleTarget.endpoint === dropHandleTarget.endpoint
        )) {
          clearDropTarget();
          dropHandleTarget = nextDropHandleTarget;
          dropHandleTarget.handleEl.addClass(
            "base-board-graph-edge-handle--drop-target",
          );
        }
        pathEl.setAttribute(
          "d",
          this.getFloatingEdgePath(edge, endpoint, graphPoint),
        );
        handleEl.setAttribute("cx", String(graphPoint.x));
        handleEl.setAttribute("cy", String(graphPoint.y));
        return;
      }

      // 2) Over/near a node → reveal its anchor slots and snap to the nearest.
      //    The current endpoint's own node is a valid target (re-anchor on the
      //    same node); a different node must be a valid reassign target.
      const hoverNode = this.getNodeNearClientPoint(
        moveEvent.clientX,
        moveEvent.clientY,
        nodeElsByPath,
        GRAPH_ANCHOR_REVEAL_PX,
      );
      const sameNode = hoverNode?.file.path === currentNode.file.path;
      const reassignNode =
        hoverNode && !sameNode
          ? this.getValidEdgeEndpointDropNode(edge, endpoint, hoverNode)
          : null;
      const nodeEl = hoverNode
        ? (nodeElsByPath.get(hoverNode.file.path) ?? null)
        : null;
      if (hoverNode && nodeEl && (sameNode || reassignNode)) {
        const slot = this.getNearestAnchorSlotForNode(
          nodeEl,
          moveEvent.clientX,
          moveEvent.clientY,
        );
        clearDropTarget();
        if (reassignNode) {
          dropNode = reassignNode;
          dropNodeEl = nodeEl;
          dropNodeEl.addClass("base-board-graph-node--edge-drop-target");
        }
        anchorTarget = { node: hoverNode, slot };
        showAnchorSlots(hoverNode, slot);
        const anchorPoint = this.getNodeAnchorPointForSlot(hoverNode, slot);
        pathEl.setAttribute(
          "d",
          this.getFloatingEdgePath(edge, endpoint, anchorPoint),
        );
        handleEl.setAttribute("cx", String(anchorPoint.x));
        handleEl.setAttribute("cy", String(anchorPoint.y));
        return;
      }

      // 3) No target → floating; clear all targets/affordances.
      anchorTarget = null;
      clearAnchorSlots();
      clearDropTarget();
      pathEl.setAttribute(
        "d",
        this.getFloatingEdgePath(edge, endpoint, graphPoint),
      );
      handleEl.setAttribute("cx", String(graphPoint.x));
      handleEl.setAttribute("cy", String(graphPoint.y));
    };

    const upHandler = (upEvent: MouseEvent) => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      this.containerEl.removeClass("base-board-graph--edge-rewiring");
      pathEl.removeClass("base-board-graph-edge--rewiring");
      handleEl.removeClass("base-board-graph-edge-handle--dragging");
      const targetNode = dropNode;
      const targetHandle = dropHandleTarget;
      const targetAnchor = anchorTarget;
      clearAnchorSlots();
      clearDropTarget();

      if (!didDrag || (!targetHandle && !targetAnchor)) {
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

      if (targetAnchor) {
        if (targetAnchor.node.file.path === currentNode.file.path) {
          // Re-anchor the line on the same node (cosmetic routing only).
          this.setEndpointAnchorOverride(
            edge,
            endpoint,
            targetAnchor.node,
            targetAnchor.slot,
          );
        } else if (targetNode) {
          // Reassign to a different node, carrying the chosen anchor slot.
          void this.reassignGraphEdgeEndpoint(
            edge,
            endpoint,
            targetNode,
            targetAnchor.slot,
          );
        } else {
          pathEl.setAttribute("d", originalPath);
          this.syncRenderedGraphEdges();
        }
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
    if (nextZoom === previousZoom) return;

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
    if (nextZoom === previousZoom) return;

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
    const root = this.isGraphPhysics()
      ? nodes.find(
          (node) => this.getTemporalNodeKey(node) === this.physicsRootKey,
        )
      : null;
    if (root) {
      const size = this.getPhysicsNodeSize(root);
      const bounds = this.getRenderedNodesCanvasBounds(nodes);
      const canvasCenter = this.getNodeCenter(root);
      const center = {
        x: root.x + size.width / 2,
        y: root.y + size.height / 2,
      };
      const frame = (
        minimum: number,
        maximum: number,
        focus: number,
        extent: number,
        preferred = extent / 2,
      ): number => {
        const first = 32 + (focus - minimum) * this.graphZoom;
        const last = extent - 32 - (maximum - focus) * this.graphZoom;
        return first <= last
          ? Math.max(first, Math.min(preferred, last))
          : preferred;
      };
      const mode = this.getGraphPhysicsLayout();
      const rootMargin = Math.min(
        viewportEl.clientHeight / 2,
        size.height / 2 + 48,
      );
      const verticalFocus =
        mode === "hanging"
          ? rootMargin
          : mode === "growing"
            ? viewportEl.clientHeight - rootMargin
            : viewportEl.clientHeight / 2;
      this.scrollViewportToWorldPoint(
        viewportEl,
        center,
        frame(bounds.minX, bounds.maxX, canvasCenter.x, viewportEl.clientWidth),
        frame(
          bounds.minY,
          bounds.maxY,
          canvasCenter.y,
          viewportEl.clientHeight,
          verticalFocus,
        ),
      );
      return;
    }
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
        (this.isGraphOverview() && !this.isGraphPhysics()
          ? bounds.minY * this.graphZoom - 32
          : centerY * this.graphZoom - viewportEl.clientHeight / 2),
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
    if (Number.isNaN(zoom)) return 1;
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
    if (this.temporalCursor !== null) return this.graphViewportState;
    if (this.isGraphPhysics()) return this.physicsCamera;
    const raw = this.config?.get(
      this.isGraphOverview()
        ? CONFIG_KEY_GRAPH_OVERVIEW_VIEWPORT
        : CONFIG_KEY_GRAPH_VIEWPORT,
    );
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
    if (this.temporalCursor !== null) return;
    if (this.isGraphPhysics()) {
      this.physicsCamera = state;
      return;
    }
    // Persisting viewport state calls config.set, which can trigger a full
    // re-render (onDataUpdated) and detach the live viewport. During an active
    // pan that would orphan the pan handler mid-gesture (the camera freezes
    // while the button is still held), so defer the write until the pan ends.
    // finishPan re-invokes this after clearing graphPanActive to flush it.
    if (this.graphPanActive) {
      this.graphPanViewportPersistPending = true;
      return;
    }
    this.config?.set(
      this.isGraphOverview()
        ? CONFIG_KEY_GRAPH_OVERVIEW_VIEWPORT
        : CONFIG_KEY_GRAPH_VIEWPORT,
      {
        scrollLeft: Math.round(state.scrollLeft),
        scrollTop: Math.round(state.scrollTop),
        zoom: state.zoom,
        ...(state.centerX !== undefined && state.centerY !== undefined
          ? {
              centerX: Math.round(state.centerX),
              centerY: Math.round(state.centerY),
            }
          : {}),
      },
    );
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
    const overview = this.isGraphOverview();
    const item = overview ? this.overviewItems.get(node.file.path) : undefined;
    const virtual = node.file.path === OVERVIEW_UNASSIGNED;
    const physicsContext =
      this.isGraphPhysics() && this.physicsContextPaths.has(node.file.path);
    const fixedRoot =
      this.isGraphPhysics() &&
      this.getTemporalNodeKey(node) === this.physicsRootKey;
    const container =
      node.descendantCount > 0 ||
      node.kind === "group" ||
      node.kind === "process";
    const summary = this.graphWorkSummaries.get(node.file.path);
    const displayState =
      overview && !this.isCompensationNode(node)
        ? summary
          ? container
            ? getOverviewSummaryState(summary)
            : summary.state
          : node.state
        : node.state;
    const indicatorState =
      !overview && displayState === "active" && this.isActiveStatus(node.status)
        ? "in-progress"
        : displayState;
    const nodeEl = parentEl.createDiv({
      cls: `base-board-graph-node base-board-graph-node--${displayState}`,
    });
    if (this.isGraphPhysics()) {
      nodeEl.style.setProperty(
        "--graph-physics-diameter",
        `${this.getPhysicsNodeSize(node).width}px`,
      );
      nodeEl.toggleClass(
        "base-board-graph-node--has-summary",
        Boolean(summary && node.descendantCount > 0),
      );
    }
    if (item) {
      nodeEl.addClass(`base-board-graph-node--${item.role}`);
      nodeEl.dataset.overviewRole = item.role;
      nodeEl.style.setProperty("--graph-overview-height", `${item.height}px`);
      if (item.trail.length)
        nodeEl.addClass("base-board-graph-node--compressed");
    }
    if (virtual) nodeEl.addClass("base-board-graph-node--unassigned");
    if (fixedRoot) {
      nodeEl.addClass("base-board-graph-node--root");
      nodeEl.dataset.physicsFixed = "true";
    }
    this.positionRenderedGraphNodeEl(nodeEl, node);
    nodeEl.style.setProperty(
      "--graph-node-color",
      overview
        ? this.getOverviewColor(displayState)
        : getColumnColor(this.config, this.getNodeColorStatus(node)),
    );
    nodeEl.dataset.filePath = node.file.path;
    nodeEl.setAttr("role", "button");
    nodeEl.setAttr("tabindex", "0");
    setTooltip(nodeEl, this.getNodeTooltip(node));
    nodeEl.dataset.state = displayState;
    const nodeKey = this.getTemporalNodeKey(node);
    const hasChangedDescendant = getOverviewDescendants(node).some((child) =>
      this.temporalChangedKeys.has(this.getTemporalNodeKey(child)),
    );
    const lostChild = this.temporalRemovedNodes.some(
      (removed) =>
        (removed.parentKey !== null &&
          this.getNodeIdentities(node).includes(removed.parentKey)) ||
        removed.rollupToKeys.some((key) =>
          this.getNodeIdentities(node).includes(key),
        ),
    );
    nodeEl.toggleClass(
      "base-board-graph-node--history-added",
      this.temporalAddedKeys.has(nodeKey),
    );
    nodeEl.toggleClass(
      "base-board-graph-node--history-changed",
      this.temporalChangedKeys.has(nodeKey) ||
        hasChangedDescendant ||
        lostChild,
    );
    if (node.descendantCount > 0 && !physicsContext)
      nodeEl.setAttr("aria-expanded", String(!node.collapsed));
    nodeEl.setAttr(
      "aria-label",
      `${node.title}, ${this.getOverviewStateLabel(node, indicatorState)}${fixedRoot ? ", fixed graph root" : ""}`,
    );

    if (node.descendantCount > 0 && !physicsContext) {
      const collapseBtn = nodeEl.createEl("button", {
        cls: "base-board-graph-collapse",
        attr: {
          type: "button",
          title: `${node.collapsed ? "Expand" : "Collapse"} ${node.title}`,
          "aria-label": `${node.collapsed ? "Expand" : "Collapse"} ${node.title}`,
          "aria-expanded": String(!node.collapsed),
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

    if (!overview && node.descendantCount > 0) {
      const lockBtn = nodeEl.createEl("button", {
        cls: `base-board-graph-lock${
          node.effectiveLocked ? " base-board-graph-lock--locked" : ""
        }`,
        attr: {
          type: "button",
          title: node.effectiveLocked ? "Unlock subgraph" : "Lock subgraph",
        },
      });
      setIcon(
        lockBtn,
        node.effectiveLocked ? "lucide-lock" : "lucide-lock-open",
      );
      lockBtn.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void this.toggleGraphLock(node);
      });
    }

    if (item?.trail.length) {
      const trailEl = nodeEl.createDiv({
        cls: "base-board-graph-wrapper-trail",
      });
      for (const wrapper of item.trail) {
        const button = trailEl.createEl("button", {
          text: wrapper.title,
          attr: {
            type: "button",
            title: `Focus ${wrapper.title}`,
            "aria-label": `Focus ${wrapper.title}`,
          },
        });
        button.addEventListener("click", (event: MouseEvent) => {
          event.stopPropagation();
          this.focusOverview(this.getTemporalNodeKey(wrapper));
        });
      }
    }
    const titleEl = nodeEl.createDiv({
      cls: "base-board-graph-node-title",
      text: node.title,
    });
    titleEl.setAttr("title", node.title);

    const metaEl = nodeEl.createDiv({ cls: "base-board-graph-node-meta" });
    if (node.nodeType) {
      metaEl.createSpan({
        cls: "base-board-graph-node-deps",
        text: node.workflow ?? node.nodeType,
      });
    }
    if (!overview && node.dependsOnKeys.length > 0) {
      this.renderGraphVisual(
        metaEl,
        "base-board-graph-node-deps",
        `${node.predecessors.length} of ${node.dependsOnKeys.length} dependencies visible`,
        "lucide-link",
        undefined,
        `${node.predecessors.length}/${node.dependsOnKeys.length}`,
      );
    }
    if (!overview && node.collapsed && node.descendantCount > 0) {
      this.renderGraphVisual(
        metaEl,
        "base-board-graph-node-deps",
        `${node.descendantCount} hidden descendants`,
        "lucide-layers",
        undefined,
        String(node.descendantCount),
      );
    }

    if (overview) {
      if (node.descendantCount > 0 || node.kind === "group") {
        const focusButton = nodeEl.createEl("button", {
          cls: "base-board-graph-focus-node",
          attr: {
            type: "button",
            "aria-label": `Focus ${node.title}`,
            title: `Focus ${node.title}`,
          },
        });
        setIcon(focusButton, "lucide-scan");
        focusButton.addEventListener("click", (event: MouseEvent) => {
          event.stopPropagation();
          this.focusOverview(this.getTemporalNodeKey(node));
        });
      }
      if (!virtual) {
        const openButton = nodeEl.createEl("button", {
          cls: "base-board-graph-open-note",
          attr: {
            type: "button",
            "aria-label": `Open ${node.title}`,
            title: `Open ${node.title}`,
          },
        });
        setIcon(openButton, "lucide-file-text");
        openButton.addEventListener("click", (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          this.openGraphNode(node);
        });
      }
      if (summary && node.descendantCount > 0)
        this.renderGraphWorkSummary(
          nodeEl,
          summary,
          this.isGraphPhysics() || item?.role === "heading",
        );
    } else {
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
    }

    nodeEl.addEventListener("click", (event: MouseEvent) => {
      if (this.suppressNextNodeClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (physicsContext) this.focusOverview(this.getTemporalNodeKey(node));
      else if (overview && node.descendantCount > 0)
        void this.toggleGraphCollapse(node);
      else this.openGraphNode(node);
    });
    nodeEl.addEventListener("mousedown", (event: MouseEvent) => {
      if (this.isGraphPhysics()) this.startPhysicsNodeDrag(event, node);
      else if (!overview) this.startNodeDrag(event, node);
    });
    if (this.isGraphPhysics()) {
      const trace = (): void => {
        this.containerEl.addClass("base-board-graph--tracing");
        this.renderedGraphEdges.forEach((edge, index) => {
          this.renderedGraphEdgeEls[index]?.toggleClass(
            "base-board-graph-edge--traced",
            edge.from.file.path === node.file.path ||
              edge.to.file.path === node.file.path,
          );
        });
      };
      const clearTrace = (): void => {
        this.containerEl.removeClass("base-board-graph--tracing");
        for (const edgeEl of this.renderedGraphEdgeEls)
          edgeEl.removeClass("base-board-graph-edge--traced");
      };
      nodeEl.addEventListener("mouseenter", trace);
      nodeEl.addEventListener("mouseleave", clearTrace);
      nodeEl.addEventListener("focusin", trace);
      nodeEl.addEventListener("focusout", clearTrace);
    }
    nodeEl.addEventListener("contextmenu", (event: MouseEvent) => {
      if (overview) {
        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        if (!virtual)
          menu.addItem((item) =>
            item
              .setTitle("Open note")
              .setIcon("lucide-file-text")
              .onClick(() => this.openGraphNode(node)),
          );
        if (node.descendantCount > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Focus this branch")
              .setIcon("lucide-scan")
              .onClick(() => this.focusOverview(this.getTemporalNodeKey(node))),
          );
          if (!physicsContext)
            menu.addItem((item) =>
              item
                .setTitle(
                  node.collapsed ? "Expand workstream" : "Collapse workstream",
                )
                .setIcon(
                  node.collapsed
                    ? "lucide-chevrons-down"
                    : "lucide-chevrons-up",
                )
                .onClick(() => {
                  void this.toggleGraphCollapse(node);
                }),
            );
        }
        menu.showAtMouseEvent(event);
      } else this.showNodeContextMenu(event, node);
    });
    nodeEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.target !== nodeEl) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (physicsContext) this.focusOverview(this.getTemporalNodeKey(node));
      else if (overview && node.descendantCount > 0)
        void this.toggleGraphCollapse(node);
      else this.openGraphNode(node);
    });
  }

  private openGraphNode(node: GraphNode): void {
    if (node.file.path === OVERVIEW_UNASSIGNED) {
      this.focusOverview(OVERVIEW_UNASSIGNED);
      return;
    }
    if (this.temporalCursor !== null) {
      const snapshot = this.temporalSnapshots.get(node.file.path);
      if (snapshot)
        new RecordedGraphNodeModal(
          this.app,
          snapshot,
          this.temporalCursor,
        ).open();
      return;
    }
    new CardDetailModal(this.app, node.file).open();
  }

  private getOverviewColor(state: GraphNodeState): string {
    return getGraphStateVisual(state).color;
  }

  private getOverviewStateLabel(
    node: GraphNode,
    state: GraphNodeState,
  ): string {
    if (node.kind === "impact") return "Observation";
    if (this.isCompensationNode(node) && state === "active") return "Rollback";
    return getGraphStateVisual(state).label;
  }

  private renderGraphWorkSummary(
    nodeEl: HTMLElement,
    summary: GraphWorkSummary,
    compact = false,
  ): void {
    const progressEl = nodeEl.createDiv({
      cls: "base-board-graph-work-summary",
    });
    const completedVisual = getGraphStateVisual("completed");
    const completedCount = progressEl.createSpan({
      cls: "base-board-graph-work-completed",
      text: `${summary.completed} / ${summary.total}`,
      attr: {
        "aria-label": `${summary.completed} of ${summary.total} work items completed`,
      },
    });
    completedCount.style.color = completedVisual.color;
    setTooltip(
      completedCount,
      `${summary.completed} of ${summary.total} work items completed`,
    );
    if (!compact) {
      const meter = progressEl.createDiv({
        cls: "base-board-graph-progress",
        attr: {
          role: "progressbar",
          "aria-label": "Completed work items",
          "aria-valuemin": "0",
          "aria-valuemax": String(Math.max(1, summary.total)),
          "aria-valuenow": String(summary.completed),
          "aria-valuetext": `${summary.completed} of ${summary.total} work items completed`,
        },
      });
      const completed = meter.createSpan({
        cls: "base-board-graph-progress--completed",
      });
      completed.style.width = `${getOverviewCompletion(summary) * 100}%`;
      completed.setAttr("title", `${summary.completed} completed`);
    }
    const counts = progressEl.createDiv({
      cls: "base-board-graph-work-counts",
    });
    for (const [key, state] of [
      ["active", "in-progress"],
      ["awaiting", "awaiting"],
      ["blocked", "blocked"],
      ["mitigations", "blocked"],
      ["ready", "active"],
    ] as const) {
      if (summary[key] === 0) continue;
      if (this.isGraphPhysics() && key !== "blocked" && key !== "mitigations")
        continue;
      const visual =
        key === "mitigations"
          ? {
              icon: "lucide-undo-2",
              color: "var(--color-orange, #e0843a)",
              label: "Rollback",
            }
          : getGraphStateVisual(state);
      const count = counts.createSpan({
        cls: `base-board-graph-work-count--${key}`,
        text: String(summary[key]),
        attr: { "aria-label": `${visual.label}: ${summary[key]}` },
      });
      count.style.color = visual.color;
      setTooltip(count, `${visual.label}: ${summary[key]}`);
    }
  }

  private startPhysicsNodeDrag(event: MouseEvent, node: GraphNode): void {
    const simulation = this.physicsSimulation;
    const viewport = this.physicsViewportEl;
    if (
      event.button !== 0 ||
      !simulation ||
      !viewport ||
      this.physicsDraggingId ||
      this.getTemporalNodeKey(node) === this.physicsRootKey
    )
      return;
    if (
      (event.target as HTMLElement).closest("button, input, textarea, select")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const id = this.getTemporalNodeKey(node);
    const original = { x: node.x, y: node.y };
    const viewportRect = viewport.getBoundingClientRect();
    const start = this.getViewportWorldPoint(
      viewport,
      event.clientX - viewportRect.left,
      event.clientY - viewportRect.top,
    );
    let dragged = false;
    this.physicsDraggingId = id;
    simulation.pin(id, node.x, node.y);
    const element = this.physicsElements.get(id);
    const move = (moveEvent: MouseEvent): void => {
      if (
        !dragged &&
        Math.hypot(
          moveEvent.clientX - event.clientX,
          moveEvent.clientY - event.clientY,
        ) < GRAPH_PAN_THRESHOLD_PX
      )
        return;
      dragged = true;
      moveEvent.preventDefault();
      element?.addClass("base-board-graph-node--dragging");
      const rect = viewport.getBoundingClientRect();
      const point = this.getViewportWorldPoint(
        viewport,
        moveEvent.clientX - rect.left,
        moveEvent.clientY - rect.top,
      );
      simulation.pin(
        id,
        original.x + point.x - start.x,
        original.y + point.y - start.y,
      );
      this.applyPhysicsPositions(simulation.positions());
      this.animateGraphPhysics();
      this.updatePhysicsControls();
    };
    const finish = (cancelled: boolean): void => {
      activeWindow.removeEventListener("mousemove", move);
      activeWindow.removeEventListener("mouseup", release);
      activeWindow.removeEventListener("keydown", cancel, true);
      activeWindow.removeEventListener("blur", blur);
      element?.removeClass("base-board-graph-node--dragging");
      this.physicsDragCleanup = null;
      this.physicsDraggingId = null;
      if (cancelled) {
        simulation.pin(id, original.x, original.y);
        this.applyPhysicsPositions(simulation.positions());
      }
      simulation.release(id, dragged && !cancelled);
      this.applyPhysicsPositions(simulation.positions());
      if (dragged || cancelled) {
        this.suppressNextNodeClick = true;
        window.setTimeout(() => {
          this.suppressNextNodeClick = false;
        }, 0);
      }
      if (this.temporalDisposed) return;
      if (this.physicsRenderPending) {
        this.physicsRenderPending = false;
        this.render();
      } else {
        this.animateGraphPhysics();
        this.updatePhysicsControls();
      }
    };
    const release = (): void => finish(false);
    const blur = (): void => finish(true);
    const cancel = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(true);
    };
    this.physicsDragCleanup = finish;
    activeWindow.addEventListener("mousemove", move);
    activeWindow.addEventListener("mouseup", release);
    activeWindow.addEventListener("keydown", cancel, true);
    activeWindow.addEventListener("blur", blur);
    this.animateGraphPhysics();
    this.updatePhysicsControls();
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

  /**
   * Finds the node whose rendered box (expanded by `margin`) is under or
   * closest to a client point — used while dragging a link endpoint to reveal
   * a node's anchor slots when the cursor is over it or near its boundary.
   * Tries the node directly under the cursor first, then the nearest within
   * `margin`. `nodeElsByPath` is a snapshot of node elements taken at drag
   * start to avoid repeated DOM queries.
   */
  private getNodeNearClientPoint(
    clientX: number,
    clientY: number,
    nodeElsByPath: Map<string, HTMLElement>,
    margin: number,
  ): GraphNode | null {
    const over = this.getGraphNodeFromPoint(clientX, clientY);
    if (over) return over;
    let nearest: GraphNode | null = null;
    let nearestDistance = margin;
    for (const node of this.visibleNodes) {
      const nodeEl = nodeElsByPath.get(node.file.path);
      if (!nodeEl) continue;
      const rect = nodeEl.getBoundingClientRect();
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (distance <= nearestDistance) {
        nearestDistance = distance;
        nearest = node;
      }
    }
    return nearest;
  }

  /** Nearest anchor slot on a node to a client point (cursor may be outside). */
  private getNearestAnchorSlotForNode(
    nodeEl: HTMLElement,
    clientX: number,
    clientY: number,
  ): GraphNodeAnchorSlot {
    const rect = nodeEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return GRAPH_NODE_ANCHOR_SLOTS.reduce((nearestSlot, candidateSlot) =>
      this.getNodeAnchorSlotDistance(candidateSlot, rect, x, y) <
      this.getNodeAnchorSlotDistance(nearestSlot, rect, x, y)
        ? candidateSlot
        : nearestSlot,
    );
  }

  /**
   * Pins a link endpoint to a specific anchor slot on its current node (a
   * cosmetic routing override, not a relationship change). Used when a line end
   * is dragged from one anchor point to another on the same node.
   */
  private setEndpointAnchorOverride(
    edge: GraphEdge,
    endpoint: GraphEdgeEndpoint,
    node: GraphNode,
    slot: GraphNodeAnchorSlot,
  ): void {
    const anchorPoint = this.getNodeAnchorPointForSlot(node, slot);
    this.graphEndpointAnchorOverrides.set(
      this.getEdgeEndpointOverrideKey(edge, endpoint),
      this.getGraphEndpointAnchorOverride(node, anchorPoint),
    );
    this.syncRenderedGraphEdges();
    new Notice("Re-anchored line");
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
    // When either endpoint is in a locked subgraph, only the membership
    // (aggregation) link is offered — structural links are frozen.
    if (sourceNode.effectiveLocked || targetNode.effectiveLocked) {
      const lockedMenu = new Menu();
      lockedMenu.addItem((item) => {
        item
          .setTitle("Roll up into (membership)")
          .setIcon("lucide-layers")
          .onClick(() => {
            void this.createGraphLink(
              sourceNode,
              targetNode,
              "membership",
              sourceSlot,
              targetSlot,
            );
          });
      });
      lockedMenu.showAtMouseEvent(event);
      return;
    }
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
    menu.addItem((item) => {
      item
        .setTitle("Roll up into (membership)")
        .setIcon("lucide-layers")
        .onClick(() => {
          void this.createGraphLink(
            sourceNode,
            targetNode,
            "membership",
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
    if (
      kind !== "membership" &&
      (sourceNode.effectiveLocked || targetNode.effectiveLocked)
    ) {
      new Notice(
        "Subgraph is locked \u2014 unlock it to add structural links.",
      );
      return;
    }
    this.beginGraphHistory("Create link");
    if (kind === "requirement") {
      await this.updateGraphParent(targetNode, sourceNode);
    } else if (kind === "successor") {
      await this.addGraphReference(targetNode, "depends_on", sourceNode);
    } else if (kind === "break") {
      await this.addGraphReference(sourceNode, "breaks_to", targetNode);
    } else if (kind === "restart") {
      await this.addGraphReference(sourceNode, "restarts_to", targetNode);
    } else {
      await this.addGraphReference(sourceNode, "rollup_to", targetNode);
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
    if (kind === "membership") return "membership";
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
    this.updatePhysicsRouteNodes();
    this.renderedGraphEdges.forEach((edge, index) => {
      const edgeEl = this.renderedGraphEdgeEls[index];
      if (!edgeEl) return;
      const path = this.getEdgePath(edge);
      edgeEl.setAttribute("d", path);
      const hitEl = this.renderedGraphEdgeHitEls[index];
      if (hitEl) hitEl.setAttribute("d", path);
      if (this.isGraphPhysics()) return;
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
    if (edge.backtrack) return;

    // Requirement-return and compensation edges are derived (from containment /
    // triggered `compensates`), so they expose no structural edit action.
    if (
      edge.kind === "requirement-return" ||
      edge.kind === "compensation" ||
      edge.kind === "association"
    ) {
      return;
    }
    // Structural edges in a locked subgraph cannot be deleted/rewired.
    if (this.isEdgeStructurallyLocked(edge)) return;

    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(
          edge.kind === "membership" ? "Remove from scope" : "Delete line",
        )
        .setIcon("lucide-unlink")
        .onClick(() => {
          void this.deleteGraphEdge(edge);
        });
    });
    menu.showAtMouseEvent(event);
  }

  private async deleteGraphEdge(edge: GraphEdge): Promise<void> {
    if (edge.backtrack) return;
    // Requirement-return and compensation edges are derived; nothing to delete.
    if (
      edge.kind === "requirement-return" ||
      edge.kind === "compensation" ||
      edge.kind === "association"
    ) {
      return;
    }
    // Structural edges inside a locked subgraph are frozen.
    if (this.isEdgeStructurallyLocked(edge)) return;
    this.beginGraphHistory("Delete link");
    if (edge.kind === "requirement-start") {
      await this.updateGraphParent(edge.to, null, edge.from);
    } else if (edge.kind === "gating") {
      await this.removeGraphReference(edge.to, "depends_on", edge.from);
    } else if (edge.kind === "membership") {
      await this.removeGraphReference(edge.from, "rollup_to", edge.to);
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
      edge.kind === "membership" ? "Removed from scope" : "Deleted line",
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
      if (this.isImpactNode(current)) continue;
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
      if (this.isImpactNode(prerequisite)) continue;
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
      if (this.isImpactNode(candidate)) continue;
      if (!this.isGenuinelyFailedStatus(candidate.status)) continue;
      const visited = new Set<string>();
      let current: GraphNode | null = candidate;
      while (current && !visited.has(current.file.path)) {
        if (this.isImpactNode(current)) break;
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
    const inactiveForward =
      (edge.kind === "gating" ||
        edge.kind === "requirement-start" ||
        edge.kind === "restart") &&
      (edge.to.state === "invalidated" ||
        edge.to.state === "cancelled" ||
        edge.to.state === "waiting");
    if (this.isGraphPhysics()) {
      if (
        edge.kind === "membership" ||
        edge.kind === "compensation" ||
        edge.kind === "association"
      )
        return edge.kind;
      if (edge.kind === "break") return "physics-interrupted";
      if (inactiveForward) return "physics-invalidated";
      if (edge.kind === "requirement-return") {
        const state = edge.returnState ?? edge.from.state;
        return state === "completed"
          ? "physics-completed"
          : state === "cancelled"
            ? "physics-cancelled"
            : "physics-waiting";
      }
      const source = edge.kind === "requirement-start" ? edge.to : edge.from;
      const state =
        source.state === "active" && this.isActiveStatus(source.status)
          ? "in-progress"
          : source.state;
      return `physics-${state}`;
    }
    if (inactiveForward) return "flow-inactive";
    if (edge.kind === "break") {
      if (
        edge.backtrack ||
        this.isBreakEdgeTriggered(edge) ||
        this.isBreakEdgeEscalated(edge)
      ) {
        return "break";
      }
      return "break-dormant";
    }
    // A requirement-return edge means "completion flowing back up from child to
    // parent". It is only a true (green) completion line when the child
    // (edge.from) is genuinely Completed. This must use the child's DERIVED
    // state, not its stored status: a group child carries no live stored
    // status, so its return only greens when all of its descendants complete.
    if (edge.kind === "requirement-return") {
      return (edge.returnState ?? edge.from.state) === "completed"
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
    if (this.isImpactNode(node)) {
      new Notice(
        `"${node.title}" is an impact node and does not enter work flow.`,
      );
      return;
    }
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

  /**
   * Work-node operation: Set Awaiting (Milestone 4). Like Set Active, the node
   * becomes the live frontier and everything *before* it becomes `Completed`
   * while everything *after* becomes `Planned` — but the node is *parked*,
   * waiting on something external (a rollout to propagate, an agent awaiting
   * input/verification) rather than actively in hand. Distinct from `Active`
   * (amber, not blue) and non-terminal, so downstream stays gated. Only leaf
   * statuses are written; groups derive.
   */
  private async markNodeAwaiting(node: GraphNode): Promise<void> {
    if (this.isImpactNode(node)) {
      new Notice(
        `"${node.title}" is an impact node and does not enter work flow.`,
      );
      return;
    }
    if (node.children.length > 0) {
      new Notice(
        `"${node.title}" is a group — its state derives from its children.`,
      );
      return;
    }
    this.beginGraphHistory("Set as awaiting");
    const target = this.buildExecutionPartitionTargets(node, {
      before: GRAPH_STATUS_COMPLETED,
      self: GRAPH_STATUS_AWAITING,
      after: GRAPH_STATUS_PLANNED,
    });
    const updated = await this.applyLeafStatuses(target, node.file.path);
    new Notice(
      this.describeWorkNodeOp(`Set "${node.title}" as awaiting`, updated),
    );
    await this.commitGraphHistory();
    this.render();
  }
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
    return nodes.filter(
      (candidate) =>
        candidate.children.length === 0 && !this.isImpactNode(candidate),
    );
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
    ).filter((leaf) => !this.isCompensationNode(leaf));
    const afterLeaves = this.getLeafNodes(
      this.getDownstreamResetNodes(node, parentByPath),
    ).filter((leaf) => !this.isCompensationNode(leaf));
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
    if (this.isImpactNode(node)) {
      new Notice(
        `"${node.title}" is an impact node and does not enter work flow.`,
      );
      return;
    }
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

    const event = buildTransitionEvent({
      node: nodeId,
      from,
      to,
      property: propertyName,
      source: "baseboard-graph",
      reason,
    });

    frontmatter[historyProperty] = [...history, event];
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
    if (entry.positions) this.applyPositionHistory(entry.positions, true);
    this.graphRedoStack.push(entry);
    this.graphEndpointAnchorOverrides.clear();
    new Notice(`Undid: ${entry.label}`);
    this.render();
  }

  private async redoGraphHistory(): Promise<void> {
    const entry = this.graphRedoStack.pop();
    if (!entry) return;
    await this.applyGraphHistoryState(entry.files, false);
    if (entry.positions) this.applyPositionHistory(entry.positions, false);
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
    if (this.isImpactNode(node)) {
      new Notice(
        `"${node.title}" is an impact node and does not enter work flow.`,
      );
      return;
    }
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
      "rollup_to",
      "compensates",
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
    anchorSlot?: GraphNodeAnchorSlot,
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
    } else if (edge.kind === "membership") {
      if (endpoint === "from") {
        await Promise.all([
          this.removeGraphReference(edge.from, "rollup_to", edge.to),
          this.addGraphReference(targetNode, "rollup_to", edge.to),
        ]);
      } else {
        await this.replaceGraphReference(
          edge.from,
          "rollup_to",
          edge.to,
          targetNode,
        );
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
    // Carry the chosen anchor slot onto the reassigned endpoint for the simple
    // source→target kinds, whose resulting edge identity is predictable. (The
    // requirement/containment kinds re-derive their endpoints, so they keep the
    // default anchor.) Set before render so it is picked up immediately.
    if (
      anchorSlot &&
      (edge.kind === "gating" ||
        edge.kind === "break" ||
        edge.kind === "restart" ||
        edge.kind === "membership")
    ) {
      const fromPath =
        endpoint === "from" ? targetNode.file.path : edge.from.file.path;
      const toPath =
        endpoint === "to" ? targetNode.file.path : edge.to.file.path;
      const key = [edge.kind, fromPath, toPath, endpoint].join("::");
      const anchorPoint = this.getNodeAnchorPointForSlot(
        targetNode,
        anchorSlot,
      );
      this.graphEndpointAnchorOverrides.set(
        key,
        this.getGraphEndpointAnchorOverride(targetNode, anchorPoint),
      );
    }
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
    this.applyGraphNodePositions(
      nodes.map((node) => ({ path: node.file.path, x: node.x, y: node.y })),
      nodes.length > 1
        ? `Move ${nodes.length} nodes`
        : `Move ${nodes[0]?.title ?? "node"}`,
    );
  }

  /**
   * Writes node positions to the graph view config and records one undoable
   * layout-history entry. Used by drag and by Organize. An optimistic
   * `pendingGraphPositions` overlay keeps the view correct until the config
   * write round-trips through `onDataUpdated`.
   */
  private applyGraphNodePositions(
    updates: { path: string; x: number; y: number }[],
    label: string,
  ): void {
    if (updates.length === 0) return;
    const positions = { ...this.getGraphNodePositions() };
    const before: Record<string, { x: number; y: number } | null> = {};
    const after: Record<string, { x: number; y: number }> = {};
    for (const update of updates) {
      const existing = positions[update.path];
      before[update.path] = existing ? { ...existing } : null;
      const point = { x: Math.round(update.x), y: Math.round(update.y) };
      positions[update.path] = point;
      after[update.path] = point;
      this.pendingGraphPositions.set(update.path, point);
    }
    this.pushLayoutHistory(label, { before, after });
    this.config?.set(CONFIG_KEY_GRAPH_NODE_POSITIONS, positions);
  }

  private pushLayoutHistory(
    label: string,
    positions: GraphPositionChange,
  ): void {
    this.graphUndoStack.push({ label, files: [], positions });
    if (this.graphUndoStack.length > GRAPH_HISTORY_LIMIT) {
      this.graphUndoStack.shift();
    }
    this.graphRedoStack = [];
    this.updateGraphHistoryButtons();
  }

  private applyPositionHistory(
    change: GraphPositionChange,
    useBefore: boolean,
  ): void {
    const positions = { ...this.getGraphNodePositions() };
    const target = useBefore ? change.before : change.after;
    for (const path of Object.keys(target)) {
      const value = target[path];
      if (value === null) {
        delete positions[path];
        this.pendingGraphPositions.delete(path);
      } else {
        positions[path] = value;
        this.pendingGraphPositions.set(path, value);
      }
    }
    this.config?.set(CONFIG_KEY_GRAPH_NODE_POSITIONS, positions);
  }

  // --- Organize (algorithmic layout, see GRAPH_ARCHITECTURE_PLAN.md) ---------

  /** Builds a layout-engine tree from a node's (visible) containment subtree. */
  private buildLayoutNode(node: GraphNode, seen: Set<string>): LayoutNode {
    seen.add(node.file.path);
    return {
      id: node.file.path,
      title: node.title,
      order: this.getOrder(node.file),
      dependsOn: node.predecessors.map((predecessor) => predecessor.file.path),
      children: node.children
        .filter((child) => !seen.has(child.file.path))
        .map((child) => this.buildLayoutNode(child, seen)),
    };
  }

  /**
   * Organizes a node's containment subtree with the layout engine, anchored on
   * the clicked node (it keeps its position; descendants reflow around it). The
   * write is one undoable layout-history entry.
   */
  private organizeSubtree(
    node: GraphNode,
    orientation: LayoutOrientation,
    siblingOrder: LayoutSiblingOrder,
  ): void {
    if (node.children.length === 0) return;
    const root = this.buildLayoutNode(node, new Set<string>());
    const topDown = orientation === "top-down";
    const positions = computeSubtreeLayout(root, {
      orientation,
      siblingOrder,
      levelGap: topDown ? 220 : 320,
      columnGap: topDown ? 280 : 150,
      anchor: { x: node.x, y: node.y },
    });
    const updates = [...positions].map(([path, point]) => ({
      path,
      x: point.x,
      y: point.y,
    }));
    this.applyGraphNodePositions(updates, `Organize ${node.title}`);
    new Notice(`Organized ${updates.length} nodes under "${node.title}"`);
    this.render();
  }

  /** Mirrors a node's containment subtree about its own bounding box. */
  private mirrorSubtree(
    node: GraphNode,
    axis: "vertical" | "horizontal",
  ): void {
    const subtree = [node, ...this.getContainmentDescendants(node)];
    const current: PositionMap = new Map(
      subtree.map((member) => [member.file.path, { x: member.x, y: member.y }]),
    );
    const flipped =
      axis === "vertical" ? mirrorVertical(current) : mirrorHorizontal(current);
    const updates = [...flipped].map(([path, point]) => ({
      path,
      x: point.x,
      y: point.y,
    }));
    this.applyGraphNodePositions(updates, `Mirror ${node.title}`);
    this.render();
  }

  private async toggleGraphCollapse(node: GraphNode): Promise<void> {
    if (this.isGraphOverview()) {
      if (node.file.path === OVERVIEW_UNASSIGNED) {
        this.focusOverview(OVERVIEW_UNASSIGNED);
        return;
      }
      const viewport = this.getGraphViewportEl();
      const nodeEl = this.getRenderedGraphNodeEl(node);
      if (viewport && nodeEl) {
        const viewportRect = viewport.getBoundingClientRect();
        const nodeRect = nodeEl.getBoundingClientRect();
        this.overviewAnchor = {
          path: node.file.path,
          x: nodeRect.left + nodeRect.width / 2 - viewportRect.left,
          y: nodeRect.top + 16 * this.graphZoom - viewportRect.top,
        };
      }
      if (this.temporalCursor !== null) {
        const key = this.getTemporalNodeKey(node);
        if (node.collapsed) this.temporalExpandedKeys.add(key);
        else this.temporalExpandedKeys.delete(key);
        this.render();
        return;
      }
      const expanded = new Set(
        this.graphNodes
          .filter(
            (candidate) =>
              !candidate.collapsed && candidate.descendantCount > 0,
          )
          .map((candidate) => candidate.file.path),
      );
      if (node.collapsed) expanded.add(node.file.path);
      else expanded.delete(node.file.path);
      this.config?.set(CONFIG_KEY_GRAPH_OVERVIEW_EXPANDED, [...expanded]);
      this.render();
      return;
    }
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter[GRAPH_COLLAPSED_PROPERTY] = !node.collapsed;
      },
    );
    this.render();
  }

  /**
   * Locks/unlocks a node's subgraph (Step B). Writes an explicit `graph_locked`
   * so it overrides any inherited value (nearest-explicit-wins): unlocking a
   * node frees its subtree even if an ancestor is locked, and locking freezes
   * it even inside an unlocked parent.
   */
  private async toggleGraphLock(node: GraphNode): Promise<void> {
    const nextLocked = !node.effectiveLocked;
    this.beginGraphHistory(nextLocked ? "Lock subgraph" : "Unlock subgraph");
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter[GRAPH_LOCKED_PROPERTY] = nextLocked;
      },
    );
    new Notice(
      nextLocked ? `Locked "${node.title}"` : `Unlocked "${node.title}"`,
    );
    await this.commitGraphHistory();
    this.render();
  }

  /** Cycles a node's executor (human → agent → mixed), writing it explicitly. */
  private async cycleNodeExecutor(node: GraphNode): Promise<void> {
    const next =
      GRAPH_EXECUTORS[
        (GRAPH_EXECUTORS.indexOf(node.executor) + 1) % GRAPH_EXECUTORS.length
      ];
    this.beginGraphHistory("Set executor");
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter.executor = next;
      },
    );
    new Notice(`"${node.title}" run by ${next}`);
    await this.commitGraphHistory();
    this.render();
  }

  /** Cycles a node's autonomy (propose → execute → autopilot), written explicitly. */
  private async cycleNodeAutonomy(node: GraphNode): Promise<void> {
    const next =
      GRAPH_AUTONOMY_LEVELS[
        (GRAPH_AUTONOMY_LEVELS.indexOf(node.autonomy) + 1) %
          GRAPH_AUTONOMY_LEVELS.length
      ];
    this.beginGraphHistory("Set autonomy");
    await this.snapshotForUndo(node.file.path);
    await this.app.fileManager.processFrontMatter(
      node.file,
      (frontmatter: Record<string, unknown>) => {
        frontmatter.autonomy = next;
      },
    );
    new Notice(`"${node.title}" autonomy: ${next}`);
    await this.commitGraphHistory();
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
    // A locked subgraph cannot have new nodes/templates added inside it.
    if (sourceNode?.effectiveLocked) {
      menu.addItem((item) => {
        item
          .setTitle("Subgraph locked \u2014 unlock to add")
          .setIcon("lucide-lock")
          .setDisabled(true);
      });
      return;
    }
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
          void this.createChildNode(
            sourceNode,
            value.title,
            value.kind,
            value.label,
          );
        } else if (point) {
          void this.createStandaloneNode(
            value.kind,
            value.label,
            value.title,
            point,
          );
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
    kind: GraphNodeKind,
    label: string,
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
      type: label || undefined,
      kind,
      workflow: label ? this.getWorkflowForNodeType(label) : undefined,
      status: "To Do",
      tags: this.visibleNodes[0] ? this.getTags(this.visibleNodes[0].file) : [],
      x: point.x,
      y: point.y,
    });
    new Notice(`Created ${safeTitle}`);
  }

  private async createChildNode(
    sourceNode: GraphNode,
    title: string,
    kind: GraphNodeKind,
    label: string,
  ): Promise<void> {
    const safeTitle = title.trim();
    if (!safeTitle) return;
    if (sourceNode.effectiveLocked) {
      new Notice("Subgraph is locked \u2014 unlock it to add nodes.");
      return;
    }
    await this.createTemplateNode({
      title: safeTitle,
      type: label || undefined,
      kind,
      workflow: label ? this.getWorkflowForNodeType(label) : undefined,
      status: "To Do",
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
    // one allowed action is Prune (Cancel sub-graph). Scope/aggregation nodes
    // are not work at all — they only roll up members, so they get neither.
    if (this.isScopeNode(sourceNode) || this.isImpactNode(sourceNode)) {
      // Scope/impact node: not actionable work; no work-node or prune actions.
    } else if (sourceNode.children.length === 0) {
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
          .setTitle("Set as awaiting")
          .setIcon("lucide-hourglass")
          .onClick(() => {
            void this.markNodeAwaiting(sourceNode);
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
    if (sourceNode.descendantCount > 0) {
      menu.addItem((item) => {
        item
          .setTitle(
            sourceNode.effectiveLocked ? "Unlock subgraph" : "Lock subgraph",
          )
          .setIcon(
            sourceNode.effectiveLocked ? "lucide-lock-open" : "lucide-lock",
          )
          .onClick(() => {
            void this.toggleGraphLock(sourceNode);
          });
      });
    }
    // Agency (who executes the work). Not applicable to pure group/aggregation
    // or impact nodes. Cycles executor and, when an agent is involved, autonomy.
    if (sourceNode.kind !== "group" && !this.isImpactNode(sourceNode)) {
      menu.addItem((item) => {
        item
          .setTitle(`Run by: ${sourceNode.executor}`)
          .setIcon(
            sourceNode.executor === "agent"
              ? "lucide-bot"
              : sourceNode.executor === "mixed"
                ? "lucide-users"
                : "lucide-user",
          )
          .onClick(() => {
            void this.cycleNodeExecutor(sourceNode);
          });
      });
      if (sourceNode.executor !== "human") {
        menu.addItem((item) => {
          item
            .setTitle(`Autonomy: ${sourceNode.autonomy}`)
            .setIcon("lucide-gauge")
            .onClick(() => {
              void this.cycleNodeAutonomy(sourceNode);
            });
        });
      }
    }
    if (sourceNode.children.length > 0) {
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle("Organize subtree").setIcon("lucide-layout-dashboard");
        const submenu = (
          item as MenuItem & { setSubmenu: () => Menu }
        ).setSubmenu();
        submenu.addItem((sub) =>
          sub
            .setTitle("Tidy — top-down")
            .setIcon("lucide-chevrons-down")
            .onClick(() =>
              this.organizeSubtree(sourceNode, "top-down", "natural"),
            ),
        );
        submenu.addItem((sub) =>
          sub
            .setTitle("Tidy — left-to-right")
            .setIcon("lucide-chevrons-right")
            .onClick(() =>
              this.organizeSubtree(sourceNode, "left-right", "natural"),
            ),
        );
        submenu.addItem((sub) =>
          sub
            .setTitle("Layered — gated →, subtree ↓")
            .setIcon("lucide-network")
            .onClick(() =>
              this.organizeSubtree(sourceNode, "top-down", "gating"),
            ),
        );
        submenu.addItem((sub) =>
          sub
            .setTitle("Layered — gated ↓, subtree →")
            .setIcon("lucide-network")
            .onClick(() =>
              this.organizeSubtree(sourceNode, "left-right", "gating"),
            ),
        );
        submenu.addSeparator();
        submenu.addItem((sub) =>
          sub
            .setTitle("Mirror vertical")
            .setIcon("lucide-flip-vertical-2")
            .onClick(() => this.mirrorSubtree(sourceNode, "vertical")),
        );
        submenu.addItem((sub) =>
          sub
            .setTitle("Mirror horizontal")
            .setIcon("lucide-flip-horizontal-2")
            .onClick(() => this.mirrorSubtree(sourceNode, "horizontal")),
        );
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
      locked: true,
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
      locked: true,
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
              locked: true,
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
              locked: true,
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
            locked: true,
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
        effecting: true,
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
      // Compensation (saga): ship a dormant "disable feature flag" that
      // undoes the enable. It is out-of-band (compensates only, no depends_on),
      // so it stays hidden until a failure escalates through the ring, then
      // derives active as a parallel mitigation. See GRAPH_ARCHITECTURE_PLAN.md
      // "Compensation (saga)".
      await this.createTemplateNode({
        title: `${title} - disable feature flag`,
        displayTitle: "disable feature flag",
        type: "disable",
        status: "To Do",
        parent: this.getWikiLink(ringNode.file),
        compensates: [this.getWikiLink(enableFlag)],
        tags: sourceNode ? this.getTags(sourceNode.file) : this.getRootTags(),
        ...this.getTemplateChildPosition(origin, -0.5, 2),
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
      rollupToKeys: [],
      compensatesKeys: [],
      effecting: false,
      nodeType,
      workflow,
      collapsed: false,
      descendantCount: 0,
      children: [],
      successors: [],
      predecessors: [],
      breakTargets: [],
      restartTargets: [],
      rollupTargets: [],
      members: [],
      compensatesTargets: [],
      compensatedBy: [],
      needsCompensation: false,
      excludedFromFold: false,
      kindExplicit: null,
      kind: "work",
      executorExplicit: null,
      executor: "human",
      autonomyExplicit: null,
      autonomy: "propose",
      lockedExplicit: null,
      effectiveLocked: false,
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
    type?: string;
    kind?: GraphNodeKind;
    status: string;
    parent?: string;
    workflow?: string;
    dependsOn?: string[];
    compensates?: string[];
    effecting?: boolean;
    tags?: string[];
    locked?: boolean;
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
    ];
    if (options.type) {
      lines.push(`type: ${this.formatYamlScalar(options.type)}`);
    }
    // Only persist `kind` when it is not the structural default (`work`); the
    // rest is inferred. Groups especially need it (empty groups look like work).
    if (options.kind && options.kind !== "work") {
      lines.push(`kind: ${this.formatYamlScalar(options.kind)}`);
    }
    lines.push(
      `kanban_order: ${JSON.stringify(this.getNextKanbanOrder(options.status))}`,
      `graph_order: ${this.getNextOrder(options.status)}`,
      `created: ${new Date().toISOString()}`,
      `id: ${this.getGeneratedId(options.title)}`,
    );
    if (options.workflow) {
      lines.push(`workflow: ${this.formatYamlScalar(options.workflow)}`);
    }
    if (options.locked) {
      lines.push(`${GRAPH_LOCKED_PROPERTY}: true`);
    }
    if (options.effecting) {
      lines.push(`${GRAPH_EFFECTING_PROPERTY}: true`);
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
    // Compensation (saga): a dormant rollback node links ONLY via `compensates`
    // (what it undoes) — never `depends_on` — so it stays out-of-band and
    // hidden until a failure escalates through its target's container.
    if (options.compensates && options.compensates.length > 0) {
      lines.push("compensates:");
      for (const target of options.compensates) {
        lines.push(`  - ${this.formatYamlScalar(target)}`);
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
      `kanban_order: ${JSON.stringify(this.getNextKanbanOrder(status))}`,
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
    this.temporalSnapshots.clear();
    const entries: BasesEntry[] = this.data?.data ?? [];
    let nodes: GraphNode[] = [];
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
        rollupToKeys: this.getRollupToKeys(file),
        compensatesKeys: this.getCompensatesKeys(file),
        effecting: this.getGraphEffecting(file),
        nodeType: this.getNodeType(file),
        workflow: this.getWorkflow(file),
        collapsed: this.isGraphCollapsed(file),
        descendantCount: 0,
        children: [],
        successors: [],
        predecessors: [],
        breakTargets: [],
        restartTargets: [],
        rollupTargets: [],
        members: [],
        compensatesTargets: [],
        compensatedBy: [],
        needsCompensation: false,
        excludedFromFold: false,
        kindExplicit: this.getGraphKind(file),
        kind: "work",
        executorExplicit: this.getGraphExecutor(file),
        executor: "human",
        autonomyExplicit: this.getGraphAutonomy(file),
        autonomy: "propose",
        lockedExplicit: this.getGraphLockedExplicit(file),
        effectiveLocked: false,
        x: 0,
        y: 0,
        savedX: this.getSavedGraphPosition(file, GRAPH_POSITION_PROPERTY_X),
        savedY: this.getSavedGraphPosition(file, GRAPH_POSITION_PROPERTY_Y),
        state: "idle",
      });
    }

    this.observeTemporalGraph(nodes);
    if (this.temporalCursor !== null && this.temporalHistory) {
      const recorded =
        graphAtTime(this.temporalHistory, this.temporalCursor) ?? [];
      this.temporalSnapshots = new Map(
        recorded.map((node) => [node.path, node]),
      );
      nodes = recorded.map((snapshot): GraphNode => {
        const file = new TFile();
        file.path = snapshot.path;
        file.name = snapshot.path.split("/").pop() ?? snapshot.path;
        file.basename = file.name.replace(/\.md$/i, "");
        file.extension = "md";
        file.stat = { ctime: 0, mtime: 0, size: 0 };
        return {
          ...snapshot,
          entry: null,
          file,
          collapsed: false,
          descendantCount: 0,
          children: [],
          successors: [],
          predecessors: [],
          breakTargets: [],
          restartTargets: [],
          rollupTargets: [],
          members: [],
          compensatesTargets: [],
          compensatedBy: [],
          needsCompensation: false,
          excludedFromFold: false,
          kind: "work",
          executor: "human",
          autonomy: "propose",
          effectiveLocked: false,
          x: 0,
          y: 0,
          savedX: null,
          savedY: null,
          state: "idle",
        };
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
      // Aggregation membership: `rollup_to` links a node up into a scope
      // (many-to-many). The scope discovers its members via the reverse edge.
      for (const rollupKey of node.rollupToKeys) {
        const scope = nodesByIdentity.get(rollupKey);
        if (!scope || scope.file.path === node.file.path) continue;
        node.rollupTargets.push(scope);
        scope.members.push(node);
      }
      // Compensation (saga): `compensates` links a rollback/mitigation node to
      // the effecting node it undoes; the effecting node discovers its
      // compensations via the reverse edge.
      for (const compensatesKey of node.compensatesKeys) {
        const effecting = nodesByIdentity.get(compensatesKey);
        if (!effecting || effecting.file.path === node.file.path) continue;
        node.compensatesTargets.push(effecting);
        effecting.compensatedBy.push(node);
      }
    }

    for (const node of nodes) {
      node.children.sort((first, second) => this.compareNodes(first, second));
      node.members.sort((first, second) => this.compareNodes(first, second));
      node.successors.sort((first, second) => this.compareNodes(first, second));
      node.predecessors.sort((first, second) =>
        this.compareNodes(first, second),
      );
    }

    for (const node of nodes) {
      // A compensation is out-of-band: exclude it from its parent's fold (and,
      // below, from sibling chains, the execution partition, and — when dormant
      // — visibility).
      node.excludedFromFold = node.compensatesTargets.length > 0;
    }

    this.assignNodeKinds(nodes);
    this.assignNodeStates(nodes);
    this.assignNodeLocks(nodes);
    this.assignNodeAgency(nodes);
    nodes.sort((first, second) => this.compareNodes(first, second));
    const expanded = this.config?.get(CONFIG_KEY_GRAPH_OVERVIEW_EXPANDED);
    this.graphWorkSummaries.clear();
    for (const node of nodes) {
      node.descendantCount = getOverviewDescendants(node).filter(
        (child) => !this.isDormantCompensation(child),
      ).length;
      this.graphWorkSummaries.set(node.file.path, summarizeGraphWork(node));
      if (this.isGraphOverview()) {
        node.collapsed =
          node.descendantCount > 0 &&
          (this.temporalCursor !== null
            ? !this.temporalExpandedKeys.has(this.getTemporalNodeKey(node))
            : Array.isArray(expanded)
              ? !expanded.includes(node.file.path)
              : true);
      }
    }
    this.graphNodes = nodes;
    if (this.isGraphOverview()) {
      return this.prepareScopedOverview(nodes);
    }
    return this.getVisibleGraphNodes(nodes);
  }

  private getVisibleGraphNodes(nodes: GraphNode[]): GraphNode[] {
    const visibleNodes = projectOverview(
      nodes,
      new Set(nodes.filter((node) => node.collapsed)),
    ).visible.map((node) => ({ ...node }));
    const byPath = new Map(visibleNodes.map((node) => [node.file.path, node]));
    for (const node of visibleNodes) {
      for (const relation of [
        "children",
        "successors",
        "predecessors",
        "breakTargets",
        "restartTargets",
        "rollupTargets",
        "members",
        "compensatesTargets",
        "compensatedBy",
      ] as const) {
        node[relation] = node[relation]
          .map((target) => byPath.get(target.file.path))
          .filter((target): target is GraphNode => target !== undefined);
      }
    }

    return visibleNodes;
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

    return this.buildGraphFlowEdges(nodes);
  }

  private buildGraphFlowEdges(nodes: GraphNode[]): GraphEdge[] {
    const allNodes = this.graphNodes.length > 0 ? this.graphNodes : nodes;
    const parentByPath = this.getResolvedParentsByPath(allNodes);
    const breakEdgeKeys = new Set<string>();
    const derivedBreakEdges: GraphEdge[] = [];
    const brokenParentPaths = new Set<string>();
    const getPrevious = (
      child: GraphNode,
      parent: GraphNode,
      path: ReadonlySet<string>,
    ): GraphNode[] => {
      const predecessors = child.predecessors.filter(
        (predecessor) =>
          parentByPath.get(predecessor.file.path)?.file.path ===
            parent.file.path &&
          !this.isImpactNode(predecessor) &&
          !this.isCompensationNode(predecessor) &&
          !predecessor.restartTargets.some(
            (target) => target.file.path === child.file.path,
          ) &&
          !path.has(predecessor.file.path),
      );
      return predecessors.length > 0 ? predecessors : [parent];
    };
    const traced = new Set<string>();
    const traceFailure = (child: GraphNode, path = new Set<string>()): void => {
      if (traced.has(child.file.path) || path.has(child.file.path)) return;
      const parent = parentByPath.get(child.file.path);
      if (!parent || this.isImpactNode(parent)) return;
      const branch = new Set(path).add(child.file.path);
      brokenParentPaths.add(parent.file.path);
      for (const target of getPrevious(child, parent, branch)) {
        if (branch.has(target.file.path)) continue;
        const key = `${child.file.path}->${target.file.path}`;
        if (!breakEdgeKeys.has(key)) {
          breakEdgeKeys.add(key);
          derivedBreakEdges.push({
            from: child,
            to: target,
            kind: "break",
            backtrack: true,
          });
        }
        if (!this.isScopeNode(target)) traceFailure(target, branch);
      }
      traced.add(child.file.path);
    };
    for (const node of allNodes) {
      if (this.isImpactNode(node)) continue;
      if (!this.isGenuinelyFailedStatus(node.status)) continue;
      traceFailure(node);
    }

    const returnEdges = new Map<string, GraphEdge>();
    const traceReturn = (terminal: GraphNode, parent: GraphNode): void => {
      const state =
        terminal.state === "completed" || terminal.state === "cancelled"
          ? terminal.state
          : "waiting";
      const visited = new Set<string>();
      const visit = (child: GraphNode, path = new Set<string>()): void => {
        if (
          child.file.path === parent.file.path ||
          visited.has(child.file.path)
        )
          return;
        visited.add(child.file.path);
        const branch = new Set(path).add(child.file.path);
        for (const target of getPrevious(child, parent, branch)) {
          if (branch.has(target.file.path)) continue;
          const key = `${child.file.path}->${target.file.path}`;
          const existing = returnEdges.get(key);
          if (!existing || existing.returnState === "completed")
            returnEdges.set(key, {
              from: child,
              to: target,
              kind: "requirement-return",
              backtrack: true,
              returnState: state,
            });
          if (target.file.path !== parent.file.path) visit(target, branch);
        }
      };
      visit(terminal);
    };

    const edges: GraphEdge[] = [];
    for (const node of nodes) {
      // Compensations are out-of-band (failure-triggered branches), so they are
      // excluded from the forward sibling chain — no requirement-start/return,
      // and they never act as the chain terminal.
      const childChains = this.getSiblingChains(
        node.children.filter(
          (child) =>
            !this.isCompensationNode(child) &&
            !this.isImpactNode(child) &&
            !this.isScopeNode(node) &&
            !this.isImpactNode(node),
        ),
      );
      for (const child of node.children) {
        if (
          this.isImpactNode(child) ||
          this.isImpactNode(node) ||
          this.isScopeNode(node)
        )
          edges.push({ from: node, to: child, kind: "association" });
      }
      for (const chain of childChains) {
        const firstChild = chain[0];
        const lastChild = chain[chain.length - 1];
        if (firstChild) {
          edges.push({ from: node, to: firstChild, kind: "requirement-start" });
        }
        if (
          lastChild &&
          (!brokenParentPaths.has(node.file.path) ||
            (lastChild.state === "completed" &&
              !traced.has(lastChild.file.path)))
        )
          traceReturn(lastChild, node);
      }
      for (const successor of node.successors) {
        const isRestart = node.restartTargets.some(
          (target) => target.file.path === successor.file.path,
        );
        edges.push({
          from: node,
          to: successor,
          kind:
            this.isImpactNode(node) || this.isImpactNode(successor)
              ? "association"
              : isRestart
                ? "restart"
                : "gating",
        });
      }
      // Membership (manual aggregation): the node rolls up into each scope.
      for (const scope of node.rollupTargets) {
        edges.push({ from: node, to: scope, kind: "membership" });
      }
      // Compensation (saga): when a declared compensation is live (triggered by
      // a failure), draw a rollback edge from the effecting node to its
      // mitigation. Latent (un-triggered) compensations are not drawn.
      for (const compensation of node.compensatedBy) {
        if (this.isLiveGraphState(compensation.state)) {
          edges.push({ from: node, to: compensation, kind: "compensation" });
        }
      }
      // Authored `breaks_to` links only render when the source is genuinely
      // failed (a real triggered break). Dormant authored breaks are not drawn —
      // in the derived model an inactive break is not a real link and must not
      // compete with the canonical return (GRAPH_SEMANTICS_SPEC.md Layer B).
      // Containment escalation is covered by the derived break edges above.
      if (
        !this.isImpactNode(node) &&
        this.isGenuinelyFailedStatus(node.status)
      ) {
        const ancestors = new Set<string>();
        let ancestor = parentByPath.get(node.file.path);
        while (ancestor && !ancestors.has(ancestor.file.path)) {
          ancestors.add(ancestor.file.path);
          ancestor = parentByPath.get(ancestor.file.path);
        }
        for (const breakTarget of node.breakTargets) {
          if (ancestors.has(breakTarget.file.path)) continue;
          const key = `${node.file.path}->${breakTarget.file.path}`;
          if (breakEdgeKeys.has(key)) continue;
          breakEdgeKeys.add(key);
          edges.push({ from: node, to: breakTarget, kind: "break" });
        }
      }
    }
    for (const [key, edge] of returnEdges)
      if (!breakEdgeKeys.has(key)) edges.push(edge);
    edges.push(...derivedBreakEdges);
    const visible = new Map(nodes.map((node) => [node.file.path, node]));
    return edges
      .filter(
        (edge) =>
          visible.has(edge.from.file.path) && visible.has(edge.to.file.path),
      )
      .map((edge) => ({
        ...edge,
        from: visible.get(edge.from.file.path)!,
        to: visible.get(edge.to.file.path)!,
      }));
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
    engineDeriveStates(
      nodes,
      (node) => parentByPath.get((node as GraphNode).file.path) ?? null,
    );
    this.runSignalScheduler(nodes, parentByPath);
  }

  /**
   * View-level reactions run after the shared engine derives compensation
   * state. Attention badges consume the same failure boundaries as the engine.
   */
  private readonly signalHandlers: ReadonlyArray<GraphSignalHandler> = [
    {
      id: "attention",
      apply: (context) =>
        this.applyAttentionSignals(
          context.nodes,
          context.parentByPath,
          context.failureScope,
        ),
    },
  ];

  /**
   * Step C signal scheduler. Propagates work signals through the containment
   * hierarchy (currently only `failure`), then dispatches the resulting scope
   * to each registered handler in order. This generalises the M3 failure
   * escalation: propagation honours a per-kind bounce policy, and the
   * compensation / attention reactions are pluggable handlers instead of
   * hard-wired passes.
   */
  private runSignalScheduler(
    nodes: GraphNode[],
    parentByPath: Map<string, GraphNode>,
  ): void {
    const context: GraphSignalContext = {
      nodes,
      parentByPath,
      failureScope: this.propagateFailureSignals(nodes, parentByPath),
    };
    for (const handler of this.signalHandlers) handler.apply(context);
  }

  /** A node that undoes an effecting node (`compensates`). */
  private isCompensationNode(node: GraphNode): boolean {
    return engineIsCompensationNode(node);
  }

  private isImpactNode(node: GraphNode): boolean {
    return engineIsImpactNode(node);
  }

  private isDormantCompensation(node: GraphNode): boolean {
    return this.isCompensationNode(node) && node.state === "idle";
  }

  /**
   * Status used to derive a node's column colour. Normally the raw status, but
   * a triggered compensation is `Planned` on disk while its derived state is
   * `active` — colour it as active so the live rollback reads as frontier (blue)
   * rather than dormant grey. The orange mitigation edge/badge still mark it as
   * a rollback. See GRAPH_ARCHITECTURE_PLAN.md "Compensation (saga)".
   */
  private getNodeColorStatus(node: GraphNode): string | null {
    if (this.isCompensationNode(node) && node.state === "active") {
      return GRAPH_STATUS_ACTIVE;
    }
    return node.status;
  }

  /**
   * Propagates a `failure` signal from every genuinely-failed leaf up the
   * containment chain, collecting the ancestors it reaches. Escalation stops at
   * the first ancestor whose kind `absorb`s the signal (the aggregation
   * boundary), so a failure stays contained within its group/scope instead of
   * painting the whole portfolio as broken. The collected set is the "failure
   * scope" consumed by the compensation and attention handlers.
   */
  private propagateFailureSignals(
    nodes: GraphNode[],
    parentByPath: Map<string, GraphNode>,
  ): Set<string> {
    const scope = engineGetFailureScope(
      nodes,
      (node) => parentByPath.get((node as GraphNode).file.path) ?? null,
    );
    return new Set([...scope].map((node) => (node as GraphNode).file.path));
  }

  /**
   * Attention signal (Compensation Phase 3). Flags an effecting node whose live
   * side-effect is now stranded by a failure but has **no declared compensation**
   * — the graph cannot invent the domain rollback, so it raises a cue for a
   * human/agent to propose one. Declared compensations are already handled by
   * the shared compensation derivation, so they never raise this. Pure recompute.
   */
  private applyAttentionSignals(
    nodes: GraphNode[],
    parentByPath: Map<string, GraphNode>,
    brokenScopePaths: Set<string>,
  ): void {
    for (const node of nodes) {
      node.needsCompensation = this.isUnmitigatedEffectingFailure(
        node,
        parentByPath,
        brokenScopePaths,
      );
    }
  }

  /**
   * True when an explicitly-`effecting` node has a live (completed) side-effect,
   * a genuine failure has escalated through its container, and nothing is
   * declared to undo it (`compensatedBy` empty). The absence of a `compensates`
   * edge is exactly why this needs an explicit `effecting` flag — a missing
   * compensation is otherwise indistinguishable from "no side-effect".
   */
  private isUnmitigatedEffectingFailure(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
    brokenScopePaths: Set<string>,
  ): boolean {
    if (!node.effecting) return false;
    if (node.compensatedBy.length > 0) return false;
    if (!this.isCompletedStatus(node.status)) return false;
    const parent = parentByPath.get(node.file.path);
    return parent ? brokenScopePaths.has(parent.file.path) : false;
  }

  /**
   * Resolves each node's effective subgraph lock (Step B). Lock is inherited
   * down containment; the nearest self-or-ancestor with an explicit
   * `graph_locked` decides, defaulting to unlocked. So a locked template root
   * freezes its whole subtree, and a nested template with its own lock is an
   * independent locked unit (unlocking an ancestor does not free it).
   */
  /**
   * Computes each node's behavioural `kind` (GRAPH_ARCHITECTURE_PLAN.md). An
   * explicit `kind` wins; otherwise it is inferred from structure (members →
   * group, children → process, else work). A `group` with no members yet must
   * declare `kind: group` explicitly — there is no label-name fallback.
   */
  private assignNodeKinds(nodes: GraphNode[]): void {
    engineAssignNodeKinds(nodes);
  }

  /**
   * Resolves each node's effective agency (executor + autonomy). Like the lock,
   * agency is inherited down containment (nearest self-or-ancestor with an
   * explicit value wins); defaults executor `human`, autonomy `propose`.
   */
  private assignNodeAgency(nodes: GraphNode[]): void {
    const parentByPath = this.getResolvedParentsByPath(nodes);
    for (const node of nodes) {
      node.executor =
        this.resolveInheritedValue(
          node,
          parentByPath,
          (candidate) => candidate.executorExplicit,
        ) ?? "human";
      node.autonomy =
        this.resolveInheritedValue(
          node,
          parentByPath,
          (candidate) => candidate.autonomyExplicit,
        ) ?? "propose";
    }
  }

  private resolveInheritedValue<T>(
    node: GraphNode,
    parentByPath: Map<string, GraphNode>,
    pick: (candidate: GraphNode) => T | null,
  ): T | null {
    const seen = new Set<string>();
    let current: GraphNode | null = node;
    while (current && !seen.has(current.file.path)) {
      seen.add(current.file.path);
      const value = pick(current);
      if (value !== null) return value;
      current = parentByPath.get(current.file.path) ?? null;
    }
    return null;
  }

  private assignNodeLocks(nodes: GraphNode[]): void {
    const parentByPath = this.getResolvedParentsByPath(nodes);
    for (const node of nodes) {
      const seen = new Set<string>();
      let current: GraphNode | null = node;
      let resolved = false;
      while (current && !seen.has(current.file.path)) {
        seen.add(current.file.path);
        if (current.lockedExplicit !== null) {
          node.effectiveLocked = current.lockedExplicit;
          resolved = true;
          break;
        }
        current = parentByPath.get(current.file.path) ?? null;
      }
      if (!resolved) node.effectiveLocked = false;
    }
  }

  /**
   * Structural edges define a node's computed shape and are frozen when locked.
   * Membership (`rollup_to`) is the one manually-editable relation and is never
   * locked (rolling a subgraph up into a scope is an external act).
   */
  private isStructuralEdge(edge: GraphEdge): boolean {
    return edge.kind !== "membership";
  }

  /** True when an edge is structural AND either endpoint is in a locked subgraph. */
  private isEdgeStructurallyLocked(edge: GraphEdge): boolean {
    return (
      this.isStructuralEdge(edge) &&
      (edge.from.effectiveLocked || edge.to.effectiveLocked)
    );
  }

  /** Aggregation/scope nodes: pure rollup containers (no work state machine). */
  private isScopeNode(node: GraphNode): boolean {
    return engineIsScopeNode(node);
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
    if (this.isGraphPhysics()) {
      const peers = this.renderedGraphEdges.filter(
        (candidate) =>
          candidate.kind === edge.kind &&
          candidate.to.file.path === edge.to.file.path,
      );
      const lane = Math.max(0, peers.indexOf(edge));
      const body = (node: GraphNode): GraphPhysicsNode => ({
        id: node.file.path,
        ...this.getNodeCanvasPosition(node),
        ...this.getPhysicsNodeSize(node),
      });
      const curve = routeGraphPhysicsEdge(
        body(edge.from),
        body(edge.to),
        edge.backtrack
          ? edge.kind === "break"
            ? "failure-trace"
            : "completion-trace"
          : edge.kind,
        this.physicsRouteNodes,
        lane,
      );
      return `M ${curve.start.x} ${curve.start.y} Q ${curve.control.x} ${curve.control.y} ${curve.end.x} ${curve.end.y}`;
    }
    if (this.isGraphOverview()) {
      const from = this.getNodeCanvasPosition(edge.from);
      const to = this.getNodeCanvasPosition(edge.to);
      const startY = from.y + this.getRenderedGraphNodeSize(edge.from).height;
      const endY = to.y + this.getRenderedGraphNodeSize(edge.to).height / 2;
      return `M ${from.x + 8} ${startY} V ${endY} H ${to.x}`;
    }
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
    if (edge.backtrack) {
      const forward: GraphEdge = {
        from: edge.to,
        to: edge.from,
        kind: edge.to.children.some(
          (child) => child.file.path === edge.from.file.path,
        )
          ? "requirement-start"
          : "gating",
      };
      const anchor = this.getDefaultEdgeEndpointAnchor(
        forward,
        endpoint === "from" ? "to" : "from",
      );
      const node = this.getEdgeEndpointNode(edge, endpoint);
      const position = this.getNodeCanvasPosition(node);
      const size = this.getRenderedGraphNodeSize(node);
      return anchor.side === "left" || anchor.side === "right"
        ? {
            ...anchor,
            y: Math.max(
              position.y + 8,
              Math.min(position.y + size.height - 8, anchor.y + 12),
            ),
          }
        : {
            ...anchor,
            x: Math.max(
              position.x + 8,
              Math.min(position.x + size.width - 8, anchor.x + 12),
            ),
          };
    }
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
    if (edge.backtrack) return 72;
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
    if (this.isGraphPhysics()) return this.getPhysicsNodeSize(node);
    const physicsSize = this.isGraphPhysics()
      ? this.physicsSizes.get(node.file.path)
      : undefined;
    if (physicsSize) return physicsSize;
    const nodeEl = this.getRenderedGraphNodeEl(node);
    return {
      width: nodeEl?.offsetWidth ?? NODE_WIDTH,
      height:
        (this.isGraphOverview()
          ? this.overviewItems.get(node.file.path)?.height
          : undefined) ??
        nodeEl?.offsetHeight ??
        (this.isGraphOverview() ? OVERVIEW_NODE_HEIGHT : NODE_MIN_HEIGHT),
    };
  }

  private getNodeCanvasPosition(node: GraphNode): { x: number; y: number } {
    return this.worldToCanvasPoint({ x: node.x, y: node.y });
  }

  private updatePhysicsRouteNodes(): void {
    if (!this.isGraphPhysics()) return;
    this.physicsRouteNodes = this.visibleNodes.map((node) => ({
      id: node.file.path,
      ...this.getNodeCanvasPosition(node),
      ...this.getPhysicsNodeSize(node),
    }));
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
      maxY: Math.max(
        ...nodes.map(
          (node) =>
            node.y +
            (this.isGraphOverview()
              ? (this.overviewItems.get(node.file.path)?.height ??
                OVERVIEW_NODE_HEIGHT)
              : NODE_MIN_HEIGHT),
        ),
      ),
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
    if (this.temporalCursor !== null) return this.graphWorldBounds;
    if (this.isGraphPhysics()) return this.physicsWorld;
    const raw = this.config?.get(
      this.isGraphOverview()
        ? CONFIG_KEY_GRAPH_OVERVIEW_WORLD
        : CONFIG_KEY_GRAPH_WORLD,
    );
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
    if (this.isGraphPhysics()) {
      this.physicsWorld = bounds;
      return;
    }
    if (this.temporalCursor !== null) {
      this.graphWorldBounds = bounds;
      return;
    }
    // Persisting world bounds calls config.set, which can trigger a full
    // re-render (onDataUpdated) and detach the live viewport. During an active
    // pan that would orphan the pan handler's viewport reference and send the
    // camera running off screen, so defer persistence until the pan finishes.
    if (this.graphPanActive) {
      this.graphPanWorldPersistPending = true;
      return;
    }
    this.config?.set(
      this.isGraphOverview()
        ? CONFIG_KEY_GRAPH_OVERVIEW_WORLD
        : CONFIG_KEY_GRAPH_WORLD,
      {
        minX: Math.round(bounds.minX),
        minY: Math.round(bounds.minY),
        maxX: Math.round(bounds.maxX),
        maxY: Math.round(bounds.maxY),
      },
    );
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
      string | undefined;
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

  /** This node's own explicit `kind` (null = infer from structure). */
  private getGraphKind(file: TFile): GraphNodeKind | null {
    const raw = this.normalizeText(this.getFrontmatter(file)?.kind)
      ?.toLowerCase()
      .trim();
    return GRAPH_NODE_KINDS.find((kind) => kind === raw) ?? null;
  }

  /** This node's own explicit `executor` agency (null = inherit). */
  private getGraphExecutor(file: TFile): GraphExecutor | null {
    const raw = this.normalizeText(this.getFrontmatter(file)?.executor)
      ?.toLowerCase()
      .trim();
    return GRAPH_EXECUTORS.find((executor) => executor === raw) ?? null;
  }

  /** This node's own explicit `autonomy` level (null = inherit). */
  private getGraphAutonomy(file: TFile): GraphAutonomy | null {
    const raw = this.normalizeText(this.getFrontmatter(file)?.autonomy)
      ?.toLowerCase()
      .trim();
    return GRAPH_AUTONOMY_LEVELS.find((level) => level === raw) ?? null;
  }

  private getWorkflow(file: TFile): string | null {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeText(frontmatter?.workflow);
  }

  private isGraphCollapsed(file: TFile): boolean {
    const frontmatter = this.getFrontmatter(file);
    return frontmatter?.[GRAPH_COLLAPSED_PROPERTY] === true;
  }

  /** This node's own stored `graph_locked` (null = no explicit value). */
  private getGraphLockedExplicit(file: TFile): boolean | null {
    const value = this.getFrontmatter(file)?.[GRAPH_LOCKED_PROPERTY];
    if (value === true) return true;
    if (value === false) return false;
    return null;
  }

  /** Explicit `effecting: true` — this node performs an undoable side-effect. */
  private getGraphEffecting(file: TFile): boolean {
    return this.getFrontmatter(file)?.[GRAPH_EFFECTING_PROPERTY] === true;
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

  private getRollupToKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(frontmatter?.rollup_to);
  }

  private getCompensatesKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(frontmatter?.compensates);
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
    return engineNormalizeReferences(value);
  }

  private normalizeReference(value: unknown): string | null {
    return engineNormalizeReference(value);
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
    const recorded = this.temporalSnapshots.get(node.file.path);
    if (recorded) return recorded.identities;
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
    const orderDifference = compareOrderValues(
      this.getOrder(first.file),
      this.getOrder(second.file),
    );
    if (orderDifference !== 0) return orderDifference;
    return first.title.localeCompare(second.title);
  }

  private getOrder(file: TFile): OrderValue {
    const recorded = this.temporalSnapshots.get(file.path);
    if (recorded) return recorded.order;
    const frontmatter = this.getFrontmatter(file);
    return (
      readOrderValue(frontmatter?.graph_order) ??
      readOrderValue(frontmatter?.[ORDER_PROPERTY])
    );
  }

  /** Node positions live in the graph view config (not note frontmatter). */
  private getGraphNodePositions(): Record<string, { x: number; y: number }> {
    const raw = this.config?.get(CONFIG_KEY_GRAPH_NODE_POSITIONS);
    return raw && typeof raw === "object"
      ? (raw as Record<string, { x: number; y: number }>)
      : {};
  }

  private getSavedGraphPosition(
    file: TFile,
    propertyName: string,
  ): number | null {
    const axis = propertyName === GRAPH_POSITION_PROPERTY_X ? "x" : "y";
    const pending = this.pendingGraphPositions.get(file.path);
    const stored = this.getGraphNodePositions()[file.path];
    if (pending) {
      if (stored && stored.x === pending.x && stored.y === pending.y) {
        this.pendingGraphPositions.delete(file.path);
      } else {
        return pending[axis];
      }
    }
    if (
      stored &&
      typeof stored[axis] === "number" &&
      Number.isFinite(stored[axis])
    ) {
      return stored[axis];
    }
    // Legacy migration-read: fall back to per-note frontmatter graph_x/graph_y
    // (older vaults). New writes only go to the config map.
    const value = this.getFrontmatter(file)?.[propertyName];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private isCompletedStatus(status: string | null): boolean {
    return engineIsCompletedStatus(status);
  }

  private isInterruptedStatus(status: string | null): boolean {
    return engineIsInterruptedStatus(status);
  }

  private isInvalidatedStatus(status: string | null): boolean {
    return engineIsInvalidatedStatus(status);
  }

  private isCancelledStatus(status: string | null): boolean {
    return engineIsCancelledStatus(status);
  }

  private isAwaitingStatus(status: string | null): boolean {
    return engineIsAwaitingStatus(status);
  }

  private isBlockedStatus(status: string | null): boolean {
    return engineIsBlockedStatus(status);
  }

  private isActiveStatus(status: string | null): boolean {
    return engineIsActiveStatus(status);
  }

  /** Live (non-terminal, on-the-frontier) derived states. */
  private isLiveGraphState(state: GraphNodeState): boolean {
    return (
      state === "active" ||
      state === "in-progress" ||
      state === "awaiting" ||
      state === "blocked" ||
      state === "interrupted"
    );
  }

  private getNodeTooltip(node: GraphNode): string {
    const lines = [node.title, `Status: ${node.status ?? "(No value)"}`];
    if (node.executor !== "human")
      lines.push(`Run by ${node.executor}; autonomy: ${node.autonomy}`);
    if (node.compensatesTargets.length > 0)
      lines.push(
        `Rollback for: ${node.compensatesTargets.map((target) => target.title).join(", ")}`,
      );
    if (node.needsCompensation)
      lines.push("Unmitigated side-effect needs attention");
    if (this.temporalCursor !== null)
      lines.push(
        `Recorded graph snapshot: ${new Date(this.temporalCursor).toLocaleString()}`,
      );
    if (this.isGraphOverview()) {
      const summary = this.graphWorkSummaries.get(node.file.path);
      if (summary && node.descendantCount > 0) {
        lines.push(
          `${summary.completed} / ${summary.total} work items completed`,
        );
        lines.push(
          `${summary.active} running, ${summary.awaiting} awaiting, ${summary.blocked} blocked, ${summary.ready} ready`,
        );
      }
    }
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
    if (this.temporalCursor !== null) return [];
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
      .filter(
        (order): order is number =>
          typeof order === "number" && Number.isFinite(order),
      );
    return orders.length > 0 ? Math.max(...orders) + 1 : 0;
  }

  private getNextKanbanOrder(status: string): OrderValue {
    const orders = this.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        const frontmatter = this.getFrontmatter(file);
        const value = frontmatter?.[this.getGroupByProperty() ?? "status"];
        return (
          typeof value === "string" &&
          value.toLowerCase() === status.toLowerCase()
        );
      })
      .map((file) =>
        readOrderValue(this.getFrontmatter(file)?.[ORDER_PROPERTY]),
      );
    const keys = orders.filter(isOrderKey).sort();
    if (keys.length > 0) return generateOrderKey(keys[keys.length - 1], null);
    const numeric = orders.filter(
      (order): order is number => typeof order === "number",
    );
    return numeric.length > 0
      ? Math.max(...numeric) + 1
      : generateOrderKey(null, null);
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
  private kindValue: GraphNodeKind = "work";
  private labelValue = "";
  private submitButtonEl: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private modalTitle: string,
    private onSubmit: (value: {
      title: string;
      kind: GraphNodeKind;
      label: string;
    }) => void,
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

    new Setting(contentEl)
      .setName("Kind")
      .setDesc("A work item, subprocess, group, or inert impact/metric.")
      .addDropdown((dropdown) => {
        for (const option of GRAPH_ADD_NODE_KIND_OPTIONS) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown.setValue(this.kindValue);
        dropdown.onChange((value) => {
          this.kindValue = value as GraphNodeKind;
        });
      });

    new Setting(contentEl)
      .setName("Label")
      .setDesc("Optional descriptor such as feature, semester, or career.")
      .addText((text) => {
        text.setPlaceholder("Optional");
        text.onChange((value) => {
          this.labelValue = value.trim();
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
    this.submitButtonEl.disabled = !this.titleValue;
  }

  private submit(): void {
    if (!this.titleValue) return;
    this.onSubmit({
      title: this.titleValue,
      kind: this.kindValue,
      label: this.labelValue,
    });
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

class RecordedGraphNodeModal extends Modal {
  constructor(
    app: App,
    private snapshot: GraphHistoryNode,
    private at: number,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.snapshot.title });
    this.contentEl.createEl("time", {
      text: new Date(this.at).toLocaleString(),
      attr: { datetime: new Date(this.at).toISOString() },
    });
    this.contentEl.createEl("p", { text: this.snapshot.path });
    const properties = this.contentEl.createEl("dl", {
      cls: "base-board-recorded-node",
    });
    for (const [label, value] of [
      ["Status", this.snapshot.status],
      ["Parent", this.snapshot.parentValue],
      ["Dependencies", this.snapshot.dependsOnKeys.join(", ")],
      ["Scopes", this.snapshot.rollupToKeys.join(", ")],
      ["Compensates", this.snapshot.compensatesKeys.join(", ")],
      ["Kind", this.snapshot.kindExplicit],
      ["Executor", this.snapshot.executorExplicit],
      ["Autonomy", this.snapshot.autonomyExplicit],
    ]) {
      if (!value) continue;
      properties.createEl("dt", { text: label ?? "" });
      properties.createEl("dd", { text: value });
    }
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

// Read-only validation panel for the active-frontier derivation and graph
// hygiene. Shows each frontier leaf with its work breadcrumb and the set of
// nodes disconnected from the hierarchy.
class GraphFrontierModal extends Modal {
  constructor(
    app: App,
    private frontier: GraphFrontierItem[],
    private hygiene: GraphHygieneItem[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("base-board-graph-frontier-modal");

    contentEl.createEl("h3", {
      text: `Active frontier (${this.frontier.length})`,
    });
    if (this.frontier.length === 0) {
      contentEl.createEl("p", {
        cls: "base-board-graph-frontier-empty",
        text: "No actionable frontier nodes right now.",
      });
    } else {
      const listEl = contentEl.createEl("ul", {
        cls: "base-board-graph-frontier-list",
      });
      for (const item of this.frontier) {
        const itemEl = listEl.createEl("li", {
          cls: "base-board-graph-frontier-item",
        });
        const crumbEl = itemEl.createDiv({
          cls: "base-board-graph-frontier-crumb",
        });
        item.lineage.forEach((segment, index) => {
          const isLast = index === item.lineage.length - 1;
          crumbEl.createSpan({
            cls: isLast
              ? "base-board-graph-frontier-leaf"
              : "base-board-graph-frontier-seg",
            text: segment,
          });
          if (!isLast) {
            crumbEl.createSpan({
              cls: "base-board-graph-frontier-sep",
              text: " › ",
            });
          }
        });
        itemEl.createSpan({
          cls: `base-board-graph-frontier-meta base-board-graph-frontier-meta--${item.state}`,
          text: `${item.status ?? "(no status)"} · ${item.state}`,
        });
      }
    }

    contentEl.createEl("h3", {
      text: `Hygiene (${this.hygiene.length})`,
    });
    if (this.hygiene.length === 0) {
      contentEl.createEl("p", {
        cls: "base-board-graph-frontier-empty",
        text: "Every node is connected to the hierarchy.",
      });
    } else {
      const hygieneEl = contentEl.createEl("ul", {
        cls: "base-board-graph-frontier-list",
      });
      for (const finding of this.hygiene) {
        const findingEl = hygieneEl.createEl("li", {
          cls: "base-board-graph-frontier-item",
        });
        findingEl.createSpan({
          cls: "base-board-graph-frontier-leaf",
          text: finding.title,
        });
        findingEl.createSpan({
          cls: "base-board-graph-frontier-meta",
          text: finding.reason,
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
