# Graph Semantics Spec (authoritative behavior model)

Trigger phrase for a future Copilot chat: **Implement the graph semantics model**.

> **Why this file exists.** Earlier work implemented graph behavior by
> imperatively mutating statuses inside `makeNodeActive` / `markNodeFailed` with
> a growing pile of special cases (ancestor deps, downstream-of-ancestors,
> parallel cancellation, break re-homing, container coloring…). That approach
> kept introducing regressions because it patches *projections* of a model that
> was never encoded. This document encodes that model. It is the **acceptance
> spec** for Milestone 3 of `GRAPH_ARCHITECTURE_PLAN.md` (deterministic
> recompute + per-node-type behavior). Build to THIS, with the worked cases as
> tests. Do not re-derive behavior by tweaking call sites.

## The two node categories (the core distinction)

1. **Work node (leaf).** An actionable step with **no children**. It carries an
   explicit, user-settable status: `Planned`, `Active`, `Completed`, `Failed`,
   `Invalidated` (later: `Awaiting`, `Cancelled`). The user acts on these.

2. **Group node (container).** A node **with children**. It represents the
   aggregate of a gated sub-graph (e.g. `stage`, `repo`, `rollout`, `dev`,
   `iteration`, the feature root `A`). **Its state is DERIVED from its children,
   never set directly** (Case 2). Groups are not directly actionable for
   Active/Completed.

> This split is the abstraction we were missing. Container state must be a pure
> function of descendants, computed bottom-up — not imperatively written.

## Two derived layers (everything below is a projection, not stored truth)

The **only source of truth is the set of work-node (leaf) statuses** plus the
graph structure (containment + `depends_on` gating). Everything else is derived:

### Layer A — Group state (fold over children, bottom-up)

For a group node, derive its state from its children's states:

| Children condition | Group state |
|--------------------|-------------|
| all children `Completed` | `Completed` (green) |
| any child `Active` or `In Progress`, or any child `Failed` | `In Progress` (purple) |
| all children `Cancelled` (or pruned) | `Cancelled` (orange/dim) |
| all children `Invalidated` | `Invalidated` (gray/dim) |
| group's own dependencies not yet satisfied / all children `Planned` | `Planned` |

`In Progress` is a **new derived state** for "this group contains the active
frontier / live work" — distinct from `Active` (the single work-node frontier)
and from `Completed`. **Color: purple** (`--color-purple` / `#a371f7`, fallback
with a faint tint + border, NOT a glow — it should read as "spans active work"
and stay visually subordinate to the blue `Active` frontier leaf). Modeled like
`Cancelled`/`Awaiting`: a status keyword + node-state + CSS.

> Precedence for mixed children (decreasing): `In Progress` > `Completed` >
> `Cancelled`/`Invalidated` > `Planned`. (Refine with the user if needed.)

### Layer B — Link color (projection of endpoint states)

Links are colored by the states of the nodes they connect; never set directly.

- **Containment return link** (terminal child → parent group): **green** iff the
  parent group is `Completed`; **muted green** while the group is in progress /
  not complete. (Case 1: `review → dev` green; `verify → stage` muted green;
  `broad → repo` muted green.)
- **Break link** (failed work node → its parent group): exists/red **only when
  the source work node is `Failed`** and on the active failure path; it
  *replaces* that group's canonical return link while active (re-homing), and
  **escalates red up the containment chain**. When the failure is cleared, the
  break link disappears and the canonical return link is restored.

## The unifying primitive: execution order ("before" / "after")

Every other rule reduces to a node's position in **execution order**, computed
once as a partial order over: `depends_on` gating **threaded through
containment** (a group occupies the span of its children: a node inside a group
runs after the group's predecessors and before the group's successors). This is
the single concept that the piecemeal "ancestor dependencies" /
"downstream-of-ancestors" patches were approximating. Compute it once; derive
everything from it.

## Operations on a WORK node (the only user actions)

Given the execution-order partition relative to the acted-on work node `X`:

### Set Active(X)
- `X` → `Active`.
- **Everything before `X`** (execution order) → `Completed`.
- **Everything after `X`** → `Planned`.
- All group nodes **re-derive** (Layer A): groups containing `X` → `In Progress`;
  groups entirely before → `Completed`; groups entirely after → `Planned`.
- Links re-derive (Layer B).

### Set Failed(X)
- `X` → `Failed`; a **red break link** is drawn `X → parent group` and escalates
  red up the containment chain.
- **Everything before `X`** → `Completed` (it ran).
- **Everything after `X`** → `Invalidated` (unreachable: the rest of its ring AND
  all subsequent rings).
- Groups + links re-derive.
- **No iteration is spawned here.** Whether a retry/next iteration is warranted
  is a *policy* decision owned by the agent (or a human), NOT the deterministic
  failure mechanics. See "Iteration creation" below.

### Set Completed(X)
- `X` → `Completed`; everything before `X` → `Completed`. Groups/links re-derive.

## Operation on a GROUP node: Prune (Cancel sub-graph)

Groups are not actionable for Active/Completed/Failed (Case 2). The one allowed
group-level action is **Prune** (UI label; status value `Cancelled`), for
deliberately stopping a whole sub-graph for an external reason:
- Every leaf in the group's sub-graph → `Cancelled`; the group then *derives*
  `Cancelled` (we never set a group status directly).
