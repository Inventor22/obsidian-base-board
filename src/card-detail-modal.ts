import {
  App,
  ButtonComponent,
  Modal,
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

const STATUS_PROPERTY = "status";
const STATUS_HISTORY_PROPERTY = "status_history";
const COMPLETED_SEGMENT_TAIL_MIN_MS = 12 * 60 * 60 * 1000;
const COMPLETED_SEGMENT_TAIL_MAX_MS = 3 * 24 * 60 * 60 * 1000;
const COMPLETED_SEGMENT_TAIL_RATIO = 0.1;

export class CardDetailModal extends Modal {
  private file: TFile;
  private view: CardDetailView | undefined;
  private leaf!: WorkspaceLeaf;

  constructor(app: App, file: TFile, view?: CardDetailView) {
    super(app);
    this.file = file;
    this.view = view;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("base-board-card-modal");

    // Remove the native modal title because the Rogue Leaf has its own inline title
    this.titleEl.empty();

    // Actions Container at the top of the body
    const actionsEl = contentEl.createDiv({
      cls: "base-board-card-modal-actions",
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
    // Gracefully clean up the rogue leaf
    if (this.leaf) {
      this.leaf.detach();
    }
    this.contentEl.empty();
  }
}
