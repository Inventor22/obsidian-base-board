import {
  BasesEntry,
  BasesPropertyId,
  BasesView,
  NullValue,
  QueryController,
  setIcon,
  setTooltip,
  TFile,
} from "obsidian";
import type BaseBoardPlugin from "./main";
import {
  CONFIG_KEY_TAG_COLORS,
  CONFIG_KEY_TIMELINE_LABEL_WIDTH,
  CONFIG_KEY_TIMELINE_PRESET,
  CONFIG_KEY_TIMELINE_ZOOM_DURATION,
  NO_VALUE_COLUMN,
  TIMELINE_ORDER_PROPERTY,
} from "./constants";
import { relativeLuminance } from "./color-utils";
import { ColorPickerModal } from "./tags";
import { getColumnColor } from "./status-colors";
import { CardDetailModal } from "./card-detail-modal";

type TimelineZoomId = "day" | "week" | "month" | "year";

interface TimelineZoomLevel {
  id: TimelineZoomId;
  label: string;
  durationMs: number;
}

interface TransitionHistoryRecord {
  from?: unknown;
  to?: unknown;
  at?: unknown;
  property?: unknown;
}

interface TimelineEvent {
  from: string | null;
  to: string | null;
  at: Date;
}

interface TimelineSegment {
  status: string | null;
  start: Date;
  end: Date;
}

interface TimelineTask {
  entry: BasesEntry;
  file: TFile;
  title: string;
  currentStatus: string | null;
  tags: string[];
  parentKey: string | null;
  timelineOrder: number;
  segments: TimelineSegment[];
}

interface TimelinePool {
  id: string;
  title: string;
  lanes: TimelineLane[];
}

interface TimelineLane {
  task: TimelineTask;
  depth: number;
  hasChildren: boolean;
  segments: TimelineSegment[];
}

interface TimelineTreeNode {
  task: TimelineTask;
  children: TimelineTreeNode[];
}

interface TimelineRange {
  start: Date;
  end: Date;
}

interface TimelineTick {
  at: Date;
  label: string;
  major: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 31 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

const ZOOM_LEVELS: TimelineZoomLevel[] = [
  { id: "day", label: "Day", durationMs: DAY_MS },
  { id: "week", label: "Week", durationMs: WEEK_MS },
  { id: "month", label: "Month", durationMs: MONTH_MS },
  { id: "year", label: "Year", durationMs: YEAR_MS },
];

const LEGACY_ZOOM_DURATIONS: Record<string, number> = {
  "1d": DAY_MS,
  "2d": 2 * DAY_MS,
  "3d": 3 * DAY_MS,
  "4d": 4 * DAY_MS,
  "5d": 5 * DAY_MS,
  "1w": WEEK_MS,
  "2w": 2 * WEEK_MS,
  "3w": 3 * WEEK_MS,
  "1mo": MONTH_MS,
  "2mo": 2 * MONTH_MS,
  "3mo": 3 * MONTH_MS,
  "4mo": 4 * MONTH_MS,
  "5mo": 5 * MONTH_MS,
  "6mo": 6 * MONTH_MS,
  "1y": YEAR_MS,
  "2y": 2 * YEAR_MS,
  "3y": 3 * YEAR_MS,
  "4y": 4 * YEAR_MS,
  "5y": 5 * YEAR_MS,
  "10y": 10 * YEAR_MS,
  "20y": 20 * YEAR_MS,
  "40y": 40 * YEAR_MS,
  day: DAY_MS,
  week: WEEK_MS,
  month: MONTH_MS,
  semester: 6 * MONTH_MS,
  year: YEAR_MS,
  fit: MONTH_MS,
};

function isTimelineZoomId(value: unknown): value is TimelineZoomId {
  return ZOOM_LEVELS.some((zoomLevel) => zoomLevel.id === value);
}

function getZoomDuration(id: TimelineZoomId): number {
  return (
    ZOOM_LEVELS.find((zoomLevel) => zoomLevel.id === id)?.durationMs ?? MONTH_MS
  );
}

const MIN_TIMELINE_WIDTH = 960;
const DEFAULT_LABEL_WIDTH = 240;
const MIN_LABEL_WIDTH = 180;
const MAX_LABEL_WIDTH = 520;
const TIMELINE_PAST_WINDOWS = 2;
const TIMELINE_FUTURE_WINDOWS = 2;
const TIMELINE_TOTAL_WINDOWS =
  TIMELINE_PAST_WINDOWS + 1 + TIMELINE_FUTURE_WINDOWS;
const LANE_HEIGHT = 44;
const POOL_HEADER_HEIGHT = 34;
const LANE_GAP = 8;

export class TimelineView extends BasesView {
  type = "timeline";
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  plugin: BaseBoardPlugin;
  public activeFilters: Set<string> = new Set();
  private zoomId: TimelineZoomId = "month";
  private zoomDurationMs = MONTH_MS;
  private pendingCurrentWindowAlignment = false;
  private suppressClickAfterPan = false;
  private visibleTasks: TimelineTask[] = [];

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    plugin: BaseBoardPlugin,
  ) {
    super(controller);
    this.scrollEl = scrollEl;
    this.plugin = plugin;
    this.containerEl = scrollEl.createDiv({ cls: "base-board-timeline" });
    this.zoomDurationMs = this.getSavedZoomDuration();
    this.zoomId = this.getZoomIdForDuration(this.zoomDurationMs);
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
    const previousScrollLeft = this.getCurrentTimelineScrollLeft();
    const previousScrollTop = this.getCurrentTimelineScrollTop();

    this.containerEl.empty();
    this.zoomDurationMs = this.getSavedZoomDuration();
    this.zoomId = this.getZoomIdForDuration(this.zoomDurationMs);

    const groupByProp = this.getGroupByProperty();
    if (!groupByProp) {
      this.renderPlaceholder(
        'Set "group by" to choose the task phase property.',
      );
      return;
    }

    const allTasks = this.getTasks(groupByProp);
    if (allTasks.length === 0) {
      this.renderPlaceholder("No tasks found for this timeline.");
      return;
    }

    this.renderToolbar(allTasks);

    const visibleTasks = this.filterTasks(allTasks);
    this.visibleTasks = visibleTasks;
    if (visibleTasks.length === 0) {
      this.renderPlaceholder("No tasks match the selected tag filters.");
      return;
    }

    const range = this.getTimelineRange(visibleTasks);
    const pools = this.getPools(visibleTasks);
    this.renderTimeline(pools, range, previousScrollLeft, previousScrollTop);
  }

