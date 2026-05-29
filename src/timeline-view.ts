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
  CONFIG_KEY_TIMELINE_PRESET,
  NO_VALUE_COLUMN,
  TIMELINE_ORDER_PROPERTY,
} from "./constants";
import { relativeLuminance } from "./color-utils";
import { ColorPickerModal } from "./tags";
import { getColumnColor } from "./status-colors";
import { CardDetailModal } from "./card-detail-modal";

type TimelinePreset = "day" | "week" | "month" | "semester" | "year" | "fit";

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
  lanes: TimelineTask[];
}

interface TimelineRange {
  start: Date;
  end: Date;
}

interface TimelineTick {
  at: Date;
  label: string;
}

const PRESETS: Array<{ id: TimelinePreset; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "semester", label: "Semester" },
  { id: "year", label: "Year" },
  { id: "fit", label: "Fit" },
];

function isTimelinePreset(value: unknown): value is TimelinePreset {
  return PRESETS.some((preset) => preset.id === value);
}

const PRESET_DURATIONS: Record<Exclude<TimelinePreset, "fit">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  semester: 182 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
};

const MIN_TIMELINE_WIDTH = 960;
const LANE_HEIGHT = 44;
const POOL_HEADER_HEIGHT = 34;
const LANE_GAP = 8;

export class TimelineView extends BasesView {
  type = "timeline";
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  plugin: BaseBoardPlugin;
  public activeFilters: Set<string> = new Set();
  private preset: TimelinePreset = "month";
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
    this.preset = this.getSavedPreset();
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
    this.containerEl.empty();
    this.preset = this.getSavedPreset();

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
    this.renderTimeline(pools, range);
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
    for (const preset of PRESETS) {
      const buttonEl = zoomEl.createEl("button", {
        cls: "base-board-timeline-zoom-btn",
        text: preset.label,
      });
      if (this.preset === preset.id) buttonEl.addClass("is-active");
      buttonEl.addEventListener("click", () => {
        this.setPreset(preset.id);
      });
    }

