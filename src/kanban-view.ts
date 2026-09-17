import {
  BasesView,
  BasesEntry,
  BasesEntryGroup,
  BasesAllOptions,
  BooleanValue,
  HoverParent,
  HoverPopover,
  NumberValue,
  NullValue,
  QueryController,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type BaseBoardPlugin from "./main";
import { DragDropManager } from "./drag-drop";
import { ColumnManager } from "./column";
import { CardManager } from "./card";
import { Tags } from "./tags";
import {
  compareOrderValues,
  generateOrderKeys,
  isOrderKey,
  OrderValue,
  readOrderValue,
} from "./order";
import { coerceColumnValue, GroupByValueType } from "./value-utils";
import {
  NO_VALUE_COLUMN,
  ORDER_PROPERTY,
  CONFIG_KEY_COLUMNS,
  CONFIG_KEY_COLLAPSED_COLUMNS,
  CONFIG_KEY_OPEN_BEHAVIOR,
  CONFIG_KEY_BOARD_PROJECTION,
  CONFIG_KEY_FRONTIER_SCOPE,
  CONFIG_KEY_FRONTIER_PRIORITY,
  CONFIG_KEY_COLUMN_COLORS,
  CONFIG_KEY_WIP_LIMITS,
  CONFIG_KEY_COVER_PROPERTY,
  CONFIG_KEY_ADD_TO_TOP,
} from "./constants";
import { getColumnColor } from "./status-colors";
import {
  buildTransitionEvent,
  type TransitionEvent,
} from "./transition-history";
import {
  buildFrontierGraph,
  getFrontierNodes,
  getFrontierLineage,
  getScopeAncestors,
  normalizeReference,
  normalizeReferences,
  isCompletedStatus as engineIsCompletedStatus,
  isBlockedStatus as engineIsBlockedStatus,
  isActiveStatus as engineIsActiveStatus,
  ENGINE_NODE_KINDS,
  type EngineNode,
  type EngineNodeKind,
  type FrontierNode,
  type FrontierRawNode,
} from "./graph-engine";

const ARCHIVE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const PLANNED_COLUMN = "Planned";
const ARCHIVE_DROP_COLUMN = "Archived";
const ARCHIVE_TARGET_STATUS = "Completed";
const ARCHIVED_PROPERTY = "archived";
const STACKED_COLUMN_GROUPS = [["Flighting", "Blocked"]];

// --- Active-frontier projection (Step D) -----------------------------------
// The frontier board is a derived projection of the graph: live columns are the
// active frontier leaves bucketed by status; history columns read the event log.
const FRONTIER_HISTORY_WINDOW_DAYS = 7;
const FRONTIER_SCOPE_ALL = "all";
const FRONTIER_LIVE_COLUMNS = [
  "To Do",
  "In Progress",
  "In Review",
  "Blocked",
] as const;

/** A scope (`group`) node summarised for the lens picker (Step E). */
interface FrontierScopeSummary {
  key: string;
  title: string;
  depth: number;
  frontierCount: number;
  hasAttention: boolean;
}

/** A work card projected onto the frontier board. */
interface FrontierCardModel {
  file: TFile;
  entry: BasesEntry;
  title: string;
  lineage: string[];
  status: string | null;
  state: FrontierNode["state"];
  facets: { label: string; kind: string }[];
  tags: string[];
  /** 1-based rank in today's priority overlay for the active scope, else null. */
  priorityRank: number | null;
  timestamp: Date | null;
}

/** Parses an explicit frontmatter `kind` into the engine's closed kind set. */
function parseFrontmatterKind(value: unknown): EngineNodeKind | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : null;
  return ENGINE_NODE_KINDS.find((kind) => kind === raw) ?? null;
}

interface ArchivedEntry {
  file: TFile;
  title: string;
  status: string;
  completedAt: Date;
  columnColor: string;
}

interface PlannedEntry {
  file: TFile;
  title: string;
  status: string;
  columnColor: string;
}

type BoardProjectionMode = "all" | "active-frontier";

interface BoardScrollState {
  boardLeft: number;
  viewTop: number;
  columnTops: Map<string, number>;
}

// ---------------------------------------------------------------------------
//  Kanban View
// ---------------------------------------------------------------------------

export class KanbanView extends BasesView implements HoverParent {
  type = "kanban";
  // Required by HoverParent — Obsidian manages the popover lifecycle.
  hoverPopover: HoverPopover | null = null;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  plugin: BaseBoardPlugin;

  private dragDropManager: DragDropManager;
  private columnManager: ColumnManager;
  public currentGroups: BasesEntryGroup[] = [];
  public cardManager: CardManager;

