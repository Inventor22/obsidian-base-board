import { describe, expect, it } from "vitest";
import {
  applyGraphBatch,
  patchGraphMarkdown,
  previewGraphBatch,
  proposeGraphUndo,
  readGraphDocument,
  type GraphBatch,
  type GraphBatchReceipt,
  type GraphChange,
  type GraphCommandStore,
} from "../src/graph-commands";

function fixture() {
  const notes = new Map([
    [
      "Stage.md",
      "---\r\nid: stage\r\nstatus: In Progress\r\ncustom: {zone: west} # keep\r\n---\r\nStage mostly deployed. One zone is broken.\r\n",
    ],
    [
      "Canary.md",
      "---\nid: canary\nstatus: Planned\ndepends_on: [Stage]\n---\nCanary rationale.\n",
    ],
    ["Pilot.md", "---\nid: pilot\nstatus: Planned\n---\n"],
  ]);
  const receipts = new Map<string, GraphBatchReceipt>();
  let writeCount = 0;
  let failAt = 0;
  let afterWrite: ((change: GraphChange) => void) | null = null;
  const store: GraphCommandStore = {
    list: async () => [...notes.keys()],
    read: (path) => readGraphDocument(path, notes.get(path) ?? null),
    write: async (change) => {
      writeCount += 1;
      if (writeCount === failAt) throw new Error("Injected write failure");
      const current = await store.read(change.path);
      if (current.revision !== change.expectedRevision)
        throw new Error("CAS conflict");
      if (change.delete) notes.delete(change.path);
      else
        notes.set(
          change.path,
          patchGraphMarkdown(notes.get(change.path) ?? "", change),
        );
      afterWrite?.(change);
      return store.read(change.path);
    },
    getReceipt: async (id) => receipts.get(id) ?? null,
    saveReceipt: async (receipt) => {
      receipts.set(receipt.id, structuredClone(receipt));
    },
  };
  const batch = async (paths = ["Canary.md"]): Promise<GraphBatch> => ({
    id: "promote-canary",
    actor: { kind: "agent", name: "GitHub Copilot" },
    reason:
      "Dustin recorded sufficient bake; broken Stage zone remains residual work.",
    evidence: ["[[Stage#Bake evidence]]"],
    changes: await Promise.all(
      paths.map(async (path) => ({
        path,
        expectedRevision: (await store.read(path)).revision,
        set: { status: "In Progress" },
      })),
    ),
  });
  return {
    notes,
    receipts,
    store,
    batch,
    fail: (ordinal: number) => {
      failAt = ordinal;
    },
    after: (callback: (change: GraphChange) => void) => {
      afterWrite = callback;
    },
  };
}

async function apply(setup: ReturnType<typeof fixture>, batch: GraphBatch) {
  const preview = await previewGraphBatch(setup.store, batch);
  return applyGraphBatch(setup.store, batch, preview.token);
}

