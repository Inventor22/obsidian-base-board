import {
  BasesEntry,
  BasesView,
  NullValue,
  QueryController,
  setIcon,
  TFile,
} from "obsidian";
import type BaseBoardPlugin from "./main";
import { DragDropManager } from "./drag-drop";
import { CardDetailModal } from "./card-detail-modal";

interface RolloutHistoryEntry {
  from: string | null;
  to: string | null;
  at: string;
  property: "rollout_ring";
  source: "baseboard-rollout-board";
}

interface RolloutItem {
  entry: BasesEntry;
  file: TFile;
  title: string;
  ring: string;
  order: number;
  status: string | null;
  feature: string | null;
}

const ROLLOUT_RING_PROPERTY = "rollout_ring";
const ROLLOUT_HISTORY_PROPERTY = "rollout_history";
const ROLLOUT_ENABLED_PROPERTY = "rollout_enabled";
const ROLLOUT_ORDER_PROPERTY = "rollout_order";
const ROLLOUT_COLUMNS = ["None", "Stage", "Canary", "Pilot", "Broad"];
const ROLLOUT_COLUMN_COLORS: Record<string, string> = {
  none: "#6b7280",
  stage: "#3f7d9a",
  canary: "#b08a3f",
  pilot: "#7a6fba",
  broad: "#4f8f6b",
};

export class RolloutView extends BasesView {
  type = "rollout";