  /** Prevent re-renders while we batch-update frontmatter. */
  private isUpdating = false;
  /** Track if Bases delivered fresh query data while we were updating. */
  private pendingDataRender = false;
  /** True until the first successful render completes. */
  private isFirstRender = true;
  /** Debounce timer for render calls. */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the computed archive shelf is expanded. */
  private isArchiveExpanded = false;
  /** Whether the computed planned shelf is expanded. */
  private isPlannedExpanded = true;
  /** Active frontier lens scope (Step E) for the current render. */
  private activeFrontierScopeKey: string = FRONTIER_SCOPE_ALL;
  /** Today's ordered priority overlay (file paths) for the active scope (Step F). */
  private activeFrontierPriority: string[] = [];
  /** Local drop intent retained until Bases publishes the matching groups. */
  private optimisticMoves = new Map<string, string>();
  private optimisticColumnOrders = new Map<string, string[]>();
  /** Label Manager for tags and filters */
  public tags: Tags;
  /** Currently selected card file paths (for batch operations) */
  public selectedCards: Set<string> = new Set();
  public detailLeaf: WorkspaceLeaf | null = null;

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    plugin: BaseBoardPlugin,
  ) {
    super(controller);
    this.scrollEl = scrollEl;
    this.plugin = plugin;
    this.containerEl = scrollEl.createDiv({ cls: "base-board-container" });

    this.tags = new Tags(this);
    this.cardManager = new CardManager(this);
    this.columnManager = new ColumnManager(this);

    this.dragDropManager = new DragDropManager(this.app, {
      onCardDrop: (
        filePath: string,
        targetColumn: string,
        orderedPaths: string[],
      ) => this.handleCardDrop(filePath, targetColumn, orderedPaths),
      onColumnReorder: (orderedNames: string[]) =>
        this.handleColumnReorder(orderedNames),
      getSelectedCards: () => this.selectedCards,
    });
  }

  onload(): void {}

  onunload(): void {
    this.dragDropManager.destroy();
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    if (this.isUpdating) {
      this.pendingDataRender = true;
      return;
    }
    this.acknowledgeOptimisticMoves();
    this.scheduleRender();
  }

  /**
   * Run a batch of state updates without triggering intermediate re-renders.
   * Defers rendering until the entire batch is complete.
   */
  public async applyBatchUpdate(
    updateFn: () => Promise<void> | void,
  ): Promise<void> {
    this.isUpdating = true;
    this.pendingDataRender = false;

    try {
      await updateFn();
    } finally {
      this.isUpdating = false;
    }

    // If Bases fired onDataUpdated during our batch, schedule a debounced render.
    if (this.pendingDataRender) {
      this.pendingDataRender = false;
      this.acknowledgeOptimisticMoves();
      this.scheduleRender();
    }
  }

  public getCurrentEntries(): BasesEntry[] {
    return this.data?.data ?? [];
  }

  static getViewOptions(): BasesAllOptions[] {
    return [
      {
        type: "group" as const,
        displayName: "Display",
        items: [
          {
            key: CONFIG_KEY_OPEN_BEHAVIOR,
            type: "dropdown" as const,
            displayName: "Open card in",
            default: "modal",
            options: {
              active: "Active pane / tab",
              modal: "Floating modal",
              split: "Split to the right",
              tab: "New tab",
            },
          },
          {
            key: CONFIG_KEY_BOARD_PROJECTION,
            type: "dropdown" as const,
            displayName: "Show cards",
            default: "all",
            options: {
              all: "All cards",
              "active-frontier": "Active frontier",
            },
          },
          {
            key: CONFIG_KEY_COVER_PROPERTY,
            type: "text" as const,
            displayName: "Cover property",
            default: "cover",
            placeholder: "E.g. cover",
          },
          {
            key: CONFIG_KEY_ADD_TO_TOP,
            type: "toggle" as const,
            displayName: "Add new cards to top",
            default: false,
          },
        ],
      },
    ];
  }

  public isAddNewCardsToTop(): boolean {
    return !!this.config?.get(CONFIG_KEY_ADD_TO_TOP);
  }

  // ---------------------------------------------------------------------------
  //  Base identity
  // ---------------------------------------------------------------------------

  /**
   * Build a stable, unique identifier for this board view.
   *
   * Uses the view's display name (unique within a .base file) combined with
   * the groupBy property.  If neither is available we fall back to a hash
   * derived from the file paths currently in the dataset so that column
   * configs never collide across different boards.
   */
  private getBaseId(): string {
    const viewName = this.config?.name ?? "";
    const groupBy = this.getGroupByProperty() ?? "";

    // Try to discover the .base file path from the entries in the dataset.
    // All entries originate from the same .base query so any entry's folder
    // ancestor pattern is a reasonable proxy.  This gives us a path-qualified
    // key even when two .base files share the same view name.
    let basePath = "";
    const entries: BasesEntry[] = this.data?.data ?? [];
    if (entries.length > 0) {
      const firstPath = entries[0].file?.path ?? "";
      const lastSlash = firstPath.lastIndexOf("/");
      basePath = lastSlash > 0 ? firstPath.substring(0, lastSlash) : "";
    }

    return `${basePath}::${viewName}::${groupBy}`;
  }

  // ---------------------------------------------------------------------------
  //  Helpers
  // ---------------------------------------------------------------------------

  /**
   * Return the frontmatter property name used for groupBy (e.g. "status").
   *
   * The Bases engine stores this in the view config as a BasesPropertyId
   * like "note.status".  We strip the "note." prefix so the result is
   * directly usable as a frontmatter key.
   *
   * Note: `BasesViewConfig.get()` only retrieves custom options registered
   * via `BasesViewRegistration.options`.  The `groupBy` setting is a
   * built-in structural property on the config object, so we access it
   * directly from the config's internal representation.
   */
  public getGroupByProperty(): string | null {
    const cfg = this.config as {
      groupBy?: { property?: string };
      get?: (key: string) => unknown;
    };

    // 1. Direct access to the built-in groupBy config property
    const groupBy = cfg?.groupBy;
    if (groupBy?.property) {
      const raw: string = groupBy.property;
      return raw.startsWith("note.") ? raw.slice(5) : raw;
    }

    // 2. Fallback: try the custom-options API in case future Obsidian
    //    versions surface groupBy through get()
    const fromGet = cfg?.get?.("groupBy") as { property?: string } | undefined;
    if (fromGet?.property) {
      const raw: string = fromGet.property;
      return raw.startsWith("note.") ? raw.slice(5) : raw;
    }

    return null;
  }

  public getCardOpenBehavior(): "active" | "modal" | "split" | "tab" {
    const val = this.config?.get(CONFIG_KEY_OPEN_BEHAVIOR);
    if (val === "modal" || val === "split" || val === "tab") return val;
    if (val === "active") return val;
    return "modal";
  }

  public getBoardProjectionMode(): BoardProjectionMode {
    const val = this.config?.get(CONFIG_KEY_BOARD_PROJECTION);
    return val === "active-frontier" ? "active-frontier" : "all";
  }

  /** Persists the board mode (All cards / Active frontier) and re-renders. */
  private setBoardProjectionMode(mode: BoardProjectionMode): void {
    if (mode === this.getBoardProjectionMode()) return;
    this.config?.set(CONFIG_KEY_BOARD_PROJECTION, mode);
    this.scheduleRender();
  }

  /**
   * Renders the segmented board-mode toggle at the top of the view, mirroring
   * the "Show cards" view option but in-board for discoverability.
   */
  private renderBoardModeToggle(parentEl: HTMLElement): void {
    const mode = this.getBoardProjectionMode();
    const toggleEl = parentEl.createDiv({ cls: "base-board-mode-toggle" });
    const addButton = (
      value: BoardProjectionMode,
      label: string,
      icon: string,
    ): void => {
      const btn = toggleEl.createEl("button", {
        cls:
          value === mode
            ? "base-board-mode-btn base-board-mode-btn--active"
            : "base-board-mode-btn",
        attr: { type: "button", "aria-pressed": String(value === mode) },
      });
      setIcon(btn.createSpan({ cls: "base-board-mode-btn-icon" }), icon);
      btn.createSpan({ cls: "base-board-mode-btn-label", text: label });
      btn.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        this.setBoardProjectionMode(value);
      });
    };
    addButton("all", "All cards", "lucide-layout-grid");
    addButton("active-frontier", "Active frontier", "lucide-target");
  }

  public getCardCoverProperty(): string | null {
    const val = this.config?.get(CONFIG_KEY_COVER_PROPERTY);
    if (val === undefined || val === null) {
      return "cover";
    }
    return typeof val === "string" && val.trim() !== "" ? val.trim() : null;
  }

  public isLeafAttached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) found = true;
    });
    return found;
  }

  public getColumnColors(): Record<string, string> {
    const raw = this.config?.get(CONFIG_KEY_COLUMN_COLORS);
    return raw && typeof raw === "object"
      ? (raw as Record<string, string>)
      : {};
  }

  public getColumnColor(columnName: string): string | null {
    const customColors = this.getColumnColors();
    return customColors[columnName] ?? null;
  }

  public setColumnColor(columnName: string, color: string): void {
    const colors = this.getColumnColors();
    if (color) {
      colors[columnName] = color;
    } else {
      delete colors[columnName];
    }
    this.config?.set(CONFIG_KEY_COLUMN_COLORS, colors);
    this.scheduleRender();
  }

  // ---------------------------------------------------------------------------
  //  WIP Limits
  // ---------------------------------------------------------------------------

  public getWipLimits(): Record<string, number> {
    const raw = this.config?.get(CONFIG_KEY_WIP_LIMITS);
    return raw && typeof raw === "object"
      ? (raw as Record<string, number>)
      : {};
  }

  public getWipLimit(columnName: string): number | null {
    const limits = this.getWipLimits();
    const val = limits[columnName];
    return typeof val === "number" && val > 0 ? val : null;
  }

  public setWipLimit(columnName: string, limit: number | null): void {
    const limits = this.getWipLimits();
    if (limit !== null && limit > 0) {
      limits[columnName] = limit;
    } else {
      delete limits[columnName];
    }
    this.config?.set(CONFIG_KEY_WIP_LIMITS, limits);
    this.scheduleRender();
  }

  private getColumnName(key: unknown): string {
    if (key === undefined || key === null || key instanceof NullValue) {
      return NO_VALUE_COLUMN;
    }
    if (typeof key === "object" && key !== null) {
      if ("value" in key) {
        const val = (key as Record<string, unknown>).value;
        return String(val);
      }
      // Bases group-key objects expose the column name via toString()
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Bases-controlled object with custom toString
      return String(key);
    }
    if (typeof key === "string") return key;
    if (typeof key === "number" || typeof key === "boolean") return String(key);
    return "";
  }

  /**
   * Infer the JS type of the groupBy property from the group keys that Bases
   * actually produced. Bases exposes group keys as typed Value objects, so a
   * checkbox-grouped board yields BooleanValue keys and a numeric one yields
   * NumberValue keys. Booleans win outright so a mix of real checkboxes and
   * already-corrupted "false" strings still resolves to "boolean".
   */
  private groupByValueType(): GroupByValueType {
    for (const group of this.currentGroups) {
      if (group.key instanceof BooleanValue) return "boolean";
      if (group.key instanceof NumberValue) return "number";
    }
    return "other";
  }

  /**
   * Write the groupBy property for a card into `fm`, preserving its real type.
   *
   * The "(No value)" column removes the property entirely; every other column
   * stores a correctly-typed value so a checkbox `false` is never turned into
   * the string "false" (which is truthy and breaks grouping).
   */
  public applyGroupByValue(
    fm: Record<string, unknown>,
    groupByProp: string,
    columnName: string,
  ): void {
    if (columnName === NO_VALUE_COLUMN) {
      delete fm[groupByProp];
      return;
    }
    fm[groupByProp] = coerceColumnValue(columnName, this.groupByValueType());
  }

  /**
   * Read kanban_order from metadataCache (more reliable than entry.values
   * since the Bases engine may not expose all properties).
   */
  public getFileOrder(filePath: string): OrderValue {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    return readOrderValue(cache?.frontmatter?.[ORDER_PROPERTY]);
  }

  public compareFileOrder(pathA: string, pathB: string): number {
    return compareOrderValues(
      this.getFileOrder(pathA),
      this.getFileOrder(pathB),
    );
  }

  public compareCardOrder(
    columnName: string,
    pathA: string,
    pathB: string,
  ): number {
    const optimisticOrder = this.optimisticColumnOrders.get(columnName);
    if (optimisticOrder) {
      const indexA = optimisticOrder.indexOf(pathA);
      const indexB = optimisticOrder.indexOf(pathB);
      if (indexA !== -1 || indexB !== -1) {
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      }
    }
    return this.compareFileOrder(pathA, pathB);
  }

  public getEntriesForColumn(
    columnName: string,
    group: BasesEntryGroup | null,
  ): BasesEntry[] {
    const entries = [...(group?.entries ?? [])].filter((entry) => {
      const path = entry.file?.path;
      const optimisticColumn = path ? this.optimisticMoves.get(path) : null;
      return !optimisticColumn || optimisticColumn === columnName;
    });
    const present = new Set(entries.map((entry) => entry.file?.path));

    for (const entry of this.data?.data ?? []) {
      const path = entry.file?.path;
      if (
        path &&
        this.optimisticMoves.get(path) === columnName &&
        !present.has(path)
      ) {
        entries.push(entry);
      }
    }
    return entries;
  }

  public getOrderedPathsForColumn(columnName: string): string[] {
    const group = this.currentGroups.find(
      (candidate) => this.getColumnName(candidate.key) === columnName,
    );
    const paths = (group?.entries ?? [])
      .map((entry) => entry.file?.path)
      .filter((path): path is string => typeof path === "string");
    return paths.sort((a, b) => this.compareFileOrder(a, b));
  }

  public isArchivedEntry(entry: BasesEntry, columnName: string): boolean {
    return this.getArchivedEntry(entry, columnName) !== null;
  }

  public entryMatchesActiveTagFilters(entry: BasesEntry): boolean {
    if (this.tags.activeFilters.size === 0) return true;

    const file = entry.file;
    if (!(file instanceof TFile)) return false;

    const fileTags = this.tags.extractTagsFromFile(file);
    return Array.from(this.tags.activeFilters).some((filter) =>
      fileTags.includes(filter),
    );
  }

  public entryMatchesBoardProjection(_entry: BasesEntry): boolean {
    // The active-frontier projection now renders its own derived board
    // (renderFrontierBoard), so the classic board never projects entries out.
    return true;
  }

  private getArchivedEntry(
    entry: BasesEntry,
    columnName: string,
  ): ArchivedEntry | null {
    if (!this.isCompletedStatus(columnName)) return null;

    const file = entry.file;
    if (!(file instanceof TFile)) return null;

    const groupByProp = this.getGroupByProperty();
    if (!groupByProp) return null;

    const frontmatter = this.getFrontmatter(file);
    const explicitlyArchived = frontmatter?.[ARCHIVED_PROPERTY] === true;
    const completedAt = this.getCompletedStateEnteredAt(file, groupByProp);
    if (!completedAt && !explicitlyArchived) return null;

    if (!explicitlyArchived && completedAt) {
      const archiveAt = completedAt.getTime() + ARCHIVE_GRACE_PERIOD_MS;
      if (Date.now() < archiveAt) return null;
    }

    return {
      file,
      title: this.cardManager.getCardTitle(entry),
      status: columnName,
      completedAt: completedAt ?? new Date(file.stat.mtime),
      columnColor: getColumnColor(this.config, columnName),
    };
  }

  private getArchivedEntries(): ArchivedEntry[] {
    const archivedEntries: ArchivedEntry[] = [];

    for (const group of this.currentGroups) {
      const columnName = this.getColumnName(group.key);
      for (const entry of group.entries) {
        if (!this.entryMatchesActiveTagFilters(entry)) continue;
        if (!this.entryMatchesBoardProjection(entry)) continue;
        const archivedEntry = this.getArchivedEntry(entry, columnName);
        if (archivedEntry) archivedEntries.push(archivedEntry);
      }
    }

    return archivedEntries.sort((first, second) => {
      const completedAtDiff =
        second.completedAt.getTime() - first.completedAt.getTime();
      if (completedAtDiff !== 0) return completedAtDiff;
      return first.title.localeCompare(second.title);
    });
  }

  private getPlannedEntries(): PlannedEntry[] {
    const plannedEntries: PlannedEntry[] = [];

    for (const group of this.currentGroups) {
      const columnName = this.getColumnName(group.key);
      if (!this.isPlannedStatus(columnName)) continue;

      for (const entry of group.entries) {
        if (!this.entryMatchesActiveTagFilters(entry)) continue;
        if (!this.entryMatchesBoardProjection(entry)) continue;
        const file = entry.file;
        if (!(file instanceof TFile)) continue;
        plannedEntries.push({
          file,
          title: this.cardManager.getCardTitle(entry),
          status: columnName,
          columnColor: getColumnColor(this.config, columnName),
        });
      }
    }

    return plannedEntries.sort((first, second) =>
      first.title.localeCompare(second.title),
    );
  }

  private getCompletedStateEnteredAt(
    file: TFile,
    groupByProp: string,
  ): Date | null {
    const propertyName =
      this.plugin.data_.transitionHistory.propertyName.trim();
    if (!propertyName) return null;

    const frontmatter = this.getFrontmatter(file);
    const rawHistory = frontmatter?.[propertyName];
    if (!Array.isArray(rawHistory)) return null;

    const historyRecords = (rawHistory as unknown[])
      .map((rawRecord) =>
        this.parseTransitionHistoryRecord(rawRecord, groupByProp),
      )
      .filter(
        (
          record,
        ): record is { from: string | null; to: string | null; at: Date } =>
          record !== null,
      )
      .sort((first, second) => first.at.getTime() - second.at.getTime());

    let completedStateEnteredAt: Date | null = null;
    for (const record of historyRecords) {
      if (this.isCompletedStatus(record.to)) {
        if (!this.isCompletedStatus(record.from)) {
          completedStateEnteredAt = record.at;
        }
      } else {
        completedStateEnteredAt = null;
      }
    }

    return completedStateEnteredAt;
  }

  private parseTransitionHistoryRecord(
    rawRecord: unknown,
    groupByProp: string,
  ): { from: string | null; to: string | null; at: Date } | null {
    if (!rawRecord || typeof rawRecord !== "object") return null;
    const record = rawRecord as Partial<TransitionEvent>;
    if (
      typeof record.property === "string" &&
      record.property !== groupByProp
    ) {
      return null;
    }
    if (typeof record.at !== "string") return null;

    const recordDate = new Date(record.at);
    if (Number.isNaN(recordDate.getTime())) return null;

    return {
      from: this.normalizeStatus(record.from),
      to: this.normalizeStatus(record.to),
      at: recordDate,
    };
  }

  private getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? frontmatter
      : undefined;
  }

  private normalizeStatus(value: unknown): string | null {
    if (value === undefined || value === null || value instanceof NullValue) {
      return null;
    }
    if (Array.isArray(value)) return this.normalizeStatus(value[0]);
    if (typeof value === "object") {
      if ("value" in value) {
        return this.normalizeStatus((value as Record<string, unknown>).value);
      }
      return null;
    }
    if (typeof value === "string") {
      const status = value.trim();
      return status.length > 0 ? status : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      const status = String(value).trim();
      return status.length > 0 ? status : null;
    }
    return null;
  }

  private isCompletedStatus(status: string | null): boolean {
    const normalizedStatus = status?.trim().toLowerCase();
    return normalizedStatus === "completed" || normalizedStatus === "done";
  }

  private isPlannedStatus(status: string | null): boolean {
    return status?.trim().toLowerCase() === PLANNED_COLUMN.toLowerCase();
  }

  // ---------------------------------------------------------------------------
  //  Column config  (dual-layer: .base file via config API + plugin data.json)
  // ---------------------------------------------------------------------------

  /**
   * Read the persisted column order.
   *
   * Priority:
   *  1. View-level config stored inside the .base file (via BasesViewConfig)
   *  2. Legacy plugin data.json (for backwards-compat with existing boards)
   *  3. Fall back to whatever columns the data naturally produces
   *
   * Any columns present in the live data but missing from the stored list
   * are appended at the end so they are never silently hidden.
   */
  public getColumns(): string[] {
    // 1. Try .base file config first (new preferred storage)
    const fromConfig = this.config?.get(CONFIG_KEY_COLUMNS) as
      string[] | undefined;

    // 2. Fallback: legacy plugin data.json
    const fromPlugin = this.plugin.getColumnConfig(this.getBaseId());

    const rawStored = fromConfig?.length
      ? fromConfig
      : fromPlugin?.columns?.length
        ? fromPlugin.columns
        : null;

    const stored = rawStored
      ? rawStored.map((col) => (col === "" ? NO_VALUE_COLUMN : col))
      : null;

    const dataColumns = this.currentGroups
      .map((g) => this.getColumnName(g.key))
      .filter((columnName) => !this.isPlannedStatus(columnName));

    if (stored && stored.length > 0) {
      const result = stored.filter(
        (columnName) => !this.isPlannedStatus(columnName),
      );
      for (const col of dataColumns) {
        if (!result.includes(col)) {
          result.push(col);
        }
      }
      return result;
    }

    return dataColumns;
  }

  public getCollapsedColumns(): Record<string, boolean> {
    const raw = this.config?.get(CONFIG_KEY_COLLAPSED_COLUMNS);
    return raw && typeof raw === "object"
      ? (raw as Record<string, boolean>)
      : {};
  }

  public isColumnCollapsed(columnName: string): boolean {
    return !!this.getCollapsedColumns()[columnName];
  }

  public setColumnCollapsed(columnName: string, collapsed: boolean): void {
    const state = this.getCollapsedColumns();
    if (collapsed) {
      state[columnName] = true;
    } else {
      delete state[columnName];
    }
    this.config?.set(CONFIG_KEY_COLLAPSED_COLUMNS, state);
    this.scheduleRender();
  }

  public toggleColumnCollapsed(columnName: string): void {
    this.setColumnCollapsed(columnName, !this.isColumnCollapsed(columnName));
  }

  private getGroupForColumn(columnName: string): BasesEntryGroup | null {
    for (const group of this.currentGroups) {
      if (this.getColumnName(group.key) === columnName) {
        return group;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  //  Rendering
  // ---------------------------------------------------------------------------

  /**
   * Ensure `file.name` is present in the view's property `order:` configuration.
   * This guarantees that Obsidian's database engine indexes card titles for search.
   */
  private ensureFileNameInOrder(): void {
    if (!this.config) return;
    const currentOrder =
      (this.config.get("order") as string[] | undefined) ?? [];
    if (
      !currentOrder.includes("file.name") &&
      !currentOrder.includes("file.file")
    ) {
      this.config.set("order", ["file.name", ...currentOrder]);
    }
  }

  public cardElCache = new Map<string, HTMLElement>();
  public columnElCache = new Map<string, HTMLElement>();

  public render(): void {
    this.ensureFileNameInOrder();
    this.selectedCards.clear();
    const scrollState = this.captureScrollState();

    // Index stable DOM nodes before rebuilding the lightweight board shell.
    // Columns are detached as complete subtrees, preserving their card lists,
    // card descendants, scroll state, image elements, and event listeners.
    this.cardElCache.clear();
    this.containerEl
      .querySelectorAll(".base-board-card[data-render-version]")
      .forEach((el) => {
        const path = (el as HTMLElement).dataset.filePath;
        if (path) {
          this.cardElCache.set(path, el as HTMLElement);
        }
      });

    this.columnElCache.clear();
    this.containerEl
      .querySelectorAll<HTMLElement>(
        ".base-board-board:not(.base-board-frontier-board) .base-board-column",
      )
      .forEach((el) => {
        const name = el.dataset.columnName;
        if (name) {
          this.columnElCache.set(name, el);
          el.remove();
        }
      });

    this.containerEl.empty();

    // Board mode toggle (All cards / Active frontier) — rendered first so it
    // pins to the top of the view for discoverability.
    this.renderBoardModeToggle(this.containerEl);

    // Use the official API: this.data is a BasesQueryResult
    const groupedData: BasesEntryGroup[] = this.data?.groupedData ?? [];
    const hasGroupBy =
      groupedData.length > 1 ||
      (groupedData.length === 1 &&
        groupedData[0].key !== undefined &&
        !(groupedData[0].key instanceof NullValue));

    // If the board has configured columns (from .base or data.json) but
    // no cards exist yet, render the empty columns so users can see and
    // add cards instead of showing an opaque placeholder.
    const stored =
      (this.config?.get(CONFIG_KEY_COLUMNS) as string[] | undefined) ??
      this.plugin.getColumnConfig(this.getBaseId())?.columns;
    const hasStoredColumns = stored && stored.length > 0;
    const shouldShowPlaceholder =
      !hasGroupBy && groupedData.length <= 1 && !hasStoredColumns;

    if (
      shouldShowPlaceholder &&
      this.getBoardProjectionMode() !== "active-frontier"
    ) {
      this.dragDropManager.destroy();
      const msgEl = this.containerEl.createDiv({
        cls: "base-board-placeholder",
      });
      setIcon(
        msgEl.createSpan({ cls: "base-board-placeholder-icon" }),
        "lucide-kanban",
      );
      msgEl.createEl("p", {
        text: 'Set "group by" in the sort menu to organize cards into columns.',
      });
      return;
    }

    this.currentGroups = groupedData;

    const boardEl = this.containerEl.createDiv({ cls: "base-board-board" });

    this.tags.renderFilterBar(this.containerEl);

    // Only animate cards on the very first render
    if (this.isFirstRender) {
      boardEl.addClass("base-board-board--animate");
      this.isFirstRender = false;
    }

    // Active-frontier projection (Step D): a derived board driven by the graph
    // frontier (live work) + the event log (recent history), not raw status
    // grouping. The classic status board renders below in "all" mode.
    if (this.getBoardProjectionMode() === "active-frontier") {
      this.dragDropManager.destroy();
      boardEl.addClass("base-board-frontier-board");
      this.renderFrontierBoard(boardEl);
      this.restoreScrollState(boardEl, scrollState);
      return;
    }

    const columns = this.getColumns();

    const renderedColumns = new Set<string>();
    columns.forEach((columnName, idx) => {
      if (renderedColumns.has(columnName)) return;
      if (this.shouldDeferToStackAnchor(columnName, columns)) return;

      const stackedGroup = this.getStackedColumnGroup(columnName, columns);
      if (stackedGroup) {
        const stackEl = boardEl.createDiv({ cls: "base-board-column-stack" });
        for (const stackedColumnName of stackedGroup) {
          renderedColumns.add(stackedColumnName);
          const group = this.getGroupForColumn(stackedColumnName);
          this.columnManager.renderColumn(
            stackEl,
            stackedColumnName,
            group,
            columns.indexOf(stackedColumnName),
            this.columnElCache.get(stackedColumnName),
          );
        }
        return;
      }

      renderedColumns.add(columnName);
      const group = this.getGroupForColumn(columnName);
      this.columnManager.renderColumn(
        boardEl,
        columnName,
        group,
        idx,
        this.columnElCache.get(columnName),
      );
    });

    this.columnManager.renderAddColumnButton(boardEl);
    const shelvesEl = this.containerEl.createDiv({ cls: "base-board-shelves" });
    const plannedShelfEl = this.renderPlannedSection(
      shelvesEl,
      this.getPlannedEntries(),
    );
    const archiveShelfEl = this.renderArchiveSection(
      shelvesEl,
      this.getArchivedEntries(),
    );
    this.dragDropManager.initBoard(
      boardEl,
      [plannedShelfEl, archiveShelfEl].filter(
        (shelfEl): shelfEl is HTMLElement => shelfEl !== null,
      ),
    );
    this.restoreScrollState(boardEl, scrollState);
  }

  private captureScrollState(): BoardScrollState {
    const boardEl =
      this.containerEl.querySelector<HTMLElement>(".base-board-board");
    const columnTops = new Map<string, number>();

    boardEl
      ?.querySelectorAll<HTMLElement>(".base-board-column")
      .forEach((columnEl) => {
        const name = columnEl.dataset.columnName;
        const cardsEl =
          columnEl.querySelector<HTMLElement>(".base-board-cards");
        if (name && cardsEl) columnTops.set(name, cardsEl.scrollTop);
      });

    return {
      boardLeft: boardEl?.scrollLeft ?? 0,
      viewTop: this.scrollEl.scrollTop,
      columnTops,
    };
  }

  private restoreScrollState(
    boardEl: HTMLElement,
    state: BoardScrollState,
  ): void {
    // All columns are attached, so these assignments restore against the final
    // layout and cannot race a deferred callback from an earlier render.
    boardEl.scrollLeft = state.boardLeft;
    this.scrollEl.scrollTop = state.viewTop;

    boardEl
      .querySelectorAll<HTMLElement>(".base-board-column")
      .forEach((columnEl) => {
        const name = columnEl.dataset.columnName;
        const cardsEl =
          columnEl.querySelector<HTMLElement>(".base-board-cards");
        const scrollTop = name ? state.columnTops.get(name) : undefined;
        if (cardsEl && scrollTop !== undefined) {
          cardsEl.scrollTop = scrollTop;
        }
      });
  }

  private renderPlannedSection(
    parentEl: HTMLElement,
    plannedEntries: PlannedEntry[],
  ): HTMLElement | null {
    const plannedEl = parentEl.createDiv({
      cls: "base-board-archive base-board-planned-shelf",
    });
    plannedEl.dataset.columnName = PLANNED_COLUMN;
    if (this.isPlannedExpanded) {
      plannedEl.addClass("base-board-archive--expanded");
    }

    const headerEl = plannedEl.createDiv({
      cls: "base-board-archive-header",
    });
    headerEl.setAttr("role", "button");
    headerEl.setAttr("tabindex", "0");
    headerEl.setAttr("aria-expanded", String(this.isPlannedExpanded));
    const chevronEl = headerEl.createSpan({
      cls: "base-board-archive-chevron",
    });
    setIcon(
      chevronEl,
      this.isPlannedExpanded ? "lucide-chevron-down" : "lucide-chevron-right",
    );
    const plannedIconEl = headerEl.createSpan({
      cls: "base-board-archive-icon",
    });
    setIcon(plannedIconEl, "lucide-calendar-clock");
    headerEl.createSpan({ cls: "base-board-archive-title", text: "Planned" });
    headerEl.createSpan({
      cls: "base-board-archive-count",
      text: String(plannedEntries.length),
    });
    headerEl.createSpan({
      cls: "base-board-archive-hint",
      text: "Future or gated work",
    });
    const addPlannedBtn = headerEl.createEl("button", {
      cls: "base-board-column-add-card base-board-planned-add-card",
      attr: {
        type: "button",
        title: "Add planned card",
      },
    });
    setIcon(addPlannedBtn, "plus");
    headerEl.addEventListener("click", () => {
      this.isPlannedExpanded = !this.isPlannedExpanded;
      this.render();
    });
    headerEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.isPlannedExpanded = !this.isPlannedExpanded;
      this.render();
    });
    addPlannedBtn.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.isPlannedExpanded) {
        this.isPlannedExpanded = true;
        this.render();
        return;
      }
      this.cardManager.startInlineCardCreation(
        addPlannedBtn,
        PLANNED_COLUMN,
        plannedEntries.length,
      );
    });

    if (!this.isPlannedExpanded) return plannedEl;

    const listEl = plannedEl.createDiv({
      cls: "base-board-archive-list base-board-planned-list",
    });
    plannedEntries.forEach((plannedEntry) => {
      const cardEl = listEl.createDiv({
        cls: "base-board-card base-board-planned-card",
      });
      cardEl.setAttr("draggable", "true");
      cardEl.dataset.filePath = plannedEntry.file.path;
      cardEl.dataset.columnName = plannedEntry.status;
      cardEl.style.setProperty(
        "--planned-status-color",
        plannedEntry.columnColor,
      );
      cardEl.setAttr("title", `${plannedEntry.title} - planned`);

      const markerEl = cardEl.createSpan({ cls: "base-board-planned-marker" });
      setIcon(markerEl, "lucide-calendar-clock");
      cardEl.createSpan({
        cls: "base-board-planned-title",
        text: plannedEntry.title,
      });
      cardEl.createSpan({
        cls: "base-board-planned-status",
        text: plannedEntry.status,
      });

      cardEl.addEventListener("click", (event: MouseEvent) => {
        this.cardManager.openCardFile(plannedEntry.file, event);
      });
    });

    return plannedEl;
  }

  private getStackedColumnGroup(
    columnName: string,
    columns: string[],
  ): string[] | null {
    for (const group of STACKED_COLUMN_GROUPS) {
      if (group[0] !== columnName) continue;
      const availableColumns = group.filter((candidate) =>
        columns.includes(candidate),
      );
      return availableColumns.length > 1 ? availableColumns : null;
    }
    return null;
  }

  private shouldDeferToStackAnchor(
    columnName: string,
    columns: string[],
  ): boolean {
    for (const group of STACKED_COLUMN_GROUPS) {
      const [anchorColumn, ...stackedColumns] = group;
      if (columnName === anchorColumn) continue;
      if (!stackedColumns.includes(columnName)) continue;
      return Boolean(anchorColumn && columns.includes(anchorColumn));
    }
    return false;
  }

  private renderArchiveSection(
    parentEl: HTMLElement,
    archivedEntries: ArchivedEntry[],
  ): HTMLElement | null {
    const archiveEl = parentEl.createDiv({ cls: "base-board-archive" });
    archiveEl.dataset.columnName = ARCHIVE_DROP_COLUMN;
    if (this.isArchiveExpanded) {
      archiveEl.addClass("base-board-archive--expanded");
    }

    const headerEl = archiveEl.createEl("button", {
      cls: "base-board-archive-header",
      attr: {
        type: "button",
        "aria-expanded": String(this.isArchiveExpanded),
      },
    });
    const chevronEl = headerEl.createSpan({
      cls: "base-board-archive-chevron",
    });
    setIcon(
      chevronEl,
      this.isArchiveExpanded ? "lucide-chevron-down" : "lucide-chevron-right",
    );
    const archiveIconEl = headerEl.createSpan({
      cls: "base-board-archive-icon",
    });
    setIcon(archiveIconEl, "lucide-archive");
    headerEl.createSpan({ cls: "base-board-archive-title", text: "Archived" });
    headerEl.createSpan({
      cls: "base-board-archive-count",
      text: String(archivedEntries.length),
    });
    headerEl.createSpan({
      cls: "base-board-archive-hint",
      text: "Completed for 7+ days",
    });
    headerEl.addEventListener("click", () => {
      this.isArchiveExpanded = !this.isArchiveExpanded;
      this.render();
    });

    if (!this.isArchiveExpanded || archivedEntries.length === 0)
      return archiveEl;

    const listEl = archiveEl.createDiv({ cls: "base-board-archive-list" });
    archivedEntries.forEach((archivedEntry) => {
      const rowEl = listEl.createEl("button", {
        cls: "base-board-card base-board-archive-row",
        attr: { type: "button", draggable: "true" },
      });
      rowEl.dataset.filePath = archivedEntry.file.path;
      rowEl.dataset.columnName = archivedEntry.status;
      rowEl.style.setProperty(
        "--archive-status-color",
        archivedEntry.columnColor,
      );
      rowEl.setAttr(
        "title",
        `${archivedEntry.title} - completed ${archivedEntry.completedAt.toLocaleString()}`,
      );

      const markerEl = rowEl.createSpan({ cls: "base-board-archive-marker" });
      setIcon(markerEl, "lucide-check");
      rowEl.createSpan({
        cls: "base-board-archive-row-title",
        text: archivedEntry.title,
      });
      rowEl.createSpan({
        cls: "base-board-archive-row-status",
        text: archivedEntry.status,
      });
      rowEl.createSpan({
        cls: "base-board-archive-row-date",
        text: this.formatArchiveDate(archivedEntry.completedAt),
      });
      rowEl.addEventListener("click", (event: MouseEvent) => {
        this.cardManager.openCardFile(archivedEntry.file, event);
      });
    });

    return archiveEl;
  }

  private formatArchiveDate(date: Date): string {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions =
      date.getFullYear() === now.getFullYear()
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" };
    return date.toLocaleDateString(undefined, options);
  }

  // ---------------------------------------------------------------------------
  //  Active-frontier projection board (Step D)
  // ---------------------------------------------------------------------------

  /**
   * Renders the frontier-projected board: live columns are the active frontier
   * leaves (derived by the shared graph engine over the whole dataset) bucketed
   * by status; history columns read the event log for recently completed and
   * recently blocked work. Each card shows its work lineage breadcrumb.
   */
  private renderFrontierBoard(boardEl: HTMLElement): void {
    const { raw, refByKey } = this.collectFrontierRawNodes();
    const graph = buildFrontierGraph(raw);
    const nodeByKey = new Map<string, FrontierNode>(
      graph.map((node) => [node.key, node]),
    );
    const frontier = getFrontierNodes(graph);

    // Lens scoping (Step E): the picker summarises the scope hierarchy and the
    // chosen scope narrows the board to `frontier(scope)`.
    const scopeSummaries = this.buildFrontierScopeSummaries(graph, frontier);
    const activeScopeKey = this.resolveActiveFrontierScope(scopeSummaries);
    this.activeFrontierScopeKey = activeScopeKey;
    this.activeFrontierPriority = this.getFrontierPriorityList(activeScopeKey);
    this.renderFrontierScopePicker(
      boardEl,
      scopeSummaries,
      activeScopeKey,
      frontier.length,
    );
    const inScope = (node: FrontierNode): boolean =>
      this.isNodeInFrontierScope(node, activeScopeKey);

    const liveBuckets = new Map<string, FrontierCardModel[]>();
    for (const columnName of FRONTIER_LIVE_COLUMNS) {
      liveBuckets.set(columnName, []);
    }
    let liveCount = 0;
    for (const node of frontier) {
      const ref = refByKey.get(node.key);
      if (!ref) continue;
      if (!inScope(node)) continue;
      if (!this.entryMatchesActiveTagFilters(ref.entry)) continue;
      const columnName = this.frontierLiveColumn(node);
      liveBuckets
        .get(columnName)
        ?.push(this.buildFrontierCard(node, ref, null));
      liveCount += 1;
    }

    const windowMs = FRONTIER_HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const completed: FrontierCardModel[] = [];
    const recentlyBlocked: FrontierCardModel[] = [];
    for (const [key, ref] of refByKey) {
      const node = nodeByKey.get(key);
      if (!node) continue;
      if (
        node.children.length > 0 ||
        node.kind === "group" ||
        node.kind === "impact"
      )
        continue; // actionable/history leaves only
      if (!inScope(node)) continue;
      if (!this.entryMatchesActiveTagFilters(ref.entry)) continue;

      if (node.state === "completed") {
        const completedAt = this.getStatusEnteredWithinWindow(
          ref.file,
          engineIsCompletedStatus,
          windowMs,
        );
        if (completedAt) {
          completed.push(this.buildFrontierCard(node, ref, completedAt));
        }
        continue;
      }

      if (node.state !== "blocked") {
        const blockedAt = this.getStatusEnteredWithinWindow(
          ref.file,
          engineIsBlockedStatus,
          windowMs,
        );
        if (blockedAt) {
          recentlyBlocked.push(this.buildFrontierCard(node, ref, blockedAt));
        }
      }
    }

    const totalCards = liveCount + completed.length + recentlyBlocked.length;
    if (totalCards === 0) {
      const emptyEl = boardEl.createDiv({
        cls: "base-board-frontier-empty",
      });
      setIcon(
        emptyEl.createSpan({ cls: "base-board-frontier-empty-icon" }),
        "lucide-target",
      );
      emptyEl.createEl("p", {
        text:
          activeScopeKey === FRONTIER_SCOPE_ALL
            ? "No active frontier work. Connect cards into a feature/work graph to populate the frontier."
            : "No active frontier work in this scope. Pick a different lens above.",
      });
      return;
    }

    for (const columnName of FRONTIER_LIVE_COLUMNS) {
      this.renderFrontierColumn(
        boardEl,
        columnName,
        liveBuckets.get(columnName) ?? [],
        false,
      );
    }

    if (completed.length > 0 || recentlyBlocked.length > 0) {
      boardEl.createDiv({ cls: "base-board-frontier-divider" });
      this.renderFrontierColumn(boardEl, "Completed", completed, true);
      this.renderFrontierColumn(
        boardEl,
        "Recently blocked",
        recentlyBlocked,
        true,
      );
    }
  }

  /**
   * Lens picker (Step E): summarises every scope (`group`) node with its
   * frontier count + a health flag, ordered by depth in the scope spine. Each
   * frontier leaf contributes to every scope it belongs to (containment +
   * membership), so nested portfolios (e.g. Msft → Career → Dustin) accumulate.
   */
  private buildFrontierScopeSummaries(
    graph: FrontierNode[],
    frontier: FrontierNode[],
  ): FrontierScopeSummary[] {
    const parentOf = (candidate: EngineNode): EngineNode | null =>
      (candidate as FrontierNode).parent;
    const byKey = new Map<string, FrontierScopeSummary>();
    for (const node of graph) {
      if (node.kind !== "group") continue;
      byKey.set(node.key, {
        key: node.key,
        title: node.title,
        depth: getScopeAncestors(node, parentOf).length,
        frontierCount: 0,
        hasAttention: false,
      });
    }
    for (const leaf of frontier) {
      const attention =
        leaf.state === "blocked" || leaf.state === "interrupted";
      for (const scope of getScopeAncestors(leaf, parentOf)) {
        const summary = byKey.get((scope as FrontierNode).key);
        if (!summary) continue;
        summary.frontierCount += 1;
        if (attention) summary.hasAttention = true;
      }
    }
    return [...byKey.values()].sort(
      (first, second) =>
        first.depth - second.depth || first.title.localeCompare(second.title),
    );
  }

  /** The persisted lens scope, or `all` when unset / pointing at a gone scope. */
  private resolveActiveFrontierScope(
    summaries: FrontierScopeSummary[],
  ): string {
    const raw = this.config?.get(CONFIG_KEY_FRONTIER_SCOPE);
    if (typeof raw === "string" && summaries.some((s) => s.key === raw)) {
      return raw;
    }
    return FRONTIER_SCOPE_ALL;
  }

  /** True when a leaf belongs to the active scope (or no scope is selected). */
  private isNodeInFrontierScope(node: FrontierNode, scopeKey: string): boolean {
    if (scopeKey === FRONTIER_SCOPE_ALL) return true;
    return getScopeAncestors(
      node,
      (candidate: EngineNode) => (candidate as FrontierNode).parent,
    ).some((scope) => (scope as FrontierNode).key === scopeKey);
  }

  /** Renders the clickable scope-hierarchy strip above the frontier board. */
  private renderFrontierScopePicker(
    boardEl: HTMLElement,
    summaries: FrontierScopeSummary[],
    activeScopeKey: string,
    totalFrontier: number,
  ): void {
    if (summaries.length === 0) return; // no scopes — nothing to pick
    const parent = boardEl.parentElement;
    if (!parent) return;
    const pickerEl = parent.createDiv({ cls: "base-board-frontier-scopes" });
    parent.insertBefore(pickerEl, boardEl);

    const addChip = (
      key: string,
      label: string,
      count: number,
      depth: number,
      attention: boolean,
    ): void => {
      const chipEl = pickerEl.createEl("button", {
        cls: "base-board-frontier-scope",
        attr: { type: "button" },
      });
      if (key === activeScopeKey) {
        chipEl.addClass("base-board-frontier-scope--active");
      }
      if (attention) chipEl.addClass("base-board-frontier-scope--attention");
      if (depth > 0) chipEl.style.setProperty("--scope-depth", String(depth));
      chipEl.createSpan({
        cls: "base-board-frontier-scope-label",
        text: label,
      });
      chipEl.createSpan({
        cls: "base-board-frontier-scope-count",
        text: String(count),
      });
      chipEl.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        this.setFrontierScope(key);
      });
    };

    addChip(FRONTIER_SCOPE_ALL, "All work", totalFrontier, 0, false);
    for (const summary of summaries) {
      addChip(
        summary.key,
        summary.title,
        summary.frontierCount,
        summary.depth,
        summary.hasAttention,
      );
    }
  }

  /** Persists the chosen lens scope and re-renders the board. */
  private setFrontierScope(scopeKey: string): void {
    this.config?.set(CONFIG_KEY_FRONTIER_SCOPE, scopeKey);
    this.scheduleRender();
  }

  /** Buckets a live frontier leaf into a board column by its state + status. */
  private frontierLiveColumn(node: FrontierNode): string {
    const status = node.status?.trim().toLowerCase();
    if (node.state === "blocked" || node.state === "interrupted") {
      return "Blocked";
    }
    if (node.state === "awaiting" || status === "in review") {
      return "In Review";
    }
    if (
      engineIsActiveStatus(node.status) ||
      status === "flighting" ||
      status === "in review"
    ) {
      return "In Progress";
    }
    return "To Do";
  }

  /** Reads the whole dataset into the raw rows the frontier engine needs. */
  private collectFrontierRawNodes(): {
    raw: FrontierRawNode[];
    refByKey: Map<string, { file: TFile; entry: BasesEntry }>;
  } {
    const groupByProp = this.getGroupByProperty() ?? "status";
    const raw: FrontierRawNode[] = [];
    const refByKey = new Map<string, { file: TFile; entry: BasesEntry }>();
    for (const entry of this.getCurrentEntries()) {
      const file = entry.file;
      if (!(file instanceof TFile)) continue;
      const frontmatter = this.getFrontmatter(file);
      const title = this.cardManager.getCardTitle(entry);
      const id =
        typeof frontmatter?.id === "string" ? frontmatter.id.toLowerCase() : "";
      const identities = [
        file.path.replace(/\.md$/i, "").toLowerCase(),
        file.basename.toLowerCase(),
        title.toLowerCase(),
        id,
      ].filter((identity) => identity.length > 0);
      raw.push({
        key: file.path,
        title,
        identities,
        status: this.normalizeStatus(frontmatter?.[groupByProp]),
        kindExplicit: parseFrontmatterKind(frontmatter?.kind),
        parentKey: normalizeReference(frontmatter?.parent),
        dependsOnKeys: normalizeReferences(frontmatter?.depends_on),
        rollupToKeys: normalizeReferences(frontmatter?.rollup_to),
        compensatesKeys: normalizeReferences(frontmatter?.compensates),
      });
      refByKey.set(file.path, { file, entry });
    }
    return { raw, refByKey };
  }

  /** Builds the render model for a frontier card (breadcrumb + facets + tags). */
  private buildFrontierCard(
    node: FrontierNode,
    ref: { file: TFile; entry: BasesEntry },
    timestamp: Date | null,
  ): FrontierCardModel {
    const frontmatter = this.getFrontmatter(ref.file);
    const facets: { label: string; kind: string }[] = [];
    const people = frontmatter?.people;
    const peopleList = Array.isArray(people) ? people : people ? [people] : [];
    for (const person of peopleList) {
      const label = this.normalizeStatus(person);
      if (label) facets.push({ label, kind: "people" });
    }
    const repo = this.normalizeStatus(frontmatter?.repo);
    if (repo) facets.push({ label: repo, kind: "repo" });
    const kindLabel = this.normalizeStatus(frontmatter?.kind);
    if (kindLabel) facets.push({ label: kindLabel, kind: "kind" });

    const rankIndex = this.activeFrontierPriority.indexOf(ref.file.path);

    return {
      file: ref.file,
      entry: ref.entry,
      title: node.title,
      lineage: getFrontierLineage(node),
      status: node.status,
      state: node.state,
      facets,
      tags: this.tags.extractTagsFromFile(ref.file),
      priorityRank: rankIndex >= 0 ? rankIndex + 1 : null,
      timestamp,
    };
  }

  private renderFrontierColumn(
    boardEl: HTMLElement,
    columnName: string,
    cards: FrontierCardModel[],
    isHistory: boolean,
  ): void {
    const sorted = [...cards].sort((first, second) => {
      // Priority overlay (Step F): explicitly ranked cards float to the top in
      // rank order; everything else keeps the default ordering below.
      if (first.priorityRank !== null || second.priorityRank !== null) {
        if (first.priorityRank === null) return 1;
        if (second.priorityRank === null) return -1;
        if (first.priorityRank !== second.priorityRank) {
          return first.priorityRank - second.priorityRank;
        }
      }
      if (isHistory) {
        const firstTime = first.timestamp?.getTime() ?? 0;
        const secondTime = second.timestamp?.getTime() ?? 0;
        if (firstTime !== secondTime) return secondTime - firstTime;
      }
      return first.lineage
        .join(" › ")
        .localeCompare(second.lineage.join(" › "));
    });

    const columnEl = boardEl.createDiv({
      cls: isHistory
        ? "base-board-column base-board-frontier-column base-board-frontier-column--history"
        : "base-board-column base-board-frontier-column",
    });
    columnEl.dataset.columnName = columnName;

    const columnColor = getColumnColor(this.config, columnName);
    columnEl.style.setProperty("--column-color", columnColor);
    const accentEl = columnEl.createDiv({ cls: "base-board-column-accent" });
    accentEl.style.backgroundColor = columnColor;

    const headerEl = columnEl.createDiv({ cls: "base-board-column-header" });
    headerEl.style.setProperty("--base-board-column-color", columnColor);
    headerEl.createSpan({ cls: "base-board-column-title", text: columnName });
    headerEl.createSpan({
      cls: "base-board-column-count",
      text: String(sorted.length),
    });

    const cardsEl = columnEl.createDiv({ cls: "base-board-cards" });
    for (const card of sorted) {
      this.renderFrontierCard(cardsEl, card);
    }
  }

  private renderFrontierCard(
    cardsEl: HTMLElement,
    card: FrontierCardModel,
  ): void {
    const cardEl = cardsEl.createDiv({
      cls: "base-board-card base-board-frontier-card",
    });
    cardEl.dataset.filePath = card.file.path;
    const isPrioritized = card.priorityRank !== null;
    if (isPrioritized) cardEl.addClass("base-board-frontier-card--pinned");

    // Work lineage breadcrumb (replaces the old hierarchy tags).
    if (card.lineage.length > 1) {
      const crumbEl = cardEl.createDiv({
        cls: "base-board-frontier-crumb",
      });
      card.lineage.forEach((segment, index) => {
        const isLast = index === card.lineage.length - 1;
        if (isLast) return; // leaf is shown as the card title
        crumbEl.createSpan({
          cls: "base-board-frontier-seg",
          text: segment,
        });
        crumbEl.createSpan({
          cls: "base-board-frontier-sep",
          text: " › ",
        });
      });
    }

    const titleRow = cardEl.createDiv({ cls: "base-board-frontier-title-row" });
    if (isPrioritized) {
      titleRow.createSpan({
        cls: "base-board-frontier-rank",
        text: String(card.priorityRank),
      });
    }
    titleRow.createSpan({
      cls: "base-board-frontier-leaf",
      text: card.title,
    });
    const pinBtn = titleRow.createEl("button", {
      cls: isPrioritized
        ? "base-board-frontier-pin base-board-frontier-pin--active"
        : "base-board-frontier-pin",
      attr: {
        type: "button",
        "aria-label": isPrioritized ? "Remove priority" : "Pin to top",
        title: isPrioritized ? "Remove priority" : "Pin to top",
      },
    });
    setIcon(pinBtn, "lucide-pin");
    pinBtn.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleFrontierPriority(card.file.path);
    });

    const metaRow = cardEl.createDiv({ cls: "base-board-frontier-meta" });
    if (card.status) {
      metaRow.createSpan({
        cls: "base-board-frontier-status",
        text: card.status,
      });
    }
    if (card.timestamp) {
      metaRow.createSpan({
        cls: "base-board-frontier-time",
        text: this.formatArchiveDate(card.timestamp),
      });
    }

    if (card.facets.length > 0 || card.tags.length > 0) {
      const chipsEl = cardEl.createDiv({ cls: "base-board-frontier-chips" });
      for (const facet of card.facets) {
        chipsEl.createSpan({
          cls: `base-board-frontier-chip base-board-frontier-chip--${facet.kind}`,
          text: facet.label,
        });
      }
      for (const tag of card.tags) {
        chipsEl.createSpan({
          cls: "base-board-frontier-chip base-board-frontier-chip--tag",
          text: `#${tag}`,
        });
      }
    }

    cardEl.addEventListener("click", (event: MouseEvent) => {
      this.cardManager.openCardFile(card.file, event);
    });
  }

  /**
   * Priority overlay (Step F): toggles a card in today's ordered priority list
   * for the active scope. Pinning an unranked card promotes it to #1; clicking
   * a ranked card removes it. The overlay is ephemeral per `(scope, day)` and
   * lives in view config — it never touches durable `kanban_order`.
   */
  private toggleFrontierPriority(path: string): void {
    const scopeKey = this.activeFrontierScopeKey;
    const list = this.getFrontierPriorityList(scopeKey);
    const next = list.includes(path)
      ? list.filter((entry) => entry !== path)
      : [path, ...list];
    this.setFrontierPriority(scopeKey, next);
    this.scheduleRender();
  }

  /** Today's ordered priority paths for a scope (empty when unset). */
  private getFrontierPriorityList(scopeKey: string): string[] {
    const raw = this.config?.get(CONFIG_KEY_FRONTIER_PRIORITY);
    if (!raw || typeof raw !== "object") return [];
    const bucket = (raw as Record<string, unknown>)[
      this.frontierPriorityBucketKey(scopeKey)
    ];
    return Array.isArray(bucket)
      ? bucket.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  /**
   * Persists today's priority list for a scope, dropping every bucket from a
   * previous day so the overlay stays ephemeral (per `(scope, day)`).
   */
  private setFrontierPriority(scopeKey: string, paths: string[]): void {
    const raw = this.config?.get(CONFIG_KEY_FRONTIER_PRIORITY);
    const today = this.getTodayKey();
    const map: Record<string, string[]> = {};
    if (raw && typeof raw === "object") {
      const source = raw as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        if (!key.endsWith(`::${today}`)) continue; // prune past days
        const value = source[key];
        if (Array.isArray(value)) {
          map[key] = value.filter(
            (entry): entry is string => typeof entry === "string",
          );
        }
      }
    }
    const bucketKey = this.frontierPriorityBucketKey(scopeKey);
    if (paths.length > 0) map[bucketKey] = paths;
    else delete map[bucketKey];
    this.config?.set(CONFIG_KEY_FRONTIER_PRIORITY, map);
  }

  private frontierPriorityBucketKey(scopeKey: string): string {
    return `${scopeKey}::${this.getTodayKey()}`;
  }

  /** Local calendar day (YYYY-MM-DD) used to scope the priority overlay. */
  private getTodayKey(): string {
    const now = new Date();
    const pad = (value: number): string =>
      value < 10 ? `0${value}` : `${value}`;
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /**
   * The most recent time a note entered a status matching `matches` (a
   * transition whose `to` matches and `from` does not), if within `windowMs`.
   * Reads the event log (`status_history`).
   */
  private getStatusEnteredWithinWindow(
    file: TFile,
    matches: (status: string | null) => boolean,
    windowMs: number,
  ): Date | null {
    const groupByProp = this.getGroupByProperty();
    if (!groupByProp) return null;
    const propertyName =
      this.plugin.data_.transitionHistory.propertyName.trim();
    if (!propertyName) return null;

    const frontmatter = this.getFrontmatter(file);
    const rawHistory = frontmatter?.[propertyName];
    if (!Array.isArray(rawHistory)) return null;

    const records = (rawHistory as unknown[])
      .map((rawRecord) =>
        this.parseTransitionHistoryRecord(rawRecord, groupByProp),
      )
      .filter(
        (
          record,
        ): record is { from: string | null; to: string | null; at: Date } =>
          record !== null,
      )
      .sort((first, second) => first.at.getTime() - second.at.getTime());

    let enteredAt: Date | null = null;
    for (const record of records) {
      if (matches(record.to) && !matches(record.from)) {
        enteredAt = record.at;
      }
    }
    if (!enteredAt) return null;
    return Date.now() - enteredAt.getTime() <= windowMs ? enteredAt : null;
  }

  // ---------------------------------------------------------------------------
  //  Column & Filter management helpers
  // ---------------------------------------------------------------------------

  private handleColumnReorder(orderedNames: string[]): void {
    this.saveColumns(orderedNames);
    this.render();
  }

  /**
   * Persist the column list.
   *
   * Writes to two locations for compatibility:
   *  - BasesViewConfig (stored inside the .base file itself — portable)
   *  - Plugin data.json (legacy, kept so older board setups still work)
   */
  public saveColumns(columns: string[]): void {
    // Primary: persist in .base file via the official config API
    const toSave = columns.map((col) => (col === NO_VALUE_COLUMN ? "" : col));
    this.config?.set(CONFIG_KEY_COLUMNS, toSave);

    // Legacy fallback: also write to plugin data.json
    void this.plugin.saveColumnConfig(this.getBaseId(), { columns });
  }

  public updateColumnPreferences(oldName: string, newName: string): void {
    const collapsed = this.getCollapsedColumns();
    if (collapsed[oldName]) {
      delete collapsed[oldName];
      collapsed[newName] = true;
      this.config?.set(CONFIG_KEY_COLLAPSED_COLUMNS, collapsed);
    }
  }

  public removeColumnPreferences(columnName: string): void {
    const collapsed = this.getCollapsedColumns();
    if (collapsed[columnName]) {
      delete collapsed[columnName];
      this.config?.set(CONFIG_KEY_COLLAPSED_COLUMNS, collapsed);
    }
  }

  // ---------------------------------------------------------------------------
  //  Card drop handler (column move + reordering)
  // ---------------------------------------------------------------------------

  private async handleCardDrop(
    filePath: string,
    targetColumnName: string,
    orderedPaths: string[],
  ): Promise<void> {
    const groupByProp = this.getGroupByProperty();
    if (!groupByProp) {
      throw new Error("Cannot move a card without a group by property");
    }
    const isArchiveDrop = targetColumnName === ARCHIVE_DROP_COLUMN;
    const targetStatus = isArchiveDrop
      ? ARCHIVE_TARGET_STATUS
      : targetColumnName;

    // Snapshot the selection NOW, before any async work or re-render can clear it
    const selectedSnapshot = new Set(this.selectedCards);
    const isMultiDrag =
      selectedSnapshot.size > 1 && selectedSnapshot.has(filePath);

    // If the dragged card is part of a multi-selection, expand the drop to
    // include all selected cards. The dragged card goes where it was dropped
    // (already in orderedPaths); the rest of the selection is appended after.
    const otherSelected = isMultiDrag
      ? Array.from(selectedSnapshot).filter(
          (p) => p !== filePath && !orderedPaths.includes(p),
        )
      : [];

    // Insert co-selected cards right after the dragged card's position
    const fullOrderedPaths = [...orderedPaths];
    if (!fullOrderedPaths.includes(filePath)) fullOrderedPaths.push(filePath);
    if (otherSelected.length > 0) {
      const dropIdx = fullOrderedPaths.indexOf(filePath);
      const insertAt = dropIdx !== -1 ? dropIdx + 1 : fullOrderedPaths.length;
      fullOrderedPaths.splice(insertAt, 0, ...otherSelected);
    }

    const pathsToMove = isMultiDrag ? [filePath, ...otherSelected] : [filePath];
    for (const path of pathsToMove) {
      this.optimisticMoves.set(path, targetStatus);
    }
    this.optimisticColumnOrders.set(targetStatus, fullOrderedPaths);

    try {
      await this.applyBatchUpdate(async () => {
        // 1. Move all cards to the target column (dragged card + any co-selected)
        const movePromises = pathsToMove.map((fp) => {
          const file = this.app.vault.getAbstractFileByPath(fp);
          if (!file || !(file instanceof TFile)) return Promise.resolve();
          const sourceColumn = this.getCardSourceColumn(fp);
          return this.app.fileManager.processFrontMatter(
            file,
            (fm: Record<string, unknown>) => {
              if (sourceColumn !== targetStatus) {
                this.appendTransitionHistory(
                  fm,
                  groupByProp,
                  sourceColumn,
                  targetStatus,
                );
              }
              this.applyGroupByValue(fm, groupByProp, targetStatus);
              if (isArchiveDrop) fm[ARCHIVED_PROPERTY] = true;
              else delete fm[ARCHIVED_PROPERTY];
            },
          );
        });
        await Promise.all(movePromises);

        // 2. Update only the moved cards when the column already uses string
        // fractional keys. Numeric legacy columns are migrated once, in DOM order.
        await this.writeCardOrder(fullOrderedPaths, pathsToMove);
      });
    } catch (error) {
      this.clearOptimisticMoves(pathsToMove, targetStatus);
      this.scheduleRender();
      throw error;
    }

    // The optimistic DOM move remains visible until Bases acknowledges the
    // write through onDataUpdated(), which is the only fresh-data render path.
  }

  private acknowledgeOptimisticMoves(): void {
    const confirmedPaths: string[] = [];
    for (const [path, expectedColumn] of this.optimisticMoves) {
      if (
        this.findCardColumn(this.data?.groupedData ?? [], path) ===
        expectedColumn
      ) {
        confirmedPaths.push(path);
      }
    }
    for (const path of confirmedPaths) this.optimisticMoves.delete(path);

    for (const [columnName, orderedPaths] of this.optimisticColumnOrders) {
      if (orderedPaths.every((path) => !this.optimisticMoves.has(path))) {
        this.optimisticColumnOrders.delete(columnName);
      }
    }
  }

  private clearOptimisticMoves(paths: string[], columnName: string): void {
    for (const path of paths) this.optimisticMoves.delete(path);
    this.optimisticColumnOrders.delete(columnName);
  }

  /** Persist a contiguous block within an ordered column. */
  public async writeCardOrder(
    orderedPaths: string[],
    pathsToAssign: string[],
  ): Promise<void> {
    if (pathsToAssign.length === 0) return;

    const startIdx = orderedPaths.indexOf(pathsToAssign[0]);
    const prevPath = startIdx > 0 ? orderedPaths[startIdx - 1] : null;
    const nextPath =
      startIdx + pathsToAssign.length < orderedPaths.length
        ? orderedPaths[startIdx + pathsToAssign.length]
        : null;
    const existingPaths = orderedPaths.filter(
      (path) => !pathsToAssign.includes(path),
    );
    const hasLegacyOrder = existingPaths.some(
      (path) => !isOrderKey(this.getFileOrder(path)),
    );
    const pathsToWrite = hasLegacyOrder ? orderedPaths : pathsToAssign;
    const previousOrder = prevPath ? this.getFileOrder(prevPath) : null;
    const followingOrder = nextPath ? this.getFileOrder(nextPath) : null;
    const newOrders = hasLegacyOrder
      ? generateOrderKeys(null, null, orderedPaths.length)
      : generateOrderKeys(
          isOrderKey(previousOrder) ? previousOrder : null,
          isOrderKey(followingOrder) ? followingOrder : null,
          pathsToAssign.length,
        );

    await Promise.all(
      pathsToWrite.map((cardPath, index) => {
        const file = this.app.vault.getAbstractFileByPath(cardPath);
        if (!file || !(file instanceof TFile)) return Promise.resolve();
        const orderVal = hasLegacyOrder
          ? newOrders[index]
          : newOrders[pathsToAssign.indexOf(cardPath)];
        return this.app.fileManager.processFrontMatter(
          file,
          (fm: Record<string, unknown>) => {
            fm[ORDER_PROPERTY] = orderVal;
          },
        );
      }),
    );
  }

  /** Debounced render — coalesces multiple calls into one. */
  public scheduleRender(): void {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 50);
  }

  private getCardSourceColumn(filePath: string): string | null {
    return this.findCardColumn(this.currentGroups, filePath);
  }

  private findCardColumn(
    groups: BasesEntryGroup[],
    filePath: string,
  ): string | null {
    for (const group of groups) {
      for (const entry of group.entries) {
        if (entry.file?.path === filePath) {
          return this.getColumnName(group.key);
        }
      }
    }
    return null;
  }

  private appendTransitionHistory(
    fm: Record<string, unknown>,
    groupByProp: string,
    sourceColumn: string | null,
    targetColumnName: string,
  ): void {
    const settings = this.plugin.data_.transitionHistory;
    if (!settings.enabled) return;

    const propertyName = settings.propertyName.trim();
    if (!propertyName) return;

    const existingHistory = fm[propertyName];
    const history: unknown[] = [];

    if (Array.isArray(existingHistory)) {
      for (const item of existingHistory as unknown[]) {
        history.push(item);
      }
    } else if (existingHistory !== undefined && existingHistory !== null) {
      history.push(existingHistory);
    }

    const nodeId = this.ensureNodeId(fm);
    const entry = buildTransitionEvent({
      node: nodeId,
      from: sourceColumn === NO_VALUE_COLUMN ? null : sourceColumn,
      to: targetColumnName === NO_VALUE_COLUMN ? null : targetColumnName,
      property: groupByProp,
      source: "baseboard-drag-drop",
    });

    fm[propertyName] = [...history, entry];
  }

  /** Ensures the note carries a stable frontmatter `id`, backfilling one. */
  private ensureNodeId(fm: Record<string, unknown>): string {
    const existing = fm.id;
    if (typeof existing === "string" && existing.trim().length > 0) {
      return existing.trim();
    }
    const rawTitle =
      typeof fm.title === "string" && fm.title.trim()
        ? fm.title.trim()
        : "node";
    const slug =
      rawTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "node";
    const rand = Math.random().toString(36).slice(2, 6);
    const generated = `${slug}-${rand}`;
    fm.id = generated;
    return generated;
  }
}
