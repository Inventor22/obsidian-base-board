# Work Graph Architecture

## Implemented

Build `2026.09.16.12` changes the existing Obsidian plugin, not its frameworks or
desktop-only scope. [GRAPH_SEMANTICS_SPEC.md](GRAPH_SEMANTICS_SPEC.md) is the
product contract. The earlier scheduler/event-sourced workflow roadmap is
retired, not a dependency for further work.

| Boundary | Owner |
| --- | --- |
| Recorded status interpretation, identity, hierarchy | `src/graph-engine.ts` |
| Relationship schema, assessments, Suggested Next, migration policy | `src/work-graph.ts` |
| Revisions, previews, validation, receipts, apply/undo | `src/graph-commands.ts` |
| Obsidian storage, review dialogs, local request handling | `src/graph-command-ui.ts` |
| Canonical transition records | `src/transition-history.ts` |
| Observation journal, replay, gaps and scoped comparisons | `src/graph-history.ts` |
| Graph hierarchy summaries, packing and branch transitions | `src/graph-overview.ts` |
| D3 simulation, Dagre seeding, obstacle/crossing-aware routing | `src/graph-physics.ts` |
| Local query, reviewed changes and backed-up migration | `scripts/work-graph.mjs` |

Notes remain the current source of truth. Bases configuration stores layout,
collapse, scope, and other view preferences. Plugin data retains recorded graph
history and settings. Batch receipts describe edits; they do not become a
second writable status store. Unknown data is retained across migrations.

## Preserved Visual Architecture

The working tree was inspected and backed up before this redesign. The recovered
Physics/history work from build `2026.09.16.11` was retained, not restored from an
older branch or commit.

- Overview, Free layout, and opt-in Physics remain. Containment and membership
  keep rooted scope navigation, visual Unassigned, breadcrumbs, and focus.
- Physics retains 144px work circles, 160px summaries, D3 springs/collision,
  Dagre initialization, and Workflow/Hanging/Growing/Radial presets.
- The configured root remains fixed at world `(0, 0)` in Physics. Its 8px
  magenta border and subtle fill identify Dustin's anchor without claiming a
  work status. Primary ownership springs retain real connectivity; context
  links and failure feedback do not invent ownership.
- Full-curve obstacle checks, waypoint detours, cached routes, and crossing
  penalties remain. Sequence links now participate in both spring connectivity
  and Dagre seeding. Dense/nonplanar graphs can still have crossings.
- All presentations retain 0.01%-225% zoom and Home framing. Cameras and Physics
  caches remain separate from manual `graphNodePositions`.
- Collapsed containers retain two rings total. Leaf-first collapse and reversed
  expansion retain bounded timing, reduced-motion behavior, deferred refresh,
  rapid reversal cleanup, and a paused simulation during branch transitions.
- Historical browsing remains static Overview; returning to present restores
  live presentation and positions. Physics motion does not record work events.

## Write Boundary

Graph status actions, links, bulk templates/deletions, Kanban card movement,
Rollout movement, and Timeline ordering use explicit command batches. Commands
validate field shape, named link targets, identities, ownership cycles, and
revisions. YAML document ranges preserve untouched fields and note bodies.
Obsidian uses `vault.process` for conflict-checked note edits. Offline CLI writes
require a closed application; open-vault requests use the native plugin.

A batch is recoverable but not a database transaction spanning all notes.
Intent and per-file results are journaled; a failed write triggers a narrow
inverse. Conflicts stay visible in the receipt. Existing history is append-only;
undo preserves later unrelated changes and adds observed reversal events.

Manual layout undo stays a view-config operation. Template positions use that
same view configuration, not new `graph_x`/`graph_y` writes. Existing positions
and preferences are not removed by migration.

## Migration

The reusable migration inventories graph-eligible notes, all Bases files, and
installed plugin data before writing. It backs up every inventoried file with
hash verification, saves an inventory/journal, rechecks content, and preserves
unrelated edits during rollback. Reruns are inert.

Schema migration is additive on notes. It preserves legacy `depends_on` and
container status values with explicit `unreviewed` warnings. It never guesses
which old cascades happened or repairs history/statuses. Old daily-priority
configuration is archived under `baseboard_legacy_frontier`; it is not fabricated
into new recommendations. Existing physics, layout, query, and recording
configuration is retained. Native migration saves and suspends the affected
Bases tabs, pauses Base Board, waits for current and retained-instance saves,
then restores the prior tabs and loaded plugin state. Editable Markdown panes
with embedded Graph views must be closed explicitly before migration.

See [WORK_GRAPH_DELIVERY.md](WORK_GRAPH_DELIVERY.md) for the requirement checklist,
actual migration results, gates, and remaining verification work.

## Future Ideas

Not implemented: historical Markdown body revisions, timelapse playback,
cross-device journal merging, general permanent Physics pins, automatic
reconciliation of interrupted receipts, or a dedicated dependency-assessment
editor. Assessments are editable through notes and the shared commands.

An optional future MCP adapter could expose the same commands. There is no
planned automatic frontier scheduler, approval inference, compensation engine,
hosted agent requirement, or production-execution capability in this redesign.