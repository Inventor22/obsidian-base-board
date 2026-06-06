import {
  BasesEntry,
  BasesPropertyId,
  BasesView,
  Notice,
  NullValue,
  QueryController,
  setIcon,
  setTooltip,
  TFile,
} from "obsidian";
import type BaseBoardPlugin from "./main";
import { CardDetailModal } from "./card-detail-modal";
import { InputModal } from "./modals";
import { ORDER_PROPERTY, sanitizeFilename } from "./constants";
import { getColumnColor } from "./status-colors";

type GraphRelationKind = "requirement" | "successor";
type GraphNodeState = "active" | "waiting" | "completed" | "blocked" | "idle";
type GraphEdgeKind = "requirement-start" | "requirement-return" | "gating";

interface GraphNode {
  entry: BasesEntry;
  file: TFile;
  title: string;
  status: string | null;
  parentKey: string | null;
  parentValue: string | null;
  dependsOnKeys: string[];
  children: GraphNode[];
  successors: GraphNode[];
  predecessors: GraphNode[];
  x: number;
  y: number;
  savedX: number | null;
  savedY: number | null;
  state: GraphNodeState;
}

interface GraphEdge {
  from: GraphNode;
  to: GraphNode;
  kind: GraphEdgeKind;
}

const GRAPH_BUILD_VERSION = "2026.06.06.2";
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
const GRAPH_PAN_THRESHOLD_PX = 4;
const GRAPH_PAN_MARGIN_X = 720;
const GRAPH_PAN_MARGIN_Y = 320;
const GRAPH_POSITION_PROPERTY_X = "graph_x";
const GRAPH_POSITION_PROPERTY_Y = "graph_y";

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
    this.render();
  }

  public render(): void {
    const previousViewportEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-graph-viewport",
    );
    const hadPreviousViewport = previousViewportEl !== null;
    const previousScrollLeft = previousViewportEl?.scrollLeft ?? 0;
    const previousScrollTop = previousViewportEl?.scrollTop ?? 0;

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

    window.requestAnimationFrame(() => {
      viewportEl.scrollLeft = hadPreviousViewport
        ? previousScrollLeft
        : GRAPH_PAN_MARGIN_X - EDGE_MARGIN;
      viewportEl.scrollTop = hadPreviousViewport
        ? previousScrollTop
        : GRAPH_PAN_MARGIN_Y - EDGE_MARGIN;
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
    toolbarEl.createSpan({
      cls: "base-board-graph-version",
      text: `v${GRAPH_BUILD_VERSION}`,
    });
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

  private renderCanvas(nodes: GraphNode[], edges: GraphEdge[]): HTMLElement {
    const bounds = this.getGraphBounds(nodes);
    const viewportEl = this.containerEl.createDiv({
      cls: "base-board-graph-viewport",
    });
    viewportEl.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        this.zoomGraph(event, viewportEl, zoomContentEl, canvasEl, bounds);
      },
      { passive: false },
    );
    viewportEl.addEventListener("mousedown", (event: MouseEvent) => {
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
      "gating",
    ] as const) {
      const markerEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "marker",
      );
      markerEl.setAttribute("id", `base-board-graph-arrow-${kind}`);
      markerEl.setAttribute("markerWidth", "7");
      markerEl.setAttribute("markerHeight", "7");
      markerEl.setAttribute("refX", "6");
      markerEl.setAttribute("refY", "5");
      markerEl.setAttribute("orient", "auto");
      markerEl.setAttribute("markerUnits", "strokeWidth");
      markerEl.addClass(`base-board-graph-arrow-marker--${kind}`);

      const arrowEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      arrowEl.setAttribute("d", "M 0 2 L 7 5 L 0 8 z");
      markerEl.appendChild(arrowEl);
      defsEl.appendChild(markerEl);
    }
    svgEl.appendChild(defsEl);
  }

  private renderEdges(svgEl: SVGSVGElement, edges: GraphEdge[]): void {
    this.renderedGraphEdges = edges;
    this.renderedGraphEdgeEls = [];
    for (const edge of edges) {
      const pathEl = activeDocument.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      pathEl.addClass("base-board-graph-edge");
      pathEl.addClass(`base-board-graph-edge--${edge.kind}`);
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("d", this.getEdgePath(edge));
      pathEl.setAttribute(
        "marker-end",
        `url(#base-board-graph-arrow-${edge.kind})`,
      );
      svgEl.appendChild(pathEl);
      this.renderedGraphEdgeEls.push(pathEl);
    }
  }

  private applyGraphZoom(
    zoomContentEl: HTMLElement,
    canvasEl: HTMLElement,
    bounds: { width: number; height: number },
  ): void {
    zoomContentEl.style.width = `${
      GRAPH_PAN_MARGIN_X * 2 + bounds.width * this.graphZoom
    }px`;
    zoomContentEl.style.height = `${
      GRAPH_PAN_MARGIN_Y * 2 + bounds.height * this.graphZoom
    }px`;
    canvasEl.style.left = `${GRAPH_PAN_MARGIN_X}px`;
    canvasEl.style.top = `${GRAPH_PAN_MARGIN_Y}px`;
    canvasEl.style.transform = `scale(${this.graphZoom})`;
  }

  private zoomGraph(
    event: WheelEvent,
    viewportEl: HTMLElement,
    zoomContentEl: HTMLElement,
    canvasEl: HTMLElement,
    bounds: { width: number; height: number },
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
    const graphX =
      (viewportEl.scrollLeft + pointerX - GRAPH_PAN_MARGIN_X) / previousZoom;
    const graphY =
      (viewportEl.scrollTop + pointerY - GRAPH_PAN_MARGIN_Y) / previousZoom;

    this.graphZoom = nextZoom;
    this.applyGraphZoom(zoomContentEl, canvasEl, bounds);
    viewportEl.scrollLeft = GRAPH_PAN_MARGIN_X + graphX * nextZoom - pointerX;
    viewportEl.scrollTop = GRAPH_PAN_MARGIN_Y + graphY * nextZoom - pointerY;
  }

  private clampGraphZoom(zoom: number): number {
    return Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, zoom));
  }

  private startGraphPan(event: MouseEvent, viewportEl: HTMLElement): void {
    if (event.button !== 0) return;
    const targetEl = event.target instanceof HTMLElement ? event.target : null;
    if (
      targetEl?.closest(
        ".base-board-graph-node, button, input, textarea, select",
      )
    ) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const startScrollLeft = viewportEl.scrollLeft;
    const startScrollTop = viewportEl.scrollTop;
    let didPan = false;

    const moveHandler = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!didPan && Math.hypot(deltaX, deltaY) >= GRAPH_PAN_THRESHOLD_PX) {
        didPan = true;
        viewportEl.addClass("base-board-graph-viewport--panning");
      }
      if (!didPan) return;
      moveEvent.preventDefault();
      viewportEl.scrollLeft = startScrollLeft - deltaX;
      viewportEl.scrollTop = startScrollTop - deltaY;
    };

    const upHandler = () => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      viewportEl.removeClass("base-board-graph-viewport--panning");
      if (didPan) {
        this.suppressNextNodeClick = true;
        window.setTimeout(() => {
          this.suppressNextNodeClick = false;
        }, 0);
      }
    };

    activeWindow.addEventListener("mousemove", moveHandler);
    activeWindow.addEventListener("mouseup", upHandler);
  }

  private renderNode(parentEl: HTMLElement, node: GraphNode): void {
    const nodeEl = parentEl.createDiv({
      cls: `base-board-graph-node base-board-graph-node--${node.state}`,
    });
    nodeEl.style.left = `${node.x}px`;
    nodeEl.style.top = `${node.y}px`;
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
    if (node.dependsOnKeys.length > 0) {
      metaEl.createSpan({
        cls: "base-board-graph-node-deps",
        text: `${node.predecessors.length}/${node.dependsOnKeys.length} deps`,
      });
    }

    const requirementBtn = nodeEl.createEl("button", {
      cls: "base-board-graph-add base-board-graph-add--requirement",
      attr: { type: "button", title: "Add requirement" },
    });
    setIcon(requirementBtn, "lucide-plus");
    requirementBtn.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.promptCreateRelatedNode(node, "requirement");
    });

    const successorBtn = nodeEl.createEl("button", {
      cls: "base-board-graph-add base-board-graph-add--successor",
      attr: { type: "button", title: "Add gated successor" },
    });
    setIcon(successorBtn, "lucide-plus");
    successorBtn.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.promptCreateRelatedNode(node, "successor");
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
    nodeEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      new CardDetailModal(this.app, node.file).open();
    });
  }

  private startNodeDrag(event: MouseEvent, node: GraphNode): void {
    if (event.button !== 0) return;
    const targetEl = event.target instanceof HTMLElement ? event.target : null;
    if (targetEl?.closest("button, input, textarea, select")) return;

    event.preventDefault();
    event.stopPropagation();

    const movedNodes = this.getMovableSubgraph(node);
    const movedPaths = new Set(
      movedNodes.map((movedNode) => movedNode.file.path),
    );
    const movedNodeEls = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>(".base-board-graph-node"),
    ).filter((nodeEl) => movedPaths.has(nodeEl.dataset.filePath ?? ""));
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
        nodeEl.style.left = `${movedNode.x}px`;
        nodeEl.style.top = `${movedNode.y}px`;
      }
      this.syncRenderedGraphEdges();
    };

    const upHandler = () => {
      activeWindow.removeEventListener("mousemove", moveHandler);
      activeWindow.removeEventListener("mouseup", upHandler);
      movedNodeEls.forEach((nodeEl) =>
        nodeEl.removeClass("base-board-graph-node--dragging"),
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
    for (const node of movedNodes) {
      const original = originalPositions.get(node.file.path);
      if (!original) continue;
      minAllowedX = Math.max(minAllowedX, EDGE_MARGIN - original.x);
      minAllowedY = Math.max(minAllowedY, EDGE_MARGIN - original.y);
    }
    return {
      x: Math.max(deltaX, minAllowedX),
      y: Math.max(deltaY, minAllowedY),
    };
  }

  private syncRenderedGraphEdges(): void {
    this.renderedGraphEdges.forEach((edge, index) => {
      const edgeEl = this.renderedGraphEdgeEls[index];
      if (!edgeEl) return;
      edgeEl.setAttribute("d", this.getEdgePath(edge));
    });
  }

  private async persistGraphNodePositions(nodes: GraphNode[]): Promise<void> {
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
    this.render();
  }

  private promptCreateRelatedNode(
    sourceNode: GraphNode,
    relation: GraphRelationKind,
  ): void {
    const title =
      relation === "requirement" ? "Add requirement" : "Add gated successor";
    const placeholder =
      relation === "requirement" ? "Debug exception" : "Canary flighting";
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
        children: [],
        successors: [],
        predecessors: [],
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
    }

    for (const node of nodes) {
      node.children.sort((first, second) => this.compareNodes(first, second));
      node.successors.sort((first, second) => this.compareNodes(first, second));
      node.predecessors.sort((first, second) =>
        this.compareNodes(first, second),
      );
    }

    this.assignNodeStates(nodes);
    return nodes;
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
        if (lastChild) {
          edges.push({
            from: lastChild,
            to: node,
            kind: "requirement-return",
          });
        }
      }
      for (const successor of node.successors) {
        edges.push({ from: node, to: successor, kind: "gating" });
      }
    }
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

  private assignNodeStates(nodes: GraphNode[]): void {
    for (const node of nodes) {
      if (this.isCompletedStatus(node.status)) {
        node.state = "completed";
      } else if (this.isBlockedStatus(node.status)) {
        node.state = "blocked";
      } else if (!this.areDependenciesCompleted(node)) {
        node.state = "waiting";
      } else if (this.hasIncompleteChildren(node)) {
        node.state = "idle";
      } else {
        node.state = "active";
      }
    }
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
    return node.children.some((child) => !this.isCompletedStatus(child.status));
  }

  private areDependenciesCompleted(node: GraphNode): boolean {
    return node.predecessors.every((dependency) =>
      this.isCompletedStatus(dependency.status),
    );
  }

  private getEdgePath(edge: GraphEdge): string {
    if (edge.kind === "gating") {
      const startX = edge.from.x + NODE_WIDTH;
      const startY = edge.from.y + NODE_MIN_HEIGHT / 2;
      const endX = edge.to.x;
      const endY = edge.to.y + NODE_MIN_HEIGHT / 2;
      const midX = startX + Math.max(32, (endX - startX) / 2);
      return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
    }

    if (edge.kind === "requirement-return") {
      const startX = edge.from.x + NODE_WIDTH;
      const startY = edge.from.y + NODE_MIN_HEIGHT / 2;
      const endX = edge.to.x + NODE_WIDTH / 2;
      const endY = edge.to.y + NODE_MIN_HEIGHT;
      const elbowX = Math.max(startX + 42, endX + 42);
      const elbowY = startY - Math.max(46, (startY - endY) / 2);
      return `M ${startX} ${startY} C ${elbowX} ${startY}, ${elbowX} ${elbowY}, ${endX} ${endY}`;
    }

    const startX = edge.from.x + NODE_WIDTH / 2;
    const startY = edge.from.y + NODE_MIN_HEIGHT;
    const endX = edge.to.x + NODE_WIDTH / 2;
    const endY = edge.to.y;
    const midY = startY + Math.max(32, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }

  private getGraphBounds(nodes: GraphNode[]): {
    width: number;
    height: number;
  } {
    const maxX = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
    const maxY = Math.max(...nodes.map((node) => node.y + NODE_MIN_HEIGHT));
    return {
      width: Math.max(maxX + 160, 720),
      height: Math.max(maxY + 160, 420),
    };
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
    return typeof title === "string" && title.trim() ? title : file.basename;
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
    return (
      frontmatter?.parent ??
      frontmatter?.parent_task ??
      frontmatter?.parentTask ??
      frontmatter?.feature
    );
  }

  private getDependsOnKeys(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    return this.normalizeReferences(
      frontmatter?.depends_on ?? frontmatter?.dependsOn,
    );
  }

  private getTags(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    const rawTags = frontmatter?.tags ?? frontmatter?.tag;
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
    const graphOrder = frontmatter?.graph_order ?? frontmatter?.graphOrder;
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
    const value = frontmatter?.[propertyName];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private isCompletedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "completed" || normalizedStatus === "done";
  }

  private isBlockedStatus(status: string | null): boolean {
    return status?.trim().toLowerCase() === "blocked";
  }

  private getStateIcon(state: GraphNodeState): string {
    if (state === "completed") return "lucide-check";
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
    const basePath = folder ? `${folder}/${title}.md` : `${title}.md`;
    if (!this.app.vault.getAbstractFileByPath(basePath)) return basePath;

    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = folder
        ? `${folder}/${title} ${suffix}.md`
        : `${title} ${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    throw new Error(`Unable to find available file path for ${title}`);
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
