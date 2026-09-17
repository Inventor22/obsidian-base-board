import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

vi.mock("obsidian", () => {
  const element = (): Record<string, unknown> => ({
    empty() {},
    setText() {},
    setAttr() {},
    addClass() {},
    createEl: element,
    createDiv: element,
    createSpan: element,
  });
  class Value {
    constructor(public value: unknown) {}
    toString(): string {
      return String(this.value);
    }
    isTruthy(): boolean {
      return Boolean(this.value);
    }
  }
  class TFile {
    path = "";
    basename = "";
    stat = { ctime: 0, mtime: 0 };
  }
  return {
    TFile,
    Value,
    BooleanValue: class extends Value {},
    NumberValue: class extends Value {},
    NullValue: class extends Value {},
    DateValue: class extends Value {},
    LinkValue: class extends Value {},
    ListValue: class extends Value {},
    BasesView: class {},
    Modal: class {
      titleEl = { setText() {} };
      contentEl = element();
      onOpen() {}
      onClose() {}
      open() {
        this.onOpen();
      }
      close() {
        this.onClose();
      }
    },
    Plugin: class {},
    PluginSettingTab: class {},
    Notice: class {},
    Menu: class {},
    Setting: class {
      addButton(build: (button: unknown) => void) {
        let label = "";
        const button = {
          setButtonText(value: string) {
            label = value;
            return button;
          },
          setCta() {
            return button;
          },
          onClick(callback: () => void) {
            if (label === "Apply batch") queueMicrotask(callback);
            return button;
          },
        };
        build(button);
        return this;
      }
    },
    Platform: { isMobile: false },
    Keymap: { isModEvent: () => false },
    setIcon: vi.fn(),
    setTooltip: vi.fn(),
  };
});

import { BooleanValue, NumberValue, TFile } from "obsidian";
import { KanbanView } from "../src/kanban-view";
import { CardManager } from "../src/card";
import { ColumnManager } from "../src/column";
import { RolloutView } from "../src/rollout-view";
import { TimelineView } from "../src/timeline-view";
import {
  createVaultCommandStore,
  handleGraphRequest,
} from "../src/graph-command-ui";
import { previewGraphBatch, type GraphBatch } from "../src/graph-commands";
import BaseBoardPlugin from "../src/main";
import { GraphView } from "../src/graph-view";
import { isGraphSpringEdge } from "../src/graph-physics";
import type { EngineNode } from "../src/graph-engine";
import type { GraphWorkSummary } from "../src/graph-overview";
import {
  recordGraphObservation,
  type GraphHistory,
  type GraphHistoryNode,
} from "../src/graph-history";
import { generateOrderKeys, isOrderKey } from "../src/order";
import { NO_VALUE_COLUMN } from "../src/constants";
import { type TransitionEvent } from "../src/transition-history";

interface Note {
  path: string;
  properties: Record<string, unknown>;
}

function fixture(notes: Note[], groupKeys?: unknown[]) {
  const files = notes.map(({ path }) =>
    Object.assign(new TFile(), {
      path,
      basename: path.replace(/\.md$/, ""),
    }),
  );
  const properties = new Map(
    notes.map((note) => [note.path, { ...note.properties }]),
  );
  const writes: string[] = [];
  const adapterFiles = new Map<string, string>();
  const bodies = new Map(
    notes.map((note) => [note.path, "Synthetic note body.\n"]),
  );
  const readNote = (file: TFile) =>
    `---\n${stringify(properties.get(file.path))}---\n${bodies.get(file.path) ?? ""}`;
  const writeNote = (file: TFile, content: string) => {
    const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
    if (!match) throw new Error("Fixture expected YAML frontmatter");
    const updated = parse(match[1]) as Record<string, unknown>;
    const current = properties.get(file.path) ?? {};
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, updated);
    properties.set(file.path, current);
    bodies.set(file.path, content.slice(match[0].length));
    writes.push(file.path);
  };
  const keys = groupKeys ?? [
    ...new Set(notes.map((note) => note.properties.status)),
  ];
  const entries = files.map((file) => ({ file }));
  const groups = keys.map((key) => ({
    key,
    entries: entries.filter(
      ({ file }) => String(properties.get(file.path)!.status) === String(key),
    ),
  }));
  const view = Object.create(KanbanView.prototype) as KanbanView;
  Object.assign(view, {
    app: {
      vault: {
        getAbstractFileByPath: (path: string) =>
          files.find((file) => file.path === path) ?? null,
        getMarkdownFiles: () => files,
        read: async (file: TFile) => readNote(file),
        process: async (file: TFile, update: (content: string) => string) =>
          writeNote(file, update(readNote(file))),
        create: async (path: string, content: string) => {
          const file = Object.assign(new TFile(), {
            path,
            basename: path.replace(/\.md$/, ""),
          });
          files.push(file);
          writeNote(file, content);
          return file;
        },
        adapter: {
          exists: async (path: string) => adapterFiles.has(path),
          mkdir: async (path: string) => {
            adapterFiles.set(path, "");
          },
          read: async (path: string) => adapterFiles.get(path)!,
          write: async (path: string, content: string) => {
            adapterFiles.set(path, content);
          },
          rename: async (from: string, to: string) => {
            adapterFiles.set(to, adapterFiles.get(from)!);
            adapterFiles.delete(from);
          },
        },
      },
      metadataCache: {
        getFileCache: (file: TFile) => ({
          frontmatter: properties.get(file.path),
        }),
      },
      fileManager: {
        trashFile: async (file: TFile) => {
          files.splice(files.indexOf(file), 1);
          properties.delete(file.path);
          writes.push(file.path);
        },
        processFrontMatter: async (
          file: TFile,
          update: (value: Record<string, unknown>) => void,
        ) => {
          writes.push(file.path);
          update(properties.get(file.path)!);
        },
      },
    },
    plugin: {
      data_: {
        transitionHistory: { enabled: true, propertyName: "status_history" },
      },
    },
    config: { get: vi.fn(), set: vi.fn(), getOrder: () => [] },
    data: { data: entries, groupedData: groups },
    currentGroups: groups,
    selectedCards: new Set<string>(),
    optimisticMoves: new Map<string, string>(),
    optimisticColumnOrders: new Map<string, string[]>(),
    getGroupByProperty: () => "status",
    scheduleRender: vi.fn(),
    isUpdating: false,
    pendingDataRender: false,
  });
  const drop = (path: string, column: string, order: string[]) =>
    (
      view as unknown as {
        handleCardDrop: (
          path: string,
          column: string,
          order: string[],
        ) => Promise<void>;
      }
    ).handleCardDrop(path, column, order);
  return { view, properties, writes, files, drop };
}

beforeEach(() => vi.clearAllMocks());

describe("recorded and planned timeline", () => {
  it("never invents status history from file timestamps or a newer current status", () => {
    const setup = fixture([
      { path: "Stage.md", properties: { status: "Completed" } },
    ]);
    const view = Object.assign(Object.create(TimelineView.prototype), {
      app: setup.view.app,
    });
    expect(view.getSegments(setup.files[0], [], "Completed")).toEqual([]);
    const at = new Date("2026-01-01T12:00:00Z");
    const segments = view.getSegments(
      setup.files[0],
      [{ from: "Planned", to: "Awaiting", at }],
      "Completed",
    );
    expect(segments).toEqual([
      { status: "Awaiting", start: at, end: at, basis: "recorded" },
    ]);
  });

  it("groups the same records by a configured property and keeps planned dates separate", () => {
    const setup = fixture([
      {
        path: "Stage.md",
        properties: {
          status: "In Progress",
          owner: "Dustin",
          planned_start: "2026-10-01",
          planned_end: "2026-10-03",
        },
      },
      {
        path: "Canary.md",
        properties: { status: "In Progress", owner: "Copilot" },
      },
    ]);
    const view = Object.assign(Object.create(TimelineView.prototype), {
      app: setup.view.app,
      config: { get: () => "owner" },
    });
    const tasks = setup.files.map((file) => ({
      file,
      title: file.basename,
      currentStatus: "In Progress",
      segments: [],
      rolloutSegments: [],
    }));
    expect(
      view.getPools(tasks).map((pool: { title: string }) => pool.title),
    ).toEqual(["Copilot", "Dustin"]);
    expect(view.getPlannedSegments(setup.files[0])).toEqual([
      expect.objectContaining({ basis: "planned", status: "Planned" }),
    ]);
    expect(view.getSegments(setup.files[0], [], "In Progress")).toEqual([]);
    expect(setup.writes).toEqual([]);
  });
});

