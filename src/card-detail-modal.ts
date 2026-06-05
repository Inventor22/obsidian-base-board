import {
  App,
  ButtonComponent,
  Modal,
  setIcon,
  setTooltip,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { NO_VALUE_COLUMN } from "./constants";
import { getColumnColor } from "./status-colors";

interface TimelineHistoryRecord {
  from?: unknown;
  to?: unknown;
  at?: unknown;
  property?: unknown;
}

interface CardMiniTimelineSegment {
  status: string | null;
  start: Date;
  end: Date;
}

interface CardDetailView {
  tags?: {
    promptEditTags(file: TFile): void;
  };
}

interface ModalHierarchyTask {
  file: TFile;
  title: string;
  parentKey: string | null;
  status: string;
}

interface ModalOutlineNode {
  task: ModalHierarchyTask;
  children: ModalOutlineNode[];
}

interface CardDetailModalOptions {
  history?: TFile[];
  historyIndex?: number;
}

interface CardModalSnapshot {
  history: TFile[];
  historyIndex: number;
  view: CardDetailView | undefined;
}

const STATUS_PROPERTY = "status";
const STATUS_HISTORY_PROPERTY = "status_history";
const COMPLETED_SEGMENT_TAIL_MIN_MS = 12 * 60 * 60 * 1000;
const COMPLETED_SEGMENT_TAIL_MAX_MS = 3 * 24 * 60 * 60 * 1000;
const COMPLETED_SEGMENT_TAIL_RATIO = 0.1;

export class CardDetailModal extends Modal {
  private static modalStack: CardDetailModal[] = [];
  private static forwardStack: CardModalSnapshot[] = [];
  private static forwardStackExpireTimer: number | null = null;
  private static stackMouseNavigationHandler: ((event: MouseEvent) => void) | null =
    null;
  private static stackMouseNavigationTargets: Array<Document | Window> = [];
  private static stackLastMouseNavigationAt = 0;
  private static stackLastMouseNavigationButton: number | null = null;
  private static stackMouseNavigationEvents: Array<
    "pointerdown" | "pointerup" | "mousedown" | "mouseup" | "auxclick"
  > = ["pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"];
  private static recentModalInteraction:
    | { modal: CardDetailModal; at: number }
    | null = null;
  private static patchedWorkspace:
    | {
        app: App;
        openLinkText: App["workspace"]["openLinkText"];
      }
    | null = null;

  private file: TFile;
  private view: CardDetailView | undefined;
  private leaf!: WorkspaceLeaf;
  private collapsedOutlines: Set<string> = new Set();
  private initialHistory: TFile[] | null = null;
  private initialHistoryIndex = 0;
  private history: TFile[] = [];
  private historyIndex = 0;
  private modalBackButtonEl: HTMLElement | null = null;
  private modalForwardButtonEl: HTMLElement | null = null;
  private internalLinkNavigationHandler: ((event: MouseEvent) => void) | null =
    null;
  private internalLinkNavigationEvents: Array<
    "pointerdown" | "pointerup" | "mousedown" | "mouseup" | "click"
  > = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"];
  private internalLinkNavigationTargets: Array<Document | HTMLElement> = [];
  private lastInternalLinkNavigationAt = 0;
  private lastInternalLinkNavigationPath: string | null = null;

  constructor(
    app: App,
    file: TFile,
    view?: CardDetailView,
    options?: CardDetailModalOptions,
  ) {
    super(app);
    this.file = file;
    this.view = view;
    this.initialHistory = options?.history ?? null;
    this.initialHistoryIndex = options?.historyIndex ?? 0;
  }

  async onOpen() {
    const { contentEl } = this;
    this.history = this.initialHistory?.length ? [...this.initialHistory] : [this.file];
    this.historyIndex = Math.min(
      Math.max(this.initialHistoryIndex, 0),
      this.history.length - 1,
    );
    this.file = this.history[this.historyIndex];
    this.modalEl.addClass("base-board-card-modal");
    CardDetailModal.registerActiveModal(this);

    // Remove the native modal title because the Rogue Leaf has its own inline title
    this.titleEl.empty();

    // Actions Container at the top of the body
    const actionsEl = contentEl.createDiv({
      cls: "base-board-card-modal-actions",
    });

    const navActionsEl = actionsEl.createDiv({
      cls: "base-board-card-modal-nav-actions",
    });
    this.modalBackButtonEl = navActionsEl.createDiv({
      cls: "base-board-card-modal-nav-btn",
      attr: { role: "button", tabindex: "0", title: "Back" },
    });
    setIcon(this.modalBackButtonEl, "lucide-arrow-left");
    this.modalBackButtonEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.goBack();
    });
    this.modalBackButtonEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      this.goBack();
    });
    this.modalForwardButtonEl = navActionsEl.createDiv({
      cls: "base-board-card-modal-nav-btn",
      attr: { role: "button", tabindex: "0", title: "Forward" },
    });
    setIcon(this.modalForwardButtonEl, "lucide-arrow-right");
    this.modalForwardButtonEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.goForward();
    });
    this.modalForwardButtonEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      this.goForward();
    });

    // Open in Tab Button
    new ButtonComponent(actionsEl)
      .setButtonText("Open in split pane")
      .setIcon("lucide-columns")
      .onClick(() => {
        this.close();
        const leaf = this.app.workspace.getLeaf("split");
        void leaf.openFile(this.file);
      });

    // Open in New Tab Button
    new ButtonComponent(actionsEl)
      .setButtonText("Open in new tab")
      .setIcon("lucide-external-link")
      .onClick(() => {
        this.close();
        const leaf = this.app.workspace.getLeaf("tab");
        void leaf.openFile(this.file);
      });

    if (this.view?.tags) {
      new ButtonComponent(actionsEl)
        .setButtonText("Edit tags")
        .setIcon("lucide-tags")
        .onClick(() => {
          this.view?.tags?.promptEditTags(this.file);
        });
    }

    contentEl.createEl("hr", { cls: "base-board-modal-separator" });

    // Markdown Content Container
    const bodyEl = contentEl.createDiv({ cls: "base-board-card-modal-body" });
    this.renderMiniTimeline(bodyEl);
    this.renderDescendantOutline(bodyEl);

    // Create a truly orphaned workspace leaf instead of a tracked split/tab
    const LeafClass = WorkspaceLeaf as unknown as new (
      app: App,
    ) => WorkspaceLeaf;
    this.leaf = new LeafClass(this.app);

    // Open out file in that leaf
    await this.leaf.openFile(this.file, { active: false });

    // Reroute the leaf's container element to inside our modal
    bodyEl.appendChild(this.leaf.view.containerEl);

    // Add a class so CSS can control it rather than hardcoding static styles
    this.leaf.view.containerEl.addClass("base-board-rogue-leaf-container");
    this.scheduleModalNavigationControlUpdate();
    this.registerInternalLinkNavigation();
  }

  private renderDescendantOutline(containerEl: HTMLElement): void {
    const outlineNodes = this.getDescendantOutlineNodes(this.file);
    if (outlineNodes.length === 0) return;

    const descendantCount = this.countOutlineNodes(outlineNodes);
    const sectionEl = containerEl.createDiv({
      cls: "base-board-card-modal-outline",
    });
    const leafContainerEl = containerEl.querySelector(
      ".base-board-rogue-leaf-container",
    );
    if (leafContainerEl) {
      containerEl.insertBefore(sectionEl, leafContainerEl);
    }

    const headerEl = sectionEl.createDiv({
      cls: "base-board-card-modal-outline-header",
    });
    headerEl.createDiv({
      cls: "base-board-card-modal-outline-title",
      text: "Descendants",
    });
    headerEl.createDiv({
      cls: "base-board-card-modal-outline-count",
      text: `${descendantCount} ${descendantCount === 1 ? "task" : "tasks"}`,
    });

    const listEl = sectionEl.createDiv({
      cls: "base-board-card-modal-outline-list",
    });
    this.renderModalOutlineNodes(listEl, outlineNodes, 0);
  }

  private renderModalOutlineNodes(
    parentEl: HTMLElement,
    nodes: ModalOutlineNode[],
    depth: number,
  ): void {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isCollapsed = this.collapsedOutlines.has(node.task.file.path);
      const rowEl = parentEl.createDiv({
        cls: "base-board-card-modal-outline-row",
      });
      rowEl.style.setProperty(
        "--modal-outline-depth",
        String(Math.min(depth, 4)),
      );
      rowEl.setAttr("role", "button");
      rowEl.setAttr("tabindex", "0");
      rowEl.setAttr("title", `${node.task.title} - ${node.task.status}`);
      if (hasChildren) {
        rowEl.addClass("base-board-card-modal-outline-row--parent");
      }

      const toggleSlotEl = rowEl.createSpan({
        cls: "base-board-card-modal-outline-toggle-slot",
      });
      if (hasChildren) {
        const toggleEl = toggleSlotEl.createEl("button", {
          cls: "base-board-card-modal-outline-toggle",
          attr: {
            type: "button",
            title: isCollapsed ? "Expand child tasks" : "Collapse child tasks",
          },
        });
        setIcon(
          toggleEl.createSpan(),
          isCollapsed ? "lucide-chevron-right" : "lucide-chevron-down",
        );
        toggleEl.addEventListener("click", (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          this.toggleModalOutlineNode(node.task.file.path);
        });
      } else {
        setIcon(toggleSlotEl, "lucide-dot");
      }

      rowEl.createSpan({
        cls: "base-board-card-modal-outline-row-title",
        text: node.task.title,
      });
      rowEl.createSpan({
        cls: "base-board-card-modal-outline-row-status",
        text: node.task.status,
      });

      rowEl.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        void this.navigateToFile(node.task.file);
      });
      rowEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        void this.navigateToFile(node.task.file);
      });

      if (hasChildren && !isCollapsed) {
        this.renderModalOutlineNodes(parentEl, node.children, depth + 1);
      }
    }
  }

  private toggleModalOutlineNode(filePath: string): void {
    if (this.collapsedOutlines.has(filePath)) {
      this.collapsedOutlines.delete(filePath);
    } else {
      this.collapsedOutlines.add(filePath);
    }

    const outlineEl = this.contentEl.querySelector(
      ".base-board-card-modal-outline",
    );
    outlineEl?.remove();
    const bodyEl = this.contentEl.querySelector<HTMLElement>(
      ".base-board-card-modal-body",
    );
    if (bodyEl) this.renderDescendantOutline(bodyEl);
  }

  private async navigateToFile(file: TFile): Promise<void> {
    if (file.path === this.file.path) return;

    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(file);
    this.historyIndex = this.history.length - 1;
    await this.openFileInModal(file);
  }

  private async navigateHistory(delta: -1 | 1): Promise<void> {
    const nextIndex = this.historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= this.history.length) return;

    this.historyIndex = nextIndex;
    await this.openFileInModal(this.history[this.historyIndex]);
  }

  private async openFileInModal(file: TFile): Promise<void> {
    this.file = file;
    this.collapsedOutlines.clear();

    const bodyEl = this.contentEl.querySelector<HTMLElement>(
      ".base-board-card-modal-body",
    );
    bodyEl?.querySelector(".base-board-card-mini-timeline")?.remove();
    bodyEl?.querySelector(".base-board-card-modal-outline")?.remove();

    if (bodyEl) {
      this.renderMiniTimeline(bodyEl);
      this.renderDescendantOutline(bodyEl);
    }

    await this.leaf.openFile(file, { active: false });
    this.leaf.view.containerEl.addClass("base-board-rogue-leaf-container");
    this.scheduleModalNavigationControlUpdate();
  }

  private registerInternalLinkNavigation(): void {
    this.internalLinkNavigationHandler = (event: MouseEvent) => {
      if (this.isEventInsideModal(event)) {
        CardDetailModal.rememberModalInteraction(this);
      }

      const linkedFile = this.getInternalLinkTarget(event);
      if (!linkedFile) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (this.isDuplicateInternalLinkNavigation(linkedFile)) return;
      this.openLinkedFileInNewModal(linkedFile);
    };
    this.internalLinkNavigationTargets = [activeDocument, this.modalEl];
    for (const eventName of this.internalLinkNavigationEvents) {
      for (const target of this.internalLinkNavigationTargets) {
        target.addEventListener(
          eventName,
          this.internalLinkNavigationHandler as EventListener,
          true,
        );
      }
    }
  }

  private isEventInsideModal(event: MouseEvent): boolean {
    return event.composedPath().includes(this.modalEl);
  }

  private isDuplicateInternalLinkNavigation(file: TFile): boolean {
    return (
      this.lastInternalLinkNavigationPath === file.path &&
      Date.now() - this.lastInternalLinkNavigationAt < 350
    );
  }

  private openLinkedFileInNewModal(file: TFile): void {
    if (this.isDuplicateInternalLinkNavigation(file)) return;

    this.lastInternalLinkNavigationAt = Date.now();
    this.lastInternalLinkNavigationPath = file.path;
    CardDetailModal.clearForwardStack();
    new CardDetailModal(this.app, file, this.view).open();
  }

  private static registerActiveModal(modal: CardDetailModal): void {
    CardDetailModal.modalStack = CardDetailModal.modalStack.filter(
      (activeModal) => activeModal !== modal,
    );
    CardDetailModal.modalStack.push(modal);
    CardDetailModal.patchWorkspaceLinkOpening(modal.app);
    CardDetailModal.ensureStackMouseNavigation(modal.app);
  }

  private static unregisterActiveModal(modal: CardDetailModal): void {
    CardDetailModal.modalStack = CardDetailModal.modalStack.filter(
      (activeModal) => activeModal !== modal,
    );
    if (CardDetailModal.recentModalInteraction?.modal === modal) {
      CardDetailModal.recentModalInteraction = null;
    }
    CardDetailModal.releaseGlobalHandlersIfIdle();
  }

  private static rememberModalInteraction(modal: CardDetailModal): void {
    CardDetailModal.recentModalInteraction = { modal, at: Date.now() };
  }

  private static ensureStackMouseNavigation(app: App): void {
    if (CardDetailModal.stackMouseNavigationHandler) return;

    CardDetailModal.stackMouseNavigationHandler = (event: MouseEvent) => {
      CardDetailModal.handleStackMouseNavigation(app, event);
    };
    CardDetailModal.stackMouseNavigationTargets = [
      activeDocument.defaultView ?? window,
      activeDocument,
    ];
    for (const eventName of CardDetailModal.stackMouseNavigationEvents) {
      for (const target of CardDetailModal.stackMouseNavigationTargets) {
        target.addEventListener(
          eventName,
          CardDetailModal.stackMouseNavigationHandler as EventListener,
          true,
        );
      }
    }
  }

  private static removeStackMouseNavigation(): void {
    if (!CardDetailModal.stackMouseNavigationHandler) return;

    for (const eventName of CardDetailModal.stackMouseNavigationEvents) {
      for (const target of CardDetailModal.stackMouseNavigationTargets) {
        target.removeEventListener(
          eventName,
          CardDetailModal.stackMouseNavigationHandler as EventListener,
          true,
        );
      }
    }
    CardDetailModal.stackMouseNavigationHandler = null;
    CardDetailModal.stackMouseNavigationTargets = [];
  }

  private static handleStackMouseNavigation(app: App, event: MouseEvent): void {
    if (event.button !== 3 && event.button !== 4) return;

    const topModal = CardDetailModal.getTopActiveModal();
    const canHandleBack = event.button === 3 && topModal !== null;
    const canHandleForward =
      event.button === 4 &&
      ((topModal?.canGoForward() ?? false) ||
        CardDetailModal.forwardStack.length > 0);
    if (!canHandleBack && !canHandleForward) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!CardDetailModal.shouldActivateStackMouseNavigation(event)) return;

    if (event.button === 3) {
      topModal?.goBack({ deferClose: true });
      return;
    }

    if (topModal?.canGoForward()) {
      topModal.goForward();
      return;
    }

    CardDetailModal.reopenForwardSnapshot(app);
  }

  private static shouldActivateStackMouseNavigation(event: MouseEvent): boolean {
    if (
      event.type !== "pointerup" &&
      event.type !== "mouseup" &&
      event.type !== "auxclick"
    ) {
      return false;
    }

    const now = Date.now();
    if (
      CardDetailModal.stackLastMouseNavigationButton === event.button &&
      now - CardDetailModal.stackLastMouseNavigationAt < 250
    ) {
      return false;
    }

    CardDetailModal.stackLastMouseNavigationButton = event.button;
    CardDetailModal.stackLastMouseNavigationAt = now;
    return true;
  }

  private static pushForwardSnapshot(snapshot: CardModalSnapshot): void {
    const file = snapshot.history[snapshot.historyIndex];
    if (!file) return;

    CardDetailModal.forwardStack.push(snapshot);
    CardDetailModal.resetForwardStackExpiry();
  }

  private static reopenForwardSnapshot(app: App): void {
    const snapshot = CardDetailModal.forwardStack.pop();
    if (!snapshot) {
      CardDetailModal.clearForwardStack();
      return;
    }

    const file = snapshot.history[snapshot.historyIndex];
    if (!file) {
      CardDetailModal.clearForwardStack();
      return;
    }

    new CardDetailModal(app, file, snapshot.view, {
      history: snapshot.history,
      historyIndex: snapshot.historyIndex,
    }).open();

    if (CardDetailModal.forwardStack.length === 0) {
      window.setTimeout(() => {
        if (CardDetailModal.forwardStack.length === 0) {
          CardDetailModal.clearForwardStack();
        }
      }, 50);
    } else {
      CardDetailModal.resetForwardStackExpiry();
    }
  }

  private static resetForwardStackExpiry(): void {
    if (CardDetailModal.forwardStackExpireTimer !== null) {
      window.clearTimeout(CardDetailModal.forwardStackExpireTimer);
    }
    CardDetailModal.forwardStackExpireTimer = window.setTimeout(() => {
      CardDetailModal.clearForwardStack();
    }, 30000);
  }

  private static clearForwardStack(): void {
    CardDetailModal.forwardStack = [];
    if (CardDetailModal.forwardStackExpireTimer !== null) {
      window.clearTimeout(CardDetailModal.forwardStackExpireTimer);
      CardDetailModal.forwardStackExpireTimer = null;
    }
    CardDetailModal.releaseGlobalHandlersIfIdle();
  }

  private static releaseGlobalHandlersIfIdle(): void {
    if (
      CardDetailModal.modalStack.length > 0 ||
      CardDetailModal.forwardStack.length > 0
    ) {
      return;
    }

    CardDetailModal.restoreWorkspaceLinkOpening();
    CardDetailModal.removeStackMouseNavigation();
  }

  private static patchWorkspaceLinkOpening(app: App): void {
    if (CardDetailModal.patchedWorkspace) return;

    const originalOpenLinkText = app.workspace.openLinkText.bind(app.workspace);
    CardDetailModal.patchedWorkspace = {
      app,
      openLinkText: originalOpenLinkText,
    };

    app.workspace.openLinkText = async (
      linktext,
      sourcePath,
      newLeaf,
      openViewState,
    ) => {
      const modal =
        CardDetailModal.getModalForSourcePath(sourcePath) ??
        CardDetailModal.getRecentlyInteractedModal();
      if (!modal) {
        return originalOpenLinkText(
          linktext,
          sourcePath,
          newLeaf,
          openViewState,
        );
      }

      const normalizedLinktext = modal.normalizeInternalLinktext(linktext);
      if (!normalizedLinktext) return;

      const linkedFile = app.metadataCache.getFirstLinkpathDest(
        normalizedLinktext,
        sourcePath,
      );
      if (!(linkedFile instanceof TFile)) return;

      modal.openLinkedFileInNewModal(linkedFile);
    };
  }

  private static restoreWorkspaceLinkOpening(): void {
    const patchedWorkspace = CardDetailModal.patchedWorkspace;
    if (!patchedWorkspace) return;

    patchedWorkspace.app.workspace.openLinkText = patchedWorkspace.openLinkText;
    CardDetailModal.patchedWorkspace = null;
  }

  private static getModalForSourcePath(sourcePath: string): CardDetailModal | null {
    return (
      [...CardDetailModal.modalStack]
        .reverse()
        .find((modal) => modal.file.path === sourcePath) ?? null
    );
  }

  private static getTopActiveModal(): CardDetailModal | null {
    return CardDetailModal.modalStack[CardDetailModal.modalStack.length - 1] ?? null;
  }

  private isTopActiveModal(): boolean {
    return CardDetailModal.getTopActiveModal() === this;
  }

  private static getRecentlyInteractedModal(): CardDetailModal | null {
    const recent = CardDetailModal.recentModalInteraction;
    if (!recent) return null;
    if (Date.now() - recent.at > 1000) return null;
    return CardDetailModal.modalStack.includes(recent.modal) ? recent.modal : null;
  }

  private getInternalLinkTarget(event: MouseEvent): TFile | null {
    const linkEl = this.getInternalLinkElement(event);
    if (!linkEl) return null;

    const rawLink =
      linkEl.getAttr("data-href") ??
      linkEl.getAttr("data-link-path") ??
      linkEl.getAttr("href") ??
      "";
    const linktext = this.normalizeInternalLinktext(rawLink);
    if (!linktext) return null;

    const targetFile = this.app.metadataCache.getFirstLinkpathDest(
      linktext,
      this.file.path,
    );
    return targetFile instanceof TFile ? targetFile : null;
  }

  private getInternalLinkElement(event: MouseEvent): HTMLElement | null {
    const selector =
      "a.internal-link, .internal-link, .cm-hmd-internal-link, [data-href], [data-link-path]";
    const path = event.composedPath();

    for (const pathEntry of path) {
      if (!(pathEntry instanceof HTMLElement)) continue;
      const linkEl = pathEntry.matches(selector)
        ? pathEntry
        : pathEntry.closest<HTMLElement>(selector);
      if (linkEl && this.modalEl.contains(linkEl)) return linkEl;
    }

    const targetEl = event.target;
    if (!(targetEl instanceof HTMLElement)) return null;
    const linkEl = targetEl.closest<HTMLElement>(selector);
    return linkEl && this.modalEl.contains(linkEl) ? linkEl : null;
  }

  private normalizeInternalLinktext(rawLink: string): string | null {
    const trimmed = rawLink.trim();
    if (!trimmed) return null;
    if (/^(?:https?|mailto):/i.test(trimmed)) return null;
    if (trimmed.startsWith("#")) return null;

    let linktext = trimmed;
    const hashIndex = linktext.indexOf("#");
    if (hashIndex >= 0) linktext = linktext.slice(0, hashIndex);
    const queryIndex = linktext.indexOf("?");
    if (queryIndex >= 0) linktext = linktext.slice(0, queryIndex);

    try {
      linktext = decodeURIComponent(linktext);
    } catch {
      // Keep the original link text if it is not URI-encoded.
    }

    return linktext.trim() || null;
  }

  private goBack(options?: { deferClose?: boolean }): void {
    if (this.historyIndex > 0) {
      void this.navigateHistory(-1);
      return;
    }

    CardDetailModal.pushForwardSnapshot(this.getSnapshot());
    if (options?.deferClose) {
      window.setTimeout(() => this.close(), 0);
    } else {
      this.close();
    }
  }

  private goForward(): void {
    if (this.canGoForward()) {
      void this.navigateHistory(1);
    }
  }

  private canGoForward(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  private getSnapshot(): CardModalSnapshot {
    return {
      history: [...this.history],
      historyIndex: this.historyIndex,
      view: this.view,
    };
  }

  private updateModalNavigationControls(): void {
    this.setModalNavigationControlState(this.modalBackButtonEl, true);
    this.setModalNavigationControlState(
      this.modalForwardButtonEl,
      this.historyIndex < this.history.length - 1,
    );
  }

  private scheduleModalNavigationControlUpdate(): void {
    this.updateModalNavigationControls();
    window.requestAnimationFrame(() => this.updateModalNavigationControls());
    window.setTimeout(() => this.updateModalNavigationControls(), 0);
    window.setTimeout(() => this.updateModalNavigationControls(), 50);
  }

  private setModalNavigationControlState(
    element: HTMLElement | null,
    enabled: boolean,
  ): void {
    if (!element) return;
    element.toggleClass("is-disabled", !enabled);
    element.setAttr("aria-disabled", enabled ? "false" : "true");
    element.setAttr("tabindex", enabled ? "0" : "-1");
  }

  private getDescendantOutlineNodes(file: TFile): ModalOutlineNode[] {
    const tasks = this.getHierarchyTasks();
    const tasksByIdentity = new Map<string, ModalHierarchyTask>();
    for (const task of tasks) {
      for (const identity of this.getTaskIdentities(task)) {
        tasksByIdentity.set(identity, task);
      }
    }

    const currentTask = tasks.find((task) => task.file.path === file.path);
    if (!currentTask) return [];
    return this.getChildOutlineNodes(
      currentTask,
      tasks,
      tasksByIdentity,
      new Set([currentTask.file.path]),
    );
  }

  private getHierarchyTasks(): ModalHierarchyTask[] {
    return this.app.vault.getMarkdownFiles().map((file) => {
      const frontmatter = this.getFrontmatterForFile(file);
      return {
        file,
        title: this.getTaskTitle(file, frontmatter),
        parentKey: this.normalizeReference(
          frontmatter?.parent ??
            frontmatter?.parent_task ??
            frontmatter?.parentTask ??
            frontmatter?.feature,
        ),
        status:
          this.normalizeStatus(frontmatter?.[STATUS_PROPERTY]) ?? NO_VALUE_COLUMN,
      };
    });
  }

  private getChildOutlineNodes(
    parent: ModalHierarchyTask,
    tasks: ModalHierarchyTask[],
    tasksByIdentity: Map<string, ModalHierarchyTask>,
    visitedPaths: Set<string>,
  ): ModalOutlineNode[] {
    const children = tasks
      .filter((task) => {
        if (!task.parentKey || visitedPaths.has(task.file.path)) return false;
        const resolvedParent = tasksByIdentity.get(task.parentKey);
        return resolvedParent?.file.path === parent.file.path;
      })
      .sort((first, second) => first.title.localeCompare(second.title));

    return children.map((child) => {
      const nextVisitedPaths = new Set(visitedPaths);
      nextVisitedPaths.add(child.file.path);
      return {
        task: child,
        children: this.getChildOutlineNodes(
          child,
          tasks,
          tasksByIdentity,
          nextVisitedPaths,
        ),
      };
    });
  }

  private countOutlineNodes(nodes: ModalOutlineNode[]): number {
    return nodes.reduce(
      (count, node) => count + 1 + this.countOutlineNodes(node.children),
      0,
    );
  }

  private getTaskIdentities(task: ModalHierarchyTask): string[] {
    return [
      task.file.path.replace(/\.md$/i, "").toLowerCase(),
      task.file.basename.toLowerCase(),
      task.title.toLowerCase(),
    ];
  }

  private getTaskTitle(
    file: TFile,
    frontmatter: Record<string, unknown> | undefined,
  ): string {
    const title = frontmatter?.title;
    return typeof title === "string" && title.trim() ? title : file.basename;
  }

  private getFrontmatterForFile(
    file: TFile,
  ): Record<string, unknown> | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
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

  private renderMiniTimeline(containerEl: HTMLElement): void {
    const segments = this.getMiniTimelineSegments();
    if (segments.length === 0) return;

    const startTime = Math.min(
      ...segments.map((segment) => segment.start.getTime()),
    );
    const endTime = Math.max(
      ...segments.map((segment) => segment.end.getTime()),
    );
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return;
    if (endTime <= startTime) return;

    const timelineEl = containerEl.createDiv({
      cls: "base-board-card-mini-timeline",
    });
    const leafContainerEl = containerEl.querySelector(
      ".base-board-rogue-leaf-container",
    );
    if (leafContainerEl) {
      containerEl.insertBefore(timelineEl, leafContainerEl);
    }
    timelineEl.createDiv({
      cls: "base-board-card-mini-timeline-title",
      text: "Timeline",
    });
    const trackEl = timelineEl.createDiv({
      cls: "base-board-card-mini-timeline-track",
    });

    for (const segment of segments) {
      const left =
        ((segment.start.getTime() - startTime) / (endTime - startTime)) * 100;
      const right =
        ((segment.end.getTime() - startTime) / (endTime - startTime)) * 100;
      const width = Math.max(right - left, 1.5);
      const status = segment.status ?? NO_VALUE_COLUMN;
      const segmentEl = trackEl.createDiv({
        cls: "base-board-card-mini-timeline-segment",
        text: status,
      });
      segmentEl.style.left = `${left}%`;
      segmentEl.style.width = `${Math.min(width, 100 - left)}%`;
      segmentEl.style.setProperty(
        "--mini-timeline-status-color",
        getColumnColor({}, segment.status),
      );
      setTooltip(
        segmentEl,
        `${status}\n${segment.start.toLocaleString()} -> ${segment.end.toLocaleString()}`,
      );
    }
  }

  private getMiniTimelineSegments(): CardMiniTimelineSegment[] {
    const frontmatter = this.getFrontmatter();
    const currentStatus = this.normalizeStatus(frontmatter?.[STATUS_PROPERTY]);
    const events = this.getStatusHistoryEvents(frontmatter);
    const now = new Date();

    if (events.length === 0) {
      const start = new Date(this.file.stat.ctime);
      const end = this.isCompletedStatus(currentStatus)
        ? this.getCompletedSegmentEnd(start, new Date(this.file.stat.mtime))
        : now;
      return [{ status: currentStatus, start, end }].filter(
        (segment) => segment.end.getTime() > segment.start.getTime(),
      );
    }

    const segments: CardMiniTimelineSegment[] = [];
    const firstEvent = events[0];
    const createdAt = new Date(
      Math.min(this.file.stat.ctime, firstEvent.at.getTime()),
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

  private getStatusHistoryEvents(
    frontmatter: Record<string, unknown> | undefined,
  ): Array<{ from: string | null; to: string | null; at: Date }> {
    const rawHistory = frontmatter?.[STATUS_HISTORY_PROPERTY];
    if (!Array.isArray(rawHistory)) return [];

    const events: Array<{ from: string | null; to: string | null; at: Date }> =
      [];
    for (const rawRecord of rawHistory as unknown[]) {
      if (!rawRecord || typeof rawRecord !== "object") continue;
      const record = rawRecord as TimelineHistoryRecord;
      if (
        typeof record.property === "string" &&
        record.property !== STATUS_PROPERTY
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

  private getFrontmatter(): Record<string, unknown> | undefined {
    const frontmatter = this.app.metadataCache.getFileCache(
      this.file,
    )?.frontmatter;
    return frontmatter && typeof frontmatter === "object"
      ? frontmatter
      : undefined;
  }

  private normalizeStatus(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return this.normalizeStatus(value[0]);
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
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

  onClose() {
    CardDetailModal.unregisterActiveModal(this);
    if (this.internalLinkNavigationHandler && this.leaf?.view?.containerEl) {
      for (const eventName of this.internalLinkNavigationEvents) {
        for (const target of this.internalLinkNavigationTargets) {
          target.removeEventListener(
            eventName,
            this.internalLinkNavigationHandler as EventListener,
            true,
          );
        }
      }
      this.internalLinkNavigationHandler = null;
      this.internalLinkNavigationTargets = [];
    }
    // Gracefully clean up the rogue leaf
    if (this.leaf) {
      this.leaf.detach();
    }
    this.contentEl.empty();
  }
}