- Everything **after** the group in execution order → `Invalidated` (it can no
  longer run).
- It is **not** a failure: no red break-link escalation, no retry.
- **Reuse the `Cancelled` status** (no new `Pruned` status). Record the reason
  in the event log (`kind: cancelled, reason: "pruned-manual"`) so history/replay
  distinguishes a manual prune from automatic parallel-branch cancellation.
  This resolves the Case 2 vs Case 5 contradiction.

## Iteration creation (policy, not mechanics)

Creating the next iteration is a **deliberate decision**, never an automatic
side-effect of failure:
- **Human:** a "Start next iteration" action.
- **Agent:** an MCP tool (e.g. `create_iteration` or `create_node` +
  `restarts_to`) the harness calls when *its* policy decides a retry is
  warranted (`GRAPH_AGENT_MCP_PLAN.md`).
- The deterministic engine only provides the *mechanism*; it does not decide.
  (This is why Case 3 shows Iteration 2 and Case 4 omits it — iteration creation
  is no longer coupled to the failure op.)

## Worked acceptance cases (verbatim from the user — these are the tests)

Base graph:

```
A
  iteration 1
    dev → design, implementation, review
    rollout → repo → stage → (await build rollout, enable feature flag,
                              await feature flag rollout, verify),
                       canary, pilot, broad
```

**Case 1 — Set `enable feature flag` Active**
```
dev (Completed): design/implementation/review (Completed); review →green→ dev
rollout (In Progress)
  repo (In Progress)
    stage (In Progress)
      await build rollout (Completed)
      enable feature flag (Active)
      await feature flag rollout (Planned)
      verify (Planned)            verify →muted-green→ stage
    canary (Planned), pilot (Planned), broad (Planned)   broad →muted-green→ repo
```

**Case 2 — Set `stage` Failed → NOT POSSIBLE.** `stage` is a group node (not
actionable); it is the aggregate of its gated children.

**Case 3 — Set `await build rollout` Failed**
```
dev (Completed) + children Completed
rollout / repo / stage (In Progress)
  await build rollout (Failed)            await build rollout →red→ stage
  enable / await flag / verify (Invalidated)   (verify muted-green→stage REMOVED)
  canary / pilot / broad (Invalidated)         (broad muted-green→repo REMOVED)
```
(Iteration 2 is created only as a separate, deliberate retry — not by the
failure op itself; see "Iteration creation".)

**Case 4 — Set `await feature flag rollout` Failed**
```
await build rollout (Completed), enable feature flag (Completed)
await feature flag rollout (Failed)     →red→ stage
verify (Invalidated)                    (verify muted-green→stage REMOVED)
canary / pilot / broad (Invalidated)    (broad muted-green→repo REMOVED)
rollout / repo / stage (In Progress)
```

**Case 5 — Prune `stage`** (the group-level "Cancel sub-graph" action; this is
the resolution of the former Case 2/5 contradiction — the sub-graph is
`Cancelled`, not Failed)
```
stage (Cancelled, derived)
  await build rollout / enable / await flag / verify (all Cancelled)
canary / pilot / broad (Invalidated — sequenced after the pruned group)
verify →gray→ stage ; broad muted-green→repo REMOVED
```

## Resolved decisions (confirmed with the user 2026-06-11)

1. **Case 2 vs Case 5 — RESOLVED.** Groups are non-actionable for work-ops
   (Active/Completed/Failed). A separate **Prune** group action (status
   `Cancelled`, reason `pruned-manual` in the event log) deliberately stops a
   sub-graph: leaves → `Cancelled` (group derives), work after the group →
   `Invalidated`, no failure escalation, no retry.
2. **`In Progress` group color — RESOLVED: purple** (`--color-purple` /
   `#a371f7`), faint tint + border, subordinate to the blue `Active` leaf.
3. **Iteration spawn — RESOLVED: not in the engine.** Failure does NOT auto-spawn
   an iteration. Iteration creation is a deliberate human action or an
   agent/MCP policy decision (`GRAPH_AGENT_MCP_PLAN.md`).

## Remaining open question

- **Group-state fold precedence** for mixed children is set to
  `In Progress > Completed > Cancelled/Invalidated > Planned`; confirm this is
  right for edge cases (e.g. a group with some Completed + some Invalidated
  children and nothing active).

## Alignment with the milestones

- This **is Milestone 3** of `GRAPH_ARCHITECTURE_PLAN.md` ("deterministic
  scheduler + per-node-type handlers"), now with a concrete behavior contract.
  The right implementation is a **pure recompute**: on any leaf-status change,
  recompute Layer A (group states) and Layer B (link colors) from the leaf
  statuses + structure, and implement the three work-node operations via the
  execution-order partition — instead of incremental status mutation.
- It needs one small **state addition** first (like `Cancelled`/`Awaiting`): the
  derived **`In Progress`** group state (status keyword + node-state + CSS).
- The circling we hit is precisely the "maintainability tipping point" the plan
  predicted; the cure is to encode this model, not to keep patching
  `makeNodeActive`/`markNodeFailed`.
- The worked cases above become the **regression oracle** for the Milestone 3
  "behavior-preserving / behavior-correcting" refactor (and supersede the
  ad-hoc per-bug fixes in `GRAPH_VIEW_RULES.md` where they differ).
```