interface OverviewTestNode extends EngineNode {
  file: TFile;
  collapsed: boolean;
  descendantCount: number;
  savedX: number | null;
  savedY: number | null;
  x: number;
  y: number;
}

function overviewFixture(extraNotes: Note[] = []) {
  const setup = fixture([
    { path: "Scope.md", properties: { title: "Scope", kind: "group" } },
    {
      path: "Feature.md",
      properties: {
        title: "Feature",
        rollup_to: ["[[Scope]]"],
        graph_collapsed: true,
        status: "Completed",
      },
    },
    {
      path: "Done.md",
      properties: { title: "Done", parent: "[[Feature]]", status: "Completed" },
    },
    {
      path: "Thread.md",
      properties: {
        title: "Thread",
        parent: "[[Feature]]",
        status: "In Progress",
        executor: "agent",
      },
    },
    ...extraNotes,
  ]);
  const settings = new Map<string, unknown>([
    ["graphNodePositions", { "Feature.md": { x: 800, y: -200 } }],
  ]);
  const container = { querySelector: () => null, querySelectorAll: () => [] };
  const graph = new GraphView(
    {} as never,
    { createDiv: () => container } as unknown as HTMLElement,
    setup.view.plugin,
  );
  Object.assign(graph, {
    app: setup.view.app,
    data: setup.view.data,
    config: {
      groupBy: { property: "note.status" },
      get: (key: string) => settings.get(key),
      set: (key: string, value: unknown) => settings.set(key, value),
    },
    render: vi.fn(),
  });
  const controller = graph as unknown as {
    getGraphNodes: () => OverviewTestNode[];
    toggleGraphCollapse: (node: OverviewTestNode) => Promise<void>;
    graphNodes: OverviewTestNode[];
    graphWorkSummaries: Map<string, GraphWorkSummary>;
    temporalHistory: GraphHistory | null;
    temporalCursor: number | null;
    temporalLiveNodes: GraphHistoryNode[];
    temporalExpandedKeys: Set<string>;
    temporalFileKeys: Map<TFile, string>;
    openGraphNode: (node: OverviewTestNode) => void;
    overviewScopeKey: string;
    overviewBreadcrumbs: { key: string; title: string }[];
    overviewScopeNodes: OverviewTestNode[];
    focusOverview: (key: string) => void;
    temporalScopeKey: string | null;
    getGraphPresentation: () => string;
    getGraphPhysicsLayout: () => string;
    getPhysicsCacheKey: () => string;
    getEdgePath: (edge: {
      from: OverviewTestNode;
      to: OverviewTestNode;
      kind: string;
    }) => string;
    graphZoom: number;
    clampGraphZoom: (zoom: number) => number;
    zoomGraphByFactor: (factor: number) => void;
    zoomGraph: (
      event: WheelEvent,
      viewport: HTMLElement,
      zoomContent: HTMLElement,
      canvas: HTMLElement,
    ) => void;
    resetGraphCamera: () => void;
    centerGraphCameraOnNodes: (
      viewport: HTMLElement,
      nodes: OverviewTestNode[],
    ) => void;
    layoutPhysicsGraph: (
      nodes: OverviewTestNode[],
    ) => { from: OverviewTestNode; to: OverviewTestNode; kind: string }[];
    buildGraphFlowEdges: (
      nodes: OverviewTestNode[],
    ) => { from: OverviewTestNode; to: OverviewTestNode; kind: string }[];
    buildPhysicsEdges: (nodes: OverviewTestNode[]) => {
      from: OverviewTestNode;
      to: OverviewTestNode;
      kind: string;
      spring: boolean;
    }[];
    getEdgeMarkerKind: (edge: {
      from: OverviewTestNode;
      to: OverviewTestNode;
      kind: string;
    }) => string;
    physicsCaches: Map<
      string,
      {
        positions: Map<string, { x: number; y: number }>;
        signature: string;
        energy: number;
      }
    >;
  };
  return { ...setup, graph, controller, settings };
}