  private plugin: BaseBoardPlugin;
  private scrollEl: HTMLElement;
  private containerEl: HTMLElement;
  private dragDropManager: DragDropManager;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private isUpdating = false;
  private pendingRender = false;

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    plugin: BaseBoardPlugin,
  ) {
    super(controller);
    this.plugin = plugin;
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({
      cls: "base-board-container base-board-rollout-container",
    });
    this.dragDropManager = new DragDropManager(this.app, {
      onCardDrop: (filePath, targetColumn, orderedPaths) =>
        this.handleCardDrop(filePath, targetColumn, orderedPaths),
      onColumnReorder: () => {},
      getSelectedCards: () => new Set(),
    });
  }

  onunload(): void {
    this.dragDropManager.destroy();
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    if (this.isUpdating) {
      this.pendingRender = true;
      return;
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 50);
  }

  private async applyBatchUpdate(
    updateFn: () => Promise<void> | void,
  ): Promise<void> {
    this.isUpdating = true;
    this.pendingRender = false;

    try {
      await updateFn();
    } finally {
      this.isUpdating = false;
    }

    if (this.pendingRender) {
      this.pendingRender = false;
      this.scheduleRender();
    }
  }

  public render(): void {
    const prevBoardEl = this.containerEl.querySelector(".base-board-board");
    const savedScrollLeft = prevBoardEl?.scrollLeft ?? 0;
    const savedScrollTop = this.scrollEl.scrollTop;

    this.containerEl.empty();

    const items = this.getRolloutItems();
    const boardEl = this.containerEl.createDiv({
      cls: "base-board-board base-board-rollout-board",
    });

    for (const columnName of ROLLOUT_COLUMNS) {
      this.renderRolloutColumn(boardEl, columnName, items);
    }

    this.dragDropManager.initBoard(boardEl);

    if (savedScrollLeft > 0 || savedScrollTop > 0) {
      window.requestAnimationFrame(() => {
        boardEl.scrollLeft = savedScrollLeft;
        this.scrollEl.scrollTop = savedScrollTop;
      });
    }
  }

  private renderRolloutColumn(
    boardEl: HTMLElement,
    columnName: string,
    items: RolloutItem[],
  ): void {
    const columnItems = items
      .filter((item) => item.ring === columnName)
      .sort((first, second) => {
        if (first.order !== second.order) return first.order - second.order;
        return first.title.localeCompare(second.title);
      });

    const columnEl = boardEl.createDiv({ cls: "base-board-column" });
    columnEl.dataset.columnName = columnName;
    const columnColor = this.getRolloutColumnColor(columnName);
    columnEl.style.setProperty("--column-color", columnColor);
    const accentEl = columnEl.createDiv({ cls: "base-board-column-accent" });
    accentEl.style.backgroundColor = columnColor;

    const headerEl = columnEl.createDiv({ cls: "base-board-column-header" });
    headerEl.style.setProperty("--base-board-column-color", columnColor);
    const dragHandle = headerEl.createDiv({
      cls: "base-board-column-drag-handle",
    });
    setIcon(dragHandle, "circle-dot");
    headerEl.createSpan({ text: columnName, cls: "base-board-column-title" });
    headerEl.createSpan({
      text: String(columnItems.length),
      cls: "base-board-column-count",
    });
    headerEl.createDiv({ cls: "base-board-header-spacer" });

    const cardsEl = columnEl.createDiv({ cls: "base-board-cards" });
    for (const item of columnItems) {
      this.renderRolloutCard(cardsEl, item, columnName);
    }
  }

  private renderRolloutCard(
    cardsEl: HTMLElement,
    item: RolloutItem,
    columnName: string,
  ): void {
    const cardEl = cardsEl.createDiv({
      cls: "base-board-card base-board-rollout-card",
    });
    cardEl.setAttr("draggable", "true");
    cardEl.dataset.filePath = item.file.path;
    cardEl.dataset.columnName = columnName;

    if (item.feature) {
      const breadcrumbEl = cardEl.createDiv({ cls: "base-board-card-hierarchy" });
      const iconEl = breadcrumbEl.createSpan({
        cls: "base-board-card-hierarchy-icon",
      });
      setIcon(iconEl, "lucide-corner-down-right");
      breadcrumbEl.createSpan({
        cls: "base-board-card-hierarchy-text",
        text: item.feature,
      });
    }

    const titleEl = cardEl.createDiv({ cls: "base-board-card-title" });
    titleEl.createSpan({ text: item.title });

    const propsEl = cardEl.createDiv({ cls: "base-board-card-props" });
    this.renderChip(propsEl, "status", item.status ?? "(No value)");
    this.renderChip(propsEl, "ring", item.ring);

    cardEl.addEventListener("click", (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        void this.app.workspace.getLeaf("tab").openFile(item.file);
        return;
      }
      new CardDetailModal(this.app, item.file).open();
    });
  }

  private renderChip(parentEl: HTMLElement, label: string, value: string): void {
    const chipEl = parentEl.createSpan({ cls: "base-board-card-chip" });
    chipEl.createSpan({ cls: "base-board-chip-label", text: label });
    chipEl.createSpan({ cls: "base-board-chip-value", text: value });
  }

  private getRolloutItems(): RolloutItem[] {
    const entries: BasesEntry[] = this.data?.data ?? [];
    const items: RolloutItem[] = [];

    for (const entry of entries) {
      const file = entry.file;
      if (!(file instanceof TFile)) continue;
      const frontmatter = this.getFrontmatter(file);
      if (!this.isRolloutEnabled(frontmatter)) continue;

      items.push({
        entry,
        file,
        title: this.getTitle(entry, file, frontmatter),
        ring: this.normalizeRing(frontmatter?.[ROLLOUT_RING_PROPERTY]),
        order: this.getRolloutOrder(frontmatter),
        status: this.normalizeText(frontmatter?.status),
        feature: this.getReferenceDisplay(frontmatter?.feature),
      });
    }

    return items;
  }

  private async handleCardDrop(
    filePath: string,
    targetColumn: string,
    orderedPaths: string[],
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;
    const nextRing = this.normalizeRing(targetColumn);

    await this.applyBatchUpdate(async () => {
      await this.updateRolloutRing(file, nextRing);
      await Promise.all(
        orderedPaths.map((orderedPath, order) => {
          const orderedFile = this.app.vault.getAbstractFileByPath(orderedPath);
          if (!(orderedFile instanceof TFile)) return Promise.resolve();
          return this.app.fileManager.processFrontMatter(
            orderedFile,
            (frontmatter) => {
              frontmatter[ROLLOUT_ORDER_PROPERTY] = order;
            },
          );
        }),
      );
    });

    this.render();
  }

  private async updateRolloutRing(file: TFile, nextRing: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const previousRing = this.normalizeRing(frontmatter[ROLLOUT_RING_PROPERTY]);
      if (previousRing === nextRing) return;

      frontmatter[ROLLOUT_ENABLED_PROPERTY] = true;
      frontmatter[ROLLOUT_RING_PROPERTY] = nextRing;
      const history = Array.isArray(frontmatter[ROLLOUT_HISTORY_PROPERTY])
        ? (frontmatter[ROLLOUT_HISTORY_PROPERTY] as unknown[])
        : [];
      const record: RolloutHistoryEntry = {
        from: previousRing === "None" ? null : previousRing,
        to: nextRing === "None" ? null : nextRing,
        at: new Date().toISOString(),
        property: ROLLOUT_RING_PROPERTY,
        source: "baseboard-rollout-board",
      };
      frontmatter[ROLLOUT_HISTORY_PROPERTY] = [...history, record];
    });
  }

  private getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? (frontmatter as Record<string, unknown>)
      : undefined;
  }

  private isRolloutEnabled(
    frontmatter: Record<string, unknown> | undefined,
  ): boolean {
    if (!frontmatter) return false;
    return frontmatter[ROLLOUT_ENABLED_PROPERTY] === true;
  }

  private getTitle(
    entry: BasesEntry,
    file: TFile,
    frontmatter: Record<string, unknown> | undefined,
  ): string {
    const title = this.normalizeText(frontmatter?.title);
    if (title) return title;
    return entry.file?.basename ?? file.basename;
  }

  private getRolloutOrder(
    frontmatter: Record<string, unknown> | undefined,
  ): number {
    const value = frontmatter?.[ROLLOUT_ORDER_PROPERTY];
    return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
  }

  private normalizeRing(value: unknown): string {
    const ring = this.normalizeText(value);
    const normalized = ring?.toLowerCase();
    if (!normalized || normalized === "none") return "None";
    const match = ROLLOUT_COLUMNS.find(
      (column) => column.toLowerCase() === normalized,
    );
    return match ?? ring ?? "None";
  }

  private getRolloutColumnColor(columnName: string): string {
    return ROLLOUT_COLUMN_COLORS[columnName.trim().toLowerCase()] ?? "#6b7280";
  }

  private normalizeText(value: unknown): string | null {
    if (value === undefined || value === null || value instanceof NullValue) {
      return null;
    }
    if (Array.isArray(value)) return this.normalizeText(value[0]);
    if (typeof value === "object" && "value" in value) {
      return this.normalizeText((value as Record<string, unknown>).value);
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

  private getReferenceDisplay(value: unknown): string | null {
    const raw = this.normalizeText(value);
    if (!raw) return null;
    const linkMatch = raw.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
    const display = linkMatch ? (linkMatch[2] ?? linkMatch[1]) : raw;
    const slashIndex = display.lastIndexOf("/");
    return slashIndex >= 0 ? display.slice(slashIndex + 1) : display;
  }
}
