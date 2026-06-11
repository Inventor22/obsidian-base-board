# Graph Architecture Evolution Plan

Trigger phrase for a future Copilot chat: **Evolve the graph architecture**.

> **Status:** Design only. Nothing here is built yet. This is the *foundational
> substrate* that the agent layer (`GRAPH_AGENT_MCP_PLAN.md`) builds on. Captures
> the architecture decisions from the design conversation so they are durable and
> sequenced. Build it in independently-testable sections (see "Incremental build
> strategy").

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
| 2 | **History read + projection** — derive current status from the log; expose a per-node history view. | 1 | None (same status, new source) | Status matches pre-refactor for all RTPv4 nodes; history shows the sequence. |
| 3 | **Scheduler + handlers (no-op refactor)** — move `markNodeFailed`/`makeNodeActive`/escalation/cancellation into per-type handlers behind a deterministic scheduler. | 1 | **None — verified identical** | Re-run the full RTPv4 scenario set (fail Validate → escalate+cancel; set active → reset+restore; mark complete) and confirm byte-identical frontmatter outcomes. |
| 4 | **`Awaiting` state** — status + node-state + CSS (mirror `Cancelled`). | 3 | New state only | Set a node Awaiting; verify color/badge; frontier treats it distinctly. |
| 5 | **`agent:` capability block + autonomy field** — frontmatter schema + parsing; no agent yet. | 3 | None (data only) | Add `agent:` to a node; confirm parsed/exposed; dry-run lifecycle manually. |
| 6 | **Impact node type (inert handler)** — first non-participating type as a real test of the handler model. | 3 | New type, inert | Branch an impact node off a ring; fail the ring; confirm impact node is untouched. |
| 7 | **Replay + timeline integration** — play events over time; timeline shows node state. | 2 | New view feature | Scrub a time range; node states reflect the log at each point. |
| 8 | **MCP read server** — `GRAPH_AGENT_MCP_PLAN.md` step 3. | 1,5 | External, read-only | Point Spark at it in advisor mode; verify `get_node_context`. |
| 9 | **MCP guarded writes (`execute`)** — `GRAPH_AGENT_MCP_PLAN.md` step 4. | 3,5,8 | Agent can transition→Awaiting | One skill end-to-end, parks at Awaiting. |
| 10 | **Autopilot (`complete_with_verify`)** — `GRAPH_AGENT_MCP_PLAN.md` step 5. | 9 | Agent self-completes | Promote one verified skill; frontier chains. |

Sections 1–7 are this document's substrate; 8–10 hand off to
`GRAPH_AGENT_MCP_PLAN.md`. Milestones 1–3 are the high-value, low-risk core and
should be done first and in order.

## Cross-references

- `GRAPH_VIEW_RULES.md` — current behavior; the regression oracle for the no-op
  refactor (milestone 3). Update it as states/handlers change.
- `GRAPH_AGENT_MCP_PLAN.md` — the agent bridge that consumes this substrate
  (milestones 8–10).