describe("Graph overview integration", () => {
  it("reviews column rename as named status changes with shared history", async () => {
    const setup = fixture([
      { path: "Stage.md", properties: { status: "In Progress" } },
      { path: "Canary.md", properties: { status: "In Progress" } },
      { path: "Residual.md", properties: { status: "Failed" } },
    ]);
    setup.view.getColumns = () => ["In Progress", "Failed"];
    setup.view.saveColumns = vi.fn();
    setup.view.updateColumnPreferences = vi.fn();
    const controller = new ColumnManager(setup.view) as unknown as {
      handleRenameColumn: (
        oldName: string,
        newName: string,
        entries: { file: TFile }[],
      ) => Promise<void>;
    };
    await controller.handleRenameColumn(
      "In Progress",
      "Awaiting",
      setup.files.slice(0, 2).map((file) => ({ file })),
    );
    expect(setup.properties.get("Stage.md")?.status).toBe("Awaiting");
    expect(setup.properties.get("Canary.md")?.status_history).toHaveLength(1);
    expect(setup.properties.get("Residual.md")?.status).toBe("Failed");
    expect(setup.view.saveColumns).toHaveBeenCalledWith(["Awaiting", "Failed"]);
  });

  it("serializes duplicate local agent requests and records the batch only once", async () => {
    const setup = fixture([
      { path: "Canary.md", properties: { id: "canary", status: "Planned" } },
    ]);
    const store = createVaultCommandStore(setup.view.app);
    const batch: GraphBatch = {
      id: "agent-request",
      actor: { kind: "agent", name: "GitHub Copilot" },
      reason: "Record reported activity",
      evidence: [],
      changes: [
        {
          path: "Canary.md",
          expectedRevision: (await store.read("Canary.md")).revision,
          set: { status: "In Progress" },
        },
      ],
    };
    const preview = await previewGraphBatch(store, batch);
    const request = JSON.stringify({
      operation: "apply",
      batch,
      token: preview.token,
    });
    const adapter = setup.view.app.vault.adapter;
    for (const id of ["first", "second"])
      await adapter.write(`.baseboard/requests/${id}.request.json`, request);
    await Promise.all([
      handleGraphRequest(setup.view.app, "first"),
      handleGraphRequest(setup.view.app, "second"),
    ]);
    expect(setup.properties.get("Canary.md")?.status_history).toHaveLength(1);
    expect(setup.properties.get("Canary.md")?.status).toBe("In Progress");
    for (const id of ["first", "second"])
      expect(
        JSON.parse(
          await adapter.read(`.baseboard/requests/${id}.response.json`),
        ),
      ).toMatchObject({ ok: true, result: { state: "applied" } });
  });

  it("cleans new sequence/context references in an explicit card deletion batch", async () => {
    const setup = fixture([
      { path: "Stage.md", properties: { id: "stage", status: "In Progress" } },
      {
        path: "Canary.md",
        properties: {
          id: "canary",
          status: "In Progress",
          sequence_after: ["[[Stage]]"],
          associations: ["[[Stage]]"],
        },
      },
    ]);
    const manager = new CardManager(setup.view);
    const controller = manager as unknown as {
      deleteCardAndCleanupReferences: (file: TFile) => Promise<number>;
    };
    expect(
      await controller.deleteCardAndCleanupReferences(setup.files[0]),
    ).toBe(2);
    expect(setup.properties.has("Stage.md")).toBe(false);
    expect(setup.properties.get("Canary.md")?.status).toBe("In Progress");
    expect(setup.properties.get("Canary.md")?.sequence_after).toBeUndefined();
    expect(setup.properties.get("Canary.md")?.associations).toBeUndefined();
  });

  it("reviews and records template insertion as one reversible batch", async () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    const controller = setup.graph as unknown as {
      insertRootTemplate: (
        kind: string,
        title: string,
        point: { x: number; y: number },
      ) => Promise<void>;
      undoGraphHistory: () => Promise<void>;
      graphUndoStack: { batch?: { applied: unknown[] }; positions?: unknown }[];
    };
    await controller.insertRootTemplate("ring-basic", "New ring", {
      x: 30,
      y: 50,
    });
    expect(controller.graphUndoStack).toHaveLength(1);
    expect(controller.graphUndoStack[0].batch?.applied).toHaveLength(3);
    expect(
      setup.properties.get("New ring - verify.md")?.sequence_after,
    ).toEqual(["[[New ring - await build rollout]]"]);
    expect(
      setup.properties.get("New ring - verify.md")?.depends_on,
    ).toBeUndefined();
    expect(setup.properties.get("New ring.md")?.graph_x).toBeUndefined();
    expect(controller.graphUndoStack[0].positions).toBeDefined();
    await controller.undoGraphHistory();
    expect(setup.properties.has("New ring.md")).toBe(false);
    expect(setup.properties.has("New ring - verify.md")).toBe(false);
    expect(setup.properties.get("Feature.md")?.status).toBe("Completed");
  });

  it("rewires two named records through a batch without status changes", async () => {
    const setup = overviewFixture([
      {
        path: "Canary.md",
        properties: {
          parent: "[[Feature]]",
          depends_on: ["[[Done]]"],
          status: "In Progress",
        },
      },
    ]);
    setup.controller.getGraphNodes();
    const find = (path: string) =>
      setup.controller.graphNodes.find((node) => node.file.path === path)!;
    const controller = setup.graph as unknown as {
      reassignGraphEdgeEndpoint: (
        edge: unknown,
        endpoint: string,
        target: unknown,
      ) => Promise<void>;
      undoGraphHistory: () => Promise<void>;
    };
    await controller.reassignGraphEdgeEndpoint(
      { from: find("Done.md"), to: find("Canary.md"), kind: "gating" },
      "to",
      find("Thread.md"),
    );
    expect(setup.properties.get("Canary.md")?.depends_on).toBeUndefined();
    expect(setup.properties.get("Thread.md")?.depends_on).toEqual(["[[Done]]"]);
    setup.properties.get("Thread.md")!.custom = "Later unrelated edit";
    await controller.undoGraphHistory();
    expect(setup.properties.get("Canary.md")?.depends_on).toEqual(["[[Done]]"]);
    expect(setup.properties.get("Thread.md")?.custom).toBe(
      "Later unrelated edit",
    );
    expect(setup.properties.get("Thread.md")?.status).toBe("In Progress");
  });

  it("retains both sequence and dependency links between the same records", () => {
    const setup = overviewFixture([
      {
        path: "Canary.md",
        properties: {
          parent: "[[Feature]]",
          status: "In Progress",
          sequence_after: ["[[Done]]"],
          depends_on: ["[[Done]]"],
        },
      },
    ]);
    setup.controller.getGraphNodes();
    const edges = setup.controller.buildGraphFlowEdges(
      setup.controller.graphNodes,
    );
    expect(
      edges
        .filter(
          (edge) =>
            edge.from.file.path === "Done.md" &&
            edge.to.file.path === "Canary.md",
        )
        .map((edge) => edge.kind)
        .sort(),
    ).toEqual(["gating", "sequence"]);
  });

  it.each([
    "In Progress",
    "Awaiting",
    "Completed",
    "Failed",
    "Cancelled",
    "Blocked",
  ])(
    "records %s on a container without changing its children or successors",
    async (status) => {
      const setup = overviewFixture([
        {
          path: "Canary.md",
          properties: { status: "In Progress", depends_on: ["[[Feature]]"] },
        },
      ]);
      const nodes = setup.controller.getGraphNodes();
      const target = nodes.find((node) => node.file.path === "Feature.md")!;
      const before = new Map(
        [...setup.properties].map(([path, properties]) => [
          path,
          structuredClone(properties),
        ]),
      );
      await (
        setup.graph as unknown as {
          setGraphNodeStatus: (
            node: OverviewTestNode,
            status: string,
          ) => Promise<void>;
        }
      ).setGraphNodeStatus(target, status);
      expect(setup.properties.get("Feature.md")!.status).toBe(status);
      for (const [path, properties] of setup.properties) {
        if (path !== "Feature.md") expect(properties).toEqual(before.get(path));
      }
      const rendered = setup.controller.getGraphNodes();
      expect(
        rendered.find((node) => node.file.path === "Feature.md")!.status,
      ).toBe(status);
      expect(
        setup.controller.graphWorkSummaries.get("Feature.md"),
      ).toMatchObject({ total: 2, completed: 1, active: 1 });
    },
  );

  it("records partial Stage and active Canary consistently through Graph commands and Kanban", async () => {
    const setup = overviewFixture([
      {
        path: "Stage.md",
        properties: { parent: "[[Feature]]", status: "In Progress" },
      },
      {
        path: "Broken zone.md",
        properties: { parent: "[[Stage]]", status: "Failed" },
      },
      {
        path: "Canary.md",
        properties: {
          status: "Planned",
          depends_on: ["[[Stage]]"],
          decision: {
            reason: "Baked sufficiently; west zone remains broken",
            evidence: ["[[Stage#Bake]]"],
          },
        },
      },
    ]);
    const beforeStage = structuredClone(setup.properties.get("Stage.md"));
    await setup.drop("Canary.md", "In Progress", ["Canary.md"]);
    expect(setup.properties.get("Stage.md")).toEqual(beforeStage);
    expect(setup.properties.get("Broken zone.md")!.status).toBe("Failed");
    setup.controller.getGraphNodes();
    const canary = setup.controller.graphNodes.find(
      (node) => node.file.path === "Canary.md",
    )!;
    expect(canary.state).toBe("active");
    expect(setup.properties.get("Canary.md")!.decision).toBeDefined();
    expect(setup.properties.get("Canary.md")!.status_history).toHaveLength(1);
  });

  it("renders obstacle detours as waypoint paths instead of the blocked curve", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    const nodes = setup.controller.getGraphNodes();
    const source = nodes.find((node) => node.file.path === "Feature.md")!;
    const target = nodes.find((node) => node.file.path === "Scope.md")!;
    Object.assign(source, { x: 0, y: 0 });
    Object.assign(target, { x: 900, y: 0 });
    Object.assign(setup.graph, {
      physicsRouteNodes: [-300, -150, 0, 150, 300].map((y, index) => ({
        id: `obstacle-${index}`,
        x: 420,
        y,
        width: 144,
        height: 144,
      })),
    });
    const path = setup.controller.getEdgePath({
      from: source,
      to: target,
      kind: "gating",
    });
    expect(path).toMatch(/^M /);
    expect(path).toContain(" L ");
    expect(path).not.toContain(" Q ");
    expect(setup.writes).toEqual([]);
  });

  it.each(["overview", "canvas", "physics"])(
    "allows deep zoom with a positive numeric floor in %s",
    (mode) => {
      const setup = overviewFixture();
      setup.settings.set("graphPresentation", mode);
      expect(setup.controller.clampGraphZoom(0.0002)).toBe(0.0002);
      expect(setup.controller.clampGraphZoom(0)).toBe(0.0001);
      expect(setup.controller.clampGraphZoom(-Infinity)).toBe(0.0001);
      expect(setup.controller.clampGraphZoom(Infinity)).toBe(2.25);
      expect(setup.controller.clampGraphZoom(Number.NaN)).toBe(1);
    },
  );

  it("keeps wheel and button zoom working below one percent and restores normal scale with Home", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    const viewport = {
      clientWidth: 1100,
      clientHeight: 573,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    } as HTMLElement;
    const content = {} as HTMLElement;
    const center = vi.fn();
    const applyZoom = vi.fn();
    const scroll = vi.fn();
    Object.assign(setup.graph, {
      graphZoom: 0.001,
      graphWorldBounds: { minX: 0, minY: 0, maxX: 5000, maxY: 5000 },
      containerEl: { querySelector: () => content },
      getGraphViewportEl: () => viewport,
      getCurrentGraphCanvasBounds: () => ({ width: 5000, height: 5000 }),
      getViewportWorldPoint: () => ({ x: 100, y: 200 }),
      getGraphViewportState: () => ({
        zoom: setup.controller.graphZoom,
        scrollLeft: 0,
        scrollTop: 0,
      }),
      applyGraphZoom: applyZoom,
      scrollViewportToWorldPoint: scroll,
      schedulePersistGraphViewportState: vi.fn(),
      persistGraphViewportState: vi.fn(),
      centerGraphCameraOnNodes: center,
    });
    setup.controller.zoomGraphByFactor(1 / 1.2);
    expect(setup.controller.graphZoom).toBeCloseTo(0.001 / 1.2, 10);
    const beforeWheel = setup.controller.graphZoom;
    setup.controller.zoomGraph(
      {
        deltaY: 100,
        clientX: 300,
        clientY: 200,
        preventDefault: vi.fn(),
      } as unknown as WheelEvent,
      viewport,
      content,
      content,
    );
    expect(setup.controller.graphZoom).toBeLessThan(beforeWheel);
    expect(scroll).toHaveBeenLastCalledWith(
      viewport,
      { x: 100, y: 200 },
      300,
      200,
    );
    for (let step = 0; step < 30; step += 1)
      setup.controller.zoomGraphByFactor(1 / 1.2);
    expect(setup.controller.graphZoom).toBe(0.0001);
    setup.controller.zoomGraphByFactor(1.2);
    expect(setup.controller.graphZoom).toBeCloseTo(0.00012, 10);
    setup.controller.resetGraphCamera();
    expect(setup.controller.graphZoom).toBe(1);
    expect(center).toHaveBeenCalledWith(viewport, []);
    expect(applyZoom).toHaveBeenCalled();
    expect(setup.writes).toEqual([]);
  });

  it.each([
    ["hanging", 1200, 128],
    ["growing", -1200, 445],
    ["radial", 1200, 286.5],
  ])("frames the %s root to match its direction", (mode, childY, expectedY) => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphPhysicsLayout", mode);
    setup.settings.set("graphRoot", "scope");
    const nodes = setup.controller.getGraphNodes();
    const root = nodes.find((node) => node.file.path === "Scope.md")!;
    const feature = nodes.find((node) => node.file.path === "Feature.md")!;
    Object.assign(root, { x: 0, y: 0 });
    Object.assign(feature, { x: 0, y: childY });
    const scroll = vi.fn();
    Object.assign(setup.graph, { scrollViewportToWorldPoint: scroll });
    setup.controller.centerGraphCameraOnNodes(
      { clientWidth: 1100, clientHeight: 573 } as HTMLElement,
      nodes,
    );
    expect(scroll.mock.calls[0][3]).toBe(expectedY);
    expect(scroll.mock.calls[0][1]).toEqual({ x: 80, y: 80 });
  });

  it("keeps each rooted physics layout separate without changing notes or manual coordinates", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphRoot", "scope");
    expect(setup.controller.getGraphPhysicsLayout()).toBe("workflow");
    const keys = new Set<string>();
    for (const mode of ["workflow", "hanging", "growing", "radial"]) {
      setup.settings.set("graphPhysicsLayout", mode);
      const nodes = setup.controller.getGraphNodes();
      setup.controller.layoutPhysicsGraph(nodes);
      keys.add(setup.controller.getPhysicsCacheKey());
      expect(setup.controller.getGraphPhysicsLayout()).toBe(mode);
      expect(nodes.find((node) => node.file.path === "Scope.md")).toMatchObject(
        { x: 0, y: 0 },
      );
    }
    expect(keys.size).toBe(4);
    expect(setup.controller.physicsCaches.size).toBe(4);
    expect(setup.settings.get("graphNodePositions")).toEqual({
      "Feature.md": { x: 800, y: -200 },
    });
    expect(setup.writes).toEqual([]);
  });

  it("physically connects every visible owning branch and terminal rollback to the root", () => {
    const setup = overviewFixture([
      { path: "Person.md", properties: { kind: "group" } },
      {
        path: "Career.md",
        properties: { kind: "group", rollup_to: ["[[Person]]"] },
      },
      {
        path: "Rollback.md",
        properties: {
          parent: "[[Feature]]",
          compensates: ["[[Done]]"],
          status: "Planned",
        },
      },
      {
        path: "Observation.md",
        properties: { parent: "[[Feature]]", kind: "impact" },
      },
    ]);
    setup.properties.get("Scope.md")!.rollup_to = ["[[Career]]"];
    setup.properties.get("Thread.md")!.status = "Failed";
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    setup.settings.set("graphRoot", "person");
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphOverviewFocus", "path:Feature.md");
    setup.settings.set("graphOverviewExpanded", ["Feature.md"]);
    const nodes = setup.controller.getGraphNodes();
    const edges = setup.controller.buildPhysicsEdges(nodes);
    const reached = new Set(["Person.md"]);
    for (let pass = 0; pass < nodes.length; pass += 1)
      for (const edge of edges.filter((edge) => edge.spring)) {
        if (reached.has(edge.from.file.path)) reached.add(edge.to.file.path);
        if (reached.has(edge.to.file.path)) reached.add(edge.from.file.path);
      }
    expect(reached.size).toBe(nodes.length);
    expect(edges.find((edge) => edge.kind === "compensation")!.spring).toBe(
      true,
    );
    expect(
      edges.find(
        (edge) =>
          edge.kind === "association" && edge.to.file.path === "Observation.md",
      )!.spring,
    ).toBe(true);
    expect(
      edges
        .filter((edge) => edge.kind === "membership")
        .every((edge) => edge.spring),
    ).toBe(true);
    expect(
      edges.filter((edge) => edge.kind === "break").some((edge) => edge.spring),
    ).toBe(false);
    expect(setup.writes).toEqual([]);
  });

  it("does not turn cross-branch information into springs and attaches orphaned terminal children through their owner", () => {
    const setup = overviewFixture([
      {
        path: "Other.md",
        properties: { kind: "group", rollup_to: ["[[Scope]]"] },
      },
      {
        path: "Other work.md",
        properties: { parent: "[[Other]]", status: "Completed" },
      },
      {
        path: "Rollback.md",
        properties: {
          parent: "[[Feature]]",
          compensates: ["[[Other work]]"],
          status: "Completed",
        },
      },
    ]);
    setup.properties.get("Thread.md")!.rollup_to = ["[[Other]]"];
    setup.settings.set("graphRoot", "scope");
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphOverviewExpanded", ["Feature.md", "Other.md"]);
    const nodes = setup.controller.getGraphNodes();
    const edges = setup.controller.buildPhysicsEdges(nodes);
    expect(
      edges.find(
        (edge) =>
          edge.kind === "membership" && edge.from.file.path === "Thread.md",
      )!.spring,
    ).toBe(false);
    expect(
      edges.find(
        (edge) =>
          edge.kind === "association" && edge.to.file.path === "Rollback.md",
      ),
    ).toMatchObject({
      from: { file: { path: "Feature.md" } },
      spring: true,
    });
    expect(setup.writes).toEqual([]);
  });

  it("frames the compact physics workflow instead of measuring padded world bounds", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphRoot", "scope");
    const nodes = setup.controller.getGraphNodes();
    const root = nodes.find((node) => node.file.path === "Scope.md")!;
    const feature = nodes.find((node) => node.file.path === "Feature.md")!;
    Object.assign(root, { x: 0, y: 0 });
    Object.assign(feature, { x: 780, y: 0 });
    const scroll = vi.fn();
    Object.assign(setup.graph, {
      graphWorldBounds: { minX: -1600, minY: -1000, maxX: 2000, maxY: 1500 },
      scrollViewportToWorldPoint: scroll,
    });
    setup.controller.centerGraphCameraOnNodes(
      { clientWidth: 1100, clientHeight: 573 } as HTMLElement,
      nodes,
    );
    const [, center, screenX] = scroll.mock.calls[0] as [
      HTMLElement,
      { x: number; y: number },
      number,
    ];
    expect(center).toEqual({ x: 80, y: 80 });
    expect(screenX - 80).toBeGreaterThanOrEqual(32);
    expect(screenX + 860).toBeLessThanOrEqual(1100 - 32);
    expect(setup.writes).toEqual([]);
  });

  it("keeps experimental physics opt-in and reuses the scoped hierarchy", async () => {
    const setup = overviewFixture();
    expect(setup.controller.getGraphPresentation()).toBe("overview");
    setup.settings.set("graphPresentation", "physics");
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    let nodes = setup.controller.getGraphNodes();
    expect(nodes.map((node) => node.file.path)).toEqual([
      "Feature.md",
      "Scope.md",
    ]);
    expect(setup.controller.layoutPhysicsGraph(nodes)).toMatchObject([
      {
        kind: "membership",
        from: { file: { path: "Feature.md" } },
        to: { file: { path: "Scope.md" } },
      },
    ]);
    await setup.controller.toggleGraphCollapse(nodes[0]);
    nodes = setup.controller.getGraphNodes();
    const edges = setup.controller.layoutPhysicsGraph(nodes);
    expect(
      edges
        .filter((edge) => edge.kind !== "membership")
        .map((edge) => edge.kind),
    ).toEqual([
      "requirement-start",
      "gating",
      "requirement-return",
      "requirement-return",
    ]);
    expect(
      edges
        .filter((edge) => edge.kind !== "membership")
        .map((edge) => [edge.from.file.path, edge.to.file.path, edge.kind]),
    ).toEqual([
      ["Feature.md", "Done.md", "requirement-start"],
      ["Done.md", "Thread.md", "gating"],
      ["Thread.md", "Done.md", "requirement-return"],
      ["Done.md", "Feature.md", "requirement-return"],
    ]);
    expect(
      edges.every(
        (edge) => nodes.includes(edge.from) && nodes.includes(edge.to),
      ),
    ).toBe(true);
    expect(setup.writes).toEqual([]);
  });

  it("colors completed forward flow green and only completes the return when the last step is done", async () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    const [feature] = setup.controller.getGraphNodes();
    await setup.controller.toggleGraphCollapse(feature);
    let edges = setup.controller.layoutPhysicsGraph(
      setup.controller.getGraphNodes(),
    );
    expect(
      setup.controller.getEdgeMarkerKind(
        edges.find((edge) => edge.kind === "requirement-start")!,
      ),
    ).toBe("physics-completed");
    expect(
      setup.controller.getEdgeMarkerKind(
        edges.find((edge) => edge.kind === "gating")!,
      ),
    ).toBe("physics-completed");
    expect(
      setup.controller.getEdgeMarkerKind(
        edges.find((edge) => edge.kind === "requirement-return")!,
      ),
    ).toBe("physics-waiting");
    expect(
      edges
        .filter((edge) => edge.kind === "requirement-return")
        .every(
          (edge) =>
            setup.controller.getEdgeMarkerKind(edge) === "physics-waiting",
        ),
    ).toBe(true);
    setup.properties.get("Thread.md")!.status = "Completed";
    edges = setup.controller.layoutPhysicsGraph(
      setup.controller.getGraphNodes(),
    );
    expect(
      setup.controller.getEdgeMarkerKind(
        edges.find((edge) => edge.kind === "requirement-return")!,
      ),
    ).toBe("physics-completed");
    expect(
      edges
        .filter((edge) => edge.kind === "requirement-return")
        .every(
          (edge) =>
            setup.controller.getEdgeMarkerKind(edge) === "physics-completed",
        ),
    ).toBe(true);
    expect(setup.writes).toEqual([]);
  });

  it("replaces the completion return with a failure feedback edge in physics", async () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    setup.properties.get("Done.md")!.status = "Failed";
    setup.properties.get("Thread.md")!.status = "Invalidated";
    const [feature] = setup.controller.getGraphNodes();
    await setup.controller.toggleGraphCollapse(feature);
    const edges = setup.controller.layoutPhysicsGraph(
      setup.controller.getGraphNodes(),
    );
    expect(edges.filter((edge) => edge.kind === "break")).toMatchObject([
      {
        from: { file: { path: "Done.md" } },
        to: { file: { path: "Feature.md" } },
      },
    ]);
    expect(edges.some((edge) => edge.kind === "requirement-return")).toBe(
      false,
    );
    expect(
      setup.controller.getEdgeMarkerKind(
        edges.find((edge) => edge.kind === "break")!,
      ),
    ).toBe("physics-interrupted");
    expect(setup.writes).toEqual([]);
  });

  it("backtracks a mid-chain failure through completed predecessors and grays the unexecuted edge", async () => {
    const setup = overviewFixture([
      {
        path: "Later.md",
        properties: {
          parent: "[[Feature]]",
          depends_on: ["[[Thread]]"],
          status: "Invalidated",
        },
      },
    ]);
    setup.settings.set("graphPresentation", "physics");
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    setup.properties.get("Thread.md")!.status = "Failed";
    const [feature] = setup.controller.getGraphNodes();
    await setup.controller.toggleGraphCollapse(feature);
    const nodes = setup.controller.getGraphNodes();
    const edges = setup.controller.layoutPhysicsGraph(nodes);
    expect(
      edges
        .filter((edge) => edge.kind === "break")
        .map((edge) => [edge.from.file.path, edge.to.file.path]),
    ).toEqual([
      ["Thread.md", "Done.md"],
      ["Done.md", "Feature.md"],
    ]);
    expect(nodes.find((node) => node.file.path === "Done.md")!.state).toBe(
      "completed",
    );
    expect(nodes.find((node) => node.file.path === "Later.md")!.state).toBe(
      "invalidated",
    );
    const downstream = edges.find(
      (edge) => edge.kind === "gating" && edge.to.file.path === "Later.md",
    )!;
    expect(setup.controller.getEdgeMarkerKind(downstream)).toBe(
      "physics-invalidated",
    );
    expect(edges.some((edge) => edge.kind === "requirement-return")).toBe(
      false,
    );
    expect(setup.writes).toEqual([]);
  });

  it("uses springs for execution flow but not scope membership or feedback", () => {
    expect(
      ["requirement-start", "gating", "requirement-return", "restart"].every(
        isGraphSpringEdge,
      ),
    ).toBe(true);
    expect(
      ["membership", "break", "compensation", "association"].some(
        isGraphSpringEdge,
      ),
    ).toBe(false);
  });

  it.each(["physics", "canvas"])(
    "keeps the completed branch's return green beside a red failure trace in %s",
    (mode) => {
      const setup = overviewFixture([
        {
          path: "Side.md",
          properties: { parent: "[[Feature]]", status: "Completed" },
        },
        {
          path: "Side finish.md",
          properties: {
            parent: "[[Feature]]",
            depends_on: ["[[Side]]"],
            status: "Completed",
          },
        },
        {
          path: "Later.md",
          properties: {
            parent: "[[Feature]]",
            depends_on: ["[[Thread]]"],
            status: "Invalidated",
          },
        },
      ]);
      setup.settings.set("graphPresentation", mode);
      setup.settings.set("graphOverviewExpanded", ["Feature.md"]);
      setup.properties.get("Feature.md")!.graph_collapsed = false;
      setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
      setup.properties.get("Thread.md")!.status = "Failed";
      const nodes = setup.controller.getGraphNodes();
      const edges = setup.controller.buildGraphFlowEdges(nodes);
      const returns = edges.filter(
        (edge) => edge.kind === "requirement-return",
      );
      expect(
        new Set(
          returns.map((edge) => `${edge.from.file.path}>${edge.to.file.path}`),
        ),
      ).toEqual(new Set(["Side finish.md>Side.md", "Side.md>Feature.md"]));
      expect(
        returns.every(
          (edge) =>
            setup.controller.getEdgeMarkerKind(edge) ===
            (mode === "physics" ? "physics-completed" : "requirement-return"),
        ),
      ).toBe(true);
      const breaks = edges.filter((edge) => edge.kind === "break");
      expect(
        new Set(
          breaks.map((edge) => `${edge.from.file.path}>${edge.to.file.path}`),
        ),
      ).toEqual(new Set(["Thread.md>Done.md", "Done.md>Feature.md"]));
      expect(
        breaks.every(
          (edge) =>
            setup.controller.getEdgeMarkerKind(edge) ===
            (mode === "physics" ? "physics-interrupted" : "break"),
        ),
      ).toBe(true);
      const skipped = edges.find(
        (edge) => edge.kind === "gating" && edge.to.file.path === "Later.md",
      )!;
      expect(setup.controller.getEdgeMarkerKind(skipped)).toBe(
        mode === "physics" ? "physics-invalidated" : "flow-inactive",
      );
      expect(setup.writes).toEqual([]);
    },
  );

  it("continues a hidden subprocess failure backward through its outer sequence", () => {
    const setup = overviewFixture([
      { path: "Outer.md", properties: { rollup_to: ["[[Scope]]"] } },
      {
        path: "Setup.md",
        properties: { parent: "[[Outer]]", status: "Completed" },
      },
    ]);
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphOverviewExpanded", ["Outer.md"]);
    Object.assign(setup.properties.get("Feature.md")!, {
      parent: "[[Outer]]",
      depends_on: ["[[Setup]]"],
      rollup_to: [],
    });
    setup.properties.get("Thread.md")!.depends_on = ["[[Done]]"];
    setup.properties.get("Thread.md")!.status = "Failed";
    const nodes = setup.controller.getGraphNodes();
    expect(nodes.some((node) => node.file.path === "Thread.md")).toBe(false);
    const edges = setup.controller.buildGraphFlowEdges(nodes);
    expect(
      new Set(
        edges
          .filter((edge) => edge.kind === "break")
          .map((edge) => `${edge.from.file.path}>${edge.to.file.path}`),
      ),
    ).toEqual(new Set(["Feature.md>Setup.md", "Setup.md>Outer.md"]));
    expect(nodes.find((node) => node.file.path === "Setup.md")!.state).toBe(
      "completed",
    );
    expect(setup.writes).toEqual([]);
  });

  it("uses one red shared return while preserving the successful arm of a fork", () => {
    const setup = overviewFixture([
      {
        path: "Other result.md",
        properties: {
          parent: "[[Feature]]",
          depends_on: ["[[Done]]"],
          status: "Completed",
        },
      },
    ]);
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphOverviewExpanded", ["Feature.md"]);
    Object.assign(setup.properties.get("Thread.md")!, {
      depends_on: ["[[Done]]"],
      status: "Failed",
    });
    const edges = setup.controller.buildGraphFlowEdges(
      setup.controller.getGraphNodes(),
    );
    expect(
      edges
        .filter(
          (edge) =>
            edge.from.file.path === "Done.md" &&
            edge.to.file.path === "Feature.md",
        )
        .map((edge) => edge.kind),
    ).toEqual(["break"]);
    expect(
      edges
        .filter((edge) => edge.kind === "requirement-return")
        .map((edge) => [edge.from.file.path, edge.to.file.path]),
    ).toEqual([["Other result.md", "Done.md"]]);
    expect(setup.writes).toEqual([]);
  });

  it("replaces old authored ancestor shortcuts without discarding explicit recovery links", () => {
    const setup = overviewFixture([
      {
        path: "Recovery.md",
        properties: { rollup_to: ["[[Scope]]"], status: "Planned" },
      },
    ]);
    setup.settings.set("graphPresentation", "physics");
    setup.settings.set("graphOverviewExpanded", ["Feature.md"]);
    Object.assign(setup.properties.get("Thread.md")!, {
      depends_on: ["[[Done]]"],
      status: "Failed",
      breaks_to: ["[[Feature]]", "[[Recovery]]"],
    });
    const edges = setup.controller.buildGraphFlowEdges(
      setup.controller.getGraphNodes(),
    );
    expect(
      new Set(
        edges
          .filter((edge) => edge.kind === "break")
          .map((edge) => `${edge.from.file.path}>${edge.to.file.path}`),
      ),
    ).toEqual(
      new Set([
        "Thread.md>Done.md",
        "Done.md>Feature.md",
        "Thread.md>Recovery.md",
      ]),
    );
    expect(setup.properties.get("Thread.md")!.breaks_to).toEqual([
      "[[Feature]]",
      "[[Recovery]]",
    ]);
    expect(setup.writes).toEqual([]);
  });

  it("draws inert observations as associations instead of workflow steps", async () => {
    const setup = overviewFixture([
      {
        path: "Metric.md",
        properties: { parent: "[[Feature]]", kind: "impact", status: "Failed" },
      },
    ]);
    setup.settings.set("graphPresentation", "physics");
    const [feature] = setup.controller.getGraphNodes();
    await setup.controller.toggleGraphCollapse(feature);
    const edges = setup.controller.layoutPhysicsGraph(
      setup.controller.getGraphNodes(),
    );
    const metricEdges = edges.filter(
      (edge) =>
        edge.from.file.path === "Metric.md" ||
        edge.to.file.path === "Metric.md",
    );
    expect(metricEdges).toMatchObject([
      {
        from: { file: { path: "Feature.md" } },
        to: { file: { path: "Metric.md" } },
        kind: "association",
      },
    ]);
    expect(metricEdges.some((edge) => isGraphSpringEdge(edge.kind))).toBe(
      false,
    );
    expect(setup.writes).toEqual([]);
  });

  it("keeps simulated positions out of notes, manual layout, and recorded metadata", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    let nodes = setup.controller.getGraphNodes();
    const originalSettings = JSON.stringify([...setup.settings]);
    const recorded = JSON.stringify(setup.controller.temporalLiveNodes);
    setup.controller.layoutPhysicsGraph(nodes);
    setup.controller.physicsCaches
      .get("path:Scope.md")!
      .positions.set("path:Feature.md", { x: 1234, y: -567 });
    nodes = setup.controller.getGraphNodes();
    setup.controller.layoutPhysicsGraph(nodes);
    expect(nodes[0]).toMatchObject({ x: 1234, y: -567 });
    expect(JSON.stringify([...setup.settings])).toBe(originalSettings);
    expect(JSON.stringify(setup.controller.temporalLiveNodes)).toBe(recorded);
    expect(setup.writes).toEqual([]);
  });

  it("forces static Overview in history without changing the selected live physics mode", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "physics");
    setup.controller.getGraphNodes();
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      setup.controller.temporalLiveNodes,
      100,
      "physics",
    ).history;
    setup.controller.temporalScopeKey = "path:Scope.md";
    setup.controller.temporalCursor = 100;
    expect(setup.controller.getGraphPresentation()).toBe("overview");
    expect(
      setup.controller.getGraphNodes().map((node) => node.file.path),
    ).toEqual(["Feature.md"]);
    expect(setup.settings.get("graphPresentation")).toBe("physics");
    setup.controller.temporalCursor = null;
    expect(setup.controller.getGraphPresentation()).toBe("physics");
  });

  it("groups disconnected items visually and never adds the virtual node to recording or ownership", () => {
    const setup = overviewFixture([
      { path: "Loose.md", properties: { title: "Loose", status: "Blocked" } },
      {
        path: "Other.md",
        properties: { title: "Other", status: "In Progress" },
      },
    ]);
    expect(
      setup.controller.getGraphNodes().map((node) => node.file.path),
    ).toEqual(["Feature.md"]);
    setup.controller.focusOverview("@all");
    const roots = setup.controller.getGraphNodes();
    expect(roots.map((node) => node.file.path).sort()).toEqual([
      "@unassigned",
      "Scope.md",
    ]);
    expect(
      setup.controller.graphWorkSummaries.get("@unassigned"),
    ).toMatchObject({ total: 2, blocked: 1, active: 1 });
    setup.controller.openGraphNode(
      roots.find((node) => node.file.path === "@unassigned")!,
    );
    expect(
      setup.controller
        .getGraphNodes()
        .map((node) => node.file.path)
        .sort(),
    ).toEqual(["Loose.md", "Other.md"]);
    expect(setup.controller.graphNodes).toHaveLength(6);
    expect(setup.controller.temporalLiveNodes).toHaveLength(6);
    expect(
      setup.controller.temporalLiveNodes.some(
        (node) => node.path === "@unassigned",
      ),
    ).toBe(false);
    expect(setup.properties.get("Loose.md")).not.toHaveProperty("parent");
    expect(setup.writes).toEqual([]);
  });

  it("keeps history focus local without overwriting live scope selection", () => {
    const setup = overviewFixture();
    setup.settings.set("graphOverviewFocus", "path:Feature.md");
    setup.controller.getGraphNodes();
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      setup.controller.temporalLiveNodes,
      100,
      "first",
    ).history;
    setup.controller.temporalCursor = 100;
    setup.controller.temporalScopeKey = "path:Feature.md";
    expect(
      setup.controller
        .getGraphNodes()
        .map((node) => node.file.path)
        .sort(),
    ).toEqual(["Done.md", "Thread.md"]);
    setup.controller.focusOverview("path:Scope.md");
    expect(
      setup.controller.getGraphNodes().map((node) => node.file.path),
    ).toEqual(["Feature.md"]);
    expect(setup.settings.get("graphOverviewFocus")).toBe("path:Feature.md");
    expect(setup.writes).toEqual([]);
  });

  it("retains a recorded identity when an ID is added and the view reopens", () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    const original = setup.controller.temporalLiveNodes;
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      original,
      100,
      "first",
    ).history;
    setup.controller.temporalFileKeys.clear();
    setup.properties.get("Thread.md")!.id = "stable-thread-id";
    setup.controller.getGraphNodes();
    const updated = setup.controller.temporalLiveNodes;
    expect(updated.find((node) => node.path === "Thread.md")!.key).toBe(
      original.find((node) => node.path === "Thread.md")!.key,
    );
    setup.controller.temporalHistory = recordGraphObservation(
      setup.controller.temporalHistory,
      updated,
      200,
      "second",
    ).history;
    setup.controller.temporalFileKeys.clear();
    const renamed = setup.files.find((file) => file.path === "Thread.md")!;
    renamed.path = "Renamed.md";
    renamed.basename = "Renamed";
    setup.properties.set("Renamed.md", setup.properties.get("Thread.md")!);
    setup.properties.delete("Thread.md");
    setup.controller.getGraphNodes();
    expect(
      setup.controller.temporalLiveNodes.find(
        (node) => node.path === "Renamed.md",
      )!.key,
    ).toBe(original.find((node) => node.path === "Thread.md")!.key);
  });

  it("replays past status, hierarchy, and removed notes without reading today's metadata", () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    const baseline = setup.controller.temporalLiveNodes;
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      baseline,
      100,
      "recorded",
    ).history;
    setup.controller.temporalCursor = 100;
    setup.controller.temporalExpandedKeys = new Set(
      baseline.map((node) => node.key),
    );
    setup.properties.get("Thread.md")!.status = "Completed";
    setup.properties.get("Thread.md")!.parent = "[[Scope]]";
    setup.view.data.data.splice(
      setup.view.data.data.findIndex((entry) => entry.file.path === "Done.md"),
      1,
    );
    const replay = setup.controller.getGraphNodes();
    expect(replay.find((node) => node.file.path === "Thread.md")!.status).toBe(
      "In Progress",
    );
    expect(
      replay.find((node) => node.file.path === "Feature.md")!.children,
    ).toHaveLength(2);
    expect(replay.some((node) => node.file.path === "Done.md")).toBe(true);
    expect(setup.controller.graphWorkSummaries.get("Scope.md")).toMatchObject({
      total: 2,
      completed: 1,
      active: 1,
    });
    expect(() =>
      setup.controller.openGraphNode(
        replay.find((node) => node.file.path === "Done.md")!,
      ),
    ).not.toThrow();
    expect(setup.writes).toEqual([]);
  });

  it("changes historical expansion locally and restores current data when leaving history", async () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    const baseline = setup.controller.temporalLiveNodes;
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      baseline,
      100,
      "recorded",
    ).history;
    setup.controller.temporalCursor = 100;
    setup.controller.temporalExpandedKeys = new Set([
      baseline.find((node) => node.path === "Scope.md")!.key,
    ]);
    const settings = JSON.stringify([...setup.settings]);
    const feature = setup.controller
      .getGraphNodes()
      .find((node) => node.file.path === "Feature.md")!;
    await setup.controller.toggleGraphCollapse(feature);
    expect(setup.controller.getGraphNodes()).toHaveLength(4);
    expect(JSON.stringify([...setup.settings])).toBe(settings);
    expect(setup.writes).toEqual([]);
    setup.properties.get("Thread.md")!.status = "Completed";
    setup.controller.temporalCursor = null;
    setup.controller.getGraphNodes();
    expect(setup.controller.graphWorkSummaries.get("Scope.md")).toMatchObject({
      total: 2,
      completed: 2,
    });
  });

  it("starts at workstreams and summarizes hidden work instead of stored container status", () => {
    const setup = overviewFixture();
    const nodes = setup.controller.getGraphNodes();
    expect(nodes.map((node) => node.file.path)).toEqual(["Feature.md"]);
    expect(setup.controller.overviewScopeKey).toBe("path:Scope.md");
    expect(setup.controller.overviewBreadcrumbs).toEqual([
      { key: "path:Scope.md", title: "Scope" },
    ]);
    expect(setup.controller.graphWorkSummaries.get("Feature.md")).toMatchObject(
      { total: 2, completed: 1, active: 1, state: "in-progress" },
    );
    expect(setup.controller.graphWorkSummaries.get("Scope.md")).toMatchObject({
      total: 2,
      completed: 1,
      active: 1,
    });
  });

  it("expands a workstream without changing notes or saved layout positions", async () => {
    const setup = overviewFixture();
    const nodes = setup.controller.getGraphNodes();
    const positions = JSON.stringify(setup.settings.get("graphNodePositions"));
    await setup.controller.toggleGraphCollapse(
      nodes.find((node) => node.file.path === "Feature.md")!,
    );
    expect(setup.controller.getGraphNodes()).toHaveLength(3);
    expect(setup.settings.get("graphOverviewExpanded")).toEqual(["Feature.md"]);
    expect(setup.writes).toEqual([]);
    expect(JSON.stringify(setup.settings.get("graphNodePositions"))).toBe(
      positions,
    );
    expect(setup.properties.get("Feature.md")!.graph_collapsed).toBe(true);
  });

  it("collapses workstreams inside the selected scope without losing child work or progress", () => {
    const setup = overviewFixture();
    setup.settings.set("graphOverviewExpanded", []);
    expect(
      setup.controller.getGraphNodes().map((node) => node.file.path),
    ).toEqual(["Feature.md"]);
    expect(
      setup.controller.graphNodes.find(
        (node) => node.file.path === "Feature.md",
      )!.children,
    ).toHaveLength(2);
    expect(setup.controller.graphWorkSummaries.get("Scope.md")!.total).toBe(2);
  });

  it("focuses a branch and navigates upward without changing ownership or manual layout", () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    const positions = JSON.stringify(setup.settings.get("graphNodePositions"));
    setup.controller.focusOverview("path:Feature.md");
    expect(
      setup.controller
        .getGraphNodes()
        .map((node) => node.file.path)
        .sort(),
    ).toEqual(["Done.md", "Thread.md"]);
    expect(
      setup.controller.overviewBreadcrumbs.map((entry) => entry.title),
    ).toEqual(["Scope", "Feature"]);
    setup.controller.focusOverview("path:Scope.md");
    expect(
      setup.controller.getGraphNodes().map((node) => node.file.path),
    ).toEqual(["Feature.md"]);
    expect(setup.writes).toEqual([]);
    expect(JSON.stringify(setup.settings.get("graphNodePositions"))).toBe(
      positions,
    );
  });

  it("does not widen a missing historical focus to the whole graph", () => {
    const setup = overviewFixture();
    setup.controller.getGraphNodes();
    setup.controller.temporalHistory = recordGraphObservation(
      null,
      setup.controller.temporalLiveNodes,
      100,
      "first",
    ).history;
    setup.controller.temporalCursor = 100;
    setup.controller.temporalScopeKey = "id:not-created-yet";
    expect(setup.controller.getGraphNodes()).toEqual([]);
    expect(setup.controller.overviewScopeKey).toBe("id:not-created-yet");
    expect(setup.controller.graphNodes).toHaveLength(4);
  });

  it("retains full work relationships and saved positions in collapsed free layout", () => {
    const setup = overviewFixture();
    setup.settings.set("graphPresentation", "canvas");
    const nodes = setup.controller.getGraphNodes();
    const feature = nodes.find((node) => node.file.path === "Feature.md")!;
    expect(feature.savedX).toBe(800);
    expect(feature.savedY).toBe(-200);
    expect(nodes.some((node) => node.file.path === "Thread.md")).toBe(false);
    expect(
      setup.controller.graphNodes.find(
        (node) => node.file.path === "Feature.md",
      )!.children,
    ).toHaveLength(2);
  });
});

