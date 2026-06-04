import {
  BasesEntry,
  BasesPropertyId,
  DateValue,
  LinkValue,
  ListValue,
  NullValue,
  setIcon,
  TFile,
  Notice,
  Menu,
  Value,
  Keymap,
} from "obsidian";
import { KanbanView } from "./kanban-view";
import { NO_VALUE_COLUMN, ORDER_PROPERTY, sanitizeFilename } from "./constants";
import { relativeLuminance } from "./color-utils";
import { CardDetailModal } from "./card-detail-modal";

// Format a Value for chip display:
//   - DateValue    → relative ("3 days ago")
//   - LinkValue    → alias if set, otherwise basename without .md extension
//                    (e.g. [[folder/Mario]] → "Mario", [[Welcome|Alias]] → "Alias")
//   - ListValue    → comma-separated list of the above, applied recursively
//   - everything else → toString() (existing behaviour)
function formatValueForChip(val: Value): string {
  if (val instanceof DateValue) {
    return val.relative();
  }
  if (val instanceof LinkValue) {
    const raw = val.toString();
    const match = raw.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
    if (match) {
      const target = match[1];
      const alias = match[2];
      if (alias) return alias;
      const basename = target.split("/").pop() ?? target;
      return basename.replace(/\.md$/, "");
    }
    return raw;
  }
  if (val instanceof ListValue) {
    const parts: string[] = [];
    const len = val.length();
    for (let i = 0; i < len; i++) {
      const item = val.get(i);
      if (!item || item instanceof NullValue || !item.isTruthy()) continue;
      parts.push(formatValueForChip(item));
    }
    return parts.join(", ");
  }
  return val.toString();
}

// File properties that are redundant (shown as the card title) or are
// complex list types that don't render usefully as a short chip value.
const FILE_PROPS_TO_SKIP = new Set([
  "name",
  "basename",
  "fullname",
  "ext",
  "extension",
  "path",
  "links",
  "backlinks",
  "inlinks",
  "outlinks",
  "embeds",
  "tags",
]);

const HIERARCHY_PROPS = new Set([
  "parent",
  "parent_task",
  "parentTask",
  "feature",
]);
const HIERARCHY_COLOR_PROPS = new Set([
  "project_color",
  "projectColor",
  "hierarchy_color",
  "hierarchyColor",
]);
const DEFAULT_TASK_TAG = "task";
const PROJECT_COLOR_PALETTE = [
  "#3f7d9a",
  "#7a6fba",
  "#4f8f6b",
  "#b0764f",
  "#9a5f7d",
  "#6f8c3f",
  "#b08a3f",
  "#4d8c8a",
];
const OUTLINE_PREVIEW_LIMIT = 7;

interface CardHierarchyEntry {
  entry: BasesEntry;
  file: TFile;
  title: string;
  parentKey: string | null;
  projectColor: string | null;
  currentStatus: string;
}

interface CardOutlineNode {
  task: CardHierarchyEntry;
  children: CardOutlineNode[];
}

interface CardHierarchyInfo {
  parentTitles: string[];
  directChildPaths: string[];
  descendantCount: number;
  outlineNodes: CardOutlineNode[];
  projectColor: string | null;
  depth: number;
}

export class CardManager {
  private view: KanbanView;
  private collapsedOutlines: Set<string> = new Set();

  constructor(view: KanbanView) {
    this.view = view;
  }

