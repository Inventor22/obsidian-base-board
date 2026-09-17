# Local Agent Interface

Implemented in build `2026.09.16.12`. The filename is retained for existing
references, but an MCP server is not required or implemented. Initial authoring
is GitHub Copilot in VS Code, using the same command core as the plugin UI.

## Read, Propose, Apply

The local helper is `scripts/work-graph.mjs`. It bundles the production pure
modules in memory; no hosted model, scheduler, network listener, or service is
started. Supply the verified vault path; scripts do not hard-code one.

```powershell
node scripts/work-graph.mjs query --vault "<vault>" --path "Canary.md" --body
node scripts/work-graph.mjs inventory --vault "<vault>" --output "<inventory.json>"
node scripts/work-graph.mjs preview --vault "<vault>" --batch "<batch.json>" --output "<preview.json>"
```

Query returns paths, content revisions and current metadata; `--body` adds
Markdown. Default query selection is graph/kanban-ordered or schema-marked
records. `--all` includes other notes; `--scope` selects persisted suggestions.
Use explicit paths and related notes to gather evidence, not topology as an
instruction to mutate.

Batch shape:

```json
{
  "id": "record-canary-start-unique-id",
  "actor": { "kind": "agent", "name": "GitHub Copilot" },
  "reason": "Record the reported Canary activity; Stage residual remains open.",
  "evidence": ["[[Canary#Promotion decision]]"],
  "changes": [{
    "path": "Canary.md",
    "expectedRevision": "<revision returned by query>",
    "set": { "status": "In Progress" }
  }]
}
```

Changes support `set`, `unset`, explicit creation (`create: true`, null expected
revision, optional Markdown `body`), and explicit deletion. Existing IDs and
history cannot be overwritten through normal field edits. Link changes use the
canonical note fields, with reference/cycle validation. Unknown custom fields
are allowed; unexpected data is preserved rather than guessed into another type.

## Open Obsidian

The plugin registers `obsidian://baseboard-command`. Put a JSON request in a
local file and queue it:

```powershell
node scripts/work-graph.mjs queue --vault "<vault>" --request "<request.json>"
```

The result gives a URI and a response-file path. Open that URI locally using
`Start-Process`; the helper resolves the verified vault path to its registered
Obsidian vault ID. Read the named response, not a polling service. Requests live
under `.baseboard/requests` and are restricted to a validated request identifier.

| Operation | Request fields | Result |
| --- | --- | --- |
| `read` | optional `paths` | Current documents and revisions |
| `preview` | `batch` | Named before/after values and review token |
| `apply` | exact `batch`, `token` | Durable receipt |
| `undo` | `receiptId` | A new inverse batch and its preview; not automatic apply |

Inspect the preview before sending apply. A token is a review/conflict binding,
not production authorization. Stale requests fail rather than silently merging
onto changed fields. Responses are written once per request identifier. Repeating
an already-applied identical batch is idempotent.

## Closed Obsidian

Offline writes require explicit `--closed` and refuse to run while Obsidian is
running on Windows:

```powershell
node scripts/work-graph.mjs apply --vault "<vault>" --batch "<preview.json>" --closed
node scripts/work-graph.mjs undo --vault "<vault>" --batch "<receipt-id>" --output "<undo-preview.json>"
node scripts/work-graph.mjs migrate --vault "<vault>" --apply --closed
```

Undo produces a reviewable proposal. Apply it using the same token/revision
rules. A failed batch retains a receipt and attempts a surgical rollback.
`partial`, `rolled-back`, and interrupted `applying` receipts are not retried
as new work. Read the receipt, inspect current fields, and propose an explicit
repair. A process crash between a note write and receipt update may need manual
reconciliation using the planned values and `baseboard_last_batch` marker.

The migration module also exports `runNativeMigration(app, vault, resultPath)`
for Obsidian's existing local CLI. It verifies the active vault, saves and
suspends Base Board's Bases tabs, pauses the plugin, waits for pending data saves,
creates verified backups, writes notes and Bases using `vault.process`, and
restores the prior tabs and loaded plugin state. Embedded Graphs in editable
Markdown panes must be closed first; the helper refuses to close those panes. Run
inventory first; see [WORK_GRAPH_DELIVERY.md](WORK_GRAPH_DELIVERY.md) for delivery
results. Do not run a write experiment against production notes as a browser test.

## Judgment and Permissions

Editable playbooks are in [AI-INSTRUCTIONS-TEMPLATE.md](AI-INSTRUCTIONS-TEMPLATE.md)
and the workspace's `maintain-work-graph` skill. They guide interpretation of
updates, residual issues, action-specific decisions, retries, and recommendations.
They are not hardcoded transition handlers.

Graph editing does not execute the represented work. These tools cannot deploy,
change production flags, merge PRs, infer approvals, or bypass external
safeguards. Existing `executor`/`autonomy` metadata is context, not a grant of
production permissions. Attribution is a local author assertion, not a
cryptographic approval certificate.

Future optional MCP integration should adapt this same command boundary rather
than introduce a second schema or automatic frontier loop.