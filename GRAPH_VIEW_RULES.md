# Graph and Shared View Rules

As built in `2026.09.16.12`. Update this file with view changes; use
[GRAPH_SEMANTICS_SPEC.md](GRAPH_SEMANTICS_SPEC.md) for the canonical data contract.
Desktop only. Preserve narrow desktop panes; do not add mobile behavior.

## Recorded State

Every node reads its own `status`, including containers and scopes. In Progress
is blue, Awaiting amber, Completed green, recorded Blocked/Failed red, and
unclassified/planned work neutral. Custom status strings remain intact. The
configured root's magenta identity outline is separate from status.

Descendant completion, activity, attention and recovery counts are independent
summaries, never replacements for container assertions. Counts are not effort.
Only completed work fills progress bars. A red descendant or impact path does
not make an ancestor Failed. Dependency advisories do not recolor an active
record as waiting or prevent editing it.

Status controls act only on the chosen node. All node kinds can be edited.
There is no predecessor completion, successor invalidation/reset, branch
cancellation, automatic recovery activation, or container-status prohibition.
Multi-item changes show named before/after values and require review. Undo uses
field-level conflict checks and retains observed transitions.

## Graph Presentation

- Overview retains packed workstreams, focus/navigation, compressed wrapper
  trails, and visual Unassigned. Its projection does not delete graph records.
- Free layout retains manual placement, editable link anchors, structural
  context menus, Organize, and view-config layout undo. Structural locks remain
  editing preferences, not status prerequisites or production permission.
- Containment collapse follows `parent` and membership. Expanded choices remain
  in `graphOverviewExpanded`; Free layout retains existing collapse metadata.
- **Fold downstream sequence** is separate. `graphSequenceFolds` hides the named
  node's downstream sequence and contained details, without changing ownership,
  status, recommendations, note positions, or history. The root stays accessible.
  **Unfold downstream sequence** reverses that presentation choice.
- Sequence, specific dependency, context association, containment, membership,
  and recovery retain distinct storage. A pair can have both sequence and a
  dependency. New template ordering uses `sequence_after`, not fake prerequisites.
- Recovery notes and declared links remain visible even when not active.
- Close parallel outcome/return tracks remain useful. Red dashed tracks are
  advisory impact from recorded failure, not proof that ancestors failed or
  successors were invalidated. Completed predecessors keep their own status.
- Suggested Next shows persisted, scoped, ranked recommendations and provenance.
  The node menu can add a recommendation with an entered reason. The panel does
  not compute an authoritative frontier or hide unrelated work from the graph.

## Physics and Navigation

Physics remains opt-in alongside Overview and Free layout, with Workflow,
Hanging, Growing, and Radial presets. Work circles are 144px, summaries 160px;
collision geometry matches. Rooted connectivity uses actual ownership and
relationship springs, not inserted notes or fictional dependencies.

The configured `graphRoot` is fixed at `(0, 0)`, cannot be dragged, and retains
its 8px magenta border on hover. Each scope/layout keeps transient positions and
guides. A successful drag rebases its guide; Escape/blur cancels. Pause/resume,
reset, deferred redraw during dragging, and reduced-motion startup remain.

Obstacle-aware curve checks and waypoint detours remain. Routes prefer fewer
crossings, are cached per geometry update, and preserve paired return tracks.
Nonplanar/dense graphs can still cross. Routing never deletes relationships or
changes statuses. Cross-branch context and advisory failure paths exert no
additional ownership force.

All presentations retain 0.01%-225% zoom. Home restores normal scale and scope/
root framing. Layout, panning, zoom, collapse, and Physics never create progress
events or overwrite manual positions.

Collapsed containers show two rings total. Leaves collapse inward first;
expansion reverses that order. Transitions stay under 660ms, preserve shared
visible nodes, defer refresh, stop Physics, and clean up on reversal/unload.

## Shared Views

- Kanban All Cards uses exact configured column values. Dragging changes that
  field only on dragged/explicitly selected cards. Reordering stays fractional;
  order normalization and multi-selection are named reviewed batches.
- Suggested Next Kanban uses exact recorded status columns and note-based
  recommendation ranks/reasons. It does not convert Failed into a synthetic
  Blocked column, or expire priorities each day. All Cards remains available.
- Timeline supports `timelineSwimlaneProperty` for owner, project, scope,
  rollout, or another configured property; `parent` preserves hierarchical
  swimlanes. Container lanes show their own assertions and events.
- Timeline draws no past span from file timestamps. Recorded transitions,
  last-known open tails, and `planned_start`/`planned_end` bars are distinguished.
  Display widths do not assert actual duration, uninterrupted work, or approval.
- Rollout keeps `rollout_ring`, `rollout_order`, and `rollout_history` independent
  from work status and other order fields. Recording a ring change does not
  execute a production promotion.

## Recording

Graph journals retain initial baselines, changed-node deltas, removals, observed
timestamps and session gaps under `graphHistories` in plugin data. Recording runs
while the Graph view is open. A query removal may be a filter change, not a
deleted note. Nothing is invented before the baseline or inside a coverage gap.

The existing history strip supports scrubbing, day steps, and scoped change
jumps. Historical views use captured metadata only and open read-only snapshots.
New snapshots include relevant decisions, assessments, suggestions, and context
links; missing older metadata is not backfilled. Returning to present restores
the live view/camera/Physics cache. Rendering does not modify note history.

Save errors remain visible and retryable; unsupported journals are not erased.
Back up plugin data as well as notes. Historical body revisions and playback
remain future work, not implemented promises.