import {
  Plugin,
  Notice,
  PluginSettingTab,
  QueryController,
  Setting,
  TFile,
  TFolder,
  TAbstractFile,
} from "obsidian";
import { KanbanView } from "./kanban-view";
import { TimelineView } from "./timeline-view";
import { RolloutView } from "./rollout-view";
import { GraphView } from "./graph-view";
import { sanitizeFilename } from "./constants";
import { CreateBoardModal, BoardConfig } from "./modals";
import { updateBaseFolderReferences } from "./folder-rename";
import {
  parseGraphHistory,
  recordGraphObservation,
  type GraphHistory,
  type GraphHistoryNode,
} from "./graph-history";

/** Per-base column configuration */
export interface ColumnConfig {
  columns: string[];
}

export interface TransitionHistorySettings {
  enabled: boolean;
  propertyName: string;
}

export interface TimelineSettings {
  weekStartDay: number;
}

export interface PluginData {
  columnConfigs: Record<string, ColumnConfig>;
  transitionHistory: TransitionHistorySettings;
  timeline: TimelineSettings;
  graphHistories: Record<string, unknown>;
}

const DEFAULT_DATA: PluginData = {
  columnConfigs: {},
  transitionHistory: {
    enabled: true,
    propertyName: "status_history",
  },
  timeline: {
    weekStartDay: 1,
  },
  graphHistories: {},
};

// ---------------------------------------------------------------------------
//  Plugin
// ---------------------------------------------------------------------------

export default class BaseBoardPlugin extends Plugin {
  data_: PluginData = DEFAULT_DATA;
  private pluginDataWrites: Promise<void> = Promise.resolve();
  private graphHistoryRevision = 0;
  private savedGraphHistoryRevision = 0;

  /** Folder rename mappings collected during one rename burst, pending flush. */
  private pendingFolderRenames: Array<{ oldPath: string; newPath: string }> =
    [];
  /** Debounce timer that flushes pendingFolderRenames once the burst settles. */
  private folderRenameFlushTimer: number | null = null;

