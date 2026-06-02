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
type TimelineZoomStopId =
  | "1d"
  | "2d"
  | "3d"
  | "4d"
  | "5d"
  | "1w"
  | "2w"
  | "3w"
  | "1mo"
  | "2mo"
  | "3mo"
  | "4mo"
  | "5mo"
  | "6mo"
  | "1y"
  | "2y"
  | "3y"
  | "4y"
  | "5y"
  | "10y"
  | "20y"
  | "40y";

interface TimelineZoomLevel {
  id: TimelineZoomId;
  label: string;
  stopId: TimelineZoomStopId;
}

interface TimelineZoomStop {
  id: TimelineZoomStopId;
  durationMs: number;
  ruler: TimelineRulerPolicy;
}

interface TimelineZoomAnchor {
  timeMs: number;
  chartViewportX: number;
  chartViewportWidth: number;
  scrollTop: number;
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

interface TimelineRulerModel {
  gridLines: TimelineGridLine[];
  labelBands: TimelineLabelBand[];
}

interface TimelineGridLine {
  at: Date;
  tier: TimelineGridLineTier;
}

interface TimelineLabelBand {
  start: Date;
  end: Date;
  labelCandidates: string[];
  row: TimelineLabelBandRow;
  labelFormat: TimelineLabelFormat;
}

interface TimelineLabelPlacement {
  startPercent: number;
  widthPercent: number;
  labelStartPx: number;
  labelEndPx: number;
  label: string;
}

interface TimelineRulerPolicy {
  gridUnit: TimelineCalendarUnit;
  gridEvery: number;
  gridLineTier: TimelineGridLineTier;
  majorGridUnit?: TimelineCalendarUnit;
  majorGridEvery?: number;
  majorLabelUnit: TimelineCalendarUnit;
  majorLabelEvery?: number;
  majorLabelFormat?: TimelineLabelFormat;
  minorLabelUnit?: TimelineCalendarUnit;
  minorLabelEvery?: number;
  minorLabelFormat?: TimelineLabelFormat;
}

type TimelineCalendarUnit = "hour" | "day" | "week" | "month" | "year";
type TimelineGridLineTier = "major" | "minor" | "subdivision";
type TimelineLabelBandRow = "major" | "minor";
type TimelineLabelFormat =
  | "auto"
  | "day-number"
  | "month-day"
  | "month-year"
  | "weekday-day";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 31 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const TIMELINE_BUILD_VERSION = "2026.06.02.19";
const COMPLETED_SEGMENT_TAIL_MIN_MS = 12 * 60 * 60 * 1000;
const COMPLETED_SEGMENT_TAIL_MAX_MS = 3 * DAY_MS;
const COMPLETED_SEGMENT_TAIL_RATIO = 0.1;

const TIMELINE_ZOOM_STOPS: TimelineZoomStop[] = [
  {
    id: "1d",
    durationMs: DAY_MS,
    ruler: {
      gridUnit: "hour",
      gridEvery: 1,
      gridLineTier: "minor",
      majorLabelUnit: "day",
      minorLabelUnit: "hour",
    },
  },
  {
    id: "2d",
    durationMs: 2 * DAY_MS,
    ruler: {
      gridUnit: "hour",
      gridEvery: 1,
      gridLineTier: "minor",
      majorLabelUnit: "day",
      minorLabelUnit: "hour",
    },
  },
  {
    id: "3d",
    durationMs: 3 * DAY_MS,
    ruler: {
      gridUnit: "hour",
      gridEvery: 6,
      gridLineTier: "minor",
      majorLabelUnit: "day",
    },
  },
  {
    id: "4d",
    durationMs: 4 * DAY_MS,
    ruler: {
      gridUnit: "hour",
      gridEvery: 6,
      gridLineTier: "minor",
      majorGridUnit: "week",
      majorLabelUnit: "week",
      majorLabelFormat: "month-year",
      minorLabelUnit: "day",
      minorLabelFormat: "weekday-day",
    },
  },
  {
    id: "5d",
    durationMs: 5 * DAY_MS,
    ruler: {
      gridUnit: "hour",
      gridEvery: 12,
      gridLineTier: "minor",
      majorGridUnit: "week",
      majorLabelUnit: "week",
      majorLabelFormat: "month-year",
      minorLabelUnit: "day",
      minorLabelFormat: "weekday-day",
    },
  },
  {
    id: "1w",
    durationMs: WEEK_MS,
    ruler: {
      gridUnit: "day",
      gridEvery: 1,
      gridLineTier: "minor",
      majorGridUnit: "week",
      majorLabelUnit: "week",
      majorLabelFormat: "month-year",
      minorLabelUnit: "day",
      minorLabelFormat: "weekday-day",
    },
  },
  {
    id: "2w",
    durationMs: 2 * WEEK_MS,
    ruler: {
      gridUnit: "day",
      gridEvery: 1,
      gridLineTier: "minor",
      majorGridUnit: "week",
      majorLabelUnit: "week",
      majorLabelFormat: "month-year",
      minorLabelUnit: "day",
      minorLabelFormat: "weekday-day",
    },
  },
  {
    id: "3w",
    durationMs: 3 * WEEK_MS,
    ruler: {
      gridUnit: "day",
      gridEvery: 1,
      gridLineTier: "minor",
      majorGridUnit: "week",
      majorLabelUnit: "week",
      majorLabelFormat: "month-year",
      minorLabelUnit: "day",
      minorLabelFormat: "weekday-day",
    },
  },
  ...(["1mo", "2mo", "3mo", "4mo", "5mo", "6mo"] as const).map(
    (id, index): TimelineZoomStop => ({
      id,
      durationMs: (index + 1) * MONTH_MS,
      ruler: {
        gridUnit: index < 2 ? "day" : "week",
        gridEvery: 1,
        gridLineTier: "minor",
        majorGridUnit: index < 2 ? "week" : "month",
        majorLabelUnit: index < 2 ? "week" : "month",
        majorLabelFormat: "month-year",
        minorLabelUnit: index < 2 ? "day" : undefined,
        minorLabelEvery: 1,
        minorLabelFormat: "day-number",
      },
    }),
  ),
  ...(["1y", "2y", "3y", "4y", "5y"] as const).map(
    (id, index): TimelineZoomStop => ({
      id,
      durationMs: (index + 1) * YEAR_MS,
      ruler: {
        gridUnit: "month",
        gridEvery: 1,
        gridLineTier: "minor",
        majorGridUnit: "year",
        majorLabelUnit: "year",
        minorLabelUnit: index < 2 ? "month" : undefined,
      },
    }),
  ),
  {
    id: "10y",
    durationMs: 10 * YEAR_MS,
    ruler: {
      gridUnit: "year",
      gridEvery: 1,
      gridLineTier: "minor",
      majorLabelUnit: "year",
    },
  },
  {
    id: "20y",
    durationMs: 20 * YEAR_MS,
    ruler: {
      gridUnit: "year",
      gridEvery: 2,
      gridLineTier: "minor",
      majorLabelUnit: "year",
      majorLabelEvery: 2,
    },
  },
  {
    id: "40y",
    durationMs: 40 * YEAR_MS,
    ruler: {
      gridUnit: "year",
      gridEvery: 5,
      gridLineTier: "minor",
      majorLabelUnit: "year",
      majorLabelEvery: 5,
    },
  },
];

const ZOOM_LEVELS: TimelineZoomLevel[] = [
  { id: "day", label: "Day", stopId: "1d" },
  { id: "week", label: "Week", stopId: "1w" },
  { id: "month", label: "Month", stopId: "1mo" },
  { id: "year", label: "Year", stopId: "1y" },
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

const WHEEL_ZOOM_DURATIONS = TIMELINE_ZOOM_STOPS.map(
  (zoomStop) => zoomStop.durationMs,
);

function isTimelineZoomId(value: unknown): value is TimelineZoomId {
  return ZOOM_LEVELS.some((zoomLevel) => zoomLevel.id === value);
}

function getZoomDuration(id: TimelineZoomId): number {
  const stopId = ZOOM_LEVELS.find((zoomLevel) => zoomLevel.id === id)?.stopId;
  return getZoomStopById(stopId ?? "1mo").durationMs;
}

function getZoomStopById(id: TimelineZoomStopId): TimelineZoomStop {
  return (
    TIMELINE_ZOOM_STOPS.find((zoomStop) => zoomStop.id === id) ??
    TIMELINE_ZOOM_STOPS[8]
  );
}

const DEFAULT_LABEL_WIDTH = 240;
const MIN_LABEL_WIDTH = 180;
const MAX_LABEL_WIDTH = 520;
const LANE_HEIGHT = 28;
const POOL_HEADER_HEIGHT = 28;
const LANE_GAP = 0;

export class TimelineView extends BasesView {
  type = "timeline";
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  plugin: BaseBoardPlugin;
  public activeFilters: Set<string> = new Set();
  private zoomId: TimelineZoomId = "month";
  private zoomDurationMs = MONTH_MS;
  private pendingZoomAnchor: TimelineZoomAnchor | null = null;
  private renderedTimelineRange: TimelineRange | null = null;
  private viewportStartMs: number | null = null;
  private pendingTimelineScrollTop: number | null = null;
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
    const previousScrollTop = this.getCurrentTimelineScrollTop();

    this.containerEl.empty();
    if (!this.hasPendingZoomRender()) {
      this.zoomDurationMs = this.getSavedZoomDuration();
    }
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
    this.renderedTimelineRange = range;
    const pools = this.getPools(visibleTasks);
    this.renderTimeline(pools, range, previousScrollTop);
  }

  private hasPendingZoomRender(): boolean {
    return Boolean(this.pendingZoomAnchor);
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
      const zoomStop = getZoomStopById(zoomLevel.stopId);
      const buttonEl = zoomEl.createEl("button", {
        cls: "base-board-timeline-zoom-btn",
        text: zoomLevel.label,
      });
      if (Math.abs(this.zoomDurationMs - zoomStop.durationMs) < 1000) {
        buttonEl.addClass("is-active");
      }
      buttonEl.addEventListener("click", () => {
        this.setZoomDuration(zoomStop.durationMs);
      });
    }
    zoomEl.createSpan({
      cls: "base-board-timeline-build-version",
      text: `v${TIMELINE_BUILD_VERSION}`,
    });
    const tickDebugEl = zoomEl.createSpan({
      cls: "base-board-timeline-build-version base-board-timeline-zoom-tick-debug",
      text: this.getWheelZoomTickDebugText(this.zoomDurationMs),
    });
    setTooltip(
      tickDebugEl,
      "Wheel zoom tick bounds and current level for debugging ruler spacing.",
    );

    this.renderFilterBar(toolbarEl, tasks);
  }