  private getCurrentTimelineScrollLeft(): number {
    const timelineEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-timeline-viewport",
    );
    return timelineEl?.scrollLeft ?? 0;
  }

  private getCurrentTimelineScrollTop(): number {
    const timelineEl = this.containerEl.querySelector<HTMLElement>(
      ".base-board-timeline-viewport",
    );
    return timelineEl?.scrollTop ?? 0;
  }

  private renderPlaceholder(text: string): void {
    const placeholderEl = this.containerEl.createDiv({
      cls: "base-board-placeholder",
    });
    setIcon(
      placeholderEl.createSpan({ cls: "base-board-placeholder-icon" }),
      "lucide-chart-gantt",
    );
    placeholderEl.createEl("p", { text });
  }

  private renderToolbar(tasks: TimelineTask[]): void {
    const toolbarEl = this.containerEl.createDiv({
      cls: "base-board-timeline-toolbar",
    });

    const zoomEl = toolbarEl.createDiv({ cls: "base-board-timeline-zoom" });
    for (const zoomLevel of ZOOM_LEVELS) {
      const buttonEl = zoomEl.createEl("button", {
        cls: "base-board-timeline-zoom-btn",
        text: zoomLevel.label,
      });
      if (Math.abs(this.zoomDurationMs - zoomLevel.durationMs) < 1000) {
        buttonEl.addClass("is-active");
      }
      buttonEl.addEventListener("click", () => {
        this.setZoomDuration(zoomLevel.durationMs);
      });
    }

    this.renderFilterBar(toolbarEl, tasks);
  }

  private renderTimeline(
    pools: TimelinePool[],
    range: TimelineRange,
    previousScrollLeft: number,
    previousScrollTop: number,
  ): void {
    const timelineEl = this.containerEl.createDiv({
      cls: "base-board-timeline-viewport",
    });
    timelineEl.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        this.zoomByWheel(event);
      },
      { passive: false },
    );
    timelineEl.addEventListener("mousedown", (event: MouseEvent) => {
      this.startTimelinePan(event, timelineEl);
    });
    timelineEl.addEventListener(
      "click",
      (event: MouseEvent) => {
        if (!this.suppressClickAfterPan) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.suppressClickAfterPan = false;
      },
      true,
    );

    const contentEl = timelineEl.createDiv({
      cls: "base-board-timeline-content",
    });
    contentEl.style.setProperty(
      "--timeline-label-width",
      `${this.getLabelWidth()}px`,
    );
    const totalLanes = pools.reduce((sum, pool) => sum + pool.lanes.length, 0);
    const width = this.getTimelineWidth(range, timelineEl);
    contentEl.style.width = `${this.getLabelWidth() + width}px`;

    this.renderRuler(contentEl, range, width);

    const bodyEl = contentEl.createDiv({ cls: "base-board-timeline-body" });
    bodyEl.style.minHeight = `${
      totalLanes * (LANE_HEIGHT + LANE_GAP) + pools.length * POOL_HEADER_HEIGHT
    }px`;

    for (const pool of pools) {
      const poolEl = bodyEl.createDiv({ cls: "base-board-timeline-pool" });
      if (pool.id !== "tasks") {
        poolEl.createDiv({
          cls: "base-board-timeline-pool-title",
          text: pool.title,
        });
      }

      for (const lane of pool.lanes) {
        this.renderLane(poolEl, lane, range);
      }
    }

    if (this.pendingCurrentWindowAlignment) {
      this.pendingCurrentWindowAlignment = false;
      this.alignViewportToCurrentWindow(timelineEl);
    } else if (previousScrollLeft > 0 || previousScrollTop > 0) {
      this.restoreTimelineScroll(
        timelineEl,
        previousScrollLeft,
        previousScrollTop,
      );
    }
  }

  private renderRuler(
    contentEl: HTMLElement,
    range: TimelineRange,
    width: number,
  ): void {
    const rulerEl = contentEl.createDiv({ cls: "base-board-timeline-ruler" });
    rulerEl.createDiv({
      cls: "base-board-timeline-ruler-label",
      text: "Tasks",
    });
    const trackEl = rulerEl.createDiv({
      cls: "base-board-timeline-ruler-track",
    });
    trackEl.style.width = `${width}px`;
    const ticks = this.getTicks(range);

    for (const tick of ticks) {
      const left = this.getPercent(tick.at, range);
      const tickEl = trackEl.createDiv({ cls: "base-board-timeline-tick" });
      tickEl.addClass(
        tick.major
          ? "base-board-timeline-tick--major"
          : "base-board-timeline-tick--minor",
      );
      tickEl.style.left = `${left}%`;
      if (tick.label) tickEl.createSpan({ text: tick.label });
    }

    const gridEl = contentEl.createDiv({ cls: "base-board-timeline-grid" });
    gridEl.style.width = `${width}px`;
    for (const tick of ticks) {
      const left = this.getPercent(tick.at, range);
      const lineEl = gridEl.createDiv({ cls: "base-board-timeline-grid-line" });
      lineEl.addClass(
        tick.major
          ? "base-board-timeline-grid-line--major"
          : "base-board-timeline-grid-line--minor",
      );
      lineEl.style.left = `${left}%`;
    }
  }

  private renderLane(
    poolEl: HTMLElement,
    lane: TimelineLane,
    range: TimelineRange,
  ): void {
    const { task } = lane;
    const laneEl = poolEl.createDiv({ cls: "base-board-timeline-lane" });
    laneEl.style.setProperty("--timeline-depth", String(lane.depth));
    laneEl.style.setProperty("--timeline-indent", `${lane.depth * 18}px`);
    if (lane.depth > 0) laneEl.addClass("base-board-timeline-lane--nested");
    if (lane.hasChildren) {
      laneEl.addClass("base-board-timeline-lane--parent");
    }
    if (lane.depth === 0 && lane.hasChildren) {
      laneEl.addClass("base-board-timeline-lane--root-parent");
    }
    laneEl.setAttr("draggable", "false");
    laneEl.dataset.filePath = task.file.path;
    laneEl.addEventListener("mousedown", (event: MouseEvent) => {
      laneEl.setAttr(
        "draggable",
        event.ctrlKey || event.metaKey ? "true" : "false",
      );
    });
    laneEl.addEventListener("dragstart", (event: DragEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        laneEl.setAttr("draggable", "false");
        return;
      }
      event.dataTransfer?.setData(
        "text/base-board-timeline-card",
        task.file.path,
      );
      event.dataTransfer?.setData("text/plain", task.file.path);
      event.dataTransfer?.setDragImage(laneEl, 12, 12);
      laneEl.addClass("base-board-timeline-lane--dragging");
    });
    laneEl.addEventListener("dragend", () => {
      laneEl.setAttr("draggable", "false");
      laneEl.removeClass("base-board-timeline-lane--dragging");
      this.containerEl
        .querySelectorAll(".base-board-timeline-lane--drag-over")
        .forEach((element) =>
          element.removeClass("base-board-timeline-lane--drag-over"),
        );
    });
    laneEl.addEventListener("dragover", (event: DragEvent) => {
      if (!this.isTimelineLaneDrag(event)) return;
      event.preventDefault();
      laneEl.addClass("base-board-timeline-lane--drag-over");
    });
    laneEl.addEventListener("dragleave", () => {
      laneEl.removeClass("base-board-timeline-lane--drag-over");
    });
    laneEl.addEventListener("drop", (event: DragEvent) => {
      const draggedPath = event.dataTransfer?.getData(
        "text/base-board-timeline-card",
      );
      if (!draggedPath || draggedPath === task.file.path) return;
      event.preventDefault();
      laneEl.removeClass("base-board-timeline-lane--drag-over");
      void this.reorderTimelineLane(draggedPath, task.file.path);
    });

    const labelEl = laneEl.createDiv({ cls: "base-board-timeline-lane-label" });
    const resizeHandleEl = labelEl.createDiv({
      cls: "base-board-timeline-label-resize-handle",
    });
    resizeHandleEl.addEventListener("mousedown", (event: MouseEvent) => {
      this.startLabelResize(event);
    });

    if (lane.hasChildren && lane.depth > 0) {
      const markerEl = labelEl.createSpan({
        cls: "base-board-timeline-tree-marker",
      });
      setIcon(markerEl, "lucide-corner-down-right");
    }
    labelEl.createDiv({
      cls: "base-board-timeline-task-title",
      text: task.title,
    });

    labelEl.addEventListener("click", () => {
      void this.app.workspace.getLeaf(false).openFile(task.file);
    });

    const trackEl = laneEl.createDiv({ cls: "base-board-timeline-track" });
    for (const segment of lane.segments) {
      if (!this.segmentOverlapsRange(segment, range)) continue;
      const start = new Date(
        Math.max(segment.start.getTime(), range.start.getTime()),
      );
      const end = new Date(
        Math.min(segment.end.getTime(), range.end.getTime()),
      );
      const left = this.getPercent(start, range);
      const right = this.getPercent(end, range);
      const width = Math.max(right - left, 0.4);
      const status = this.getDisplayStatus(segment.status);

      const segmentEl = trackEl.createDiv({
        cls: "base-board-timeline-segment",
        text: status,
      });
      segmentEl.style.left = `${left}%`;
      segmentEl.style.width = `${width}%`;
      segmentEl.style.setProperty(
        "--timeline-status-color",
        getColumnColor(this.config, segment.status),
      );
      setTooltip(
        segmentEl,
        `${task.title}\n${status}\n${this.formatBusinessElapsed(segment.start, segment.end)}\n${segment.start.toLocaleString()} → ${segment.end.toLocaleString()}`,
      );
      segmentEl.addEventListener("click", () => {
        new CardDetailModal(this.app, task.file).open();
      });
    }
  }

  private getTasks(groupByProp: string): TimelineTask[] {
    const entries: BasesEntry[] = this.data?.data ?? [];
    const tasks: TimelineTask[] = [];

    for (const entry of entries) {
      const file = entry.file;
      if (!(file instanceof TFile)) continue;

      const currentStatus = this.getCurrentStatus(file, groupByProp);
      const events = this.getHistoryEvents(file, groupByProp);
      const segments = this.getSegments(file, events, currentStatus);
      tasks.push({
        entry,
        file,
        title: this.getTaskTitle(entry, file),
        currentStatus,
        tags: this.extractTagsFromFile(file),
        parentKey: this.getParentKey(file),
        timelineOrder: this.getTimelineOrder(file),
        segments,
      });
    }

    return tasks.sort((first, second) => {
      if (first.timelineOrder !== second.timelineOrder) {
        return first.timelineOrder - second.timelineOrder;
      }
      return first.title.localeCompare(second.title);
    });
  }

  private getTimelineOrder(file: TFile): number {
    const frontmatter = this.getFrontmatter(file);
    const value = frontmatter?.[TIMELINE_ORDER_PROPERTY];
    return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
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

  private getCurrentStatus(file: TFile, groupByProp: string): string | null {
    const frontmatter = this.getFrontmatter(file);
    const value = frontmatter?.[groupByProp];
    return this.normalizeStatus(value);
  }

  private getHistoryEvents(file: TFile, groupByProp: string): TimelineEvent[] {
    const propertyName =
      this.plugin.data_.transitionHistory.propertyName.trim();
    if (!propertyName) return [];

    const frontmatter = this.getFrontmatter(file);
    const rawHistory = frontmatter?.[propertyName];
    if (!Array.isArray(rawHistory)) return [];

    const events: TimelineEvent[] = [];
    const historyRecords: unknown[] = rawHistory as unknown[];
    for (const rawRecord of historyRecords) {
      if (!rawRecord || typeof rawRecord !== "object") continue;
      const record = rawRecord as TransitionHistoryRecord;
      if (
        typeof record.property === "string" &&
        record.property !== groupByProp
      ) {
        continue;
      }
      if (typeof record.at !== "string") continue;
      const at = new Date(record.at);
      if (Number.isNaN(at.getTime())) continue;
      events.push({
        from: this.normalizeStatus(record.from),
        to: this.normalizeStatus(record.to),
        at,
      });
    }

    return events.sort(
      (first, second) => first.at.getTime() - second.at.getTime(),
    );
  }

  private getSegments(
    file: TFile,
    events: TimelineEvent[],
    currentStatus: string | null,
  ): TimelineSegment[] {
    const now = new Date();
    if (events.length === 0) {
      return [
        {
          status: currentStatus,
          start: new Date(file.stat.ctime),
          end: now,
        },
      ];
    }

    const segments: TimelineSegment[] = [];
    const firstEvent = events[0];
    const createdAt = new Date(
      Math.min(file.stat.ctime, firstEvent.at.getTime()),
    );
    if (
      firstEvent.from !== null &&
      createdAt.getTime() < firstEvent.at.getTime()
    ) {
      segments.push({
        status: firstEvent.from,
        start: createdAt,
        end: firstEvent.at,
      });
    }

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      const event = events[eventIndex];
      const nextEvent = events[eventIndex + 1];
      segments.push({
        status: nextEvent ? event.to : (currentStatus ?? event.to),
        start: event.at,
        end: nextEvent?.at ?? now,
      });
    }

    return segments.filter(
      (segment) => segment.end.getTime() > segment.start.getTime(),
    );
  }

  private getTaskTitle(entry: BasesEntry, file: TFile): string {
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

  private extractTagsFromFile(file: TFile): string[] {
    const frontmatter = this.getFrontmatter(file);
    const tags = frontmatter?.tags ?? frontmatter?.tag;
    if (Array.isArray(tags)) {
      return tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => (tag.startsWith("#") ? tag.slice(1) : tag));
    }
    if (typeof tags === "string") {
      return tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag)
        .map((tag) => (tag.startsWith("#") ? tag.slice(1) : tag));
    }
    return [];
  }

  private getParentKey(file: TFile): string | null {
    const frontmatter = this.getFrontmatter(file);
    const value =
      frontmatter?.parent ??
      frontmatter?.parent_task ??
      frontmatter?.parentTask;
    return this.normalizeReference(value);
  }

  private getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter: unknown = cache?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? (frontmatter as Record<string, unknown>)
      : undefined;
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

  private filterTasks(tasks: TimelineTask[]): TimelineTask[] {
    if (this.activeFilters.size === 0) return tasks;
    return tasks.filter((task) =>
      Array.from(this.activeFilters).some((filter) =>
        task.tags.includes(filter),
      ),
    );
  }

  private getPools(tasks: TimelineTask[]): TimelinePool[] {
    const tasksByIdentity = new Map<string, TimelineTask>();
    for (const task of tasks) {
      for (const identity of this.getTaskIdentities(task)) {
        tasksByIdentity.set(identity, task);
      }
    }

    const nodesByPath = new Map<string, TimelineTreeNode>();
    for (const task of tasks) {
      nodesByPath.set(task.file.path, { task, children: [] });
    }

    const childPaths = new Set<string>();

    for (const task of tasks) {
      if (!task.parentKey) continue;
      const parent = tasksByIdentity.get(task.parentKey);
      if (!parent || parent.file.path === task.file.path) continue;

      const parentNode = nodesByPath.get(parent.file.path);
      const childNode = nodesByPath.get(task.file.path);
      if (!parentNode || !childNode) continue;

      parentNode.children.push(childNode);
      childPaths.add(task.file.path);
    }

    const roots: TimelineTreeNode[] = [];
    for (const task of tasks) {
      const node = nodesByPath.get(task.file.path);
      if (node && !childPaths.has(task.file.path)) roots.push(node);
    }

    return [
      {
        id: "tasks",
        title: "Tasks",
        lanes: this.flattenTimelineTree(this.sortTimelineNodes(roots), 0),
      },
    ];
  }

  private sortTimelineNodes(nodes: TimelineTreeNode[]): TimelineTreeNode[] {
    return nodes
      .sort((first, second) =>
        this.compareTimelineTasks(first.task, second.task),
      )
      .map((node) => ({
        task: node.task,
        children: this.sortTimelineNodes(node.children),
      }));
  }

  private flattenTimelineTree(
    nodes: TimelineTreeNode[],
    depth: number,
  ): TimelineLane[] {
    const lanes: TimelineLane[] = [];
    for (const node of nodes) {
      lanes.push({
        task: node.task,
        depth,
        hasChildren: node.children.length > 0,
        segments:
          node.children.length > 0
            ? this.getAggregateSegments(node)
            : node.task.segments,
      });
      lanes.push(...this.flattenTimelineTree(node.children, depth + 1));
    }
    return lanes;
  }

  private getAggregateSegments(node: TimelineTreeNode): TimelineSegment[] {
    const childSegments = this.getDescendantSegments(node);
    if (childSegments.length === 0) return node.task.segments;

    const startTime = Math.min(
      ...childSegments.map((segment) => segment.start.getTime()),
    );
    const endTime = Math.max(
      ...childSegments.map((segment) => segment.end.getTime()),
    );
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      return node.task.segments;
    }

    return [
      {
        status: node.task.currentStatus,
        start: new Date(startTime),
        end: new Date(endTime),
      },
    ];
  }

  private getDescendantSegments(node: TimelineTreeNode): TimelineSegment[] {
    const segments: TimelineSegment[] = [];
    for (const child of node.children) {
      segments.push(...child.task.segments);
      segments.push(...this.getDescendantSegments(child));
    }
    return segments;
  }

  private compareTimelineTasks(
    first: TimelineTask,
    second: TimelineTask,
  ): number {
    if (first.timelineOrder !== second.timelineOrder) {
      return first.timelineOrder - second.timelineOrder;
    }
    return first.title.localeCompare(second.title);
  }

  private getTaskIdentities(task: TimelineTask): string[] {
    return [
      task.file.path.replace(/\.md$/i, "").toLowerCase(),
      task.file.basename.toLowerCase(),
      task.title.toLowerCase(),
    ];
  }

  private async reorderTimelineLane(
    draggedPath: string,
    targetPath: string,
  ): Promise<void> {
    const orderedTasks = [...this.visibleTasks];
    const draggedIndex = orderedTasks.findIndex(
      (task) => task.file.path === draggedPath,
    );
    const targetIndex = orderedTasks.findIndex(
      (task) => task.file.path === targetPath,
    );
    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedTask] = orderedTasks.splice(draggedIndex, 1);
    orderedTasks.splice(targetIndex, 0, draggedTask);

    await Promise.all(
      orderedTasks.map((task, order) =>
        this.app.fileManager.processFrontMatter(
          task.file,
          (frontmatter: Record<string, unknown>) => {
            frontmatter[TIMELINE_ORDER_PROPERTY] = order;
          },
        ),
      ),
    );
    this.render();
  }

  private isTimelineLaneDrag(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes(
      "text/base-board-timeline-card",
    );
  }

  private zoomByWheel(event: WheelEvent): void {
    const step = this.getZoomStep(this.zoomDurationMs);
    const direction = event.deltaY > 0 ? 1 : -1;
    this.setZoomDuration(this.zoomDurationMs + step * direction);
  }

  private setZoomDuration(durationMs: number): void {
    this.zoomDurationMs = this.clampZoomDuration(durationMs);
    this.zoomId = this.getZoomIdForDuration(this.zoomDurationMs);
    this.pendingCurrentWindowAlignment = true;
    this.config?.set(CONFIG_KEY_TIMELINE_ZOOM_DURATION, this.zoomDurationMs);
    this.config?.set(CONFIG_KEY_TIMELINE_PRESET, this.zoomId);
    this.render();
  }

  private getSavedZoomDuration(): number {
    const savedDuration = this.config?.get(CONFIG_KEY_TIMELINE_ZOOM_DURATION);
    if (typeof savedDuration === "number" && Number.isFinite(savedDuration)) {
      return this.clampZoomDuration(savedDuration);
    }

    const savedPreset = this.config?.get(CONFIG_KEY_TIMELINE_PRESET);
    if (isTimelineZoomId(savedPreset)) {
      return getZoomDuration(savedPreset);
    }
    if (typeof savedPreset === "string" && LEGACY_ZOOM_DURATIONS[savedPreset]) {
      return this.clampZoomDuration(LEGACY_ZOOM_DURATIONS[savedPreset]);
    }
    return MONTH_MS;
  }

  private getZoomIdForDuration(durationMs: number): TimelineZoomId {
    const exact = ZOOM_LEVELS.find(
      (zoomLevel) => Math.abs(zoomLevel.durationMs - durationMs) < 1000,
    );
    return exact?.id ?? "month";
  }

  private clampZoomDuration(durationMs: number): number {
    return Math.max(DAY_MS, Math.min(40 * YEAR_MS, durationMs));
  }

  private getZoomStep(durationMs: number): number {
    if (durationMs < WEEK_MS) return DAY_MS;
    if (durationMs < MONTH_MS) return WEEK_MS;
    if (durationMs <= YEAR_MS) return MONTH_MS;
    return YEAR_MS;
  }

  private getLabelWidth(): number {
    const saved = this.config?.get(CONFIG_KEY_TIMELINE_LABEL_WIDTH);
    return typeof saved === "number"
      ? this.clampLabelWidth(saved)
      : DEFAULT_LABEL_WIDTH;
  }

  private setLabelWidth(width: number): void {
    const clampedWidth = this.clampLabelWidth(width);
    this.config?.set(CONFIG_KEY_TIMELINE_LABEL_WIDTH, clampedWidth);
    this.containerEl
      .querySelectorAll<HTMLElement>(".base-board-timeline-content")
      .forEach((contentEl) => {
        contentEl.style.setProperty(
          "--timeline-label-width",
          `${clampedWidth}px`,
        );
      });
  }

  private clampLabelWidth(width: number): number {
    return Math.max(MIN_LABEL_WIDTH, Math.min(MAX_LABEL_WIDTH, width));
  }

  private startLabelResize(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = this.getLabelWidth();

    const handlePointerMove = (moveEvent: MouseEvent) => {
      this.setLabelWidth(startWidth + moveEvent.clientX - startX);
    };
    const handlePointerUp = () => {
      activeDocument.removeEventListener("mousemove", handlePointerMove);
      activeDocument.removeEventListener("mouseup", handlePointerUp);
    };

    activeDocument.addEventListener("mousemove", handlePointerMove);
    activeDocument.addEventListener("mouseup", handlePointerUp);
  }

  private startTimelinePan(event: MouseEvent, timelineEl: HTMLElement): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    if (this.shouldIgnorePanTarget(event.target)) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const startScrollLeft = timelineEl.scrollLeft;
    const startScrollTop = timelineEl.scrollTop;
    let moved = false;

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;

      moved = true;
      timelineEl.addClass("base-board-timeline-viewport--panning");
      timelineEl.scrollLeft = startScrollLeft - deltaX;
      timelineEl.scrollTop = startScrollTop - deltaY;
      moveEvent.preventDefault();
    };

    const handlePointerUp = () => {
      activeDocument.removeEventListener("mousemove", handlePointerMove);
      activeDocument.removeEventListener("mouseup", handlePointerUp);
      timelineEl.removeClass("base-board-timeline-viewport--panning");
      if (moved) {
        this.suppressClickAfterPan = true;
        window.setTimeout(() => {
          this.suppressClickAfterPan = false;
        }, 0);
      }
    };

    activeDocument.addEventListener("mousemove", handlePointerMove);
    activeDocument.addEventListener("mouseup", handlePointerUp);
  }

  private shouldIgnorePanTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest(
        "button, input, textarea, select, .base-board-filter-pill, .base-board-filter-clear, .base-board-timeline-label-resize-handle",
      ),
    );
  }

  private restoreTimelineScroll(
    timelineEl: HTMLElement,
    scrollLeft: number,
    scrollTop: number,
  ): void {
    window.requestAnimationFrame(() => {
      timelineEl.scrollLeft = scrollLeft;
      timelineEl.scrollTop = scrollTop;
    });
  }

  private alignViewportToCurrentWindow(timelineEl: HTMLElement): void {
    window.requestAnimationFrame(() => {
      const chartWidth = Math.max(
        0,
        timelineEl.scrollWidth - this.getLabelWidth(),
      );
      const windowWidth = chartWidth / TIMELINE_TOTAL_WINDOWS;
      timelineEl.scrollLeft = Math.max(0, windowWidth * TIMELINE_PAST_WINDOWS);
    });
  }

  private getTimelineRange(tasks: TimelineTask[]): TimelineRange {
    return this.getTimelineRangeForDuration(tasks, this.zoomDurationMs);
  }

  private getTimelineRangeForDuration(
    tasks: TimelineTask[],
    durationMs: number,
  ): TimelineRange {
    const now = new Date();
    const endTime = this.roundTimelineEnd(now, durationMs);
    return {
      start: new Date(endTime - durationMs * (TIMELINE_PAST_WINDOWS + 1)),
      end: new Date(endTime + durationMs * TIMELINE_FUTURE_WINDOWS),
    };
  }

  private roundTimelineEnd(date: Date, durationMs: number): number {
    const rounded = new Date(date);
    if (durationMs <= 5 * DAY_MS) {
      rounded.setMinutes(0, 0, 0);
      if (rounded.getTime() < date.getTime()) {
        rounded.setHours(rounded.getHours() + 1);
      }
      return rounded.getTime();
    }

    if (durationMs <= 3 * 31 * DAY_MS) {
      rounded.setHours(0, 0, 0, 0);
      if (rounded.getTime() < date.getTime()) {
        rounded.setDate(rounded.getDate() + 1);
      }
      return rounded.getTime();
    }

    rounded.setDate(1);
    rounded.setHours(0, 0, 0, 0);
    if (rounded.getTime() < date.getTime()) {
      rounded.setMonth(rounded.getMonth() + 1);
    }
    return rounded.getTime();
  }

  private getSegmentTimes(tasks: TimelineTask[]): number[] {
    const times: number[] = [];
    for (const task of tasks) {
      for (const segment of task.segments) {
        times.push(segment.start.getTime(), segment.end.getTime());
      }
    }
    return times.length > 0 ? times : [Date.now()];
  }

  private getTimelineWidth(
    range: TimelineRange,
    timelineEl: HTMLElement,
  ): number {
    const chartWidth = Math.max(
      MIN_TIMELINE_WIDTH,
      timelineEl.clientWidth - this.getLabelWidth(),
    );
    return chartWidth * TIMELINE_TOTAL_WINDOWS;
  }

  private getTicks(range: TimelineRange): TimelineTick[] {
    if (this.zoomDurationMs <= 2 * DAY_MS) {
      return this.combineTicks(
        this.getDailyTicks(range, true),
        this.getHourIntervalTicks(range, 6),
      );
    }
    if (this.zoomDurationMs <= 3 * WEEK_MS) {
      return this.combineTicks(
        this.getWeeklyTicks(range, true),
        this.getDailyTicks(range, false),
      );
    }
    if (this.zoomDurationMs <= 2 * YEAR_MS) {
      return this.combineTicks(
        this.getMonthlyTicks(range, true),
        this.getWeeklyTicks(range, false, this.zoomDurationMs <= 6 * MONTH_MS),
      );
    }
    return this.combineTicks(
      this.getYearlyTicks(range, true),
      this.getMonthlyTicks(range, false),
    );
  }

  private combineTicks(
    majorTicks: TimelineTick[],
    minorTicks: TimelineTick[],
  ): TimelineTick[] {
    const majorTimes = new Set(
      majorTicks.map((tick) => this.toLocalDateOnly(tick.at).getTime()),
    );
    return [
      ...majorTicks,
      ...minorTicks.filter(
        (tick) => !majorTimes.has(this.toLocalDateOnly(tick.at).getTime()),
      ),
    ].sort((first, second) => first.at.getTime() - second.at.getTime());
  }

  private getHourIntervalTicks(
    range: TimelineRange,
    hours: number,
  ): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = new Date(range.start);
    cursor.setMinutes(0, 0, 0);
    if (cursor.getTime() < range.start.getTime())
      cursor.setHours(cursor.getHours() + hours);

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: "",
        major: false,
      });
      cursor.setHours(cursor.getHours() + hours);
    }
    return ticks;
  }

  private getDailyTicks(range: TimelineRange, major: boolean): TimelineTick[] {
    return this.getDayIntervalTicks(range, 1, major);
  }

  private getDayIntervalTicks(
    range: TimelineRange,
    days: number,
    major: boolean,
  ): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = new Date(range.start);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < range.start.getTime())
      cursor.setDate(cursor.getDate() + days);

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: cursor.toLocaleDateString([], {
          month: "short",
          day: "numeric",
        }),
        major,
      });
      cursor.setDate(cursor.getDate() + days);
    }
    return ticks;
  }

  private getWeeklyTicks(
    range: TimelineRange,
    major: boolean,
    showLabel = major,
  ): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = this.getWeekStart(range.start);
    if (cursor.getTime() < range.start.getTime()) {
      cursor.setDate(cursor.getDate() + 7);
    }

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: showLabel
          ? cursor.toLocaleDateString([], { month: "short", day: "numeric" })
          : "",
        major,
      });
      cursor.setDate(cursor.getDate() + 7);
    }
    return ticks;
  }

  private getWeekStart(date: Date): Date {
    const weekStartDay = this.plugin.data_.timeline.weekStartDay;
    const cursor = this.toLocalDateOnly(date);
    const delta = (cursor.getDay() - weekStartDay + 7) % 7;
    cursor.setDate(cursor.getDate() - delta);
    return cursor;
  }

  private getMonthlyTicks(
    range: TimelineRange,
    major: boolean,
  ): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = new Date(range.start);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < range.start.getTime())
      cursor.setMonth(cursor.getMonth() + 1);

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: cursor.toLocaleDateString([], {
          month: "short",
          year: "numeric",
        }),
        major,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return ticks;
  }

  private getYearlyTicks(range: TimelineRange, major: boolean): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = new Date(range.start);
    cursor.setMonth(0, 1);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < range.start.getTime()) {
      cursor.setFullYear(cursor.getFullYear() + 1);
    }

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: cursor.toLocaleDateString([], { year: "numeric" }),
        major,
      });
      cursor.setFullYear(cursor.getFullYear() + 1);
    }
    return ticks;
  }

  private getPercent(date: Date, range: TimelineRange): number {
    const duration = range.end.getTime() - range.start.getTime();
    if (duration <= 0) return 0;
    return ((date.getTime() - range.start.getTime()) / duration) * 100;
  }

  private formatBusinessElapsed(start: Date, end: Date): string {
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    if (durationMs < 24 * 60 * 60 * 1000) {
      return this.formatShortElapsed(durationMs);
    }

    const businessDays = this.countBusinessDaysInclusive(start, end);
    const weeks = Math.floor(businessDays / 5);
    const days = businessDays % 5;
    const parts: string[] = [];

    if (weeks > 0) {
      parts.push(`${weeks} ${weeks === 1 ? "week" : "weeks"}`);
    }
    if (days > 0 || parts.length === 0) {
      parts.push(`${days} ${days === 1 ? "day" : "days"}`);
    }

    return `(${parts.join(" ")})`;
  }

  private formatShortElapsed(durationMs: number): string {
    const totalMinutes = Math.max(1, Math.round(durationMs / (60 * 1000)));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];

    if (hours > 0) {
      parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
    }
    if (minutes > 0 || parts.length === 0) {
      parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
    }

    return `(${parts.join(" ")})`;
  }

  private countBusinessDaysInclusive(start: Date, end: Date): number {
    const firstDay = this.toLocalDateOnly(start);
    const lastDay = this.toLocalDateOnly(end);
    if (lastDay.getTime() < firstDay.getTime()) return 0;

    let businessDays = 0;
    const cursor = new Date(firstDay);
    while (cursor.getTime() <= lastDay.getTime()) {
      const day = cursor.getDay();
      if (day !== 0 && day !== 6) businessDays++;
      cursor.setDate(cursor.getDate() + 1);
    }
    return businessDays;
  }

  private toLocalDateOnly(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private segmentOverlapsRange(
    segment: TimelineSegment,
    range: TimelineRange,
  ): boolean {
    return (
      segment.end.getTime() >= range.start.getTime() &&
      segment.start.getTime() <= range.end.getTime()
    );
  }

  private normalizeStatus(value: unknown): string | null {
    if (value === undefined || value === null || value instanceof NullValue) {
      return null;
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return null;
  }

  private getDisplayStatus(status: string | null): string {
    return status ?? NO_VALUE_COLUMN;
  }

  private renderFilterBar(
    containerEl: HTMLElement,
    tasks: TimelineTask[],
  ): void {
    const allTags = new Set<string>();
    for (const task of tasks) {
      for (const tag of task.tags) allTags.add(tag);
    }

    if (allTags.size === 0 && this.activeFilters.size === 0) return;

    const filterEl = containerEl.createDiv({ cls: "base-board-filter-bar" });
    filterEl.addClass("base-board-timeline-filter-bar");
    const titleEl = filterEl.createSpan({
      cls: "base-board-filter-title",
      text: "Filters:",
    });
    setIcon(titleEl, "lucide-filter");

    const tags = Array.from(allTags).sort();
    for (const activeTag of this.activeFilters) {
      if (!allTags.has(activeTag)) tags.push(activeTag);
    }

    for (const tag of tags) {
      const pillEl = filterEl.createSpan({ cls: "base-board-filter-pill" });
      pillEl.textContent = tag;
      const color = this.getColorForTag(tag);
      pillEl.style.setProperty("--tag-color", color);
      if (relativeLuminance(color) === "dark") {
        pillEl.addClass("base-board-filter-pill-light");
      } else {
        pillEl.addClass("base-board-filter-pill-dark");
      }
      if (this.activeFilters.has(tag)) pillEl.addClass("is-active");

      setTooltip(pillEl, "Click to filter · Right-click to change color");
      pillEl.addEventListener("click", () => {
        if (this.activeFilters.has(tag)) {
          this.activeFilters.delete(tag);
        } else {
          this.activeFilters.add(tag);
        }
        this.render();
      });
      pillEl.addEventListener("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        new ColorPickerModal(this.app, tag, color, (newColor) => {
          this.setColor(tag, newColor);
        }).open();
      });
    }

    if (this.activeFilters.size > 0) {
      const clearEl = filterEl.createSpan({
        cls: "base-board-filter-clear",
        text: "Clear",
      });
      clearEl.addEventListener("click", () => {
        this.activeFilters.clear();
        this.render();
      });
    }
  }

  private getColors(): Record<string, string> {
    const raw = this.config?.get(CONFIG_KEY_TAG_COLORS);
    return raw && typeof raw === "object"
      ? (raw as Record<string, string>)
      : {};
  }

  private getColorForTag(tag: string): string {
    const colors = this.getColors();
    if (colors[tag]) return colors[tag];

    const defaults = [
      "#f87168",
      "#fbbc04",
      "#fcc934",
      "#34a853",
      "#4285f4",
      "#a142f4",
      "#f442a1",
      "#20c997",
      "#fd7e14",
      "#6f42c1",
    ];
    let hash = 0;
    for (let charIndex = 0; charIndex < tag.length; charIndex++) {
      hash = tag.charCodeAt(charIndex) + ((hash << 5) - hash);
    }
    return defaults[Math.abs(hash) % defaults.length] ?? defaults[0];
  }

  private setColor(tag: string, color: string): void {
    const colors = this.getColors();
    if (color) {
      colors[tag] = color;
    } else {
      delete colors[tag];
    }
    this.config?.set(CONFIG_KEY_TAG_COLORS, colors);
    this.render();
  }
}