    this.renderFilterBar(toolbarEl, tasks);
  }

  private renderTimeline(pools: TimelinePool[], range: TimelineRange): void {
    const timelineEl = this.containerEl.createDiv({
      cls: "base-board-timeline-viewport",
    });
    timelineEl.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        this.zoomByWheel(event.deltaY);
      },
      { passive: false },
    );
    const contentEl = timelineEl.createDiv({
      cls: "base-board-timeline-content",
    });
    const totalLanes = pools.reduce((sum, pool) => sum + pool.lanes.length, 0);
    const width = this.getTimelineWidth(range);
    contentEl.style.width = `${width}px`;

    this.renderRuler(contentEl, range, width);

    const bodyEl = contentEl.createDiv({ cls: "base-board-timeline-body" });
    bodyEl.style.minHeight = `${
      totalLanes * (LANE_HEIGHT + LANE_GAP) + pools.length * POOL_HEADER_HEIGHT
    }px`;

    for (const pool of pools) {
      const poolEl = bodyEl.createDiv({ cls: "base-board-timeline-pool" });
      poolEl.createDiv({
        cls: "base-board-timeline-pool-title",
        text: pool.title,
      });

      for (const task of pool.lanes) {
        this.renderLane(poolEl, task, range);
      }
    }
  }

  private renderRuler(
    contentEl: HTMLElement,
    range: TimelineRange,
    width: number,
  ): void {
    const rulerEl = contentEl.createDiv({ cls: "base-board-timeline-ruler" });
    const ticks = this.getTicks(range);

    for (const tick of ticks) {
      const left = this.getPercent(tick.at, range);
      const tickEl = rulerEl.createDiv({ cls: "base-board-timeline-tick" });
      tickEl.style.left = `${left}%`;
      tickEl.createSpan({ text: tick.label });
    }

    const gridEl = contentEl.createDiv({ cls: "base-board-timeline-grid" });
    gridEl.style.width = `${width}px`;
    for (const tick of ticks) {
      const left = this.getPercent(tick.at, range);
      const lineEl = gridEl.createDiv({ cls: "base-board-timeline-grid-line" });
      lineEl.style.left = `${left}%`;
    }
  }

  private renderLane(
    poolEl: HTMLElement,
    task: TimelineTask,
    range: TimelineRange,
  ): void {
    const laneEl = poolEl.createDiv({ cls: "base-board-timeline-lane" });
    laneEl.setAttr("draggable", "true");
    laneEl.dataset.filePath = task.file.path;
    laneEl.addEventListener("dragstart", (event: DragEvent) => {
      event.dataTransfer?.setData(
        "text/base-board-timeline-card",
        task.file.path,
      );
      event.dataTransfer?.setData("text/plain", task.file.path);
      event.dataTransfer?.setDragImage(laneEl, 12, 12);
      laneEl.addClass("base-board-timeline-lane--dragging");
    });
    laneEl.addEventListener("dragend", () => {
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
    labelEl.createDiv({
      cls: "base-board-timeline-task-title",
      text: task.title,
    });

    if (task.tags.length > 0) {
      labelEl.createDiv({
        cls: "base-board-timeline-task-tags",
        text: task.tags.map((tag) => `#${tag}`).join(" "),
      });
    }

    labelEl.addEventListener("click", () => {
      void this.app.workspace.getLeaf(false).openFile(task.file);
    });

    const trackEl = laneEl.createDiv({ cls: "base-board-timeline-track" });
    for (const segment of task.segments) {
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
        `${task.title}\n${status}\n${segment.start.toLocaleString()} -> ${segment.end.toLocaleString()}`,
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

    const childrenByPoolId = new Map<string, TimelineTask[]>();
    const parentByPoolId = new Map<string, TimelineTask>();
    const childPaths = new Set<string>();

    for (const task of tasks) {
      if (!task.parentKey) continue;
      const parent = tasksByIdentity.get(task.parentKey);
      const poolId = parent ? parent.file.path : `external:${task.parentKey}`;
      if (parent) parentByPoolId.set(poolId, parent);
      const children = childrenByPoolId.get(poolId) ?? [];
      children.push(task);
      childrenByPoolId.set(poolId, children);
      childPaths.add(task.file.path);
    }

    const pools: TimelinePool[] = [];
    const parentPoolPaths = new Set<string>();
    for (const [poolId, children] of childrenByPoolId) {
      const parent = parentByPoolId.get(poolId);
      const lanes = parent ? [parent, ...children] : children;
      if (parent) parentPoolPaths.add(parent.file.path);
      pools.push({
        id: poolId,
        title: parent
          ? parent.title
          : `Parent: ${poolId.replace(/^external:/, "")}`,
        lanes: this.uniqueTasks(lanes),
      });
    }

    const unpooled = tasks.filter(
      (task) =>
        !childPaths.has(task.file.path) && !parentPoolPaths.has(task.file.path),
    );
    if (unpooled.length > 0) {
      pools.push({ id: "tasks", title: "Tasks", lanes: unpooled });
    }

    return pools.sort((first, second) =>
      first.title.localeCompare(second.title),
    );
  }

  private getTaskIdentities(task: TimelineTask): string[] {
    return [
      task.file.path.replace(/\.md$/i, "").toLowerCase(),
      task.file.basename.toLowerCase(),
      task.title.toLowerCase(),
    ];
  }

  private uniqueTasks(tasks: TimelineTask[]): TimelineTask[] {
    const seen = new Set<string>();
    const unique: TimelineTask[] = [];
    for (const task of tasks) {
      if (seen.has(task.file.path)) continue;
      seen.add(task.file.path);
      unique.push(task);
    }
    return unique;
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

  private zoomByWheel(deltaY: number): void {
    const presetIds = PRESETS.map((preset) => preset.id);
    const currentIndex = presetIds.indexOf(this.preset);
    const nextIndex = Math.max(
      0,
      Math.min(presetIds.length - 1, currentIndex + (deltaY > 0 ? 1 : -1)),
    );
    const nextPreset = presetIds[nextIndex];
    if (nextPreset && nextPreset !== this.preset) {
      this.setPreset(nextPreset);
    }
  }

  private setPreset(preset: TimelinePreset): void {
    this.preset = preset;
    this.config?.set(CONFIG_KEY_TIMELINE_PRESET, preset);
    this.render();
  }

  private getSavedPreset(): TimelinePreset {
    const saved = this.config?.get(CONFIG_KEY_TIMELINE_PRESET);
    return isTimelinePreset(saved) ? saved : "month";
  }

  private getTimelineRange(tasks: TimelineTask[]): TimelineRange {
    const now = new Date();
    if (this.preset !== "fit") {
      const duration = PRESET_DURATIONS[this.preset];
      return { start: new Date(now.getTime() - duration), end: now };
    }

    const times: number[] = [];
    for (const task of tasks) {
      for (const segment of task.segments) {
        times.push(segment.start.getTime(), segment.end.getTime());
      }
    }
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times, now.getTime());
    const padding = Math.max((maxTime - minTime) * 0.05, 60 * 60 * 1000);
    return {
      start: new Date(minTime - padding),
      end: new Date(maxTime + padding),
    };
  }

  private getTimelineWidth(range: TimelineRange): number {
    const hours = Math.max(
      (range.end.getTime() - range.start.getTime()) / (60 * 60 * 1000),
      1,
    );
    if (this.preset === "day") return Math.max(MIN_TIMELINE_WIDTH, hours * 72);
    if (this.preset === "week") return Math.max(MIN_TIMELINE_WIDTH, hours * 14);
    if (this.preset === "month") return Math.max(MIN_TIMELINE_WIDTH, hours * 4);
    if (this.preset === "semester")
      return Math.max(MIN_TIMELINE_WIDTH, hours * 1.2);
    if (this.preset === "year")
      return Math.max(MIN_TIMELINE_WIDTH, hours * 0.8);
    return Math.max(MIN_TIMELINE_WIDTH, hours * 3);
  }

  private getTicks(range: TimelineRange): TimelineTick[] {
    if (this.preset === "day") return this.getHourlyTicks(range);
    if (this.preset === "week" || this.preset === "month") {
      return this.getDailyTicks(range);
    }
    if (this.preset === "semester") return this.getDayIntervalTicks(range, 14);
    if (this.preset === "year") return this.getMonthlyTicks(range);

    const duration = range.end.getTime() - range.start.getTime();
    if (duration <= PRESET_DURATIONS.week) return this.getDailyTicks(range);
    if (duration <= PRESET_DURATIONS.semester) {
      return this.getDayIntervalTicks(range, 14);
    }
    return this.getMonthlyTicks(range);
  }

  private getHourlyTicks(range: TimelineRange): TimelineTick[] {
    const ticks: TimelineTick[] = [];
    const cursor = new Date(range.start);
    cursor.setMinutes(0, 0, 0);
    if (cursor.getTime() < range.start.getTime())
      cursor.setHours(cursor.getHours() + 1);

    while (cursor.getTime() <= range.end.getTime()) {
      ticks.push({
        at: new Date(cursor),
        label: cursor.toLocaleTimeString([], { hour: "numeric" }),
      });
      cursor.setHours(cursor.getHours() + 1);
    }
    return ticks;
  }

  private getDailyTicks(range: TimelineRange): TimelineTick[] {
    return this.getDayIntervalTicks(range, 1);
  }

  private getDayIntervalTicks(
    range: TimelineRange,
    days: number,
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
      });
      cursor.setDate(cursor.getDate() + days);
    }
    return ticks;
  }

  private getMonthlyTicks(range: TimelineRange): TimelineTick[] {
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
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return ticks;
  }

  private getPercent(date: Date, range: TimelineRange): number {
    const duration = range.end.getTime() - range.start.getTime();
    if (duration <= 0) return 0;
    return ((date.getTime() - range.start.getTime()) / duration) * 100;
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
