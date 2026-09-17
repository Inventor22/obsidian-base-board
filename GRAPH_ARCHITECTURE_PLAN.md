# Graph Architecture Evolution Plan

Trigger phrase for a future Copilot chat: **Evolve the graph architecture**.

> **Status:** Partially implemented. Milestones 1-4 and 6 are implemented;
> milestone 5 has agency metadata but no skill bindings. Milestone 7 has recorded
> graph browsing; animated replay and the MCP milestones remain planned. Stored leaf status is still authoritative; the
> event-log projection is diagnostic. The milestone tables below distinguish
> shipped behavior from future architecture.

## Deep zoom and spacing (build 2026.09.16.7)

- All Graph presentations now allow 0.01%-225% zoom. Removing the absolute
  small-change threshold keeps wheel and button zoom responsive at tiny scales;
  Home restores 100% and the usual scope/root framing. A positive floor avoids
  division by zero instead of claiming mathematically infinite zoom.
- A shared compact physics preset reduces spring gap 24px to 8px, repulsion
  240 to 120, and Workflow guide strength 0.12 to 0.08. Layout rank/group gaps
  and rooted depth targets are reduced too, so the guides do not fight shorter
  springs. Circle sizes, collision bounds, branch ownership, and history remain
  unchanged. Focused tests compare actual settled link gaps in all four layouts.

## Rooted physics layouts (build 2026.09.16.6)

- The physical graph now follows owning relationships as well as execution flow.
  Primary scope membership connects branches back to the configured root; terminal
  observations and same-branch rollback links participate. Cross-branch information
  remains non-physical. Disconnected flow components attach via their existing
  owning parent, without creating execution dependencies or modifying notes.
- Four per-view layouts share the same topology: Workflow, Hanging, Growing, and
  Radial. D3 supplies directional/radial forces for the new modes; Dagre supplies
  deterministic initial positions. Each scope/layout has its own transient cache.
- Workflow drag release rebases the old positional guide and retains it through
  redraws; cancellation preserves the old guide. Nodes can settle under springs
  without being forced back to their original slots. Dustin remains the fixed root.
- Nodes retain colors, titles, numeric summaries, accessible names, and tooltips,
  but omit passive status/agency/rollback/root icons. Action controls remain.
- The read-only fixture option `node tests/browser-fixture.mjs --vault <vault>`
  loads selected graph metadata only, never note bodies. Its in-memory write mocks
  cannot modify vault files. The actual 72-note graph was verified as one physical
  component with 71 springs, including the Disable RTPv4 node; no note repairs or
  extra grouping notes were necessary.

Verification: 130 regression tests pass, with zero lint errors and the existing
12 advisory warnings. The real-vault metadata fixture verified all 72 nodes are
spring-connected, all three new layouts settle without node overlaps, and the
rollback drop survives refresh without returning to its old slot. Desktop
1440x900/1100x760 checks cover color-only nodes, directional framing, compact
paused starts, cancellation, and exact live-position restoration from history.

## Backtracking returns (build 2026.09.16.5)

- Outcome feedback follows the executed dependency route on a close parallel
  track. A failure at C in `A -> B -> C -> D` returns `C -> B -> A`; successful
  predecessors remain green, while invalidated D and its incoming link are gray.
- Completion also retraces the chain. A terminal outcome controls the whole
  return, preventing partially completed prefixes from reporting success early.
  Independent successful branches stay green; red wins on shared return segments.
- Nested/hidden failures continue through their enclosing workflow sequences.
  Membership does not transmit failure or gain springs. Superseded ancestor
  shortcuts no longer compete with the trace; explicit recovery links remain.
- Physics and Free layout share this derivation. Feedback is read-only, and
  renderer updates do not rewrite leaf states, historical records, or note links.

## Circular workflow physics (build 2026.09.16.4)

- Physics now uses compact 144px work circles and 160px summary circles, with
  correctly matched collision geometry and perimeter edge endpoints. Overview
  and Free layout keep their existing card presentations.
- The canonical Free-layout workflow builder also supplies Physics: parent to
  first step, declared dependency sequence, and terminal return to parent. Green
  completion returns and red failure escalation are retained instead of replacing
  the workflow with a parent-to-every-child Overview fan-out.
- Execution start/dependency/return/restart links are springs. Scope membership,
  inert observations, derived failure feedback, and compensation annotations are
  not. No relationships or work statuses are changed by layout.
- Dagre seeds left-to-right order and reduces crossings; D3 uses shorter springs,
  smaller circular collision bounds, and gentle positional guides. Independent
  workflows are packed into rows instead of a single tall global ranking. Curved return
  lanes and node-aware routing separate feedback from the forward path. Hover
  highlights connected edges; arbitrary dense graphs may still contain crossings.
- The configured fixed root, per-scope caches, pause/drag behavior, and read-only
  temporal browsing remain in place. Compact workflows are framed beside the root
  when they fit; large views still require panning or branch focus.

## Fixed graph root (build 2026.09.16.3)

- A per-view `graphRoot` reference selects a stable note identity without
  hardcoding a person's name in the plugin. The pin picker is disabled in history.
- Physics keeps the root at world `(0, 0)` across forces, drag cleanup, reset,
  scope changes, and reconstruction. Scope entry and Home center it; panning
  remains under user control. The root is a summary, not an executable task.
- Focused physics projections retain real containment/membership ancestry back
  to the root, without unrelated siblings or fabricated ownership. Historical
  navigation uses recorded identities and never inserts today's missing root.
- The live vault repair added 17 parents and 2 scope memberships across 19 notes.
  All 72 graph-eligible notes now reach Dustin; the independent A workflow remains
  a separate branch. Status, lifecycle history, dependencies, and bodies were
  preserved and the original 73 graph files were archived before editing.
- `scripts/audit-graph-root.mjs <vault> <root-note-path> --check --summary` checks
  the live query using the production hierarchy engine, including unresolved or
  ambiguous ownership links, cycles, and root reachability.

Verification: 100 regression tests and affected-test typechecking pass. Desktop
browser checks at 1440x900 and 1100x760 verified root selection, fixed coordinates,
root framing, real ancestry, no settled card overlaps, paused dragging and Escape
with a concurrent refresh, static history, and exact live-position restoration.
No physics or navigation action wrote note metadata or manual layout positions.
Large branches still require panning; general per-node pinning is not implemented.

## Physics experiment (build 2026.09.16.2)

Implemented the user's spring-and-repulsion experiment as an opt-in **Physics**
presentation alongside Overview and Free layout. It does not replace the packed
overview or commit a new manual arrangement.

- `d3-force` supplies link springs, many-body repulsion, conservative collision
  avoidance based on card dimensions, damping, and gentle centering. The small
  `GraphPhysics` adapter keeps the engine timer stopped; Graph drives explicit
  ticks on requestAnimationFrame and stops scheduling when paused or settled.
