import {
  Plugin,
  Notice,
  PluginSettingTab,
  QueryController,
  Setting,
  TFile,
} from "obsidian";
import { KanbanView } from "./kanban-view";
import { TimelineView } from "./timeline-view";
import { sanitizeFilename } from "./constants";
import { CreateBoardModal, BoardConfig } from "./modals";

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
};

// ---------------------------------------------------------------------------
//  Plugin
// ---------------------------------------------------------------------------

export default class BaseBoardPlugin extends Plugin {
  data_: PluginData = DEFAULT_DATA;

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
  }

  onunload() {}

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
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data_);
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
