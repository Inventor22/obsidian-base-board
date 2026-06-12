# Graph View Ruleset

> **Maintenance note:** This file is the source-of-truth reference for how the
> Base Board Graph view behaves. **Update it whenever you iterate on graph
> features** (new node states, link types, templates, color rules, edge routing,
> etc.) so future chat sessions can read this file instead of re-deriving
> behavior from code. When a rule here disagrees with the code, fix whichever is
> wrong and keep them in sync.
>
> Primary implementation: `src/graph-view.ts` (build marker `GRAPH_BUILD_VERSION`).
> Styling: `styles.css` (search `base-board-graph-`).
> Related plan docs: `GRAPH_INFINITE_CANVAS_PLAN.md`.

---

## 1. Nodes

Each node is one Obsidian note. A node has **two independent visual dimensions**:

1. **Accent color** — driven by status/column.
2. **State** — a computed overlay that sets border style, tint, opacity, and a
   badge icon.

### 1.1 Node accent color

- The node's left border and `--graph-node-color` come from
  `getColumnColor(this.config, node.status)`.
- This is the **same color as that status's Kanban column**.
- Accent color is **not** derived from node type.

### 1.2 Node state (computed / derived)

> **Milestone 3 (GRAPH_SEMANTICS_SPEC.md) — derived model.** `assignNodeStates()`
> is now a **pure recompute**, not imperative status mutation. The only stored
> truth is the set of **leaf (work-node) statuses**. **Leaf** nodes (no children)
> take their state from their own status; **group** nodes (with children) have
> their state **derived bottom-up from their children** and their own stored
> status is ignored. Run on every render via `deriveNodeState`.

**Leaf (work-node) state** — first matching rule wins:

| Priority | State | Trigger | Badge icon |
|----------|-------|---------|------------|
| 1 | `invalidated` | status is `invalidated` or `skipped` | `lucide-circle-off` |
| 2 | `cancelled` | status is `cancelled`/`canceled` | `lucide-x-circle` |
| 3 | `interrupted` | status is `interrupted` or `failed` | `lucide-ban` |
| 4 | `active` | status is `in progress`, `doing`, or `active` | `lucide-play` |
| 5 | `awaiting` | status is `awaiting` (live but parked, waiting on something external) | `lucide-hourglass` |
| 6 | `completed` | status is `completed` or `done` | `lucide-check` |
| 7 | `blocked` | status is `blocked` | `lucide-octagon-alert` |
| 8 | `waiting` | own `depends_on` deps OR any ancestor's deps are not all terminal (by DERIVED state) | `lucide-lock` |
| 9 | `active` (computed) | ready leaf: gating prerequisites satisfied | `lucide-play` |

**Group (container) state** — derived fold over children's derived states
(`deriveGroupState`), precedence `In Progress > Completed > Cancelled/Invalidated > Planned`:

| Children condition | Group state | Visual |
|--------------------|-------------|--------|
| any child `active`/`in-progress`/`awaiting`/`interrupted`/`blocked` | `in-progress` | **purple** tint + border (`--color-purple` `#a371f7`), NO glow |
| all children `completed` | `completed` | green |
| all children `cancelled` | `cancelled` | dim orange dashed |
| all children `invalidated` | `invalidated` | dim grayscale dashed |
| all terminal-abandoned (mixed cancelled/invalidated) | `invalidated` if any invalidated else `cancelled` | — |
| otherwise (mixed planned/completed, no live work) | `waiting` | muted dashed |

Notes:
- **`in-progress` (purple)** is the derived "this container spans the active
  frontier" state — distinct from the blue `active` leaf and from `completed`.
  It stays visually subordinate to the blue frontier (`lucide-circle-dot` badge).
- **No explicit-active override for containers.** Groups are never read from
  their own stored status, so a stale `In Progress` on a container has no effect
  — its state derives purely from its children.
- **`invalidated` vs `cancelled`:** `invalidated` is work sequenced *after* a
  failed/pruned point that can no longer run; `cancelled` is a deliberately
  pruned sub-graph (`reason: pruned-manual` in the event log).
- **`awaiting` (amber, `lucide-hourglass`)** is a live-but-parked leaf state:
  the work has reached this node and is waiting on something external (a rollout
  to propagate, an agent awaiting input/verification). It is **non-terminal**
  (downstream stays gated/`waiting`) and counts as **live** in the group fold
  (its container reads `in-progress`). Distinct from the gray dependency
  `waiting` lock and the dimmed `cancelled` state — it is NOT dimmed.