- Scoped visible nodes preserve hierarchy/status summaries; visible relationships
  become straight directed edges, with duplicate endpoint pairs contributing only
  one physical spring. No workflow or ownership relationships are invented.
- Pause/resume, reset, and pointer dragging are implemented. Dragging temporarily
  pins one node; Escape/blur restores the original position. Data refreshes do not
  detach a drag. Reduced-motion preference starts the experiment paused.
- Per-scope positions and cooling state are memory-only, as are its camera/world.
  Unchanged rerenders do not restart a settled graph. No tick or drag alters notes,
  manual positions, undo history, or recorded progress. Historical browsing stops
  physics and remains static/read-only; leaving the view cleans up its frame loop.

Verification: 95 tests, project type/lint gate (zero errors, 12 existing warnings),
and affected-test typecheck pass. Desktop browser checks at 1440x900 and 1100x760
verified actual node/edge motion, pause, resume, reset, settling, pointer dragging,
Escape cancellation, mid-drag refresh, static history, reduced-motion handling,
and no note/layout/journal changes. The 85-note fixture's expanded 50-node scope
with 40 springs settled with no overlaps. A small connected/disconnected graph
fits the smaller desktop viewport at normal card size after centering.

The production build and deployment succeeded with Graph marker `2026.09.16.2`;
all three installed artifact hashes match the build output. Previous plugin
files and settings were backed up before deployment.

This is a spatial experiment, not playback of historical growth. Physics controls
for force tuning, general per-node pins, and saving an arrangement are not included yet.
Native Obsidian acceptance still requires reloading the plugin and trying it in
the user's own graph.

## Scoped overview (build 2026.09.16.1)

Implemented following the user's screenshot showing an unreadably wide row of
disconnected roots and a long expanded scope spine. These improvements change
Overview itself; they do not add another presentation mode.

- Scope breadcrumbs replace large ancestor cards. A unique scope spine opens at
  its deepest unambiguous scope; home/picker navigation exposes the rest. Focus
  icons and the node menu enter any workstream, with breadcrumb navigation back.
- Disconnected leaf items live in a collapsed visual **Unassigned** group at All
  work, also reachable by an inbox/count control in a scoped view. No note data,
  ownership relationship, or history record is synthesized for the group.
- Readable 220px-wide workstreams wrap into multiple desktop columns instead of
  one enormous root row. Expanding a branch allocates space inside its column.
  Expanded processes are compact headings; leaf tasks are smaller cards; expanded
  single-child scaffolding compresses into a navigable title trail. Zoom is at
  least 80%; initial and home views start at the top, not the middle of a huge graph.
- Completion bars fill only for completed work. State icons/counts describe the
  remaining work. Blocked leaves are red; ancestors display alert counts without
  turning the entire portfolio into a red blocked item. Execution semantics are
  unchanged.
- History comparison, activity ticks, and change stepping follow the selected
  scope while the recording retains the whole graph. Scope identity and positions
  stay stable through time; absent historical scopes do not silently widen the
  view. Historical focus remains ephemeral, and present restores live focus and
  camera. Free-layout history remains graph-wide.

Verification: 83 automated tests, source lint/typecheck (zero errors; 12 existing
API warnings), and separate affected-test typecheck pass. The desktop fixture now
includes 85 notes, a three-scope spine, 12 uneven workstreams, 28 disconnected
items, and nested single-child wrappers. At 1440x960 and 1100x760 the overview
uses four/three readable columns. Expanded scope testing covered 50 rendered nodes
without overlap or overflow, unchanged neighboring columns, focus/keyboard/trail
navigation, empty zero-completion bars, scope-local history, unchanged notes and
manual positions, and restored live/free-layout cameras. Light and dark desktop
views were inspected. Native vault acceptance remains a user reload check.

The production build and deployment succeeded with Graph marker `2026.09.16.1`;
all three installed artifact hashes match the build output. Previous plugin
files and settings were backed up before deployment.

The previous overview/temporal delivery notes below describe their original
milestones; this section supersedes the former all-roots-row and ancestor-card
presentation rules.

## Recorded temporal graph (build 2026.09.15.4)

The first temporal implementation keeps one persistent graph and reconstructs
its observed metadata at a selected time. It does not duplicate notes each day.

- **Observation journal:** `src/graph-history.ts` stores one initial baseline,
  then changed-node upserts and keys that left the graph. Captured fields include
  title, identity, status, parent, dependencies, memberships, compensation links,
  kind, agency, lock metadata, and order. Derived states are recomputed using the
  shared engine. Rendering or the passage of a day does not produce change events.
- **Persistence:** each view has a `graphRecordingId`; journals live under
  `graphHistories` in plugin data, separate from note files. Saves are serialized
  with settings writes. A failed save stays retryable; damaged/unsupported history
  is surfaced without replacing it with an empty baseline. Stable note IDs and
  recorded paths preserve identity through observed renames and ID backfills.
- **Coverage:** recording begins on the first Graph query observation and runs
  while that view is open. Changes are timestamped when observed, not when an
  unobserved action might have happened. Reopening starts a new observation session
  and marks the closed interval as a gap. Gap dates show last-known state with a
  warning, not claimed exact history. Nothing is backfilled before the baseline.
  Leaving a query can mean a filter change, not necessarily deletion of the note.
- **Navigation:** a persistent bottom range control supports continuous scrubbing
  and wheel/trackpad time navigation. Buttons step one local-calendar day or jump
  to the preceding/following recorded change. Left/right keys step days when the
  timeline is focused; Shift-left/right jump changes; Home selects the baseline;
  End or the radio icon returns to present. Canvas scrolling keeps its graph role.
- **Read-only history:** past states use Overview and captured graph metadata.
  Historical node opening displays a read-only metadata snapshot, including nodes
  absent from today's query. History expansion and camera changes stay local to
  browsing; return-to-present restores the live presentation, camera, and settings.
  Live observations continue while the user is inspecting the past.
- **Changes and layout:** highlights compare with the previously displayed
  snapshot, including affected ancestry on both sides of reparenting. Added,
  changed, and removed counts use icons. Existing positions are retained during a
  browsing session; newly encountered historical nodes receive unoccupied slots.
  The timeline control stays mounted during redraws so dragging is uninterrupted.

Verification: 72 tests, source type/lint gate, and separate history-test typecheck
pass. Desktop fixture checks at 1440x900 and 1100x760 cover stepping, native slider
dragging, wheel routing, removed-item opening, gap disclosure, concurrent live
updates, save-error recovery, and restoring the live/free-layout camera without
note or layout-setting writes. These are synthetic-host checks, not a native
Obsidian acceptance run.

