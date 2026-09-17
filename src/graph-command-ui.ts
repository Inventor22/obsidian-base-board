import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { readSuggestedNext } from "./work-graph";
import {
  applyGraphBatch,
  graphRevision,
  patchGraphMarkdown,
  previewGraphBatch,
  proposeGraphUndo,
  readGraphDocument,
  type GraphBatch,
  type GraphBatchReceipt,
  type GraphChange,
  type GraphCommandOptions,
  type GraphCommandStore,
  type GraphPreview,
} from "./graph-commands";

const COMMAND_DIRECTORY = ".baseboard/commands";

export function createVaultCommandStore(app: App): GraphCommandStore {
  const adapter = app.vault.adapter;
  const store: GraphCommandStore = {
    list: async () => app.vault.getMarkdownFiles().map((file) => file.path),
    read: async (path) => {
      const file = app.vault.getAbstractFileByPath(path);
      return readGraphDocument(
        path,
        file instanceof TFile ? await app.vault.read(file) : null,
      );
    },
    write: async (change) => {
      const file = app.vault.getAbstractFileByPath(change.path);
      if (change.create) {
        if (file || change.expectedRevision !== null)
          throw new Error(`Create conflict: ${change.path}`);
        await app.vault.create(change.path, patchGraphMarkdown("", change));
      } else {
        if (!(file instanceof TFile))
          throw new Error(`Missing note: ${change.path}`);
        const before = await app.vault.read(file);
        if ((await graphRevision(before)) !== change.expectedRevision)
          throw new Error(`Revision conflict: ${change.path}`);
        if (change.delete) {
          if ((await app.vault.read(file)) !== before)
            throw new Error(`Delete conflict: ${change.path}`);
          await app.fileManager.trashFile(file);
        } else {
          await app.vault.process(file, (current) => {
            if (current !== before)
              throw new Error(`Concurrent edit: ${change.path}`);
            return patchGraphMarkdown(current, change);
          });
        }
      }
      return store.read(change.path);
    },
    getReceipt: async (id) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(id))
        throw new Error("Invalid batch identity");
      const path = `${COMMAND_DIRECTORY}/${id}.json`;
      if (!(await adapter.exists(path))) return null;
      const receipt = JSON.parse(await adapter.read(path)) as GraphBatchReceipt;
      if (
        receipt.id !== id ||
        !Array.isArray(receipt.planned) ||
        !Array.isArray(receipt.applied)
      )
        throw new Error("Unsupported command receipt");
      return receipt;
    },
    saveReceipt: async (receipt) => {
      if (!(await adapter.exists(".baseboard")))
        await adapter.mkdir(".baseboard");
      if (!(await adapter.exists(COMMAND_DIRECTORY)))
        await adapter.mkdir(COMMAND_DIRECTORY);
      const path = `${COMMAND_DIRECTORY}/${receipt.id}.json`;
      await adapter.write(`${path}.tmp`, JSON.stringify(receipt, null, 2));
      await adapter.rename(`${path}.tmp`, path);
    },
  };
  return store;
}

class GraphBatchReviewModal extends Modal {
  private resolved = false;
  constructor(
    app: App,
    private preview: GraphPreview,
    private resolve: (approved: boolean) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText("Review graph changes");
    this.contentEl.createEl("p", { text: this.preview.batch.reason });
    const list = this.contentEl.createDiv({ cls: "base-board-batch-preview" });
    for (const change of this.preview.changes) {
      list.createEl("h4", { text: change.path });
      for (const entry of change.fields) {
        if (entry.key === "baseboard_last_batch") continue;
        list.createEl("pre", {
          text: `${entry.key}: ${entry.before.exists ? JSON.stringify(entry.before.value) : "(absent)"} -> ${entry.after.exists ? JSON.stringify(entry.after.value) : "(removed)"}`,
        });
      }
      if (change.bodyAfter !== undefined)
        list.createEl("pre", {
          text: `${change.bodyBefore ?? ""}\n->\n${change.bodyAfter}`,
        });
      if (change.delete)
        list.createEl("p", { text: "Move this note to trash" });
    }
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("Apply batch")
          .setCta()
          .onClick(() => {
            this.resolved = true;
            this.resolve(true);
            this.close();
          }),
      );
  }
  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

const queues = new WeakMap<App, Promise<unknown>>();

function queueGraphCommand<Result>(
  app: App,
  command: () => Promise<Result>,
): Promise<Result> {
  const operation = (queues.get(app) ?? Promise.resolve())
    .catch(() => {})
    .then(command);
  queues.set(app, operation);
  return operation;
}

export async function editGraphNotes(
  app: App,
  changes: (Omit<GraphChange, "expectedRevision"> & {
    expectedRevision?: string | null;
  })[],
  reason: string,
  options: GraphCommandOptions = {},
): Promise<GraphBatchReceipt | null> {
  return queueGraphCommand(app, async () => {
    const store = createVaultCommandStore(app);
    const batch: GraphBatch = {
      id: `ui-${crypto.randomUUID()}`,
      actor: { kind: "human", name: "Dustin" },
      reason,
      evidence: [],
      changes: await Promise.all(
        changes.map(async (change) => ({
          ...change,
          expectedRevision:
            change.expectedRevision === undefined
              ? (await store.read(change.path)).revision
              : change.expectedRevision,
        })),
      ),
    };
    const preview = await previewGraphBatch(store, batch);
    if (changes.length > 1 || changes.some((change) => change.delete)) {
      const approved = await new Promise<boolean>((resolve) =>
        new GraphBatchReviewModal(app, preview, resolve).open(),
      );
      if (!approved) return null;
    }
    const receipt = await applyGraphBatch(store, batch, preview.token, options);
    if (receipt.state !== "applied")
      throw new Error(
        `${receipt.state}: ${receipt.error ?? "Batch incomplete"}. Receipt: ${COMMAND_DIRECTORY}/${receipt.id}.json`,
      );
    return receipt;
  });
}