  public renderCard(
    cardsEl: HTMLElement,
    entry: BasesEntry,
    columnName: string,
  ): void {
    const filePath = entry.file?.path ?? "";
    const cardEl = cardsEl.createDiv({ cls: "base-board-card" });
    cardEl.setAttr("draggable", "true");
    cardEl.dataset.filePath = filePath;
    cardEl.dataset.columnName = columnName;

    // Open the note on click; guard against accidental clicks after a drag
    let dragging = false;
    cardEl.addEventListener("dragstart", () => {
      dragging = true;
    });
    cardEl.addEventListener("dragend", () => {
      window.setTimeout(() => {
        dragging = false;
      }, 0);
    });

    cardEl.addEventListener("click", (e: MouseEvent) => {
      if (dragging) return;

      const isAlt = e.altKey;
      const isShift = e.shiftKey;
      const isMod = e.ctrlKey || e.metaKey;

      if ((isAlt || isShift) && !isMod) {
        e.preventDefault();
        this.handleCardSelect(filePath, columnName, isShift);
        return;
      }

      // If there are selected cards, clear them on a plain click instead of opening
      if (this.view.selectedCards.size > 0) {
        this.clearSelection();
        return;
      }

      const file = this.view.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      this.openCardFile(file, e);
    });

    // Middle-click → always open in new tab
    cardEl.addEventListener("auxclick", (e: MouseEvent) => {
      if (e.button !== 1) return;
      const file = this.view.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;
      void this.view.app.workspace.getLeaf("tab").openFile(file);
    });

    // Keyboard: Escape clears multi-selection when a card is focused
    cardEl.setAttribute("tabindex", "-1");
    cardEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.view.selectedCards.size > 0) {
        e.preventDefault();
        this.clearSelection();
      }
    });

    // Hover → native Obsidian page-preview popover (same as hovering a [[wikilink]])
    // Use mouseenter (not mouseover) — mouseover bubbles from every child element
    // and would re-trigger the preview on each chip/tag/title crossing.
    cardEl.addEventListener("mouseenter", (evt: MouseEvent) => {
      if (!filePath) return;
      this.view.app.workspace.trigger("hover-link", {
        event: evt,
        source: "base-board",
        hoverParent: this.view,
        targetEl: cardEl,
        linktext: filePath,
      });
    });

    // Right-click → batch move menu when cards are selected, otherwise standard file menu
    cardEl.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      const file = this.view.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      // If this card is part of a multi-selection, show the batch move menu
      if (
        this.view.selectedCards.size > 1 &&
        this.view.selectedCards.has(filePath)
      ) {
        this.showBatchMoveMenu(e);
        return;
      }

      const menu = new Menu();
      this.view.app.workspace.trigger(
        "file-menu",
        menu,
        file,
        "base-board-card",
        this.view.app.workspace.getMostRecentLeaf(),
      );
      menu.showAtMouseEvent(e);
    });

    const tagContainerEl = cardEl.createDiv({
      cls: "base-board-tag-container",
    });
    const file = this.view.app.vault.getAbstractFileByPath(filePath);
    const hierarchyInfo =
      file instanceof TFile
        ? this.getCardHierarchyInfo(file.path)
        : null;
    if (hierarchyInfo && hierarchyInfo.directChildPaths.length > 0) {
      cardEl.addClass("base-board-card--parent");
    }
    if (hierarchyInfo?.projectColor) {
      cardEl.addClass("base-board-card--hierarchy-color");
      cardEl.style.setProperty(
        "--card-hierarchy-color",
        hierarchyInfo.projectColor,
      );
      cardEl.style.setProperty(
        "--card-hierarchy-tint-strength",
        this.getHierarchyTintStrength(hierarchyInfo.depth),
      );
    }

    if (file instanceof TFile) {
      const fileTags = this.view.tags.extractTagsFromFile(file);
      for (const tag of fileTags) {
        const tagEl = tagContainerEl.createSpan({
          cls: "base-board-card-tag",
          text: tag,
        });
        const color = this.view.tags.getColorForTag(tag);
        if (color) {
          tagEl.style.setProperty("--tag-color", color);
          if (relativeLuminance(color) === "dark") {
            tagEl.addClass("base-board-card-tag-light");
          } else {
            tagEl.addClass("base-board-card-tag-dark");
          }
        }
      }
    }

    if (hierarchyInfo && hierarchyInfo.parentTitles.length > 0) {
      const breadcrumbEl = cardEl.createDiv({
        cls: "base-board-card-hierarchy",
      });
      const iconEl = breadcrumbEl.createSpan({
        cls: "base-board-card-hierarchy-icon",
      });
      setIcon(iconEl, "lucide-corner-down-right");
      const breadcrumb = hierarchyInfo.parentTitles.join(" / ");
      breadcrumbEl.createSpan({
        cls: "base-board-card-hierarchy-text",
        text: breadcrumb,
      });
      breadcrumbEl.setAttr("title", breadcrumb);
    }

    const titleEl = cardEl.createDiv({ cls: "base-board-card-title" });

    // Respect cardTitleProperty if configured — use a frontmatter property
    // (e.g. "title") as the card heading instead of the filename.
    const cardTitle = this.getCardTitle(entry);
    titleEl.createSpan({ text: cardTitle });

    if (hierarchyInfo && hierarchyInfo.directChildPaths.length > 0) {
      this.renderChildOutlineToggle(titleEl, hierarchyInfo.directChildPaths);
    }

    if (hierarchyInfo && hierarchyInfo.outlineNodes.length > 0) {
      this.renderDescendantOutline(cardEl, filePath, hierarchyInfo);
    }

    // ---- Edit button (visible on hover) ----
    const editBtn = cardEl.createDiv({ cls: "base-board-card-edit-btn" });
    setIcon(editBtn, "lucide-pencil");
    editBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation(); // Don't open the note
      this.showCardActionMenu(editBtn, filePath, titleEl);
    });

    // ---- Property chips ----
    const propsEl = cardEl.createDiv({ cls: "base-board-card-props" });
    const groupByProp = this.view.getGroupByProperty();
    const visibleProps: BasesPropertyId[] = this.view.config.getOrder();

    // Collect eligible chip descriptors in one pass so filtering logic lives
    // in one place.  No DOM is created yet.
    interface ChipDescriptor {
      propId: string;
      displayName: string;
      display: string;
    }

    const chips: ChipDescriptor[] = [];
    for (const propId of visibleProps) {
      if (chips.length >= 6) break;
      if (propId.startsWith("file.")) {
        if (FILE_PROPS_TO_SKIP.has(propId.slice(5))) continue;
      }
      const propName = propId.startsWith("note.") ? propId.slice(5) : propId;
      if (groupByProp && propName === groupByProp) continue;
      if (propName === ORDER_PROPERTY) continue;
      if (HIERARCHY_PROPS.has(propName)) continue;
      if (HIERARCHY_COLOR_PROPS.has(propName)) continue;

      const val = entry.getValue(propId);
      if (!val || val instanceof NullValue || !val.isTruthy()) continue;
      const display = formatValueForChip(val);
      if (!display) continue;

      chips.push({
        propId,
        displayName: this.view.config.getDisplayName(propId),
        display,
      });
    }

    const CHIP_VISIBLE = 4;

    // Render visible chips.
    for (let i = 0; i < chips.length && i < CHIP_VISIBLE; i++) {
      const { displayName, display, propId } = chips[i];
      this.renderChip(propsEl, displayName, display, propId);
    }

    // Overflow chips (if any) go into a collapsible container.
    let overflowEl: HTMLDivElement | null = null;
    for (let i = CHIP_VISIBLE; i < chips.length; i++) {
      if (!overflowEl) {
        overflowEl = propsEl.createDiv({
          cls: "base-board-card-chips-overflow",
        });
      }
      const { displayName, display, propId } = chips[i];
      this.renderChip(overflowEl, displayName, display, propId);
    }

    // ---- Expand toggle when chips exceed visible threshold ----
    if (overflowEl) {
      const overflowCount = chips.length - CHIP_VISIBLE;
      const toggleBtn = propsEl.createSpan({
        cls: "base-board-card-chip-more",
      });
      toggleBtn.setText(`+${overflowCount} more`);
      toggleBtn.addEventListener("click", (e: MouseEvent) => {
        e.stopPropagation();
        const expanded = overflowEl.classList.toggle(
          "base-board-card-chips-overflow--expanded",
        );
        toggleBtn.setText(expanded ? "show less" : `+${overflowCount} more`);
      });
    }
  }

  /** Create a single chip span with label + value inside the given parent. */
  private renderChip(
    parent: HTMLElement,
    label: string,
    value: string,
    propId?: string,
  ): HTMLElement {
    const chip = parent.createSpan({ cls: "base-board-card-chip" });
    if (propId) chip.setAttr("data-property-id", propId);
    chip.createSpan({ text: label, cls: "base-board-chip-label" });
    chip.createSpan({ text: value, cls: "base-board-chip-value" });
    return chip;
  }

  private renderDescendantOutline(
    cardEl: HTMLElement,
    filePath: string,
    hierarchyInfo: CardHierarchyInfo,
  ): void {
    const collapseKey = this.getRootOutlineCollapseKey(filePath);
    const isCollapsed = this.collapsedOutlines.has(collapseKey);
    const outlineEl = cardEl.createDiv({
      cls: "base-board-card-outline",
    });
    if (isCollapsed) {
      outlineEl.addClass("base-board-card-outline--collapsed");
    }
    const summaryEl = outlineEl.createDiv({
      cls: "base-board-card-outline-summary",
    });
    const descendantLabel = `${hierarchyInfo.descendantCount} ${
      hierarchyInfo.descendantCount === 1 ? "descendant" : "descendants"
    }`;
    const rootToggleEl = summaryEl.createEl("button", {
      cls: "base-board-card-outline-toggle",
      attr: {
        type: "button",
        title: isCollapsed
          ? "Expand descendant outline"
          : "Collapse descendant outline",
      },
    });
    setIcon(
      rootToggleEl.createSpan(),
      isCollapsed ? "lucide-chevron-right" : "lucide-chevron-down",
    );
    rootToggleEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleOutlineNode(collapseKey);
    });
    summaryEl.createSpan({
      cls: "base-board-card-outline-count",
      text: descendantLabel,
    });

    if (isCollapsed) return;

    const rows = this.flattenOutlineNodes(
      hierarchyInfo.outlineNodes,
      0,
      filePath,
    );
    const listEl = outlineEl.createDiv({ cls: "base-board-card-outline-list" });
    const overflowRows: HTMLElement[] = [];
    rows.forEach(({ node, depth }, index) => {
      const hasChildren = node.children.length > 0;
      const nodeCollapseKey = this.getNestedOutlineCollapseKey(
        filePath,
        node.task.file.path,
      );
      const isNodeCollapsed = this.collapsedOutlines.has(nodeCollapseKey);
      const rowEl = listEl.createDiv({ cls: "base-board-card-outline-row" });
      if (hasChildren) {
        rowEl.addClass("base-board-card-outline-row--parent");
      }
      rowEl.style.setProperty("--outline-depth", String(Math.min(depth, 4)));
      rowEl.setAttr("role", "button");
      rowEl.setAttr("tabindex", "0");
      rowEl.setAttr("title", `${node.task.title} - ${node.task.currentStatus}`);
      if (index >= OUTLINE_PREVIEW_LIMIT) {
        rowEl.addClass("base-board-card-outline-row--hidden");
        overflowRows.push(rowEl);
      }

      const markerEl = rowEl.createSpan({
        cls: "base-board-card-outline-marker",
      });
      if (hasChildren) {
        const toggleEl = markerEl.createEl("button", {
          cls: "base-board-card-outline-toggle",
          attr: {
            type: "button",
            title: isNodeCollapsed
              ? "Expand child tasks"
              : "Collapse child tasks",
          },
        });
        setIcon(
          toggleEl.createSpan(),
          isNodeCollapsed ? "lucide-chevron-right" : "lucide-chevron-down",
        );
        toggleEl.addEventListener("click", (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          this.toggleOutlineNode(nodeCollapseKey);
        });
      } else {
        setIcon(markerEl, "lucide-dot");
      }
      if (hasChildren) {
        this.renderChildOutlineToggle(
          rowEl,
          node.children.map((child) => child.task.file.path),
        );
      } else {
        rowEl.createSpan({ cls: "base-board-card-child-outline-spacer" });
      }
      rowEl.createSpan({
        cls: "base-board-card-outline-title",
        text: node.task.title,
      });
      rowEl.createSpan({
        cls: "base-board-card-outline-status",
        text: node.task.currentStatus,
      });

      rowEl.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.openCardFile(node.task.file, event);
      });
      rowEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        this.openCardFile(node.task.file);
      });
    });

    if (overflowRows.length === 0) return;

    const overflowToggleEl = outlineEl.createEl("button", {
      cls: "base-board-card-outline-more",
      attr: { type: "button" },
      text: `+${overflowRows.length} more`,
    });
    overflowToggleEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = overflowToggleEl.classList.toggle(
        "base-board-card-outline-more--expanded",
      );
      overflowRows.forEach((rowEl) => {
        rowEl.toggleClass("base-board-card-outline-row--hidden", !expanded);
      });
      overflowToggleEl.setText(expanded ? "show less" : `+${overflowRows.length} more`);
    });
  }

  private renderChildOutlineToggle(
    parentEl: HTMLElement,
    childPaths: string[],
  ): void {
    const toggleEl = parentEl.createEl("button", {
      cls: "base-board-card-child-outline-toggle",
      attr: { type: "button" },
    });
    toggleEl.dataset.childPaths = JSON.stringify(childPaths);
    const iconEl = toggleEl.createSpan({
      cls: "base-board-card-child-outline-toggle-icon",
    });
    this.syncChildOutlineToggle(toggleEl, iconEl, childPaths);
    toggleEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.focusChildCards(childPaths);
      this.syncChildOutlineToggles();
    });
  }

  private toggleOutlineNode(collapseKey: string): void {
    if (this.collapsedOutlines.has(collapseKey)) {
      this.collapsedOutlines.delete(collapseKey);
    } else {
      this.collapsedOutlines.add(collapseKey);
    }
    this.view.scheduleRender();
  }

  private getRootOutlineCollapseKey(filePath: string): string {
    return `root:${filePath}`;
  }

  private getNestedOutlineCollapseKey(
    rootFilePath: string,
    nodeFilePath: string,
  ): string {
    return `nested:${rootFilePath}:${nodeFilePath}`;
  }

  public openCardFile(file: TFile, event?: MouseEvent): void {
    const mod = event ? Keymap.isModEvent(event) : false;
    if (mod) {
      event?.preventDefault();
      void this.view.app.workspace.getLeaf(mod).openFile(file);
      return;
    }

    const openBehavior = this.view.getCardOpenBehavior();
    if (openBehavior === "split") {
      if (this.view.detailLeaf && this.view.isLeafAttached(this.view.detailLeaf)) {
        void this.view.detailLeaf.openFile(file);
      } else {
        this.view.detailLeaf = this.view.app.workspace.getLeaf(
          "split",
          "vertical",
        );
        void this.view.detailLeaf.openFile(file);
      }
    } else if (openBehavior === "tab") {
      void this.view.app.workspace.getLeaf("tab").openFile(file);
    } else if (openBehavior === "active") {
      void this.view.app.workspace.getLeaf(false).openFile(file);
    } else {
      new CardDetailModal(this.view.app, file, this.view).open();
    }
  }

  private flattenOutlineNodes(
    nodes: CardOutlineNode[],
    depth: number,
    rootFilePath: string,
  ): Array<{ node: CardOutlineNode; depth: number }> {
    const rows: Array<{ node: CardOutlineNode; depth: number }> = [];
    for (const node of nodes) {
      rows.push({ node, depth });
      const collapseKey = this.getNestedOutlineCollapseKey(
        rootFilePath,
        node.task.file.path,
      );
      if (!this.collapsedOutlines.has(collapseKey)) {
        rows.push(
          ...this.flattenOutlineNodes(node.children, depth + 1, rootFilePath),
        );
      }
    }
    return rows;
  }

  public getCardTitle(entry: BasesEntry): string {
    let cardTitle = entry.file?.basename ?? "Untitled";
    const titleProp = this.view.config.get("cardTitleProperty") as
      | string
      | undefined;
    if (!titleProp) return cardTitle;

    const propId = titleProp.startsWith("note.")
      ? titleProp
      : `note.${titleProp}`;
    const value = entry.getValue(propId as BasesPropertyId);
    if (value && !(value instanceof NullValue) && value.isTruthy()) {
      cardTitle = formatValueForChip(value);
    }
    return cardTitle;
  }

  private getCardHierarchyInfo(filePath: string): CardHierarchyInfo | null {
    const entries = this.getHierarchyEntries();
    const entriesByPath = new Map<string, CardHierarchyEntry>();
    const entriesByIdentity = new Map<string, CardHierarchyEntry>();

    for (const hierarchyEntry of entries) {
      entriesByPath.set(hierarchyEntry.file.path, hierarchyEntry);
      for (const identity of this.getCardIdentities(hierarchyEntry)) {
        entriesByIdentity.set(identity, hierarchyEntry);
      }
    }

    const current = entriesByPath.get(filePath);
    if (!current) return null;

    const directChildPaths = entries
      .filter((candidate) => {
        if (!candidate.parentKey) return false;
        const parent = entriesByIdentity.get(candidate.parentKey);
        return parent?.file.path === current.file.path;
      })
      .map((candidate) => candidate.file.path);
    const directChildren = entries.filter((candidate) =>
      this.isDirectChildOf(candidate, current, entriesByIdentity),
    );
    const outlineNodes = this.getOutlineNodes(
      directChildren,
      entries,
      entriesByIdentity,
      new Set([current.file.path]),
    );
    const descendants = this.getDescendantEntries(outlineNodes);

    const parentTitles = this.getParentTitles(
      current,
      entriesByIdentity,
    );
    const hierarchyRoot = this.getHierarchyRoot(current, entriesByIdentity);
    const participatesInHierarchy =
      parentTitles.length > 0 || directChildPaths.length > 0;
    const projectColor = participatesInHierarchy
      ? (hierarchyRoot.root.projectColor ??
        this.getGeneratedProjectColor(hierarchyRoot.root))
      : current.projectColor;

    return {
      parentTitles,
      directChildPaths,
      descendantCount: descendants.length,
      outlineNodes,
      projectColor,
      depth: hierarchyRoot.depth,
    };
  }

  private getHierarchyEntries(): CardHierarchyEntry[] {
    const entries: CardHierarchyEntry[] = [];
    for (const group of this.view.currentGroups) {
      for (const entry of group.entries) {
        const file = entry.file;
        if (!(file instanceof TFile)) continue;
        entries.push({
          entry,
          file,
          title: this.getCardTitle(entry),
          parentKey: this.getParentKey(file),
          projectColor: this.getProjectColor(file),
          currentStatus: this.getColumnName(group.key),
        });
      }
    }
    return entries;
  }

  private isDirectChildOf(
    candidate: CardHierarchyEntry,
    parent: CardHierarchyEntry,
    entriesByIdentity: Map<string, CardHierarchyEntry>,
  ): boolean {
    if (!candidate.parentKey) return false;
    const resolvedParent = entriesByIdentity.get(candidate.parentKey);
    return resolvedParent?.file.path === parent.file.path;
  }

  private getOutlineNodes(
    entries: CardHierarchyEntry[],
    allEntries: CardHierarchyEntry[],
    entriesByIdentity: Map<string, CardHierarchyEntry>,
    visitedPaths: Set<string>,
  ): CardOutlineNode[] {
    return entries.map((entry) => {
      const nextVisitedPaths = new Set(visitedPaths);
      nextVisitedPaths.add(entry.file.path);
      const children = allEntries.filter((candidate) => {
        if (nextVisitedPaths.has(candidate.file.path)) return false;
        return this.isDirectChildOf(candidate, entry, entriesByIdentity);
      });
      return {
        task: entry,
        children: this.getOutlineNodes(
          children,
          allEntries,
          entriesByIdentity,
          nextVisitedPaths,
        ),
      };
    });
  }

  private getDescendantEntries(nodes: CardOutlineNode[]): CardHierarchyEntry[] {
    const descendants: CardHierarchyEntry[] = [];
    for (const node of nodes) {
      descendants.push(node.task);
      descendants.push(...this.getDescendantEntries(node.children));
    }
    return descendants;
  }

  private getParentTitles(
    entry: CardHierarchyEntry,
    entriesByIdentity: Map<string, CardHierarchyEntry>,
  ): string[] {
    const titles: string[] = [];
    const visitedPaths = new Set([entry.file.path]);
    let parentKey = entry.parentKey;

    while (parentKey) {
      const parent = entriesByIdentity.get(parentKey);
      if (!parent || visitedPaths.has(parent.file.path)) {
        if (titles.length === 0) {
          const parentTitle = this.getParentDisplayTitle(entry.file);
          if (parentTitle) titles.push(parentTitle);
        }
        break;
      }

      titles.push(parent.title);
      visitedPaths.add(parent.file.path);
      parentKey = parent.parentKey;
    }

    return titles.reverse();
  }

  private getHierarchyRoot(
    entry: CardHierarchyEntry,
    entriesByIdentity: Map<string, CardHierarchyEntry>,
  ): { root: CardHierarchyEntry; depth: number } {
    const visitedPaths = new Set([entry.file.path]);
    let root = entry;
    let depth = 0;

    while (root.parentKey) {
      const parent = entriesByIdentity.get(root.parentKey);
      if (!parent || visitedPaths.has(parent.file.path)) break;

      root = parent;
      depth++;
      visitedPaths.add(parent.file.path);
    }

    return { root, depth };
  }

  private getHierarchyTintStrength(depth: number): string {
    return `${Math.max(5, 18 - depth * 5)}%`;
  }

  private getProjectColor(file: TFile): string | null {
    const frontmatter = this.getFrontmatter(file);
    const value =
      frontmatter?.project_color ??
      frontmatter?.projectColor ??
      frontmatter?.hierarchy_color ??
      frontmatter?.hierarchyColor;
    return this.normalizeHexColor(value);
  }

  private normalizeHexColor(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const color = value.trim();
    if (!/^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(color)) return null;
    return color.length === 4
      ? color.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3")
      : color;
  }

  private getGeneratedProjectColor(entry: CardHierarchyEntry): string {
    const seed = this.getProjectColorSeed(entry);
    let hash = 0;
    for (const character of seed) {
      hash = (hash * 31 + character.charCodeAt(0)) % 1000000007;
    }
    return PROJECT_COLOR_PALETTE[hash % PROJECT_COLOR_PALETTE.length];
  }

  private getProjectColorSeed(entry: CardHierarchyEntry): string {
    const frontmatter = this.getFrontmatter(entry.file);
    const id = frontmatter?.id;
    return typeof id === "string" && id.trim()
      ? id.trim()
      : entry.title || entry.file.path;
  }

  private getColumnName(key: unknown): string {
    if (key === undefined || key === null || key instanceof NullValue) {
      return NO_VALUE_COLUMN;
    }
    if (typeof key === "object" && key !== null) {
      if ("value" in key) {
        const value = (key as Record<string, unknown>).value;
        return String(value);
      }
      // Bases group-key objects expose the column name via toString()
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Bases-controlled object with custom toString
      return String(key);
    }
    if (typeof key === "string") return key;
    if (typeof key === "number" || typeof key === "boolean") return String(key);
    return "";
  }

  private focusChildCards(childPaths: string[]): void {
    const childPathSet = new Set(childPaths);
    const selectedCards = this.view.selectedCards;
    const shouldClearChildren =
      childPaths.length > 0 &&
      childPaths.every((childPath) => selectedCards.has(childPath));

    if (shouldClearChildren) {
      for (const childPath of childPaths) {
        selectedCards.delete(childPath);
      }
    } else {
      selectedCards.clear();
      for (const childPath of childPaths) {
        selectedCards.add(childPath);
      }
    }

    const selectedChildEls: HTMLElement[] = [];
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card")
      .forEach((cardEl) => {
        const filePath = cardEl.dataset.filePath ?? "";
        if (selectedCards.has(filePath)) {
          cardEl.addClass("base-board-card--selected");
          if (childPathSet.has(filePath)) selectedChildEls.push(cardEl);
        } else {
          cardEl.removeClass("base-board-card--selected");
        }
      });

    if (shouldClearChildren) return;

    const firstChildEl = selectedChildEls[0];
    firstChildEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    firstChildEl?.focus({ preventScroll: true });
  }

  private syncChildOutlineToggles(): void {
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card-child-outline-toggle")
      .forEach((toggleEl) => {
        const iconEl = toggleEl.querySelector<HTMLElement>(
          ".base-board-card-child-outline-toggle-icon",
        );
        if (!iconEl) return;
        const rawChildPaths = toggleEl.dataset.childPaths;
        if (!rawChildPaths) return;

        const childPaths = this.parseChildPaths(rawChildPaths);
        this.syncChildOutlineToggle(toggleEl, iconEl, childPaths);
      });
  }

  private syncChildOutlineToggle(
    toggleEl: HTMLElement,
    iconEl: HTMLElement,
    childPaths: string[],
  ): void {
    const outlined = this.areChildCardsOutlined(childPaths);
    setIcon(iconEl, outlined ? "lucide-eye" : "lucide-eye-off");
    toggleEl.toggleClass("is-active", outlined);
    toggleEl.setAttr(
      "title",
      outlined ? "Hide child outlines" : "Show child outlines",
    );
  }

  private areChildCardsOutlined(childPaths: string[]): boolean {
    return (
      childPaths.length > 0 &&
      childPaths.every((childPath) => this.view.selectedCards.has(childPath))
    );
  }

  private parseChildPaths(rawChildPaths: string): string[] {
    try {
      const parsed: unknown = JSON.parse(rawChildPaths);
      return Array.isArray(parsed)
        ? parsed.filter((path): path is string => typeof path === "string")
        : [];
    } catch {
      return [];
    }
  }

  private getParentKey(file: TFile): string | null {
    const value = this.getParentValue(file);
    return this.normalizeReference(value);
  }

  private getParentValue(file: TFile): unknown {
    const frontmatter = this.getFrontmatter(file);
    return (
      frontmatter?.parent ??
      frontmatter?.parent_task ??
      frontmatter?.parentTask ??
      frontmatter?.feature
    );
  }

  private getFrontmatter(file: TFile): Record<string, unknown> | undefined {
    const frontmatter = this.view.app.metadataCache.getFileCache(
      file,
    )?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? frontmatter
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

  private getParentDisplayTitle(file: TFile): string | null {
    const value = this.getParentValue(file);
    const firstValue = Array.isArray(value) ? (value as unknown[])[0] : value;
    if (typeof firstValue !== "string") return null;
    let display = firstValue.trim();
    if (!display) return null;

    const linkMatch = display.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
    if (linkMatch) display = linkMatch[2] ?? linkMatch[1];
    display = display.replace(/\.md$/i, "");
    const slashIndex = display.lastIndexOf("/");
    if (slashIndex >= 0) display = display.slice(slashIndex + 1);
    return display;
  }

  private getCardIdentities(entry: CardHierarchyEntry): string[] {
    return [
      entry.file.path.replace(/\.md$/i, "").toLowerCase(),
      entry.file.basename.toLowerCase(),
      entry.title.toLowerCase(),
    ];
  }

  private showCardActionMenu(
    anchorEl: HTMLElement,
    filePath: string,
    titleEl: HTMLElement,
  ): void {
    const file = this.view.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;

    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle("Edit tags")
        .setIcon("lucide-tags")
        .onClick(() => {
          this.view.tags.promptEditTags(file);
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Open")
        .setIcon("lucide-file-text")
        .onClick(() => {
          const openBehavior = this.view.getCardOpenBehavior();
          if (openBehavior === "split") {
            if (
              this.view.detailLeaf &&
              this.view.isLeafAttached(this.view.detailLeaf)
            ) {
              void this.view.detailLeaf.openFile(file);
            } else {
              this.view.detailLeaf = this.view.app.workspace.getLeaf(
                "split",
                "vertical",
              );
              void this.view.detailLeaf.openFile(file);
            }
          } else if (openBehavior === "tab") {
            void this.view.app.workspace.getLeaf("tab").openFile(file);
          } else if (openBehavior === "active") {
            void this.view.app.workspace.getLeaf(false).openFile(file);
          } else {
            new CardDetailModal(this.view.app, file, this.view).open();
          }
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Open in new tab")
        .setIcon("lucide-file-plus")
        .onClick(() => {
          void this.view.app.workspace.getLeaf("tab").openFile(file);
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setTitle("Rename")
        .setIcon("lucide-pencil")
        .onClick(() => {
          this.startCardRename(titleEl, file);
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Delete")
        .setIcon("lucide-trash-2")
        .onClick(async () => {
          await this.view.app.fileManager.trashFile(file);
          new Notice(`Moved "${file.basename}" to trash`);
        });
    });

    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.right, y: rect.bottom });
  }

  private startCardRename(titleEl: HTMLElement, file: TFile): void {
    const titleSpan = titleEl.querySelector("span");
    if (!titleSpan) return;

    const input = activeDocument.createEl("input");
    input.type = "text";
    input.value = file.basename;
    input.className = "base-board-card-rename-input";

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== file.basename) {
        const newPath = file.path.replace(
          /[^/]+\.md$/,
          `${sanitizeFilename(newName)}.md`,
        );
        try {
          await this.view.app.fileManager.renameFile(file, newPath);
        } catch (err) {
          new Notice(`Rename failed: ${String(err)}`);
        }
      }
      // Re-render will pick up the new name via onDataUpdated
      this.view.scheduleRender();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        committed = true;
        this.view.scheduleRender();
      }
    });
    input.addEventListener("blur", () => {
      void commit();
    });
  }

  public startInlineCardCreation(
    btnEl: HTMLElement,
    columnName: string,
    existingCount: number,
  ): void {
    // Find the cards list for this column.
    // The trigger button may be in the header OR in the footer, so we walk
    // up to the column element and then down into .base-board-cards.
    const columnEl = btnEl.closest(".base-board-column");
    const shelfEl = btnEl.closest(".base-board-archive");
    const cardsEl =
      (columnEl?.querySelector(".base-board-cards") as HTMLElement | null) ??
      (shelfEl?.querySelector(".base-board-planned-list") as HTMLElement | null) ??
      btnEl.parentElement!;

    btnEl.classList.add("base-board-hidden");

    const inputWrapper = cardsEl.createDiv({
      cls: "base-board-add-card-input-wrapper",
    });
    const input = inputWrapper.createEl("input", {
      cls: "base-board-add-card-input",
      attr: { type: "text", placeholder: "Card title…" },
    });
    input.focus();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const name = input.value.trim();
      inputWrapper.remove();
      btnEl.classList.remove("base-board-hidden");
      if (name) {
        await this.createNewCard(name, columnName, existingCount);
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        committed = true;
        inputWrapper.remove();
        btnEl.classList.remove("base-board-hidden");
      }
    });
    input.addEventListener("blur", () => {
      void commit();
    });
  }

  private async createNewCard(
    title: string,
    columnName: string,
    orderIndex: number,
  ): Promise<void> {
    const groupByProp = this.view.getGroupByProperty();
    if (!groupByProp) {
      new Notice("Cannot create card: no group by property configured.");
      return;
    }

    const overrides = (fm: Record<string, unknown>) => {
      fm.type = "task";
      fm[groupByProp] = columnName;
      fm[ORDER_PROPERTY] = orderIndex;
      fm.id = this.getGeneratedTaskId(title);
      fm.feature = "";
      fm.created = new Date().toISOString();
      fm.people = [];
      fm.pr = "";
      fm.reviewers = [];
      fm.blocked_reason = "";
      fm.tags = [DEFAULT_TASK_TAG];
    };

    try {
      await this.view.createFileForView(title, overrides);
    } catch (err) {
      new Notice(`Failed to create card: ${String(err)}`);
    }
  }

  private getGeneratedTaskId(title: string): string {
    const slug = sanitizeFilename(title)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${slug || "task"}-${suffix}`;
  }

  // ---------------------------------------------------------------------------
  //  Multi-select helpers
  // ---------------------------------------------------------------------------

  /**
   * Toggle or range-select a card.
   *
   * - Cmd/Ctrl+click  → toggle this card in/out of the selection
   * - Shift+click     → select a contiguous range from the last-selected card
   *                     to this one (within the same column's DOM order)
   */
  public handleCardSelect(
    filePath: string,
    columnName: string,
    isShift: boolean,
  ): void {
    const sel = this.view.selectedCards;

    if (isShift && sel.size > 0) {
      // Build DOM order for the column
      const columnEl = this.view.containerEl.querySelector(
        `[data-column-name="${CSS.escape(columnName)}"]`,
      );
      if (columnEl) {
        const cardEls = Array.from(
          columnEl.querySelectorAll<HTMLElement>(".base-board-card"),
        );
        const paths = cardEls.map((el) => el.dataset.filePath ?? "");
        const clickedIdx = paths.indexOf(filePath);
        // Find the last card in the current selection that exists in this column
        const lastIdx = paths.reduceRight((found, p, i) => {
          if (found !== -1) return found;
          return sel.has(p) ? i : -1;
        }, -1);
        if (clickedIdx !== -1 && lastIdx !== -1) {
          const [from, to] = [
            Math.min(clickedIdx, lastIdx),
            Math.max(clickedIdx, lastIdx),
          ];
          for (let i = from; i <= to; i++) {
            if (paths[i]) sel.add(paths[i]);
          }
        } else {
          sel.add(filePath); // fallback: just add
        }
      }
    } else {
      // Cmd/Ctrl+click: toggle
      if (sel.has(filePath)) {
        sel.delete(filePath);
      } else {
        sel.add(filePath);
      }
    }

    // Sync visual state on all card elements
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card")
      .forEach((el) => {
        if (sel.has(el.dataset.filePath ?? "")) {
          el.addClass("base-board-card--selected");
        } else {
          el.removeClass("base-board-card--selected");
        }
      });
  }

  public clearSelection(): void {
    this.view.selectedCards.clear();
    this.view.containerEl
      .querySelectorAll<HTMLElement>(".base-board-card--selected")
      .forEach((el) => el.removeClass("base-board-card--selected"));
  }

  /**
   * Show a "Move to…" context menu for the current multi-selection.
   * Uses the same `applyBatchUpdate` + `processFrontMatter` pattern as
   * the single-card drag/drop to stay consistent.
   */
  public showBatchMoveMenu(e: MouseEvent): void {
    const selectedPaths = Array.from(this.view.selectedCards);
    const groupByProp = this.view.getGroupByProperty();
    if (!groupByProp) return;

    const columns = this.view.getColumns();
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle(`Move ${selectedPaths.length} cards to…`).setDisabled(true);
    });
    menu.addSeparator();

    for (const col of columns) {
      menu.addItem((item) => {
        item.setTitle(col).onClick(() => {
          void this.moveBatchToColumn(selectedPaths, col, groupByProp);
        });
      });
    }

    menu.showAtMouseEvent(e);
  }

  private async moveBatchToColumn(
    filePaths: string[],
    targetColumn: string,
    groupByProp: string,
  ): Promise<void> {
    await this.view.applyBatchUpdate(async () => {
      const updates = filePaths.map((fp, i) => {
        const file = this.view.app.vault.getAbstractFileByPath(fp);
        if (!file || !(file instanceof TFile)) return Promise.resolve();
        return this.view.app.fileManager.processFrontMatter(
          file,
          (fm: Record<string, unknown>) => {
            fm[groupByProp] = targetColumn;
            // Preserve relative order by assigning sequential indices
            fm[ORDER_PROPERTY] = i;
          },
        );
      });
      await Promise.all(updates);
    });
    this.clearSelection();
    new Notice(
      `Moved ${filePaths.length} card${filePaths.length > 1 ? "s" : ""} to "${targetColumn}"`,
    );
  }
}