- Dependency/ancestor-dependency satisfaction (`areGatingPrerequisitesTerminal`)
  is evaluated against **derived** states (memoized), so group prerequisites
  resolve correctly even though groups carry no live stored status.

### 1.2.1 Work-node operations (execution-order partition)

Group nodes are **not directly actionable**. The right-click menu offers the
three work-node operations only on **leaf** nodes, and **Prune** only on groups.
Each operation partitions the graph by **execution order** relative to the
acted-on leaf `X` — `before(X)` = its dependency closure (incl. ancestor deps),
`after(X)` = its downstream closure (incl. work sequenced after its ancestors) —
and writes **only leaf statuses**; group states and link colors derive on render.

| Action | Target | Effect on leaves |
|--------|--------|------------------|
| **Set as active work** | leaf | before → `Completed`, `X` → `In Progress` (Active), after → `Planned` |
| **Set as awaiting** | leaf | before → `Completed`, `X` → `Awaiting`, after → `Planned` (like Active, but parked/non-terminal) |
| **Mark as complete** | leaf | before → `Completed`, `X` → `Completed` (after untouched) |
| **Mark as failed** | leaf | before → `Completed`, `X` → `Failed`, after → `Invalidated` |
| **Prune (cancel sub-graph)** | group | subtree leaves → `Cancelled` (`reason: pruned-manual`), after-group leaves → `Invalidated` |

Failure does **not** spawn an iteration, re-home `breaks_to`, or cancel parallel
branches (those imperative behaviors were removed). The red break link is
derived (see §2.1).


### 1.3 Node types

`nodeType` is a descriptive label only (no color impact). Allowed values
(`GRAPH_NODE_TYPE_OPTIONS`):

`feature`, `iteration`, `dev`, `rollout`, `repo`, `stage`, `canary`, `pilot`,
`broad`, `design`, `implementation`, `review`, `await`, `enable`, `verify`,
`task`.

---

## 2. Links / edges

Links are created by dragging from a node's link handle to another node, then
choosing a type from the menu (`showNewLinkTypeMenu`). Each type writes
different frontmatter and renders as a differently colored edge.

| Menu item | Menu icon | Frontmatter written | Edge kind(s) | Color / style |
|-----------|-----------|---------------------|--------------|---------------|
| **Subprocess** | `lucide-git-branch` | sets target's `parent` = source (parent/child) | `requirement-start` (down) and `requirement-return` (up) | start: `text-muted` 52% solid; return (fulfilled): `text-success` 58% dashed `8 6`; return (dormant): `text-muted` 40% dashed |
| **Dependency / gating** | `lucide-lock` | adds `depends_on` on target → source | `gating` | `interactive-accent` 58% solid + gating arrowhead |
| **Break** | `lucide-unlink` | adds `breaks_to` on source → target | `break` (triggered) / `break-dormant` | triggered: `text-error` 78% dashed `5 5`; dormant: `text-success` 42% (muted green) |
| **Restart** | `lucide-refresh-cw` | adds `restarts_to` on source → target | `restart` | `text-success` 76% dashed `7 5` |

### 2.1 Edge color meaning

- **Gating** (accent): the dependency / sequencing flow — "this can't start
  until that is done."
- **Requirement-start** (muted gray, going down): structural containment from
  parent to child (a subprocess step).
- **Requirement-return** (going up): completion flowing back up from child to
  parent. State-driven: green **only when the child (`edge.from`) is genuinely
  `Completed`** — evaluated against the child's **derived state**
  (`edge.from.state === "completed"`), NOT its stored status. This matters for
  **group** children (e.g. `repo`): a group carries no live stored status, so
  its return only greens once all of its descendants complete; a stale stored
  `Completed` on a container is ignored. Otherwise it renders **dormant muted
  gray**. It is also **suppressed entirely** for a group on the active failure
  path (a derived red break replaces the canonical return while a descendant is
  failed — `brokenParentPaths` in `layoutGraph`). Reverses for free when the
  failure clears. See `getEdgeMarkerKind`.