export async function undoGraphBatch(
  app: App,
  receipt: GraphBatchReceipt,
  options: GraphCommandOptions = {},
): Promise<GraphBatchReceipt> {
  return queueGraphCommand(app, async () => {
    const store = createVaultCommandStore(app);
    const batch = await proposeGraphUndo(
      store,
      receipt,
      { kind: "human", name: "Dustin" },
      `undo-${crypto.randomUUID()}`,
    );
    const preview = await previewGraphBatch(store, batch);
    const result = await applyGraphBatch(store, batch, preview.token, options);
    if (result.state !== "applied")
      throw new Error(`${result.state}: ${result.error ?? "Undo incomplete"}`);
    return result;
  });
}

export async function handleGraphRequest(
  app: App,
  id: string,
  options: GraphCommandOptions = {},
): Promise<void> {
  return queueGraphCommand(app, () => processGraphRequest(app, id, options));
}

async function processGraphRequest(
  app: App,
  id: string,
  options: GraphCommandOptions,
): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id))
    throw new Error("Invalid request identity");
  const directory = ".baseboard/requests";
  const adapter = app.vault.adapter;
  const responsePath = `${directory}/${id}.response.json`;
  if (await adapter.exists(responsePath)) return;
  const request = JSON.parse(
    await adapter.read(`${directory}/${id}.request.json`),
  ) as {
    operation: "read" | "preview" | "apply" | "undo";
    paths?: string[];
    batch?: GraphBatch;
    token?: string;
    receiptId?: string;
  };
  const store = createVaultCommandStore(app);
  let response: unknown;
  try {
    if (request.operation === "read") {
      const paths =
        request.paths ?? app.vault.getMarkdownFiles().map((file) => file.path);
      response = await Promise.all(paths.map((path) => store.read(path)));
    } else if (request.operation === "preview" && request.batch) {
      response = await previewGraphBatch(store, request.batch);
    } else if (
      request.operation === "apply" &&
      request.batch &&
      request.token
    ) {
      response = await applyGraphBatch(
        store,
        request.batch,
        request.token,
        options,
      );
    } else if (request.operation === "undo" && request.receiptId) {
      const receipt = await store.getReceipt(request.receiptId);
      if (!receipt) throw new Error("Unknown batch receipt");
      const batch = await proposeGraphUndo(
        store,
        receipt,
        { kind: "agent", name: "GitHub Copilot" },
        `undo-${id}`,
      );
      response = await previewGraphBatch(store, batch);
    } else throw new Error("Invalid graph command request");
    response = { ok: true, result: response };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await adapter.write(responsePath, JSON.stringify(response, null, 2));
}

export class GraphSuggestionModal extends Modal {
  private reason = "";
  private evidence = "";
  private rank = 1;

  constructor(
    app: App,
    private path: string,
    private suggestionScope: string,
    private onApplied: (receipt: GraphBatchReceipt) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add suggestion");
    new Setting(this.contentEl).setName("Scope").addText((input) =>
      input.setValue(this.suggestionScope).onChange((value) => {
        this.suggestionScope = value.trim();
      }),
    );
    new Setting(this.contentEl).setName("Rank").addText((input) => {
      input.inputEl.type = "number";
      input.inputEl.min = "1";
      input.setValue("1").onChange((value) => {
        this.rank = Number(value);
      });
    });
    new Setting(this.contentEl).setName("Reason").addTextArea((input) =>
      input.onChange((value) => {
        this.reason = value.trim();
      }),
    );
    new Setting(this.contentEl).setName("Evidence").addTextArea((input) =>
      input.onChange((value) => {
        this.evidence = value;
      }),
    );
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Add suggestion")
        .setCta()
        .onClick(() => {
          void this.submit();
        }),
    );
  }

  private async submit(): Promise<void> {
    if (
      !this.reason ||
      !this.suggestionScope ||
      !Number.isFinite(this.rank) ||
      this.rank <= 0
    ) {
      new Notice("Scope, positive rank, and reason are required");
      return;
    }
    try {
      const current = await createVaultCommandStore(this.app).read(this.path);
      const saved = current.properties.suggested_next;
      const entries = readSuggestedNext(saved);
      if (
        saved !== undefined &&
        (!Array.isArray(saved) || saved.length !== entries.length)
      )
        throw new Error(
          "Existing suggestions require review; nothing overwritten",
        );
      const receipt = await editGraphNotes(
        this.app,
        [
          {
            path: this.path,
            expectedRevision: current.revision,
            set: {
              suggested_next: [
                ...entries.filter(
                  (entry) => entry.scope !== this.suggestionScope,
                ),
                {
                  scope: this.suggestionScope,
                  rank: this.rank,
                  reason: this.reason,
                  evidence: this.evidence
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                  by: "Dustin",
                  at: new Date().toISOString(),
                },
              ],
            },
          },
        ],
        `Suggest next: ${this.reason}`,
        { transitions: [] },
      );
      if (receipt) this.onApplied(receipt);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