  async onload() {
    await this.loadPluginData();
    this.addSettingTab(new BaseBoardSettingTab(this));

    this.registerBasesView("kanban", {
      name: "Kanban",
      icon: "lucide-kanban",
      factory: (controller: QueryController, containerEl: HTMLElement) =>
        new KanbanView(controller, containerEl, this),
      options: () => KanbanView.getViewOptions(),
    });

    this.registerBasesView("timeline", {
      name: "Timeline",
      icon: "lucide-chart-gantt",
      factory: (controller: QueryController, containerEl: HTMLElement) =>
        new TimelineView(controller, containerEl, this),
      options: () => TimelineView.getViewOptions(),
    });

    this.registerBasesView("rollout", {
      name: "Rollout",
      icon: "lucide-radio-tower",
      factory: (controller: QueryController, containerEl: HTMLElement) =>
        new RolloutView(controller, containerEl, this),
    });

    this.registerBasesView("graph", {
      name: "Graph",
      icon: "lucide-git-fork",
      factory: (controller: QueryController, containerEl: HTMLElement) =>
        new GraphView(controller, containerEl, this),
      options: () => GraphView.getViewOptions(),
    });

    // -- Command: Create new board --------------------------------------------
    this.addCommand({
      id: "create-board",
      name: "Create new board",
      callback: () => {
        new CreateBoardModal(this.app, (config) => {
          void this.createBoard(config);
        }).open();
      },
    });

    // -- Keep board filters in sync when their folder is renamed/moved --------
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.handleFolderRename(file, oldPath);
      }),
    );
  }

  onunload() {
    if (this.folderRenameFlushTimer !== null) {
      window.clearTimeout(this.folderRenameFlushTimer);
    }
  }

  // -- Folder rename sync -----------------------------------------------------

  /**
   * When a folder is renamed or moved, rewrite any .base board filter that
   * pointed at the old path so the board keeps working without a manual edit.
   *
   * To avoid race condition, burst of renaming events are collected, and once
   * a timeout is reached we flush and modify the path mappings in .base
   */
  private handleFolderRename(file: TAbstractFile, oldPath: string): void {
    const timeOut = 250;

    // Only folder moves change the folder a filter targets; ignore file renames.
    if (!(file instanceof TFolder)) return;

    const newPath = file.path;
    if (newPath === oldPath) return;

    this.pendingFolderRenames.push({ oldPath, newPath });

    // Debounce: reset the timer on every event so the flush runs only after
    // the rename burst has settled and Obsidian has finished moving files.
    if (this.folderRenameFlushTimer !== null) {
      window.clearTimeout(this.folderRenameFlushTimer);
    }
    this.folderRenameFlushTimer = window.setTimeout(() => {
      this.folderRenameFlushTimer = null;
      void this.flushFolderRenames();
    }, timeOut);
  }

  /** Apply all pending folder-rename mappings to every .base file. */
  private async flushFolderRenames(): Promise<void> {
    const renames = this.pendingFolderRenames;
    this.pendingFolderRenames = [];
    if (renames.length === 0) return;

    const baseFiles = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "base");

    for (const baseFile of baseFiles) {
      try {
        let content = await this.app.vault.read(baseFile);
        let changed = false;
        for (const { oldPath, newPath } of renames) {
          const updated = updateBaseFolderReferences(content, oldPath, newPath);
          if (updated !== null) {
            content = updated;
            changed = true;
          }
        }
        if (changed) {
          await this.app.vault.modify(baseFile, content);
        }
      } catch (err) {
        console.error(
          `Base Board: failed to update folder references in "${baseFile.path}"`,
          err,
        );
      }
    }
  }

  // -- Board scaffolding ------------------------------------------------------

  private async createBoard(config: BoardConfig): Promise<void> {
    const { name, folder, groupBy } = config;
    const vault = this.app.vault;

    // Sanitize folder path
    const safeFolder = folder.replace(/[\\:*?"<>|]/g, "");
    const tasksFolder = `${safeFolder}/Tasks`;

    // 1. Create folder structure
    if (!vault.getAbstractFileByPath(safeFolder)) {
      await vault.createFolder(safeFolder);
    }
    if (!vault.getAbstractFileByPath(tasksFolder)) {
      await vault.createFolder(tasksFolder);
    }

    // 2. Create the .base file
    const basePath = `${safeFolder}/${name}.base`;
    if (vault.getAbstractFileByPath(basePath)) {
      new Notice(`A board already exists at "${basePath}".`);
      return;
    }

    const baseContent = [
      `filters:`,
      `  and:`,
      `    - file.inFolder("${tasksFolder}")`,
      `views:`,
      `  - type: kanban`,
      `    name: ${name}`,
      `    groupBy:`,
      `      property: note.${groupBy}`,
      `      direction: DESC`,
      `    order:`,
      `      - file.name`,
      `      - note.${groupBy}`,
      `  - type: graph`,
      `    name: Graph`,
      `    groupBy:`,
      `      property: note.${groupBy}`,
      `      direction: DESC`,
      `    order:`,
      `      - file.name`,
      ``,
    ].join("\n");

    await vault.create(basePath, baseContent);

    // 3. Create sample task files so the board isn't empty on first open
    const sampleTasks = [
      {
        title: "Plan project",
        value: "To Do",
        order: 0,
        tags: ["planning"],
      },
      {
        title: "Research and discovery",
        value: "To Do",
        order: 1,
        tags: ["research"],
      },
      {
        title: "Build first feature",
        value: "In Progress",
        order: 0,
        tags: ["feature"],
      },
      {
        title: "Fix onboarding bug",
        value: "In Progress",
        order: 1,
        tags: ["bug"],
      },
      {
        title: "Write documentation",
        value: "Done",
        order: 0,
        tags: ["docs"],
      },
    ];

    for (const task of sampleTasks) {
      const safeName = sanitizeFilename(task.title);
      const taskPath = `${tasksFolder}/${safeName}.md`;
      if (!vault.getAbstractFileByPath(taskPath)) {
        const tagsLine =
          task.tags.length > 0
            ? `tags:\n${task.tags.map((t) => `  - ${t}`).join("\n")}`
            : "";
        const content = [
          "---",
          `${groupBy}: ${task.value}`,
          `kanban_order: ${task.order}`,
          tagsLine,
          "---",
          "",
          `# ${task.title}`,
          "",
        ]
          .filter((line) => line !== "")
          .join("\n");
        await vault.create(taskPath, content);
      }
    }

    // 4. Open the board
    const file = vault.getAbstractFileByPath(basePath);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
      new Notice(`Board "${name}" created!`);
    }
  }

  // -- Column config helpers --------------------------------------------------

  getColumnConfig(baseId: string): ColumnConfig | null {
    return this.data_.columnConfigs[baseId] ?? null;
  }

  async saveColumnConfig(baseId: string, config: ColumnConfig): Promise<void> {
    this.data_.columnConfigs[baseId] = config;
    await this.savePluginData();
  }

  // -- Persistence ------------------------------------------------------------

  getRecordedGraphHistory(id: string): GraphHistory | null {
    if (!/^graph-[a-z0-9-]+$/.test(id))
      throw new Error("Invalid graph recording identity");
    if (
      !this.data_.graphHistories ||
      typeof this.data_.graphHistories !== "object" ||
      Array.isArray(this.data_.graphHistories)
    ) {
      throw new Error("Unsupported graph recording store");
    }
    const saved = this.data_.graphHistories[id];
    return saved === undefined ? null : parseGraphHistory(saved);
  }

  async recordGraphHistory(
    id: string,
    nodes: GraphHistoryNode[],
    at: number,
    session: string,
  ): Promise<GraphHistory> {
    const previous = this.getRecordedGraphHistory(id);
    const result = recordGraphObservation(previous, nodes, at, session);
    this.data_.graphHistories[id] = result.history;
    if (result.changed) this.graphHistoryRevision += 1;
    const revision = this.graphHistoryRevision;
    if (this.savedGraphHistoryRevision < revision) {
      await this.savePluginData();
      this.savedGraphHistoryRevision = Math.max(
        this.savedGraphHistoryRevision,
        revision,
      );
    }
    return result.history;
  }

  async finishGraphObservation(
    id: string,
    at: number,
    session: string,
  ): Promise<void> {
    const history = this.getRecordedGraphHistory(id);
    if (
      !history ||
      history.frames[history.frames.length - 1].session !== session
    )
      return;
    this.data_.graphHistories[id] = {
      ...history,
      observedThrough: Math.max(history.observedThrough, at),
    };
    await this.savePluginData();
  }

  async loadPluginData(): Promise<void> {
    const saved = (await this.loadData()) as PluginData | null | undefined;
    this.data_ = Object.assign({}, DEFAULT_DATA, saved ?? {});
    if (!this.data_.columnConfigs) this.data_.columnConfigs = {};
    this.data_.transitionHistory = Object.assign(
      {},
      DEFAULT_DATA.transitionHistory,
      saved?.transitionHistory ?? {},
    );
    this.data_.timeline = Object.assign(
      {},
      DEFAULT_DATA.timeline,
      saved?.timeline ?? {},
    );
    this.data_.graphHistories = saved?.graphHistories ?? {};
  }

  async savePluginData(): Promise<void> {
    const snapshot: unknown = JSON.parse(JSON.stringify(this.data_));
    const write = this.pluginDataWrites
      .catch(() => {})
      .then(() => this.saveData(snapshot));
    this.pluginDataWrites = write;
    await write;
  }
}

