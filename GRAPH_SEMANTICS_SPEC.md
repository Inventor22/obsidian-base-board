# Work Graph Semantics

Authoritative product contract, implemented by build `2026.09.16.12`. This
supersedes the former execution-frontier, cascade, group-fold, and compensation
activation policies. Base Board is Dustin's personal, agent-maintained work
graph, not a workflow execution engine.

## Recorded Facts

- Each Markdown note is one record. Existing `id` values remain stable.
- `status` is the canonical recorded work status on every node, including
  containers, scopes, and observations. Graph does not derive a replacement
  status from descendants. Kanban can edit another explicitly configured field.
- Setting a status changes only that record. Starting/completing does not
  complete predecessors; failure does not invalidate successors; cancellation
  does not cancel descendants or a branch. No prerequisite prevents recording
  actual activity. Multiple concurrent activities and incomplete containers are
  valid.
- Counts summarize distinct descendant work items, not effort or the
  container's own assertion. Recovery activity is counted separately. A
  completed container can have residual incomplete children; flag uncertainty
  for review instead of silently repairing it.
- Unknown fields, identifiers, Markdown bodies, layouts, and historical records
  are preserved. Unrecognized status text remains stored verbatim and neutral
  unless it has an explicitly supported visual mapping.

## Canonical Storage

`baseboard_schema: 1` identifies migrated/new work records. There is no parallel
writable graph database. Notes hold current facts; view configuration holds
presentation; journals hold observations and reversible edit receipts.

| Meaning | Note field | Direction and interpretation |
| --- | --- | --- |
| Containment | `parent` | Child belongs inside one parent |
| Sequence | `sequence_after` | Target normally follows the listed sources; advisory |
| Dependency | `depends_on` | Target requires something specific from a listed source |
| Association | `associations` | Related context, without execution implications |
| Scope membership | `rollup_to` | Record belongs to one or more scopes |
| Recovery | `compensates` | Recovery record may address an effect of a listed record |

Relationship lists contain stable IDs or unambiguous wiki links/paths. New UI
links use full note paths. Ambiguous references are not authorization to edit a
matching note. Legacy `breaks_to` and `restarts_to` remain contextual outcome and
retry relationships, not transition instructions.

Dependencies may carry `dependency_assessments`, an appendable list of:

```yaml
dependency_assessments:
  - source: "[[Stage]]"
    action: promote-canary
    assessment: satisfied
    by: Dustin
    at: "2026-09-16T12:00:00Z"
    reason: Sufficient healthy-zone bake for this promotion.
    evidence: ["[[Stage#Bake evidence]]"]
```

Each assessment requires `source`, a particular `action`, one of `unresolved`,
`satisfied`, or `waived`, and provenance (`by`, `at`, `reason`, `evidence`). The
last recorded assessment for that source/action applies. An unmatched action is
unresolved. Optional `dependency_action` selects the action shown by Graph's
advisory count; otherwise the action is `work`. Source completion does not automatically satisfy a specific
requirement. Satisfaction or waiver never changes the source status. An agent
must not infer a waiver, approval, or event time.

## Partial Stage, Active Canary

This is an illustrative synthetic example, not a production approval:

1. Stage remains `In Progress`. Healthy zones have baked; a child note records
   the broken zone and outstanding repair work.
2. Canary retains a sequence link and, where a specific bake requirement is
   useful to query, a dependency on Stage.
3. Dustin's promotion decision is recorded in Canary's Markdown or `decision`
   metadata, with rationale and evidence. The action-specific assessment above
   records what was considered sufficient. A waiver would require its own
   explicitly recorded rationale.
4. A single-record batch sets Canary to `In Progress`. Stage, the broken zone,
   Pilot, Broad, and all predecessors keep their statuses.

Do not create an approval node merely to enable a promotion. Keep unusual
domain reasoning in Markdown; add structure only when a view needs to query it.

## Advisory Information

- Readiness and possible dependency blockers are advisory. They do not replace
  status, hide activities, or reject observed transitions.
- Recovery relationships remain visible without silently activating, hiding,
  completing, or cancelling the recovery record. Possible recovery needs are
  suggestions, not evidence that recovery happened.
- Red dashed impact/return paths indicate possible impact from a recorded
  failure. Ancestor nodes retain their own assertions. Successors become gray
  only according to their own recorded state, never because a failure swept them.
- Suggested Next replaces the active frontier. `suggested_next` lives on notes
  as entries with `scope`, positive `rank`, `by`, `at`, `reason`, and `evidence`.
  One entry per note/scope; entries persist until explicitly changed. Ordering
  uses rank with deterministic tie-breaking. Completed or concurrent work is
  not automatically removed. All Cards and the full graph remain accessible.
- Containment collapse and **Fold downstream sequence** are separate actions.
  The latter uses `graphSequenceFolds` view configuration, follows sequence plus
  downstream containment, and never reparents notes or changes their state.

## Changes and History

All command batches name paths and fields, expected SHA-256 content revisions,
actor, reason, and evidence. A before/after preview produces the token required
for apply. Multi-note UI edits require review; topology alone cannot authorize
mutations. Repeat application of an already-applied identical batch is inert.

Receipts live in `.baseboard/commands`. Apply journals intent before writing and
progress after each note. Partial failures attempt a field-level inverse, refuse
to overwrite conflicts, and retain `rolled-back` or `partial` receipts. Undo is
another reviewed command, preserving unrelated fields and bodies. Undoing a
status edit appends a reversal event instead of erasing observed history.
Interrupted/partial receipts require review, not blind replay.

Transition history retains its shared event shape, adding attribution, evidence,
batch identity, and reversal identity. Current status is authoritative; history
is not a competing writable projection. Direct Markdown edits remain possible,
but unrecorded edits do not retroactively generate status events.

Timeline starts recorded spans only at recorded timestamps. Missing history
produces no invented interval from file creation/modification. Open tails are
last-known state with unverified continuity, not measured effort or actual
duration. `planned_start`/`planned_end` are separate planned bars. Parent lanes
use their own events, not an invented span over their children's work.

Graph history preserves its existing baseline/delta journal, gaps, static
historical browsing, and live-camera restoration. New observations can capture
decisions, assessments, recommendations, and sequence/context links. Old frames
are not backfilled with today's metadata or guessed approvals.

## Permissions

Graph maintenance and real production actions are separate permissions. A
status, assessment, `executor`, or legacy `autonomy` value cannot authorize a
deployment, flag change, PR merge, credential use, or external command. Dustin
and Copilot supply judgment; deterministic code stores, validates, previews,
summarizes, and renders it. No scheduler, hosted model, or MCP service is needed.