- **Break** (red dashed when triggered, muted green when dormant): represents a
  failure path. There are two sources:
  1. **Derived (Milestone 3):** a genuinely failed **leaf** synthesizes a red
     break link to its parent group that **escalates red up the containment
     chain** (`layoutGraph` walks the parent chain from each failed leaf). These
     are not stored as `breaks_to` — they appear/disappear as the failure is
     set/cleared.
  2. **Authored:** an explicit `breaks_to` link renders **only when its source
     is genuinely failed** (`interrupted`/`failed` or `blocked`) — a real
     triggered break, deduped against derived edges. A **dormant** authored
     break (source not failed) is **not drawn at all** in the derived model: an
     inactive break is not a real link and must not compete with the canonical
     return. (Stale `breaks_to` left by older builds therefore stays invisible
     until its source actually fails.)
  See `isBreakEdgeTriggered` / `isBreakEdgeEscalated` / `recomputeBreakEscalation`.
- **Restart** (green dashed): loops back to re-run a prior node.

### 2.2 Editing / deleting edges

`deleteGraphEdge` reverses whatever the edge represents:
- `requirement-start`: clears the child's `parent`.
- `gating`: removes `depends_on`.
- `break` / `restart`: removes `breaks_to` / `restarts_to`.

`requirement-return` edges are **derived from containment** and have no
structural edit/delete action — right-clicking one shows no menu. (The former
"Hide return line" action and its `graph_hidden_returns` frontmatter were
removed: link visibility is being handled by an upcoming header by-type filter,
and per-edge persisted hides are no longer a concept.)

Edge endpoints can be re-anchored by dragging the endpoint handle to a different
node; this rewrites the corresponding frontmatter reference.

### 2.3 Undo / redo

The graph toolbar has **Undo** / **Redo** buttons (left of the zoom controls).
They cover the mutating link/status actions: **Set as active work**, **Mark as
failed**, **Create link**, **Delete link**, and **Rewire link**.

- Implemented as a file-snapshot transaction. Each wrapped action calls
  `beginGraphHistory(label)`; the low-level writers (`setGraphNodeStatus`,
  `addGraphReference`, `removeGraphReference`, `replaceGraphReference`,
  `updateGraphParent`, `ensureNextIteration`, `createTemplateNode`) snapshot
  each touched file's prior content via `snapshotForUndo` while armed.
  `commitGraphHistory` records a diff entry (before/after content per file).
- Undo restores the **before** content of every file in the entry (recreating a
  file whose before-state was "did not exist" → deletes it; e.g. the iteration
  auto-created by Mark-as-failed); redo restores **after**.
- Node **drag** (`graph_x`/`graph_y`) and **collapse** (`graph_collapsed`) are
  intentionally NOT tracked (high-frequency, low-value), so they don't pollute
  the history stack.
- A new action clears the redo stack. Stack depth is capped at
  `GRAPH_HISTORY_LIMIT` (50).

---

## 3. Subprocesses (parent/child structure)

- A **subprocess** is a parent→child containment relationship created by the
  **Subprocess** link. The child gets a `parent` wikilink to the source.
- The plugin treats `feature` / `parent_task` similarly to `parent` for
  hierarchy (see repo workflow conventions).
- A node can be **collapsed** (`graph_collapsed` frontmatter), which hides its
  descendant subprocess tree.
- `getMovableSubgraph` (children + successors) defines what moves when dragging
  a node; collapsing/insertion respect this subtree.

---

## 4. Gating / successor traversal

- A node's **gated successors** = its `successors` minus its `restartTargets`
  (`getGatedSuccessors`). This means **restart links do not count as forward
  flow** when traversing the graph for layout/state.
- Forward traversal queues `children` + gated successors.

---

## 5. Active frontier ("Set as active work")

Right-click a node > **"Set as active work"** (`makeNodeActive`) declares that
node the active frontier — the single place work is currently happening in that
branch. Active frontier nodes are what surface in the kanban view's
`active-frontier` projection mode.

The action writes **status frontmatter** (the groupBy property, default
`status`) across the graph; status is the single source that drives graph color,
graph state, and kanban columns/projection:

| Target | New status | Result |
|--------|-----------|--------|
| The node itself | `In Progress` | blue, explicit `active` state, actionable kanban frontier |
| Upstream dependency chain (transitive `predecessors`) | `Completed` | green; set even if previously `Failed`/`Invalidated`/`Cancelled` (manual override implies prerequisites are done). Includes the dependencies of **every ancestor** (to work inside a container, the container's deps must be done) and the full **containment subtree** of each prerequisite. |
| Downstream (descendants + gated successors) | `Planned` | gray; excluded from kanban frontier so the node stays THE frontier. Reset even if currently failed/invalidated. Includes the work sequenced **after every ancestor** (e.g. later rollout rings like `canary`/`pilot`/`broad` after the containing `stage`) — being active inside a container means that container's successors have not run yet. See `getDownstreamResetNodes`. |
| Ancestors (parent chain) | `Completed` **only if every branch is complete** | otherwise left unchanged (still contains the in-progress branch) |
| Re-homed break link on the node | moved back to the canonical break point | reverses `markNodeFailed`'s break re-homing (see below) |

Rules / guarantees:
- **Parallel branches each keep their own frontier.** Setting one branch active
  does not touch sibling branches; you set active work per branch.
- **An ancestor is marked `Completed` only when all of its child branches are
  terminal-complete.** An ancestor still containing the in-progress branch is
  left unchanged (it stays in progress / delegating).
- **Downstream ripple effects are reset.** Because downstream nodes "could not
  have run yet" once an upstream node is the active frontier, their statuses are
  reset to `Planned` **even if they were failed/invalidated**. This clears the
  failure, so any red `break` link sourced from a reset node becomes a dormant
  muted-green link (see §2.1). The red break links update everywhere in the
  affected subgraph automatically because break color is source-state-driven.
- **Upstream dependencies override failed states.** A transitive `predecessor`
  of the activated node is set `Completed` even if it was `Failed`/`Invalidated`/
  `Cancelled`. Explicitly setting a downstream node active asserts its
  prerequisites are satisfied, so completion propagates back up the dependency
  chain (e.g. activating `Validate …` clears a `Failed` `Wait …` to `Completed`).
- **Ancestor dependencies are completed too.** Upstream completion walks the
  dependencies of the activated node AND of every **ancestor** (containment
  implies the container's deps must be done), and completes each prerequisite's
  full **containment subtree**. Example: activating a leaf inside `rollout`
  completes `rollout`'s dependency `dev` (and `dev`'s children), which unblocks
  the `rollout`/`repo`/`stage` containers so they render complete (green)
  instead of `waiting`. Gated successors are deliberately NOT followed when
  completing a prerequisite (that would sweep the active branch back in via
  `dev → rollout`). See `getUpstreamDependencyNodes` / `getContainmentDescendants`.
- **Ancestor (parent-chain) failed nodes are preserved.** A failed/terminal node
  on the activated node's *parent* chain is not overwritten (only the dependency
  chain is). Ancestors still only become `Completed` when all their branches are
  terminal-complete.
- `Planned` (not `To Do`) is used downstream on purpose: a `To Do` child with no
  dependencies would, in the kanban active-frontier projection, hide its parent
  (the active node). `Planned` is non-actionable, so the active node stays the
  visible frontier card.
- **Break re-homing is reversed across affected groups.** When you set a node
  active, every group affected by the activation — the activated node's own
  group **and the group of every upstream-completed node** — has its break point
  restored to that group's **canonical terminal** (the child with no gated
  successor inside the group). So activating `pilot` (which completes the whole
  `stage` ring upstream) moves a break that was re-homed onto `enable feature
  flag` back onto `verify`. See `restoreGroupBreakPoint`.

### 5.1 Mark as failed (`markNodeFailed`)

Right-click a node > **"Mark as failed"** is the inverse of "Set as active work"
for failure handling. Its behavior depends on whether the failed node **has a
parent** — i.e. it is a step inside a containing subprocess. If so, failing it
**breaks that subprocess** and escalates up the containment chain (the break
point is created even when the template/group authored no break links).

**Subprocess steps** (any node with a parent — e.g. rollout rings, ring steps):