describe("graph recording persistence", () => {
  async function pluginWithHistory(saved: unknown = null) {
    const plugin = new BaseBoardPlugin({} as never, {} as never);
    plugin.loadData = vi.fn(async () => saved);
    plugin.saveData = vi.fn(async () => {});
    await plugin.loadPluginData();
    const graph = overviewFixture();
    graph.controller.getGraphNodes();
    return { plugin, nodes: graph.controller.temporalLiveNodes };
  }

  it("persists deltas without writing unchanged observations repeatedly", async () => {
    const { plugin, nodes } = await pluginWithHistory();
    await plugin.recordGraphHistory("graph-test", nodes, 100, "first");
    await plugin.recordGraphHistory("graph-test", nodes, 200, "first");
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.getRecordedGraphHistory("graph-test")!.observedThrough).toBe(
      200,
    );
    expect(plugin.getRecordedGraphHistory("graph-test")!.frames).toHaveLength(
      1,
    );
  });

  it("serializes history and settings saves without losing either update", async () => {
    const { plugin, nodes } = await pluginWithHistory();
    let release: () => void = () => {};
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn(async (_snapshot: unknown) => {});
    save.mockImplementationOnce(() => firstWrite);
    plugin.saveData = save;
    const recording = plugin.recordGraphHistory(
      "graph-test",
      nodes,
      100,
      "first",
    );
    plugin.data_.columnConfigs.board = { columns: ["Planned", "Completed"] };
    const settings = plugin.savePluginData();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([recording, settings]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({
      columnConfigs: { board: { columns: ["Planned", "Completed"] } },
      graphHistories: {
        "graph-test": {
          frames: [expect.objectContaining({ kind: "baseline" })],
        },
      },
    });
  });

  it("retries an unsaved journal instead of treating an in-memory copy as durable", async () => {
    const { plugin, nodes } = await pluginWithHistory();
    const save = vi.fn(async () => {});
    save.mockRejectedValueOnce(new Error("Storage unavailable"));
    plugin.saveData = save;
    await expect(
      plugin.recordGraphHistory("graph-test", nodes, 100, "first"),
    ).rejects.toThrow("Storage unavailable");
    await plugin.recordGraphHistory("graph-test", nodes, 200, "first");
    expect(save).toHaveBeenCalledTimes(2);
    expect(plugin.getRecordedGraphHistory("graph-test")!.frames).toHaveLength(
      1,
    );
  });

  it("preserves recordings across reload and records an observation gap", async () => {
    const { plugin, nodes } = await pluginWithHistory();
    await plugin.recordGraphHistory("graph-test", nodes, 100, "first");
    await plugin.finishGraphObservation("graph-test", 200, "first");
    const saved: unknown = JSON.parse(JSON.stringify(plugin.data_));
    const reopened = await pluginWithHistory(saved);
    await reopened.plugin.recordGraphHistory(
      "graph-test",
      nodes,
      500,
      "second",
    );
    expect(
      reopened.plugin.getRecordedGraphHistory("graph-test")!.frames[1],
    ).toMatchObject({ kind: "resume", gapAfter: 200, at: 500, upserts: [] });
  });

  it("does not overwrite unsupported history with a new baseline", async () => {
    const invalid = { version: 99, frames: ["preserve this"] };
    const { plugin, nodes } = await pluginWithHistory({
      graphHistories: { "graph-test": invalid },
    });
    await expect(
      plugin.recordGraphHistory("graph-test", nodes, 100, "first"),
    ).rejects.toThrow();
    expect(plugin.data_.graphHistories["graph-test"]).toEqual(invalid);
    expect(plugin.saveData).not.toHaveBeenCalled();
  });
});