class BaseBoardSettingTab extends PluginSettingTab {
  plugin: BaseBoardPlugin;

  constructor(plugin: BaseBoardPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Transition history").setHeading();

    new Setting(containerEl)
      .setName("Log card transitions")
      .setDesc(
        "Append a timestamped history entry when a card moves between board columns.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data_.transitionHistory.enabled)
          .onChange(async (value) => {
            this.plugin.data_.transitionHistory.enabled = value;
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl)
      .setName("Transition history property")
      .setDesc("Frontmatter property used for the appended transition history.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_DATA.transitionHistory.propertyName)
          .setValue(this.plugin.data_.transitionHistory.propertyName)
          .onChange(async (value) => {
            this.plugin.data_.transitionHistory.propertyName = value.trim();
            await this.plugin.savePluginData();
          }),
      );

    new Setting(containerEl).setName("Timeline").setHeading();

    new Setting(containerEl)
      .setName("Week starts on")
      .setDesc("Day used for weekly timeline boundaries.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "0": "Sunday",
            "1": "Monday",
            "2": "Tuesday",
            "3": "Wednesday",
            "4": "Thursday",
            "5": "Friday",
            "6": "Saturday",
          })
          .setValue(String(this.plugin.data_.timeline.weekStartDay))
          .onChange(async (value) => {
            this.plugin.data_.timeline.weekStartDay = Number(value);
            await this.plugin.savePluginData();
          }),
      );
  }
}