| Step | Effect |
|------|--------|
| Status | The failed node becomes `Failed` (red `interrupted` state). |
| Keep upstream completed | The failed node's upstream dependency closure (predecessors + ancestor deps + their subtrees) stays `Completed` (it ran; the failure is downstream of it) and is excluded from cancellation/invalidation. In-flight upstream nodes are set `Completed`; genuinely failed/blocked ones are left as-is. The red break links convey that the failure is downstream of these nodes. |
| Become the break point | The failed node gets `breaks_to: <parent>`: any same-parent sibling that held it is re-homed onto the failed node, or the link is **created** if the group had none. The red break originates from the node that **actually** failed. |
| Escalate up the parent chain | Walking from the failed node's parent to the root, a `breaks_to: <parent>` link is ensured at every level (created if missing), so the whole containment chain renders red. |
| Invalidate | The sequential downstream that can no longer run becomes `Invalidated` (gray, unreachable): the failed node's **own gated-successor closure** (the rest of its ring after it, e.g. `await feature flag rollout` → `verify`) AND the break point's gated successors (the subsequent rings, e.g. Canary → Pilot → Broad). This overrides a stale `Completed` (if the chain broke early, later steps are retroactively unreachable). |
| Cancel parallel branches | At each level **up to and including the iteration node**, the escalation child's *sibling* subtrees are parallel branches that were running concurrently. Their in-flight/pending work is set to `Cancelled`. The failed node's **upstream dependency closure** and its **containment ancestors** are excluded (ancestors are escalation-path containers, not parallel work; a stale `Cancelled` ancestor is healed). Cancellation stops at the iteration boundary so it never touches the feature root's other children (the restart iteration). |
| Next iteration | The iteration node on the chain gets a `restarts_to` next iteration, created to its right if none exists. |

Worked example: failing `Validate RTPv4 Fabricator Stage automation` escalates
red links up to `RTPv4` AND cancels the in-flight work in the parallel
`Flight RTPv4 in AzAllocator` branch (sibling of `Flight RTPv4 in Fabricator`
under `Flight RTPv4`), while leaving `RTPv4 Iteration 2` untouched.

The **iteration boundary** is key: red-link escalation climbs all the way to the
feature root, but parallel cancellation only runs from the failed node's parent
up to (and including) the iteration node — `getIterationAncestor` plus the
`withinIteration` flag in `markNodeFailed`. Only in-flight/pending statuses are
cancelled (`isCancellableInFlight`); `Completed`, `Failed`, `Invalidated`,
`Blocked`, and already-`Cancelled` nodes are preserved.

**Top-level nodes** (no parent): just set the node `Failed` and `Invalidate` its
own gated-successor closure (no break point / escalation, since there is no
containing subprocess to break).

**Reversal:** "Set as active work" resumes the iteration — it resets `Cancelled`
nodes within the activated node's iteration subtree back to `Planned` (alongside
the existing `Failed`/`Invalidated` → `Planned` reset and break-point
restoration). All of this is inside the undo transaction.

### Escalation red color (render-time)

Break links climbing the parent chain (source's `breaks_to` points at its
parent) render **red** when a genuinely-failed node exists **at or below** them
on that chain — computed in `recomputeBreakEscalation` /
`isBreakEdgeEscalated`. The intermediate nodes' own statuses are **not** changed
(they stay `Completed`); only the failed leaf carries a failed status. This is
why marking one node failed turns the entire break chain red up to the feature
root, and is fully reversible:

Rules / guarantees:
- **Only `interrupted`/`failed` or `blocked` sources start an escalation.**
  `invalidated`/`skipped` nodes never ran, so they do not start a cascade
  (their own break links stay dormant per §2.1).
- Nodes already in a genuine failed state are **preserved** — never relabeled as
  a downstream invalidation.
- **Symmetric with "Set as active work":** setting an upstream node active
  resets the downstream `Invalidated`/`Failed` nodes back to `Planned`, removing
  the failed status from the chain so the escalated break links go dormant
  (muted green) again. The `breaks_to` links created during escalation persist
  in frontmatter but render dormant once nothing on the chain is failed.

### 5.2 Mark as complete (`markNodeComplete`)

Right-click a node > **"Mark as complete"** sets just that node's status to
`Completed` (green). Unlike "Set as active work" it does **not** reshuffle the
rest of the graph — it only records the node's own completion (an explicit user
override that also works on a previously failed node). An already-complete node
is a no-op. Undoable (see §2.3).

---

## 7. Templates

Insertable workflow scaffolds (`GRAPH_TEMPLATE_DEFINITIONS`). When invoked from
a node, the set is scoped to that node (`getScopedTemplateDefinitions`); on empty
canvas the full set is offered.