describe("reviewed graph commands", () => {
  it("refuses a YAML alias side effect rather than mutating an unrelated field", () => {
    const content =
      "---\nstatus: &recorded Planned\ncustom: *recorded\n---\nBody stays intact.\n";
    expect(() =>
      patchGraphMarkdown(content, { set: { status: "Completed" } }),
    ).toThrow();
  });

  it("changes Canary only and records attributable observed history", async () => {
    const setup = fixture();
    const stage = setup.notes.get("Stage.md");
    const batch = await setup.batch();
    const receipt = await apply(setup, batch);
    expect(receipt.state).toBe("applied");
    expect(setup.notes.get("Stage.md")).toBe(stage);
    expect((await setup.store.read("Pilot.md")).properties.status).toBe(
      "Planned",
    );
    const canary = await setup.store.read("Canary.md");
    expect(canary.properties.status).toBe("In Progress");
    expect(canary.properties.status_history).toEqual([
      expect.objectContaining({
        from: "Planned",
        to: "In Progress",
        by: "GitHub Copilot",
        causedBy: "agent",
        batchId: batch.id,
        evidence: batch.evidence,
      }),
    ]);
    expect(
      await applyGraphBatch(setup.store, batch, "already-applied"),
    ).toEqual(receipt);
  });

  it("previews every named change and rejects stale revisions before writing", async () => {
    const setup = fixture();
    const batch = await setup.batch(["Canary.md", "Pilot.md"]);
    const preview = await previewGraphBatch(setup.store, batch);
    expect(preview.changes).toHaveLength(2);
    setup.notes.set(
      "Pilot.md",
      setup.notes.get("Pilot.md")! + "External note edit.\n",
    );
    await expect(
      applyGraphBatch(setup.store, batch, preview.token),
    ).rejects.toThrow(/Revision conflict/);
    expect((await setup.store.read("Canary.md")).properties.status).toBe(
      "Planned",
    );
  });

  it("undoes an explicit batch without losing unrelated fields, bodies, or history", async () => {
    const setup = fixture();
    const receipt = await apply(
      setup,
      await setup.batch(["Canary.md", "Pilot.md"]),
    );
    setup.notes.set(
      "Canary.md",
      patchGraphMarkdown(setup.notes.get("Canary.md")!, {
        set: { unrelated: 42 },
        body: "New user notes.\n",
      }),
    );
    const undo = await proposeGraphUndo(
      setup.store,
      receipt,
      { kind: "human", name: "Dustin" },
      "undo-promotion",
    );
    expect((await apply(setup, undo)).state).toBe("applied");
    const canary = await setup.store.read("Canary.md");
    expect(canary.properties.status).toBe("Planned");
    expect(canary.properties.unrelated).toBe(42);
    expect(canary.body).toBe("New user notes.\n");
    expect(canary.properties.status_history).toHaveLength(2);
  });

  it("refuses undo when a touched field has newer activity", async () => {
    const setup = fixture();
    const receipt = await apply(setup, await setup.batch());
    setup.notes.set(
      "Canary.md",
      patchGraphMarkdown(setup.notes.get("Canary.md")!, {
        set: { status: "Completed" },
      }),
    );
    await expect(
      proposeGraphUndo(
        setup.store,
        receipt,
        { kind: "human", name: "Dustin" },
        "undo",
      ),
    ).rejects.toThrow(/Undo conflict/);
  });

  it("rolls back partial writes and retains an honest failure receipt", async () => {
    const setup = fixture();
    setup.fail(2);
    const receipt = await apply(
      setup,
      await setup.batch(["Canary.md", "Pilot.md"]),
    );
    expect(receipt.state).toBe("rolled-back");
    expect(receipt.error).toMatch(/Injected/);
    expect((await setup.store.read("Canary.md")).properties.status).toBe(
      "Planned",
    );
    expect(
      (await setup.store.read("Canary.md")).properties.status_history,
    ).toHaveLength(2);
  });

  it("reports partial rollback conflicts without overwriting concurrent activity", async () => {
    const setup = fixture();
    setup.fail(2);
    setup.after((change) => {
      if (change.path === "Canary.md")
        setup.notes.set(
          change.path,
          patchGraphMarkdown(setup.notes.get(change.path)!, {
            set: { status: "Completed", external: true },
          }),
        );
    });
    const receipt = await apply(
      setup,
      await setup.batch(["Canary.md", "Pilot.md"]),
    );
    expect(receipt.state).toBe("partial");
    expect(receipt.conflicts).toHaveLength(1);
    expect((await setup.store.read("Canary.md")).properties.status).toBe(
      "Completed",
    );
  });

  it("preserves YAML comments, unknown values, CRLF and note bodies", () => {
    const setup = fixture();
    const content = setup.notes.get("Stage.md")!;
    const result = patchGraphMarkdown(content, { set: { status: "Awaiting" } });
    expect(result).toContain("custom: {zone: west} # keep\r\n");
    expect(
      result.endsWith("Stage mostly deployed. One zone is broken.\r\n"),
    ).toBe(true);
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("supports explicit note creation, link edits, and safe creation undo", async () => {
    const setup = fixture();
    const batch = await setup.batch();
    batch.changes = [
      {
        path: "Residual.md",
        expectedRevision: null,
        create: true,
        set: { status: "Blocked", parent: "Stage", associations: ["Canary"] },
        body: "Broken west zone; not a promotion approval.\n",
      },
    ];
    const receipt = await apply(setup, batch);
    expect(
      (await setup.store.read("Residual.md")).properties.baseboard_schema,
    ).toBe(1);
    const undo = await proposeGraphUndo(
      setup.store,
      receipt,
      { kind: "human", name: "Dustin" },
      "undo-created-residual",
    );
    expect((await apply(setup, undo)).state).toBe("applied");
    expect(setup.notes.has("Residual.md")).toBe(false);
  });

  it("requires a reviewed token and protects stable IDs and recorded history", async () => {
    const setup = fixture();
    const batch = await setup.batch();
    await expect(
      applyGraphBatch(setup.store, batch, "unreviewed"),
    ).rejects.toThrow(/token/);
    batch.changes[0].set = { id: "replacement" };
    await expect(previewGraphBatch(setup.store, batch)).rejects.toThrow(
      /Stable identity/,
    );
    batch.changes[0].set = { status_history: [] };
    await expect(
      applyGraphBatch(setup.store, batch, "unreviewed"),
    ).rejects.toThrow(/append-only/);
  });

  it("validates explicit link targets, action assessments and containment cycles", async () => {
    const setup = fixture();
    const batch = await setup.batch();
    batch.changes[0].set = { sequence_after: ["Missing"] };
    await expect(previewGraphBatch(setup.store, batch)).rejects.toThrow(
      /Unresolved/,
    );
    batch.changes[0].set = { parent: "Canary" };
    await expect(previewGraphBatch(setup.store, batch)).rejects.toThrow(/Self/);
    setup.notes.set(
      "Stage.md",
      patchGraphMarkdown(setup.notes.get("Stage.md")!, {
        set: { parent: "Canary" },
      }),
    );
    batch.changes[0].set = { parent: "Stage" };
    await expect(previewGraphBatch(setup.store, batch)).rejects.toThrow(
      /cycle/,
    );
  });

  it("preserves ordinary Markdown horizontal rules without treating them as frontmatter", async () => {
    const body = "# Context\n\n---\nSome text\n---\n";
    const note = await readGraphDocument("Context.md", body);
    expect(note.body).toBe(body);
    expect(
      patchGraphMarkdown(body, { set: { status: "Planned" } }).endsWith(body),
    ).toBe(true);
  });
});