describe("upstream ordering with fork workflows", () => {
  it("keeps rollout movement independent from Kanban order and task status", async () => {
    const history = [{ from: "Planned", to: "Awaiting" }];
    const setup = fixture([
      {
        path: "task.md",
        properties: {
          status: "Awaiting",
          kanban_order: "a0",
          timeline_order: 7,
          rollout_enabled: true,
          rollout_ring: "Stage",
          status_history: history,
        },
      },
    ]);
    const rolloutView = Object.assign(Object.create(RolloutView.prototype), {
      app: setup.view.app,
      render: vi.fn(),
    });
    await rolloutView.handleCardDrop("task.md", "Canary", ["task.md"]);
    const saved = setup.properties.get("task.md")!;
    expect(saved).toMatchObject({
      status: "Awaiting",
      kanban_order: "a0",
      timeline_order: 7,
      rollout_ring: "Canary",
      rollout_order: 0,
      status_history: history,
    });
    expect(saved.rollout_history).toEqual([
      expect.objectContaining({ from: "Stage", to: "Canary" }),
    ]);
  });

  it("migrates numeric order in the exact requested order without changing status history", async () => {
    const history = [{ from: "Planned", to: "In Progress" }];
    const setup = fixture([
      {
        path: "first.md",
        properties: {
          status: "In Progress",
          kanban_order: 10,
          status_history: history,
        },
      },
      {
        path: "second.md",
        properties: { status: "In Progress", kanban_order: 20 },
      },
      {
        path: "third.md",
        properties: { status: "In Progress", kanban_order: 30 },
      },
    ]);
    const order = ["third.md", "first.md", "second.md"];
    await setup.drop("third.md", "In Progress", order);
    const keys = order.map((path) => setup.properties.get(path)!.kanban_order);
    expect(keys.every((key) => isOrderKey(key as string))).toBe(true);
    expect([...keys].sort()).toEqual(keys);
    expect(setup.properties.get("first.md")!.status_history).toEqual(history);
    expect(setup.properties.get("third.md")!.status_history).toBeUndefined();
  });

  it("writes only the moved order when the column already uses fractional keys", async () => {
    const keys = generateOrderKeys(null, null, 3);
    const setup = fixture(
      keys.map((key, index) => ({
        path: `${index}.md`,
        properties: { status: "Planned", kanban_order: key },
      })),
    );
    await setup.view.writeCardOrder(["0.md", "2.md", "1.md"], ["2.md"]);
    expect(setup.writes).toEqual(["2.md"]);
    expect(setup.properties.get("0.md")!.kanban_order).toBe(keys[0]);
    expect(setup.properties.get("1.md")!.kanban_order).toBe(keys[1]);
    const inserted = setup.properties.get("2.md")!.kanban_order as string;
    expect(keys[0] < inserted && inserted < keys[1]).toBe(true);
  });

  it("records a canonical transition and preserves unrelated task metadata", async () => {
    const setup = fixture([
      {
        path: "task.md",
        properties: {
          id: "task-id",
          status: "Planned",
          parent: "[[Feature]]",
          kanban_order: 4,
          timeline_order: 12,
          rollout_order: 30,
        },
      },
    ]);
    await setup.drop("task.md", "In Progress", ["task.md"]);
    const saved = setup.properties.get("task.md")!;
    expect(saved.status).toBe("In Progress");
    expect(saved.parent).toBe("[[Feature]]");
    expect(saved.timeline_order).toBe(12);
    expect(saved.rollout_order).toBe(30);
    expect((saved.status_history as TransitionEvent[])[0]).toMatchObject({
      node: "task-id",
      from: "Planned",
      to: "In Progress",
      kind: "activated",
      causedBy: "human",
      source: "baseboard-command",
      property: "status",
    });
  });

  it("archives as Completed and records the real status rather than the virtual shelf", async () => {
    const setup = fixture([
      { path: "task.md", properties: { status: "In Progress" } },
    ]);
    await setup.drop("task.md", "Archived", []);
    const saved = setup.properties.get("task.md")!;
    expect(saved.status).toBe("Completed");
    expect(saved.archived).toBe(true);
    expect(isOrderKey(saved.kanban_order as string)).toBe(true);
    expect((saved.status_history as TransitionEvent[])[0].to).toBe("Completed");
  });

  it("clears explicit archive state when moving work back to Planned", async () => {
    const setup = fixture([
      { path: "task.md", properties: { status: "Completed", archived: true } },
    ]);
    await setup.drop("task.md", "Planned", ["task.md"]);
    expect(setup.properties.get("task.md")!.archived).toBeUndefined();
  });

  it("preserves false as a boolean and numbers as numbers", async () => {
    const booleanSetup = fixture(
      [{ path: "check.md", properties: { status: true } }],
      [new BooleanValue(true)],
    );
    booleanSetup.view.getGroupByProperty = () => "checked";
    booleanSetup.properties.get("check.md")!.checked = true;
    await booleanSetup.drop("check.md", "false", ["check.md"]);
    expect(booleanSetup.properties.get("check.md")!.checked).toBe(false);
    const numberSetup = fixture(
      [{ path: "number.md", properties: { status: 1 } }],
      [new NumberValue(1)],
    );
    numberSetup.view.getGroupByProperty = () => "progress";
    numberSetup.properties.get("number.md")!.progress = 1;
    await numberSetup.drop("number.md", "2", ["number.md"]);
    expect(numberSetup.properties.get("number.md")!.progress).toBe(2);
  });

  it("removes the property and records null for a no-value drop", async () => {
    const setup = fixture([
      { path: "task.md", properties: { status: "Planned" } },
    ]);
    await setup.drop("task.md", NO_VALUE_COLUMN, ["task.md"]);
    const saved = setup.properties.get("task.md")!;
    expect(saved).not.toHaveProperty("status");
    expect((saved.status_history as TransitionEvent[])[0].to).toBeNull();
  });

  it("moves a multi-selection as a contiguous block and logs each transition once", async () => {
    const setup = fixture([
      { path: "first.md", properties: { status: "Planned" } },
      { path: "second.md", properties: { status: "Planned" } },
    ]);
    setup.view.selectedCards = new Set(["first.md", "second.md"]);
    await setup.drop("first.md", "Awaiting", ["first.md"]);
    for (const saved of setup.properties.values()) {
      expect(saved.status).toBe("Awaiting");
      expect(saved.status_history).toHaveLength(1);
    }
    expect(
      (setup.properties.get("first.md")!.kanban_order as string) <
        (setup.properties.get("second.md")!.kanban_order as string),
    ).toBe(true);
  });

  it("applies new-card defaults but keeps destination status and order authoritative", async () => {
    const setup = fixture([]);
    const defaults = {
      team: "frontend",
      type: "bug",
      status: "Wrong",
      kanban_order: 999,
    };
    setup.view.config.get = vi.fn((key: string) =>
      key === "newItemProperties" ? defaults : undefined,
    );
    let saved: Record<string, unknown> = {};
    setup.view.createFileForView = vi.fn(async (_title, update) => {
      saved = {};
      update?.(saved);
    }) as typeof setup.view.createFileForView;
    const manager = new CardManager(setup.view);
    await (
      manager as unknown as {
        createNewCard: (
          title: string,
          column: string,
          order: string,
        ) => Promise<void>;
      }
    ).createNewCard("New task", "Planned", "a0");
    expect(saved).toMatchObject({
      team: "frontend",
      type: "bug",
      status: "Planned",
      kanban_order: "a0",
      tags: ["task"],
    });
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.created).toEqual(expect.any(String));
  });
});