| Template id | Name | Icon | Structure (indent = child) |
|-------------|------|------|----------------------------|
| `feature-simple` | Simple feature | `lucide-sparkles` | Feature → dev, rollout |
| `feature-detailed` | Detailed feature | `lucide-sparkles` | Feature → dev (design, implementation, review) + rollout (repo → stage, canary, pilot, broad) |
| `iteration` | Iteration | `lucide-refresh-cw` | Iteration → dev, rollout |
| `dev` | Dev | `lucide-code-2` | dev → design, implementation, review |
| `rollout-repo` | Rollout repo | `lucide-radio-tower` | rollout → repo → stage, canary, pilot, broad |
| `ring-flagged` | Flagged ring | `lucide-flag` | ring → await build rollout, enable feature flag, await feature flag rollout, verify |
| `ring-basic` | Basic ring | `lucide-check-circle-2` | ring → await build rollout, verify |

---

## 8. Frontmatter properties used by the graph

| Property | Purpose |
|----------|---------|
| `graph_x`, `graph_y` | Persisted world coordinates of the node |
| `graph_collapsed` | Whether the node's subprocess tree is collapsed |
| `graph_hidden_returns` | Return lines (`requirement-return`) hidden by the user |
| `parent` (and `feature` / `parent_task`) | Subprocess / containment parent |
| `depends_on` | Gating dependencies (source nodes that must complete first) |
| `breaks_to` | Break targets |
| `restarts_to` | Restart targets |
| `status` | Drives accent color and computed state |
| `id` | Stable node identity; backfilled on first graph status change (join key for the transition event log) |
| `status_history` (configurable) | Append-only transition event log (see below) |

View-config keys (Bases view config, not frontmatter): `graphViewport`,
`graphWorld`.

### 8.1 Transition event log (Milestone 1 of `GRAPH_ARCHITECTURE_PLAN.md`)

Every graph status change (via `setGraphNodeStatus` — used by Set active, Mark
complete, Mark failed, and the escalation/invalidation/cancellation passes)
appends an event to the configured transition-history array (default
`status_history`, see plugin settings). Events are **append-only** and are the
first step toward event sourcing (history, replay, timeline, agent trust
record).

Record shape (backward-compatible with the Timeline view, which reads
`from`/`to`/`at`/`property`):

```yaml
- id: evt-<base36 time>-<rand>   # unique event id
  node: <frontmatter id>          # stable node identity
  kind: activated|completed|failed|invalidated|cancelled|awaiting|planned|transition
  from: <prior status | null>
  to: <new status>
  at: <ISO-8601>
  property: status                # the groupBy property
  causedBy: human                 # agent layer (later) sets "agent"
  source: baseboard-graph
```

- Honors the existing **Transition history** plugin setting (disabled → no
  events written).
- Writes happen inside the same frontmatter write as the status change, so
  **undo** reverses the event along with the status.
- `causedBy` is always `human` today; the agent bridge
  (`GRAPH_AGENT_MCP_PLAN.md`) will set `agent`.

### 8.2 History read + projection (Milestone 2 of `GRAPH_ARCHITECTURE_PLAN.md`)

The event log is read back and can derive ("project") a node's current status:

- `getNodeTransitionEvents(file)` parses the configured history array into
  sorted `GraphTransitionEvent`s (status-property records only; legacy
  kanban/rollout records are included).
- `getProjectedStatus(events)` folds them to the latest `to` — the derived
  current status. This is **read-only/diagnostic** for now; the live `status`
  frontmatter is still the source of truth (the log only captures graph
  transitions since Milestone 1, so the projection can legitimately differ for
  nodes changed elsewhere).
- Right-click a node > **"Show state history"** opens a per-node modal listing
  every transition (time · kind · causedBy · source) with a projected-vs-current
  match check. The node tooltip also shows a compact `A → B → C` sequence.

---

## 9. Status → state vocabulary quick reference

| Status value (case-insensitive) | Resulting state |
|---------------------------------|-----------------|
| `invalidated`, `skipped` | `invalidated` |
| `cancelled`, `canceled` | `cancelled` |
| `interrupted`, `failed` | `interrupted` |
| `in progress`, `doing`, `active` | `active` (explicit; overrides container rule) |
| `completed`, `done` | `completed` |
| `blocked` | `blocked` |
| `planned` | `waiting` (not-started; also excluded from kanban active-frontier) |
| anything else (e.g. `To Do`) | `waiting` / `active` / `completed` (container) by dependency + child rules |