  private renderTimeline(
    pools: TimelinePool[],
    range: TimelineRange,
    previousScrollTop: number,
  ): void {
    this.pendingZoomAnchor = null;

    const timelineEl = this.containerEl.createDiv({
      cls: "base-board-timeline-viewport",
    });
    timelineEl.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        this.zoomByWheel(event, timelineEl);
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
    const totalPoolHeaders = pools.filter((pool) => pool.id !== "tasks").length;
    const width = this.getTimelineWidth(range, timelineEl);
    contentEl.style.width = `${this.getLabelWidth() + width}px`;

    this.renderRuler(contentEl, range, width);

    const bodyEl = contentEl.createDiv({ cls: "base-board-timeline-body" });
    bodyEl.style.minHeight = `${
      totalLanes * (LANE_HEIGHT + LANE_GAP) +
      totalPoolHeaders * POOL_HEADER_HEIGHT
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

    const scrollTop = this.pendingTimelineScrollTop ?? previousScrollTop;
    this.pendingTimelineScrollTop = null;
    this.restoreTimelineScroll(timelineEl, scrollTop);
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
    const ruler = this.getRulerModel(range, width);

    for (const gridLine of ruler.gridLines) {
      if (gridLine.tier !== "major") continue;
      this.renderRulerGridLine(trackEl, gridLine, range);
    }

    const majorLabelRowEl = trackEl.createDiv({
      cls: "base-board-timeline-label-row base-board-timeline-label-row--major",
    });
    const minorLabelRowEl = trackEl.createDiv({
      cls: "base-board-timeline-label-row base-board-timeline-label-row--minor",
    });
    this.renderRulerLabelBands(
      majorLabelRowEl,
      ruler.labelBands.filter((labelBand) => labelBand.row === "major"),
      range,
      width,
    );
    this.renderRulerLabelBands(
      minorLabelRowEl,
      ruler.labelBands.filter((labelBand) => labelBand.row === "minor"),
      range,
      width,
    );

    const gridEl = contentEl.createDiv({ cls: "base-board-timeline-grid" });
    gridEl.style.width = `${width}px`;
    for (const gridLine of ruler.gridLines) {
      this.renderBodyGridLine(gridEl, gridLine, range);
    }
  }

  private getRulerModel(
    range: TimelineRange,
    width: number,
  ): TimelineRulerModel {
    const ruler = this.getRulerPolicy();
    return {
      gridLines: this.getRulerGridLines(range, ruler),
      labelBands: this.getRulerLabelBands(range, ruler),
    };
  }

  private getRulerGridLines(
    range: TimelineRange,
    ruler: TimelineRulerPolicy,
  ): TimelineGridLine[] {
    const linesByTime = new Map<number, TimelineGridLine>();

    for (const at of this.getCalendarBoundaries(
      range,
      ruler.gridUnit,
      ruler.gridEvery,
    )) {
      linesByTime.set(at.getTime(), { at, tier: ruler.gridLineTier });
    }

    if (ruler.majorGridUnit) {
      for (const at of this.getCalendarBoundaries(
        range,
        ruler.majorGridUnit,
        ruler.majorGridEvery ?? 1,
      )) {
        linesByTime.set(at.getTime(), { at, tier: "major" });
      }
    }

    return Array.from(linesByTime.values()).sort(
      (first, second) => first.at.getTime() - second.at.getTime(),
    );
  }

  private renderRulerGridLine(
    trackEl: HTMLElement,
    gridLine: TimelineGridLine,
    range: TimelineRange,
  ): void {
    const lineEl = trackEl.createDiv({ cls: "base-board-timeline-tick" });
    lineEl.addClass(`base-board-timeline-tick--${gridLine.tier}`);
    lineEl.style.left = `${this.getPercent(gridLine.at, range)}%`;
  }

  private renderBodyGridLine(
    gridEl: HTMLElement,
    gridLine: TimelineGridLine,
    range: TimelineRange,
  ): void {
    const lineEl = gridEl.createDiv({ cls: "base-board-timeline-grid-line" });
    lineEl.addClass(`base-board-timeline-grid-line--${gridLine.tier}`);
    lineEl.style.left = `${this.getPercent(gridLine.at, range)}%`;
  }

  private renderRulerLabelBands(
    rowEl: HTMLElement,
    labelBands: TimelineLabelBand[],
    range: TimelineRange,
    width: number,
  ): void {
    const placements: TimelineLabelPlacement[] = [];
    const sortedBands = this.getConsistentRulerLabelBands(
      labelBands,
      range,
      width,
    ).sort((first, second) => first.start.getTime() - second.start.getTime());

    for (const labelBand of sortedBands) {
      const placement = this.getRulerLabelPlacement(
        labelBand,
        range,
        width,
        placements,
      );
      if (!placement) continue;

      const labelEl = rowEl.createSpan({
        cls: "base-board-timeline-label-band",
        text: placement.label,
      });
      labelEl.style.left = `${placement.startPercent}%`;
      labelEl.style.width = `${placement.widthPercent}%`;
      placements.push(placement);
    }
  }

  private getConsistentRulerLabelBands(
    labelBands: TimelineLabelBand[],
    range: TimelineRange,
    width: number,
  ): TimelineLabelBand[] {
    if (
      labelBands.length === 0 ||
      !labelBands.every((labelBand) => labelBand.labelFormat === "weekday-day")
    ) {
      return [...labelBands];
    }

    const longLabelBands = labelBands.map((labelBand) => ({
      ...labelBand,
      labelCandidates: labelBand.labelCandidates.slice(0, 1),
    }));
    if (this.canPlaceAllRulerLabelBands(longLabelBands, range, width)) {
      return longLabelBands;
    }

    return labelBands.map((labelBand) => ({
      ...labelBand,
      labelCandidates: [
        labelBand.labelCandidates[1] ?? labelBand.labelCandidates[0],
      ],
    }));
  }

  private canPlaceAllRulerLabelBands(
    labelBands: TimelineLabelBand[],
    range: TimelineRange,
    width: number,
  ): boolean {
    const placements: TimelineLabelPlacement[] = [];
    const sortedBands = [...labelBands].sort(
      (first, second) => first.start.getTime() - second.start.getTime(),
    );

    for (const labelBand of sortedBands) {
      const placement = this.getRulerLabelPlacement(
        labelBand,
        range,
        width,
        placements,
      );
      if (!placement) return false;
      placements.push(placement);
    }

    return true;
  }

  private getRulerLabelPlacement(
    labelBand: TimelineLabelBand,
    range: TimelineRange,
    width: number,
    existingPlacements: TimelineLabelPlacement[],
  ): TimelineLabelPlacement | null {
    const visibleStart = Math.max(
      labelBand.start.getTime(),
      range.start.getTime(),
    );
    const visibleEnd = Math.min(labelBand.end.getTime(), range.end.getTime());
    if (visibleEnd <= visibleStart) return null;

    const startPercent = this.getPercent(new Date(visibleStart), range);
    const endPercent = this.getPercent(new Date(visibleEnd), range);
    const bandWidthPx = ((endPercent - startPercent) / 100) * width;
    const startPx = (startPercent / 100) * width;
    const endPx = (endPercent / 100) * width;
    const centerPx = startPx + (endPx - startPx) / 2;
    for (const label of labelBand.labelCandidates) {
      const requiredWidthPx = this.getEstimatedRulerLabelWidth(label);
      if (bandWidthPx < requiredWidthPx) continue;

      const labelGapPx = this.getRulerLabelGapPx(label);
      const labelStartPx = centerPx - requiredWidthPx / 2 - labelGapPx;
      const labelEndPx = centerPx + requiredWidthPx / 2 + labelGapPx;
      const collides = existingPlacements.some(
        (placement) =>
          placement.labelStartPx < labelEndPx &&
          placement.labelEndPx > labelStartPx,
      );
      if (collides) continue;

      return {
        startPercent,
        widthPercent: endPercent - startPercent,
        labelStartPx,
        labelEndPx,
        label,
      };
    }

    return null;
  }

  private getEstimatedRulerLabelWidth(label: string): number {
    if (/^\d{1,2}$/.test(label)) return label.length * 7 + 4;
    return Math.min(160, label.length * 7.5 + 18);
  }

  private getRulerLabelGapPx(label: string): number {
    if (/^\d{1,2}$/.test(label)) return 1;
    return 8;
  }

  private getRulerLabelBands(
    range: TimelineRange,
    ruler: TimelineRulerPolicy,
  ): TimelineLabelBand[] {
    const bands = this.getCalendarLabelBands(
      range,
      ruler.majorLabelUnit,
      "major",
      ruler.majorLabelEvery ?? 1,
      ruler.majorLabelFormat,
    );
    if (ruler.minorLabelUnit) {
      bands.push(
        ...this.getCalendarLabelBands(
          range,
          ruler.minorLabelUnit,
          "minor",
          ruler.minorLabelEvery ?? 1,
          ruler.minorLabelFormat,
        ),
      );
    }
    return bands;
  }

  private getRulerPolicy(): TimelineRulerPolicy {
    return this.getActiveZoomStop().ruler;
  }

  private getCalendarLabelBands(
    range: TimelineRange,
    unit: TimelineCalendarUnit,
    row: TimelineLabelBandRow,
    every = 1,
    labelFormat: TimelineLabelFormat = "auto",
  ): TimelineLabelBand[] {
    const bands: TimelineLabelBand[] = [];
    const cursor = this.getCalendarBoundaryOnOrBefore(range.start, unit);

    while (cursor.getTime() < range.end.getTime()) {
      const end = this.addCalendarUnit(cursor, unit);
      if (this.shouldUseCalendarBoundary(cursor, unit, every)) {
        const labelEnd = this.addCalendarUnits(cursor, unit, every);
        bands.push({
          start: new Date(cursor),
          end: labelEnd,
          labelCandidates: this.getCalendarLabelCandidates(
            cursor,
            unit,
            labelFormat,
            labelEnd,
          ),
          row,
          labelFormat,
        });
      }
      cursor.setTime(end.getTime());
    }

    return bands;
  }

  private getCalendarBoundaries(
    range: TimelineRange,
    unit: TimelineCalendarUnit,
    every = 1,
  ): Date[] {
    const boundaries: Date[] = [];
    const cursor = this.getCalendarBoundaryOnOrBefore(range.start, unit);

    while (cursor.getTime() <= range.end.getTime()) {
      if (
        cursor.getTime() >= range.start.getTime() &&
        this.shouldUseCalendarBoundary(cursor, unit, every)
      ) {
        boundaries.push(new Date(cursor));
      }
      this.advanceCalendarCursor(cursor, unit);
    }

    return boundaries;
  }

  private getCalendarBoundaryOnOrBefore(
    date: Date,
    unit: TimelineCalendarUnit,
  ): Date {
    if (unit === "hour") {
      const cursor = new Date(date);
      cursor.setMinutes(0, 0, 0);
      return cursor;
    }
    if (unit === "day") {
      return this.toLocalDateOnly(date);
    }
    if (unit === "week") {
      return this.getWeekStart(date);
    }
    if (unit === "month") {
      return new Date(date.getFullYear(), date.getMonth(), 1);
    }
    return new Date(date.getFullYear(), 0, 1);
  }

  private advanceCalendarCursor(
    cursor: Date,
    unit: TimelineCalendarUnit,
  ): void {
    if (unit === "hour") {
      cursor.setHours(cursor.getHours() + 1);
    } else if (unit === "day") {
      cursor.setDate(cursor.getDate() + 1);
    } else if (unit === "week") {
      cursor.setDate(cursor.getDate() + 7);
    } else if (unit === "month") {
      cursor.setMonth(cursor.getMonth() + 1);
    } else {
      cursor.setFullYear(cursor.getFullYear() + 1);
    }
  }

  private addCalendarUnit(date: Date, unit: TimelineCalendarUnit): Date {
    const nextDate = new Date(date);
    this.advanceCalendarCursor(nextDate, unit);
    return nextDate;
  }

  private addCalendarUnits(
    date: Date,
    unit: TimelineCalendarUnit,
    count: number,
  ): Date {
    const nextDate = new Date(date);
    for (let index = 0; index < count; index++) {
      this.advanceCalendarCursor(nextDate, unit);
    }
    return nextDate;
  }

  private shouldUseCalendarBoundary(
    date: Date,
    unit: TimelineCalendarUnit,
    every: number,
  ): boolean {
    if (every <= 1) return true;

    if (unit === "hour") return date.getHours() % every === 0;
    if (unit === "day")
      return Math.floor(date.getTime() / DAY_MS) % every === 0;
    if (unit === "week") {
      return (
        Math.floor(this.toLocalDateOnly(date).getTime() / WEEK_MS) % every === 0
      );
    }
    if (unit === "month") {
      return (date.getFullYear() * 12 + date.getMonth()) % every === 0;
    }
    return date.getFullYear() % every === 0;
  }

  private getCalendarLabelCandidates(
    date: Date,
    unit: TimelineCalendarUnit,
    format: TimelineLabelFormat = "auto",
    end?: Date,
  ): string[] {
    if (format === "day-number") return [String(date.getDate())];
    if (format === "month-day") {
      return [date.toLocaleDateString([], { month: "short", day: "numeric" })];
    }
    if (format === "month-year") {
      return [this.getMonthYearLabel(date, end)];
    }
    if (format === "weekday-day") {
      return [
        `${date.toLocaleDateString([], { weekday: "long" })} ${date.getDate()}`,
        `${date.toLocaleDateString([], { weekday: "short" })} ${date.getDate()}`,
      ];
    }

    if (unit === "hour") {
      const hour = date.getHours();
      const hour12 = hour % 12 || 12;
      return this.uniqueLabels([
        date.toLocaleTimeString([], { hour: "numeric" }),
        String(hour12),
      ]);
    }
    if (unit === "day") {
      return this.uniqueLabels([
        date.toLocaleDateString([], { month: "short", day: "numeric" }),
        String(date.getDate()),
      ]);
    }
    if (unit === "week") {
      return [];
    }
    if (unit === "month") {
      return this.uniqueLabels([
        date.toLocaleDateString([], { month: "long", year: "numeric" }),
        date.toLocaleDateString([], { month: "long" }),
        date.toLocaleDateString([], { month: "short" }),
      ]);
    }
    return [date.toLocaleDateString([], { year: "numeric" })];
  }

  private getMonthYearLabel(start: Date, end?: Date): string {
    if (!end) {
      return start.toLocaleDateString([], { month: "long", year: "numeric" });
    }

    const inclusiveEnd = this.addDays(end, -1);
    if (
      start.getFullYear() === inclusiveEnd.getFullYear() &&
      start.getMonth() === inclusiveEnd.getMonth()
    ) {
      return start.toLocaleDateString([], { month: "long", year: "numeric" });
    }

    if (start.getFullYear() === inclusiveEnd.getFullYear()) {
      return `${start.toLocaleDateString([], { month: "long" })}/${inclusiveEnd.toLocaleDateString([], { month: "long" })} ${start.getFullYear()}`;
    }

    return `${start.toLocaleDateString([], { month: "long", year: "numeric" })}/${inclusiveEnd.toLocaleDateString([], { month: "long", year: "numeric" })}`;
  }

  private uniqueLabels(labels: string[]): string[] {
    return Array.from(new Set(labels.filter((label) => label.length > 0)));
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
      const start = new Date(file.stat.ctime);
      const end = this.isCompletedStatus(currentStatus)
        ? this.getCompletedSegmentEnd(start, new Date(file.stat.mtime))
        : now;
      return [
        {
          status: currentStatus,
          start,
          end,
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
      const status = nextEvent ? event.to : (currentStatus ?? event.to);
      segments.push({
        status,
        start: event.at,
        end:
          nextEvent?.at ??
          (this.isCompletedStatus(status)
            ? this.getCompletedSegmentEnd(createdAt, event.at)
            : now),
      });
    }

    return segments.filter(
      (segment) => segment.end.getTime() > segment.start.getTime(),
    );
  }

  private isCompletedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "completed" || normalizedStatus === "done";
  }

  private getCompletedSegmentEnd(workflowStart: Date, completedAt: Date): Date {
    const workflowDurationMs = Math.max(
      0,
      completedAt.getTime() - workflowStart.getTime(),
    );
    const tailMs = Math.max(
      COMPLETED_SEGMENT_TAIL_MIN_MS,
      Math.min(
        COMPLETED_SEGMENT_TAIL_MAX_MS,
        workflowDurationMs * COMPLETED_SEGMENT_TAIL_RATIO,
      ),
    );
    return new Date(completedAt.getTime() + tailMs);
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

    const sortedRoots = this.sortTimelineNodes(roots);
    const pools: TimelinePool[] = [];
    const standaloneRoots: TimelineTreeNode[] = [];

    for (const root of sortedRoots) {
      if (root.children.length === 0) {
        standaloneRoots.push(root);
        continue;
      }

      pools.push({
        id: root.task.file.path,
        title: root.task.title,
        lanes: this.flattenTimelineTree(root.children, 1),
      });
    }

    if (standaloneRoots.length > 0) {
      pools.push({
        id: "tasks",
        title: "Tasks",
        lanes: this.flattenTimelineTree(standaloneRoots, 0),
      });
    }

    return pools;
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

  private zoomByWheel(event: WheelEvent, timelineEl: HTMLElement): void {
    const direction = event.deltaY > 0 ? 1 : -1;
    const nextDuration = this.getNextWheelZoomDuration(
      this.zoomDurationMs,
      direction,
    );
    if (Math.abs(nextDuration - this.zoomDurationMs) < 1000) return;

    const anchor = this.getWheelZoomAnchor(event, timelineEl);
    if (anchor) {
      this.viewportStartMs =
        anchor.timeMs -
        (anchor.chartViewportX / anchor.chartViewportWidth) * nextDuration;
      this.pendingTimelineScrollTop = anchor.scrollTop;
    }

    this.setZoomDuration(nextDuration, {
      alignToCurrentWindow: false,
      anchor,
    });
  }

  private setZoomDuration(
    durationMs: number,
    options: {
      alignToCurrentWindow?: boolean;
      anchor?: TimelineZoomAnchor | null;
    } = {},
  ): void {
    this.zoomDurationMs = this.clampZoomDuration(durationMs);
    this.zoomId = this.getZoomIdForDuration(this.zoomDurationMs);
    this.pendingZoomAnchor = options.anchor ?? null;
    if (!this.pendingZoomAnchor && (options.alignToCurrentWindow ?? true)) {
      this.viewportStartMs = this.getDefaultViewportStartMs(
        this.zoomDurationMs,
      );
    }
    this.config?.set(CONFIG_KEY_TIMELINE_ZOOM_DURATION, this.zoomDurationMs);
    this.config?.set(CONFIG_KEY_TIMELINE_PRESET, this.zoomId);
    this.render();
  }

  private getWheelZoomAnchor(
    event: WheelEvent,
    timelineEl: HTMLElement,
  ): TimelineZoomAnchor | null {
    if (this.visibleTasks.length === 0) return null;

    const range =
      this.renderedTimelineRange ?? this.getTimelineRange(this.visibleTasks);
    const width = this.getTimelineWidth(range, timelineEl);
    const duration = range.end.getTime() - range.start.getTime();
    if (width <= 0 || duration <= 0) return null;

    const viewportRect = timelineEl.getBoundingClientRect();
    const labelWidth = this.getLabelWidth();
    const rawViewportX = event.clientX - viewportRect.left;
    const chartViewportWidth = this.getTimelineWidth(range, timelineEl);
    if (chartViewportWidth <= 0) return null;

    const chartViewportX = Math.min(
      Math.max(rawViewportX - labelWidth, 0),
      chartViewportWidth,
    );
    const chartX = Math.max(0, Math.min(width, chartViewportX));
    const cursorTimeMs = range.start.getTime() + (chartX / width) * duration;

    return {
      timeMs: cursorTimeMs,
      chartViewportX,
      chartViewportWidth,
      scrollTop: timelineEl.scrollTop,
    };
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
      (zoomLevel) =>
        Math.abs(getZoomStopById(zoomLevel.stopId).durationMs - durationMs) <
        1000,
    );
    return exact?.id ?? "month";
  }

  private getActiveZoomStop(): TimelineZoomStop {
    return TIMELINE_ZOOM_STOPS[
      this.getNearestWheelZoomIndex(this.zoomDurationMs)
    ];
  }

  private clampZoomDuration(durationMs: number): number {
    return Math.max(DAY_MS, Math.min(40 * YEAR_MS, durationMs));
  }

  private getNextWheelZoomDuration(
    durationMs: number,
    direction: number,
  ): number {
    const currentIndex = this.getNearestWheelZoomIndex(durationMs);
    const nextIndex = Math.max(
      0,
      Math.min(WHEEL_ZOOM_DURATIONS.length - 1, currentIndex + direction),
    );
    return WHEEL_ZOOM_DURATIONS[nextIndex];
  }

  private getNearestWheelZoomIndex(durationMs: number): number {
    const clampedDuration = this.clampZoomDuration(durationMs);
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < WHEEL_ZOOM_DURATIONS.length; index++) {
      const distance = Math.abs(WHEEL_ZOOM_DURATIONS[index] - clampedDuration);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    return nearestIndex;
  }

  private getWheelZoomTickDebugText(durationMs: number): string {
    const currentIndex = this.getNearestWheelZoomIndex(durationMs);
    const minimumIndex = 0;
    const maximumIndex = TIMELINE_ZOOM_STOPS.length - 1;
    return (
      `ticks min ${minimumIndex}=${TIMELINE_ZOOM_STOPS[minimumIndex].id} ` +
      `current ${currentIndex}=${TIMELINE_ZOOM_STOPS[currentIndex].id} ` +
      `max ${maximumIndex}=${TIMELINE_ZOOM_STOPS[maximumIndex].id}`
    );
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
    this.ensureViewportStartMs(this.zoomDurationMs);
    const startViewportStartMs = this.viewportStartMs ?? 0;
    const chartWidth = this.getTimelineWidth(
      this.renderedTimelineRange ?? this.getTimelineRange(this.visibleTasks),
      timelineEl,
    );
    const msPerPixel = chartWidth > 0 ? this.zoomDurationMs / chartWidth : 0;
    const startScrollTop = timelineEl.scrollTop;
    let moved = false;

    const handlePointerMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;

      moved = true;
      timelineEl.addClass("base-board-timeline-viewport--panning");
      this.viewportStartMs = startViewportStartMs - deltaX * msPerPixel;
      this.pendingTimelineScrollTop = Math.max(0, startScrollTop - deltaY);
      this.render();
      moveEvent.preventDefault();
    };

    const handlePointerUp = () => {
      activeDocument.removeEventListener("mousemove", handlePointerMove);
      activeDocument.removeEventListener("mouseup", handlePointerUp);
      this.containerEl
        .querySelector<HTMLElement>(".base-board-timeline-viewport")
        ?.removeClass("base-board-timeline-viewport--panning");
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
    scrollTop: number,
  ): void {
    timelineEl.scrollTop = scrollTop;
  }

  private getTimelineRange(tasks: TimelineTask[]): TimelineRange {
    this.ensureViewportStartMs(this.zoomDurationMs);
    const startTime =
      this.viewportStartMs ??
      this.getDefaultViewportStartMs(this.zoomDurationMs);
    return {
      start: new Date(startTime),
      end: new Date(startTime + this.zoomDurationMs),
    };
  }

  private ensureViewportStartMs(durationMs: number): void {
    if (this.viewportStartMs === null) {
      this.viewportStartMs = this.getDefaultViewportStartMs(durationMs);
    }
  }

  private getDefaultViewportStartMs(durationMs: number): number {
    return this.roundTimelineEnd(new Date(), durationMs) - durationMs;
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
    return Math.max(1, timelineEl.clientWidth - this.getLabelWidth());
  }

  private getWeekStart(date: Date): Date {
    const weekStartDay = this.plugin.data_.timeline.weekStartDay;
    const cursor = this.toLocalDateOnly(date);
    const delta = (cursor.getDay() - weekStartDay + 7) % 7;
    cursor.setDate(cursor.getDate() - delta);
    return cursor;
  }

  private addDays(date: Date, days: number): Date {
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + days);
    return nextDate;
  }

  private addHours(date: Date, hours: number): Date {
    const nextDate = new Date(date);
    nextDate.setHours(nextDate.getHours() + hours);
    return nextDate;
  }

  private addMonths(date: Date, months: number): Date {
    const nextDate = new Date(date);
    nextDate.setMonth(nextDate.getMonth() + months);
    return nextDate;
  }

  private addYears(date: Date, years: number): Date {
    const nextDate = new Date(date);
    nextDate.setFullYear(nextDate.getFullYear() + years);
    return nextDate;
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
