# Work Graph Delivery Checklist

Build: `2026.09.16.12`. Worktree and installed-plugin baseline backed up before
editing. No branch, commit, push, or wholesale worktree restore.

## Behavior and Model

- [x] Local-only status changes; independent container assertions and counts.
- [x] Multiple activities, partial work, exceptions, retries and residual notes.
- [x] Advisory prerequisites; action-scoped satisfied/waived assessments with provenance.
- [x] Explicit named, previewed, attributed, reversible batches with revision checks.
- [x] Partial-write rollback and conflicts preserve unrelated fields and bodies.
- [x] Visible recovery records; no implicit activation, completion or cancellation.
- [x] Distinct containment, sequence, dependency, association, membership and recovery.
- [x] Partial-Stage/active-Canary example with residual issue and decision evidence.
- [x] Persisted ordered scoped Suggested Next; all other work remains accessible.
- [x] Separate downstream-sequence folding without reparenting or status changes.
- [x] Shared Graph/Kanban/Rollout writes and canonical transition events.
- [x] Configurable Timeline swimlanes; planned versus recorded/last-known intervals.
- [x] No fabricated durations, pre-baseline events or historical approvals.
- [x] Local CLI and plugin request interface; no hosted agent or MCP dependency.
- [x] Editable playbooks; production permissions remain separate.

## Preservation and Migration

- [x] Inspect and preserve current Physics/history implementation and dirty worktree.
- [x] Preserve identifiers, manual layouts, preferences, unknown data and Markdown.
- [x] Dry-run inventory and idempotent migration implemented and tested.
- [x] Verified backup and journaled rollback tests for notes, Bases and plugin data.
- [x] Preserve/flag ambiguous legacy dependencies and possibly stale container statuses.
- [x] Retire cascade writers, frontier projection, scheduler dispatch and invented spans.
- [x] Update semantics, architecture, view rules, agent plan and editable playbook.
- [x] Complete real-vault backup and native migration, then verify rerun is inert.

## Verification and Deployment

- [x] Focused status, recommendation, batch, undo/conflict, migration and view tests.
- [x] Physics sequence-seeding regression, root/routing/layout unit suites.
- [x] Desktop browser checks: status edits, batches, suggestions, folding, shared views.
- [x] Physics, root anchoring, zoom/Home, collapsed rings and leaf-first animations.
- [x] Static recorded browsing, live restoration and no render-induced note writes.
- [x] Timeline ruler stops: 1w, 1mo, 3mo, 6mo, 1y, 5y after deployment.
- [x] Full tests, affected-test typecheck, lint, build and deploy artifact hashes.
- [x] Automatically deploy and reload the native Graph tab. Reload/toggle Base Board for any other retained or embedded views.

## Initial Inventory

The initial read-only inventory included two empty-order records outside the
actual Base query. Eligibility was corrected and regression-tested to leave
those records untouched. The root audit verifies 72/72 real graph records
connected to Dustin, with no dangling ownership references or cycles. All 22
Bases files were backed up; one needed preference migration. Five ambiguous
title aliases remain unverified and were not used to infer relationships.

## Migration Results

Applied 74 writes: 72 additive note migrations, one Bases preference migration,
and plugin schema metadata. All 72 notes retain their original status, IDs,
custom properties, and exact Markdown bodies. All 22 Bases retain unrelated
preferences, including Physics, root, manual layout, and recording identity.
The existing history journal's entire frame prefix was independently compared
and preserved. No past status or approval was reconstructed.

There are 39 explicit review flags: 25 legacy dependencies and 14 possibly stale
container assertions. These source values remain unchanged. Both the filesystem
inventory rerun and a native migration rerun reported zero writes. Root audit:
72/72 connected, no dangling/ambiguous ownership, cycles, or parse failures.

Verified backup:

```text
C:\Users\Dustin\AppData\Local\Temp\baseboard-work-graph-migration-2f49beca-b9d3-4ea2-b8bc-7c9a43672cea
```

The first native attempt encountered a plugin-data revision conflict after 73
writes and rolled them all back. All 94 inventoried note/Base hashes matched
their pre-attempt bytes, with zero rollback conflicts. Its backup and journal
remain under the sibling directory ending
`46ce4865-430a-4bb8-86b3-9c65742542ea`. The cause was a Bases view retaining an old
plugin instance after disable. The corrected helper saves/suspends the affected
Bases tabs, drains both current and retained recording owners, then restores the
tabs and plugin. A native-lifecycle regression covers this ordering.

The native command smoke test initially used a filesystem path in the Obsidian
URI and reached a "Vault not found" dialog. The helper now resolves the exact
path to its local registry ID; a regression covers this. The corrected read-only
request successfully returned Dustin's stable ID, schema, body, and SHA-256
revision through the deployed plugin. No production notes were used for write
experiments.

## Verification Results

- 191 tests pass across 10 files. Full source lint/typecheck passes with zero
	errors and 12 existing Obsidian API warnings; all TypeScript tests typecheck.
- Synthetic native mouse actions verify Canary starts alone, suggestions retain
	provenance without changing status/history, and folding hides only Pilot/Broad
	while keeping all nine full records. Folding adds no note writes or frames.
- Native multi-card dragging opens a named preview before writes. Apply moves
	only selected statuses; undo restores them and appends reversal history.
	The integrated browser required coordinate calibration during native drags;
	captured drag/drop events were trusted, not synthetic handler calls.
- Suggested Next shows the residual under the exact Failed column with its rank
	and reason; All Cards restores all records. Owner swimlanes retain every record,
	planned bars remain separate, and missing history has no fabricated interval.
- Desktop 1440x900 light and 1100x760 dark screenshots inspected. No title
	overflow. Root dragging is rejected; an 80px Physics drag cancels exactly on
	Escape without writes. Motion moves nodes and edges without changing metadata.
- Reduced motion skips transitions. Normal collapse starts deep leaves at 0ms,
	containers at 160ms, with 180ms durations; expansion restores visibility.
	Two-ring collapsed styling remains. Manual layout and history frames stay intact.
- Historical baseline shows Canary Planned with Physics scheduling stopped;
	returning to present restores exact live positions. Deep zoom progresses from
	0.0001 to 0.00012; Home returns to 1.0.
- Read-only real-vault snapshot: all four Physics layouts retain 72 connected
	nodes and all 126 nonempty routes, root at (0,0), zero note writes.
- All six required ruler stops pass at both desktop widths with two rows,
	nonempty labels, and no label overlap/overflow after deployment.
- Existing deploy helper succeeded. All three installed artifact hashes match;
	native Obsidian shows `2026.09.16.12`, schema 1, and the restored Graph tab.

Final deployed bundle SHA-256:
`CDF4916861E3761EEAE83DEE74EA602A38C09EB3B1C9C3C8DF50ACBD8F7DF944`.

## Limitations

No historical note-body revisions, cross-device receipt merging, automatic
repair of interrupted receipts, or dedicated dependency-assessment form.
Assessments use Markdown/frontmatter or the local command interface. Batch
application is journaled/reversible, not an atomic multi-file filesystem commit.
Physics crossing reduction does not guarantee crossing-free arbitrary graphs.