The production build and deployment succeeded; all three installed artifact
hashes match the build output and the deployed Graph marker is `2026.09.15.4`.
The previous plugin files and settings were backed up before deployment.

**Deferred:** play/pause timelapse, time-scaled event/trajectory layout, focus and
intermediate-result events, document content revisions, historical editing/restore,
and cross-device journal merging. This is a local observation journal, not yet
event sourcing for the entire vault. Back up plugin data along with the vault;
history is not automatically pruned. Existing `status_history` remains unchanged.

## Working-memory overview (2026-09-15)

**Product direction:** the graph is the primary way to digest everything on the
user's plate hierarchically while many human/agent threads run concurrently.
Show a manageable set of workstreams, let the user expand detail on demand, and
keep progress and problems visible when children are hidden. Desktop only.

Implemented in Graph build `2026.09.15.2`:

- Default Overview + preserved Free layout presentations. Scope membership and
  containment both participate in collapse; expansion is a per-view preference.
- Compact top-down layout and sparse hierarchy links, without changing saved
  canvas positions or note structure. Nested expansion, collapse-all, expand-all,
  keyboard activation, and explicit note-opening controls.
- Unique-leaf completion bars plus running/awaiting/blocked/ready/rollback counts.
  Semantic colors surface hidden problems and distinguish running threads from
  ready work. Progress measures work-item counts, not effort.
- Full work graph retained independently from its rendered projection. Separate
  cameras, initialized after layout; clicking to expand preserves screen position.
- Regression coverage for scope/multi-membership/cycle behavior, visibility,
  state summaries, layout, note immutability, and saved free-layout positions.
  All 48 tests pass. Desktop browser checks at 1440x900 and 1100x760 cover real
  clicks, keyboard controls, state updates under collapse, no overlapping nodes,
  unchanged notes/positions, and zero measured anchor drift across repeated toggles.

The existing prototype/manual-canvas interaction remains in Free layout. This
does not add an agent execution runtime or change the work-state semantics.
See `GRAPH_VIEW_RULES.md` section 0 for the as-built presentation contract.

Visual refinement in Graph build `2026.09.15.3`: standard status words are
replaced by a green circled check, yellow clock, red alert octagon, and blue
circled right arrow. Summary and toolbar counts use icons plus numbers; mode
buttons and ownership use icons. Tooltips and accessible names retain meanings,
while work titles and custom labels remain visible. The engine is unchanged.
All 53 tests pass; real Lucide SVGs were checked in the desktop fixture at
1440x900 and 1100x760, including expansion, mode switching, labels, and spacing.

## Stabilization and upstream integration (2026-09-15)

Integrate upstream `2.5.1` while preserving the fork's Kanban, Timeline, Rollout,
Graph, transition history, scopes, priorities, and impact-node behavior.

**Current scope: desktop only.** Do not add phone/tablet layouts or mobile-only
features, and validate desktop viewports only. Preserve existing behavior for
narrow desktop Obsidian panes. This follows the user's September 15 clarification.

- [x] Preserve the starting HEAD archive and working-tree patch outside the repo.
- [x] Put compensation state derivation in the shared graph engine and make the
  Graph and active-frontier Kanban use the same result. Cover dormant, triggered,
  completed, failed, and scope-isolated rollbacks; retain Awaiting and impact
  semantics.
- [x] Integrate upstream correctness and interaction changes, including typed
  group-by writes, rename fixes, fractional ordering, collapsed columns, WIP
  limits, cover images, rich formulas, and default new-card properties.
- [x] Preserve existing numeric order when migrating to fractional keys. Verify
  transition history and all custom views against the updated shared APIs.
- [x] Add automated regression coverage and run tests, lint, and production build.
- [x] Update the implementation documentation and identifiable build marker.
- [x] Deploy to the verified local vault and compare deployed artifact hashes.

The user is unavailable for Git approval: keep changes uncommitted, do not push,
and do not create a branch. Upstream code integration will not by itself record
merge ancestry; a reviewed Git merge/checkpoint remains a separate action.
Live Obsidian acceptance checks must be identified separately from headless tests.

### Implementation snapshot

- Final gates: clean `npm ci`, 36 passing tests, lint with zero errors and 12
  advisory Obsidian API warnings, production build successful, dependency audit
  with zero vulnerabilities. Deployment to the configured local vault succeeded;
  SHA-256 hashes of all three deployed artifacts match the build output.
- Upstream source through `d7defc7` (`2.5.1`) is integrated as fork build
  `2.5.1-dev.1`; Graph marker is `2026.09.15.1`.
- `graph-engine.ts` owns compensation identity, state, forward-rollup exclusion,
  and failure-scope boundaries. The Graph's view-level scheduler now handles
  attention rendering only. Both views keep unresolved compensation declarations
  dormant, rather than offering a rollback as ordinary work.
- Fractional ordering is shared by Kanban and graph layout. Numeric columns
  migrate on reorder; new graph-created cards respect fractional keys. Timeline
  and Rollout retain independent ordering properties.
- Card reuse includes hierarchy/outline state in its render signature and does
  not reuse frontier/archive rows as ordinary cards. Archive drops retain real
  `Completed` status, the archive flag, and canonical transition history.
- Vitest coverage includes the shared engine, upstream ordering/value utilities,
  and real Kanban/Rollout persistence methods with an in-memory host fixture.
  The release workflow now runs the regression suite.
- Browser fixture checks passed for native dragging and its history event,
  preserved scroll/image identity, hierarchy toggles and child-state refresh,
  mode/scope/priority controls, collapsed columns, covers, and rich formulas.
  Desktop Timeline stops `1w`, `1mo`, `3mo`, `6mo`, `1y`, and `5y` had no
  overlapping labels. Mobile layouts are not an implementation or acceptance
  target; the upstream phone/tablet-specific edit-button override was omitted.
- These are synthetic-host checks, not live Obsidian certification. Obsidian
  was not running during verification. Reload the plugin and smoke-test a
  backed-up board before relying on the integrated build for daily work.

Run `node tests/browser-fixture.mjs` to inspect the real renderers against
synthetic notes on a loopback-only URL. It never reads or modifies vault notes.
The original HEAD archive, working patch, and previous deployed plugin artifacts
were preserved under the OS temp directory with prefix
`base-board-before-upstream-5d5550c411bb492abeb1fcc0b95826e7`.
Historical milestone delivery notes below are superseded by this snapshot where
they describe the former view-local compensation scheduler or older pin model.

## Why this document exists

`GRAPH_AGENT_MCP_PLAN.md` specs the agent/MCP bridge, but it assumes a substrate
underneath it: an **event log as source of truth** and **per-node-type handlers
behind a deterministic scheduler**. This document specs that substrate, records
the conceptual lineage behind it, lists the roadmap requirements it serves, and
defines the maintainability tipping points that tell us *when* to do each piece.

Read together: this doc = the engine; `GRAPH_AGENT_MCP_PLAN.md` = the agent that
drives the engine. Build this one first.

## Conceptual lineage (why this design, and what it is NOT)

The idea of "a little program on each node that reacts to signals" maps onto
well-studied paradigms:

- **Actor model** (Hewitt; Erlang/Akka) — independent units holding local state,
  reacting to messages, deciding what to send next. Erlang's supervision-tree
  "let it crash / restart" is essentially the iteration-restart pattern.
- **Vertex-centric / "think like a vertex"** (Google **Pregel**, Apache Giraph,
  GraphX) — computation expressed from one vertex's perspective: receive
  messages, update state, send messages, vote to halt; a framework runs
  synchronized "supersteps". Used at Google/Facebook for PageRank, shortest
  paths, connectivity, clustering, label propagation over billion+ vertex graphs.
- **Dataflow / reactive programming** — values propagate along edges; nodes
  recompute when inputs change (spreadsheets, React, RxJS).
- **Belief propagation / message passing** (Pearl) — same shape on probabilistic
  graphical models.

**Decision: take the *modeling idea*, not the *distributed runtime*.** Pregel
exists to solve a *distribution* problem (graphs too big for one machine). Our
graph is small and in-memory forever, so we adopt vertex-centric *rules* but keep
a single **deterministic, synchronous scheduler** — no async agents, no message
storms, no superstep machinery. This preserves determinism, testability, clean
undo/transaction boundaries, and global-invariant reasoning, while gaining the
extensibility of per-type rules.

**Pure autonomous agents are explicitly rejected as a runtime** at this scale:
they would add ordering/termination/atomicity hazards to solve concurrency and
distribution problems we do not have.

## Roadmap requirements this serves

The architecture is shaped by these stated future plans:

1. **Multiple features** in one graph.
2. **Higher root nodes** — features aggregated under a `career` and/or `semester`
   super-root (multi-root awareness).
3. **Impact nodes** — value-tracking children branched off features / rings /
   roots; mostly *inert* w.r.t. propagation (must NOT participate in failure
   escalation or frontier logic).
4. **Exact-time state tracking** — every transition timestamped with full history.
5. **Replay** — re-play transitions over time; timeline view shows each node's
   state across time.
6. **Non-work domains** — gym, meal planning, home automation, etc., each with
   different node behaviors.

Mapping: (4)(5) ⇒ event sourcing. (1)(2)(3)(6) ⇒ per-node-type handlers +
multi-root + non-participating node types. These are why the two core patterns
below were chosen.

## Core pattern 1 — Event sourcing (source of truth)

Today `status` is mutated in place; history is implicit. Flip it: the **truth is
an append-only log of transition events**; current `status` becomes a cached
projection (a fold over the log).

```ts
interface GraphEvent {
  id: string;                 // ulid/uuid, monotonic by `at`
  nodeId: string;             // stable frontmatter `id`
  kind: "activated" | "completed" | "failed" | "invalidated"
      | "cancelled" | "awaiting" | "planned" | "created" | "linked";
  from: string | null;
  to: string | null;
  at: string;                 // ISO-8601
  causedBy: "human" | "agent";
  skill?: string;
  verifyResult?: boolean;
  evidence?: string;
}
```

- Extends the existing per-note `status_history`/`state_history` pattern.
- Delivers timestamps (#4), history (#4), replay (#5), timeline (#5), and the
  agent trust record (promotion data for `GRAPH_AGENT_MCP_PLAN.md`).
- Undo/redo can later consume the same log instead of file snapshots.
- **Open question:** vault-level log file vs. per-node arrays with a derived
  aggregate; stable node identity (backfill `id` where missing).

## Core pattern 2 — Deterministic scheduler + per-node-type handlers

Refactor the propagation logic now living inside `markNodeFailed`,
`makeNodeActive`, escalation, and parallel-cancellation into **per-node-type
handlers** invoked by **one central deterministic scheduler** ("think like a
vertex, but the framework runs the rounds").

```ts
type GraphSignal =
  | { kind: "failed"; origin: string }
  | { kind: "activated"; origin: string }
  | { kind: "completed"; origin: string };

interface SignalDecision {
  statusChanges: { nodeId: string; to: string }[];
  emit: { toNodeId: string; signal: GraphSignal }[];
  structural?: StructuralChange[];   // create node / link, re-home break, etc.
  halt?: boolean;                     // stop propagation here (e.g. iteration absorbs)
}

interface NodeBehavior {
  appliesTo(node: GraphNode): boolean;        // by type/workflow
  onSignal(node, signal, ctx): SignalDecision;
}
```

- The **scheduler** owns: a work queue, visited-edge dedup, cycle prevention,
  ordering, termination, and wrapping everything in the existing undo
  transaction. (This is the synchronous, deterministic core — not async actors.)
- **Node types register behaviors.** Examples that already exist implicitly:
  - *iteration* handler: absorbs upward failure escalation (`halt`), spawns its
    `restarts_to` replacement.
  - *rollout ring* handler: on failure → `Invalidated`.
  - *feature* handler: escalate red links upward but cancel parallel siblings
    only below the iteration boundary.
  - *impact* handler: **no-op / observer** — never participates in propagation
    (serves roadmap #3 cleanly instead of skip-guards everywhere).
- The agent `skill` (in `GRAPH_AGENT_MCP_PLAN.md`) is just the node's handler for
  an "execute" signal — same mental model.

**Refactor discipline:** land this **behavior-preserving first** (no-op refactor
verified against `GRAPH_VIEW_RULES.md` scenarios), then add new behaviors.

## Multi-root & cross-domain considerations

- **Multi-root** (#2): traversals that assume a single tree (escalation "to the
  root") must define "root" as "topmost ancestor within the relevant boundary"
  (e.g. stop at the feature, or the semester), not "the one global root". Encode
  boundaries as node-type properties, not hardcoded climbs.
- **Non-participating types** (#3, #6): the handler model makes "this type
  ignores this signal" a local default, so impact/gym/home nodes coexist without
  polluting work-tracking logic.

## Maintainability tipping points (when to do each piece)

Do the refactor when ~2 of these are true (several already are):

- `markNodeFailed` / `makeNodeActive` exceed ~3 node-type special cases each.
  *(Already ~2–3: iteration boundary, break re-homing, parallel cancellation.)*
- A node type must NOT participate in an existing traversal (impact nodes).
- History/replay is needed (in-place `status` can't answer "state last Tuesday").
- Two domains share traversal code but need different rules (work vs. gym streak).
- Cross-feature/multi-root signals appear (career/semester aggregation).

## Incremental build strategy (sections)

Build in small, independently shippable, mostly behavior-preserving milestones.
Each = one focused commit/PR with its own test pass and (per repo convention) a
`GRAPH_BUILD_VERSION` bump + deploy.

| # | Milestone | Depends on | Behavior change? | How to test |
|---|-----------|-----------|------------------|-------------|
| 1 | **Event log (write-only)** ✅ *done (build 2026.06.10.10)* — emit a `GraphEvent` on every graph status transition via `setGraphNodeStatus`; stored in the configured `status_history` array (Timeline-compatible) with `id`/`node`/`kind`/`causedBy` added; `id` backfilled. `status` still the live value. | — | None (additive) | Mark nodes active/failed/complete; confirm events recorded with correct from/to/at; existing flows unchanged. |
| 2 | **History read + projection** ✅ *done (build 2026.06.11.1)* — `getNodeTransitionEvents` reads/parses the log; `getProjectedStatus` folds it to a derived status; right-click **"Show state history"** opens a per-node timeline modal (with a projected-vs-current match check); node tooltip shows the sequence. `status` is still the live value (projection is read-only/diagnostic). | 1 | None (same status, new source) | Status matches pre-refactor for all RTPv4 nodes; history shows the sequence. |
| 3 | **Scheduler + handlers (no-op refactor)** ✅ *done (build 2026.06.11.8)* — reframed by `GRAPH_SEMANTICS_SPEC.md` into a model-correcting **pure recompute**: leaf statuses are the only truth; group states (Layer A, with new derived `in-progress`/purple state) and break/return link colors (Layer B) are derived on render; the three work ops (Active/Failed/Completed) + group **Prune** write only leaf statuses via the execution-order partition. Removed the imperative break re-homing / parallel cancellation / iteration spawning. | 1 | **Model-correcting** (per spec) | Run the 5 worked cases in `GRAPH_SEMANTICS_SPEC.md`. |
| 4 | **`Awaiting` state** ✅ *done (build 2026.06.11.11)* — added a first-class `awaiting` leaf state (status `Awaiting`): node-state + amber CSS (live, not dimmed) + `lucide-hourglass` badge, `isAwaitingStatus` predicate, derivation in `deriveLeafState`, counts as "live" in `deriveGroupState` (container reads `in-progress`), **non-terminal** so downstream stays gated, and a `markNodeAwaiting` work op + "Set as awaiting" context-menu item mirroring Set Active. Event log already maps `awaiting`. | 3 | New state only | Set a node Awaiting; verify color/badge; frontier treats it distinctly. |
| 5 | **`agent:` capability block + autonomy field** ✅ *partial (build 2026.06.12.5)* — agency axis added: `executor` (human/agent/mixed) + `autonomy` (propose/execute/autopilot), parsed + inherited down containment, agency badge + Run-by/Autonomy menu cycles. Also split `type` → `kind`/`label`. (Full `agent:` capability block — skill bindings — still TBD.) | 3 | None (data only) | Add `agent:` to a node; confirm parsed/exposed; dry-run lifecycle manually. |
| 6 | **Impact node type (inert handler)** ✅ *done (build 2026.08.20.1)* — `kind: impact` is a visible observational node that derives `idle`, is excluded from parent/scope rollups, active-frontier projection, status-writing execution partitions, failure escalation/break rendering, and work/agency context-menu actions. | 3 | New type, inert | Branch an impact node off a ring; fail the ring; confirm impact node is untouched. |
| 7 | **Replay + timeline integration** — partial in build `2026.09.15.4`: baseline/delta graph observation journal, read-only time scrubbing, day/change stepping, highlights, and return-to-present. Animated playback and the time-scaled trajectory view remain planned. | 2 | New view feature | Reconstruct recorded metadata and structure; verify coverage gaps, removed items, immutable live notes, and restored camera. |
| 8 | **MCP read server** — `GRAPH_AGENT_MCP_PLAN.md` step 3. | 1,5 | External, read-only | Point Spark at it in advisor mode; verify `get_node_context`. |
| 9 | **MCP guarded writes (`execute`)** — `GRAPH_AGENT_MCP_PLAN.md` step 4. | 3,5,8 | Agent can transition→Awaiting | One skill end-to-end, parks at Awaiting. |
| 10 | **Autopilot (`complete_with_verify`)** — `GRAPH_AGENT_MCP_PLAN.md` step 5. | 9 | Agent self-completes | Promote one verified skill; frontier chains. |

Sections 1–7 are this document's substrate; 8–10 hand off to
`GRAPH_AGENT_MCP_PLAN.md`. Milestones 1–3 are the high-value, low-risk core and
should be done first and in order.

> **Milestone 3 behavior contract:** `GRAPH_SEMANTICS_SPEC.md` is the
> authoritative model + acceptance cases for Milestone 3. It reframes M3 from a
> pure no-op refactor into a **model-correcting** one: implement node behavior
> as a **pure recompute** — leaf (work-node) statuses are the only stored truth;
> group-node states and link colors are *derived*; the three work-node
> operations (Active / Failed / Completed) partition the graph by **execution
> order**. Needs a small new derived `In Progress` group state first. Build to
> the spec, not to the accumulated per-bug fixes.

## Boundaries, signals & lenses (the aggregation + focus layer)

> **Trigger phrase:** *Build the aggregation and lens layer.* Captures the design
> conversation (2026-06-12) for: (a) a manual aggregation hierarchy above
> features (Semester → Year → org; Career → person), (b) propagation that stops
> at "bounce points" instead of climbing to the global root, and (c) a
> frontier-only Kanban that can be scoped/timed/prioritised. All of this is one
> primitive applied at different levels.

### The unifying primitive — typed cells with per-type policies

Every node — a leaf step, an iteration, a feature, or a scope like "MSFT" /
"Dustin" — is the same **cell** with a `type`, typed edges (`parent`,
`depends_on`, `break`, `restart`, and the new `rollup_to`), and three
type-level policies. Every requirement below is just a setting of these knobs at
some level; nothing is special-cased per level.

1. **Propagation policy** — for each *signal kind*, the cell `pass`es, `absorb`s,
   or `transform`s it.
2. **Rollup function** — how the cell summarises its subtree for the layer above.
3. **Frontier contribution** — whether it (or its subtree) yields actionable
   frontier items.

### Node model — three orthogonal axes

The old `type` field conflated several jobs. Split it into three independent
axes (a node is a point in this 3-space):

| Axis | Question | Values | Stored as |
|------|----------|--------|-----------|
| **Kind** | how does it behave / propagate? | `work` · `process` · `group` · `impact` | `kind` (closed; inferred-by-default) |
| **Label** | what is it, in domain terms? | feature, dev, stage, semester, career, "house"… | `type` (open, cosmetic) |
| **Agency** | who executes it & how autonomously? | executor `human`·`agent`·`mixed`; autonomy `propose`·`execute`·`autopilot` | `executor` / `autonomy` (inherited) |

- **Kind** is the only axis the engine branches on (state derivation,
  propagation, frontier, editability). It is **inferred from structure**
  (no children/members → `work`; has children → `process`; has members
  (`rollup_to`) → `group`) and only set explicitly for the ambiguous cases
  (empty `group`, `impact`, a `process` flagged a **boundary**). `group` is a
  boundary by definition (absorbs work signals → never `Failed`). Replaces the
  old `isScopeNode` name-matching.
- **Label** (`type`) is purely descriptive — `semester`/`career`/`person` are
  *labels on `group`-kind nodes*, not kinds. The engine never branches on it.
- **Agency** is a separate axis (this is Milestone 5's `agent:` block). It is
  **inherited down containment** (nearest-explicit-wins, like the lock): set
  `agent` on a `rollout` subprocess and its steps inherit it; override a single
  step back to `human`. Default `human`. `executor: agent` + `autonomy: execute`
  is the node that parks at `Awaiting` for human verification (M4); `autopilot`
  self-completes. Drives frontier/lens filtering ("what *I* must act on" vs
  "what the agent handles") and the MCP `execute`/`complete_with_verify` tools
  (M9–M10). Independent of **lock** (lock = can the *structure* be edited;
  agency = who *runs* the work).

### Signals & bounce points (generalises failure escalation)

Failure escalation (and later completion/activation/attention) is a **signal**
that flows along edges. Each cell's propagation policy decides its fate:

- `pass` → re-emit to parent (keep climbing).
- `absorb` → **bounce/terminate here** (optionally react locally, e.g. an
  iteration spawns a retry). This is the `halt` of the scheduler's
  `SignalDecision`.
- `transform` → absorb the detailed signal and emit a *coarser* one upward
  (e.g. N leaf failures → one "feature health: degraded" summary).

A **bounce point is just a cell whose policy is `absorb`/`transform` for that
signal class** — so multiple bounce points at multiple levels fall out for free:

| Cell type | `failure` signal | effect |
|-----------|------------------|--------|
| work leaf | `pass` | reports failure upward |
| iteration | `absorb` | failure bounces; may spawn retry |
| **feature** | `transform` | detailed failure → one "feature health" summary |
| **scope** (semester/org/career/person) | `absorb` | only ever sees summaries |

**Crucial:** the same boundary that absorbs signals also **bounds the rollup
granularity** (a "membrane"). Below a feature you see the full work-state
machine; the feature emits *one* summary; scopes roll up *feature summaries*,
never raw leaves. That is structurally why a top root ("Dustin") can never be
`Failed` — the membrane only passes summaries up. Declare boundaries as an
`absorbs: [signalKind, …]` set per node type — do **not** hardcode "stop at
feature".

### Aggregation layer — scopes + `rollup_to` (manual; many-to-many)

A separate relation keeps the work engine (which follows `parent` + `depends_on`)
completely unaware of the aggregation layer, so boundary isolation is automatic.

- **New relation `rollup_to`** (a **list**, mirroring `depends_on`): a node's
  `rollup_to: [[Semester]]` = "member of Semester". Many-to-many (a feature can
  roll into both a semester *and* a career). Members discover scopes; scopes find
  members by reverse lookup.
- **New edge kind `membership`** — rendered distinctly (thin dotted neutral),
  visually NOT a requirement/gating/break colour so work colour-tracing stays
  clean.
- **New node category `scope`** (and/or specific `semester`/`year`/`org`/
  `career`/`person`): no template structure, not "work". Derives a **rollup**
  from its members (reuse the M3 group fold over members instead of `children`),
  later a richer portfolio/progress summary.

### Editability model (computed vs manual)

Manipulability is a property of the **relation**, not a per-link flag:

- **`membership` edges are the only manually editable links** — create via the
  link menu / drag gesture ("Roll up into…"), remove via right-click ("Remove
  from scope").
- **Structural/computed edges** (`requirement-*`, `gating`, `break`, `restart`)
  are **not manually manipulable** (template-defined structure). *(Open: lock
  ALL structural edges, or only template-generated ones — see decisions.)*

### Frontier as a scoped derived query

`frontier(scope) = actionable leaves within scope's subtree`. `frontier(MSFT)`,
`frontier(personalProjects)`, `frontier(oneFeature)` are the same function at
different roots. The Kanban renders `frontier(currentScope)`.

### Lenses (scope + filter + schedule + priority)

A **Lens** is a named, switchable view: `{ scope, filters?, schedule?, ordering }`.

- **scope** → which subtree's frontier to show.
- **schedule** → optional active-hours/days; the lens picker *suggests/highlights*
  (does not force-switch) the matching lens (work hours → "MSFT", evening →
  "Personal projects").
- **priority overlay** → ephemeral per-`(lens, day)` ranking with pin-to-#1; does
  NOT mutate durable structure (distinct from `kanban_order`).

The Kanban gains: a **lens picker** = the clickable summarised scope hierarchy
(each scope shows a rollup badge: frontier count / health), and the **board** =
`frontier(active lens)` sorted by the priority overlay.

### Incremental build order

| Step | What | Risk | Notes |
|------|------|------|-------|
| A | **Scope type + `rollup_to`/`membership` edge + scope rollup** | additive | foundational; unblocks rollups & lens picker |
| B | **Editability gate** — lock structural edges, membership editable | behaviour | ✅ *done (build 2026.06.12.2)* — `graph_locked` subgraph lock (inherited, nearest-explicit-wins); templates insert locked; lock badge + Lock/Unlock toggle; freezes add-node / structural link create+delete+rewire inside a locked subtree; membership + reposition stay free |
| C | **Signal scheduler + per-type policy** (`pass`/`absorb`/`transform`) | refactor | ✅ *done (build 2026.06.16.1)* — `runSignalScheduler` propagates a `failure` signal up containment via `propagateFailureSignals`, honouring a per-kind bounce policy (`getSignalPolicy`: `group`/scope `absorb`s, all else `pass`; `transform` reserved). Registered `signalHandlers` (compensation first, attention second) consume the propagated `failureScope`. Generalises the M3 escalation; new reactions register as handlers. |
| D | **`frontier(scope)` query + scoped/frontier Kanban mode** | new view | ✅ *done (build 2026.06.13.2)* — the shared **`src/graph-engine.ts`** now owns the single frontier derivation (state recompute, kind inference, `isFrontierLeaf`/`getFrontier`/`getNodeLineage`/`getHygiene`, status predicates, reference normalization, plus `buildFrontierGraph`/`getFrontierNodes`/`getFrontierLineage`); the Graph view delegates to it (no duplicated logic). The Kanban's **Active frontier** mode (`Show cards` dropdown) renders a derived board: **live columns** = active frontier leaves bucketed by status (To Do / In Progress / In Review=`Awaiting` / Blocked), **history columns** = event-log window (Completed + Recently blocked, last 7 days from `status_history`). Each card shows the **work lineage breadcrumb** (replacing hierarchy tags), keeps facet chips (people/repo/kind) + note tags, and has a **pin** toggle (`pinned` frontmatter → sorts to top). Scope is the whole graph (lens scoping is Step E). The classic status board stays as the "All cards" mode. |
| E | **Lens object + clickable scope-hierarchy picker** | new view | ✅ *done (build 2026.06.16.3)* — the Active-frontier Kanban gains a **scope picker** strip above the board: an "All work" chip plus one chip per `kind:group` scope (indented by depth in the scope spine), each showing its **frontier count** and a red badge when the scope holds blocked/interrupted work. Selecting a scope narrows the board to `frontier(scope)` via the new engine helper `getScopeAncestors` (walks containment `parent` + membership `rollup_to` upward). The choice persists in view config (`frontierScope`). A lens is currently just `{ scope }`; filters/schedule/priority are Step F. |
| F | **Schedule suggestion + priority overlay (pin #1)** | sugar | ⚠️ *priority overlay done (build 2026.06.16.4); schedule deferred* — each frontier card has a **pin** that toggles it into an ordered **priority overlay** (pin → rank #1, click a ranked card to remove); ranked cards float to the top with a numeric rank badge. The overlay is **ephemeral per `(scope, day)`**, stored in view config (`frontierPriority`, bucket key `<scope>::<YYYY-MM-DD>`, past days pruned on write) — distinct from durable `kanban_order`. Replaces the old durable `pinned` frontmatter toggle. **Schedule suggestion** (per-scope active-hours that *highlight* a lens by time of day) is **not built** — it needs per-lens schedule config UI that does not exist yet; deferred until lenses become first-class editable objects. |

### Open decisions (to confirm)

1. **Signal kinds first:** start with `failure` only, generalise later. *(default: yes)*
2. **Boundary granularity:** universal work-signal boundary = **feature**, with
   **iteration** as inner retry-bounce and **scope** as outer aggregation-bounce;
   allow per-node override later. *(default: yes)*
3. **Multi-membership:** `rollup_to` is a list (a node may belong to several
   scopes). *(default: yes)*
4. **Structural lock breadth:** lock ALL structural edges vs only
   template-generated. *(RESOLVED: per-subgraph `graph_locked` lock — lock is
   positional by subtree, not per-edge; templates insert locked, manually
   toggleable; membership + node reposition stay editable.)*
5. **Lens persistence:** lenses durable in plugin config; priority overlay
   per-day-ephemeral. *(default: yes)*
6. **Auto-switch:** schedule only *suggests*; user clicks to switch. *(default: yes)*

## Compensation (saga) — failure-triggered mitigation

> **Trigger phrase:** *Work on compensation/saga.* Captures the design
> conversation (2026-06-13). When a deployed-then-validated change fails
> validation, two things must happen in parallel: **mitigate now** (undo the
> live side-effect — "disable the flag") and **fix forward** (a new iteration).
> This is the Saga / compensating-action pattern, and it is the first concrete
> behaviour of the Step C signal scheduler.

### Responsibility split (graph vs. agent harness)

The graph **instantiates declared structure deterministically**; the agent
harness **invents and executes**. One-line test: *does the reaction need
judgment?* No → graph; yes → harness.

- **Declared compensation → graph activates it.** Given a pre-declared
  compensation, wiring it onto the frontier at the right moment is mechanical
  bookkeeping (deterministic, replayable, undoable, and works with **no agent
  connected** — a human still sees the mitigation task at 2am). Creating a
  *node* is inert structure — safe to do deterministically.
- **Executing** the mitigation (run pfgold, verify) → **agent/human** (a
  side-effecting, autonomy-gated *skill*).
- **No declaration / novel mitigation** → the graph cannot invent a domain
  action; it raises an **attention signal** and the **agent proposes** a
  compensation (human-approved), which becomes a declaration the graph manages.

### Encoding (decided)

- **Relation `compensates`** (list) on the rollback/mitigation node → the
  effecting node it undoes (e.g. `Disable flag` `compensates: [[Enable flag]]`).
  Matches the "responder declares" convention of `depends_on`/`breaks_to`.
- **"Effecting" is inferred for the *declared* case** — a node is effecting iff
  something compensates it. But detecting a **missing** compensation needs a
  positive signal (absence of `compensates` is indistinguishable from
  "no side-effect"), so an explicit **`effecting: true`** flag marks a node that
  performs an undoable side-effect. Templates set it (the enable-flag node);
  it is what drives the Phase 3 attention signal.

### A compensation is out-of-band (not a forward step)

Crucial correction (after a first attempt modeled it with `depends_on`): a
compensation must **not** sit in the forward sequence. As a `depends_on`
successor it becomes the chain's terminal (steals the requirement-return) and is
swept into the failure's `Invalidated` set. Instead it links **only** via
`compensates` (what it undoes) + `parent` (where it lives), and is excluded from
sibling-chains, the execution partition, and its parent's group fold. Its state
is derived out-of-band:

- **dormant** (`idle`, **hidden**) by default — when an upstream node is active
  and nothing has failed, the compensation effectively does not exist;
- **active** (frontier) when **triggered**: its effecting target is `Completed`
  (effect live) AND a genuine failure has escalated through that target's
  container (`computeBrokenScopePaths` → ancestors of failed leaves);
- **completed** once executed.

### Build status

| Phase | What | Status |
|-------|------|--------|
| 1 | `compensates` relation (parse + link + reverse `compensatedBy`); compensation is **out-of-band** — `excludedFromFold`, excluded from sibling-chains + execution partition; state derived **dormant(`idle`, hidden) / active(triggered) / completed** via `applyCompensationStates` + `computeBrokenScopePaths` (failure-in-scope), NOT via `depends_on`. | ✅ *done (build 2026.06.13.6)* |
| 1.5 | Render: orange **rollback edge** (effecting → compensation) when triggered + mitigation **badge**; derived/non-editable. | ✅ *done (build 2026.06.13.6)* |
| 2 | **Template-ify** — bake enable↔disable into the flagged-ring template so every flagged rollout ships a dormant disable that auto-activates. | ✅ *done (build 2026.06.13.7)* |
| 3 | **Attention signal** for an effecting failure with **no** declared compensation (agent's cue to propose one). Explicit **`effecting: true`** flag; `needsCompensation` derived in `applyAttentionSignals` when a completed effecting node sits in a `computeBrokenScopePaths` scope with empty `compensatedBy`; red `lucide-alert-triangle` badge (bottom-left). | ✅ *done (build 2026.06.13.8)* |
| 4 | Generalise into the **Step C** per-type signal scheduler; compensation handler = its first registered behaviour. | ✅ *done (build 2026.06.16.1)* — `runSignalScheduler` + `signalHandlers` registry (`compensation`, then `attention`) driven by `propagateFailureSignals` with a per-kind bounce policy (`getSignalPolicy`). |

Iteration spawn (fix-forward) stays a deliberate manual action for now; only the
compensation is automated.

## Graph layout engine (interactive organize + temporal)

> **Trigger phrase:** *Build the graph layout engine.* Captures the design
> conversation (2026-06-13). Goal: replace hand-positioned `graph_x`/`graph_y`
> with an **algorithmic, undoable layout system** invoked from the graph, with
> several layout modes — culminating in a **temporal** mode that unifies the
> graph and timeline views.

### Position storage (decided: view config, not note frontmatter)

A node's position is only meaningful *to the graph view*, so positions move
**out of per-note frontmatter into the graph view config** (the `.base` view,
next to `graphViewport`/`graphWorld`) as a map `graphNodePositions: { <nodeId>:
{x, y} }`.

- **Why:** a relayout touches *one* config object, not N notes — no frontmatter
  churn, no sync conflicts, no git noise, no `onDataUpdated` storm. (Hand-editing
  70 notes per layout was the pain that motivated this.)
- **Migration, not fallback:** read any legacy frontmatter `graph_x`/`graph_y`
  once, fold into the config map, then stop writing frontmatter. Manual drags +
  computed layouts both write the config map (single source of truth).
- **Undo/redo:** positions leave the note files, so the existing *file-snapshot*
  undo no longer covers them. Layout changes use a **dedicated in-memory layout
  history** (before/after position-map snapshots) wired to the same toolbar
  Undo/Redo buttons (a new entry kind alongside the file-diff entries).

### Interaction

- **Right-click a node → `Organize ▸ …`** lays out that node's **containment
  subtree** (its descendants). **Right-click a template/group** organizes its
  contained subgraph. A second scope organizes the **gating-connected flow**.
- **Anchor on the clicked node** (decided): the clicked node keeps its current
  `(x, y)`; descendants are laid out *relative* to it (cascading down or right),
  so the rest of the graph does not jump. Organizing a deep node reflows only
  that subtree.
- All position writes for one organize = **one** layout-history entry = one undo.

### Layout modes

The data has two orthogonal relations → two axes: **containment** (`parent`,
the hierarchy) and **gating** (`depends_on`, the execution sequence).

1. **Tidy tree** — Reingold–Tilford contour packing over containment. Orientation
   **top-down** or **left-to-right** (these are transposes — one engine + a swap).
2. **Layered (a)** — *gated = left→right, subtree = top↓*. Reads like a release
   pipeline / org chart: hierarchy descends, each gated sequence marches right.
3. **Layered (b)** — *gated = top↓, subtree = left→right*. The transpose of (a);
   reads like an indented outline / mind-map. **Reconciliation rule:** gating is
   the **rank/flow axis**; containment is the **grouping axis** — a parent's
   children cluster together and are ordered within the cluster by `depends_on`.
4. **Physics / force-directed** — edges = springs (attraction), nodes = charged
   particles (repulsion), iterate to equilibrium. Must be **seeded + fixed
   iterations** so it is deterministic (for stable undo/redo); optional animated
   settling. For messy cross-cut graphs with no clean root.
5. **Mirror / transpose** — flip a selection about its bounding-box center
   (`y' = minY+maxY − y`, or x), and transpose (swap x/y) to convert
   top-down ↔ left-to-right. Cheap; one undoable transform each.

### Temporal layout (the unifying fifth mode)

This remains the proposed trajectory layout. The implemented first step is
recorded snapshot browsing above, not this time-scaled layout or animated replay.

`X = real time` (sourced from the event log — `status_history`'s `activated`/
`completed` timestamps). The **Now line** is a vertical seam (≈¾ across the
viewport): **left = history placed by real timestamps**; **right = future placed
by structure** (reuse the layered/tidy engine, anchored at Now, ordered by
dependency distance from Now). The **active frontier = the set of nodes whose
`[start, end]` interval contains Now** — the vertical slice at the seam (same set
Step D's Kanban projects).

- **`start` = first-ever activation** (decided); `end` = final completion, or
  *open* (extends to Now) while still live.
- **Time scale:** **activity-compressed by default** (squeeze idle gaps — "where
  did my energy flow") with an **honest/linear toggle**; reuse the Timeline
  ruler (`TIMELINE_RULER_PLAN.md`) for scale + labels.
- **Node encoding (by kind + collapse):**
  - **leaf** → a **duration ribbon**: a real start-card + a dimmed **ghost echo**
    card at `end`/Now, joined by a **state-colored ribbon** (blue active / amber
    awaiting / red blocked / hatched planned) — which *is* the node's state
    history over time.
  - **collapsed group** → a single rolled-up **state ribbon** across its span.
  - **expanded group** → a **nested labeled swimlane/bracket** spanning its
    descendants' time range (sticky left label = swimlane label = the click/
    collapse target), tinted by its derived rollup state. Groups are **never**
    point-cards (a group is a span, not an instant).
- Containment ⇒ **nested swimlanes** (Y); gating ⇒ left→right (already temporal);
  `restart`/`break` ⇒ the only backward arcs (energy that looped back).
- This **converges the graph and timeline views**: the temporal graph is the
  timeline view at higher density; collapsing top-level scopes gives the
  "where did my energy flow this quarter" one-glance view.

### Build order

| # | Piece | Notes |
|---|-------|-------|
| 1 | **Pure layout engine** (`src/graph-layout.ts`) | tidy tree + layered (a/b) + transpose/mirror; pure `compute(root, descendants, mode, opts) → Map<id,{x,y}>`. No side effects, deterministic. |
| 2 | **Config-based positions + migration** | `graphNodePositions` map; read in `getSavedGraphPosition`; drags write the map. |
| 3 | **Layout undo entry + Organize menu** | in-memory before/after position-map history on the existing Undo/Redo buttons; `Organize ▸ Top-down / Left-to-right / Layered / Mirror` on nodes/templates, anchored on the clicked node. |
| 4 | **Physics mode** | seeded force-directed; optional animation. |
| 5 | **Temporal mode** | needs the event log (have), the Timeline ruler (have), and pieces 1–3; converges with the Timeline view. |

## Cross-references

- `GRAPH_SEMANTICS_SPEC.md` — the authoritative intended behavior model and
  worked acceptance cases (Milestone 3 contract). Supersedes ad-hoc per-bug
  fixes where they differ.
- `GRAPH_VIEW_RULES.md` — current (as-built) behavior; describes the imperative
  status mutation that Milestone 3 replaces with the derived model.
- `GRAPH_AGENT_MCP_PLAN.md` — the agent bridge that consumes this substrate
  (milestones 8–10).
