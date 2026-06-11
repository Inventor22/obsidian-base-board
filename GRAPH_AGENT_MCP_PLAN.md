# Graph Agent MCP Bridge Plan

Trigger phrase for a future Copilot chat: **Implement the graph agent MCP bridge**.

> **Status:** Design only. Nothing here is built yet. This is the bridge spec
> that lets any MCP-capable harness (Claude Code, VS Code / Copilot agent mode,
> or a custom supervisor) drive the Base Board graph through one guarded API, so
> the choice of harness/model stays a swappable detail.

## Purpose

Make the Obsidian vault the **contract** between the deterministic graph engine
and an external agent. The plugin keeps owning graph semantics (frontier,
escalation, cancellation, undo); the agent is an external actor that **reads
broadly and writes narrowly** through the same transitions a human menu click
would invoke. Every agent action becomes an **event** in an append-only log
(audit + replay).

See also: `GRAPH_VIEW_RULES.md` (current behavior), and the architecture
discussion that produced this plan (event sourcing + per-node-type handlers +
graduated per-skill autonomy gated by a `verify()` acceptance test).

> **Prerequisite:** this agent bridge assumes the substrate specced in
> `GRAPH_ARCHITECTURE_PLAN.md` (event log as source of truth + deterministic
> scheduler with per-node-type handlers). Build that first; the milestones here
> are sections 8–10 of that document's incremental build strategy.

## Architecture boundary

```
Obsidian plugin (graph + event log + frontier)   ← world model + UI + transition API
        │  vault = plain markdown (the contract)
        ▼
MCP server over the vault   ← THIS DOCUMENT: read tools + guarded write tools
        ▲
        │  same tools for every client (trust boundary lives HERE)
        │
Microsoft Spark   ← single harness: inference + automations + tool execution
(frontier loop, reasoning, verify(), git/ADO under corp auth)
```

**Single-harness model (Microsoft Spark).** Spark is an internal OpenClaw-style
harness that provides *both* the inference (brain) and the automation/tool
runtime (hands), inside the Microsoft trust/auth boundary. This collapses the
earlier two-usage-model split (external API key for the loop + a Copilot agent
surface for code/PR work) into one:

- One inference path and one automation runtime — no API-key-vs-Copilot fork.
- Corp auth, internal git, and Azure DevOps PR APIs come from Spark natively,
  which removes the hardest plumbing in the code-writing skills.
- Spark's automations can host the frontier-advancing loop, so a separate
  custom supervisor process may not be needed.

**What stays the same and must NOT move into Spark:** the MCP server remains the
**trust boundary**. The autonomy ladder, the `verify()`-gated self-completion,
the episode cap, and the kill switch live in the *server*, not in Spark's
automation/chat config — so the invariants hold regardless of harness and don't
evaporate if the harness changes. Spark is just a (privileged) client of the
same guarded tool surface every other client would use.

**Protocol note:** if Spark speaks MCP, it targets these tools directly. If it
has a native tool/function-calling format instead, expose the identical surface
in that format — the design is unchanged; only the adapter differs.

Hard rules baked into the tool surface:

- **Read-broad, write-narrow.** Reading nodes/PRs/history is unrestricted.
  Writing is limited to a small set of guarded, validated operations.
- **No direct frontmatter writes.** The agent never edits `status` etc.
  directly; it calls `request_transition`, which runs the same engine logic
  (escalation, parallel cancellation, frontier advance) and records an event.
- **Human gate is the default; lifted per-skill by earned trust.** Only a node
  whose `agent.autonomy` is `autopilot` AND whose skill `verify()` passes may be
  self-completed by the agent.
- **Every write emits an event** with `causedBy: "agent"`, the `skill`, and
  evidence, so replay distinguishes human vs. agent transitions.

## Shared data shapes

```ts
// Append-only transition log entry (event sourcing). Stored per-node in
// frontmatter `state_history` and/or a vault-level event log file.
interface GraphEvent {
  id: string;                 // ulid/uuid, monotonic by `at`
  nodeId: string;             // stable node id (frontmatter `id`)
  kind:                       // what happened
    | "activated" | "completed" | "failed" | "invalidated"
    | "cancelled" | "awaiting" | "planned" | "created" | "linked";
  from: string | null;        // prior status
  to: string | null;          // new status
  at: string;                 // ISO-8601 timestamp
  causedBy: "human" | "agent";
  skill?: string;             // agent skill that produced it
  verifyResult?: boolean;     // result of the skill's acceptance test
  evidence?: string;          // PR url, kusto result, note, etc.
}

// Declared per node (frontmatter `agent:` block). Capability contract.
interface NodeAgentCapability {
  actionable: boolean;        // opt-in; agent ignores nodes without this
  skill?: string;             // which playbook applies
  autonomy: "propose" | "execute" | "autopilot";
  inputs?: Record<string, unknown>;  // known inputs ("?" = agent must infer)
}

// What `get_node_context` returns — everything a skill needs to reason.
interface NodeContext {
  node: GraphNodeSummary;             // id, title, status, type, agent block
  ancestors: GraphNodeSummary[];      // parent chain to root
  children: GraphNodeSummary[];
  dependsOn: GraphNodeSummary[];      // gating predecessors
  successors: GraphNodeSummary[];     // gated successors
  breakTargets: GraphNodeSummary[];
  links: { prs: string[]; urls: string[] };  // extracted from note body/frontmatter
  history: GraphEvent[];              // this node's transition log
  noteBody: string;                   // markdown after frontmatter
}
```

## Tool surface

### Read tools (unrestricted)

| Tool | Input | Returns | Reads |
|------|-------|---------|-------|
| `get_active_frontier()` | — | `GraphNodeSummary[]` | computed frontier (same logic as kanban `active-frontier`) |
| `list_nodes(filter?)` | `{ status?, type?, feature?, actionable? }` | `GraphNodeSummary[]` | vault frontmatter |
| `get_node(id)` | `{ id }` | `GraphNodeSummary` | one note |
| `get_node_context(id)` | `{ id }` | `NodeContext` | node + neighbors + history + body + links |
| `get_node_history(id)` | `{ id }` | `GraphEvent[]` | per-node `state_history` |
| `get_graph_events(since?)` | `{ since?: ISO }` | `GraphEvent[]` | vault-level event log (for replay/trust metrics) |
| `search_nodes(query)` | `{ query }` | `GraphNodeSummary[]` | full-text over notes (e.g. find a flag/setting name) |

`get_node_context` is the workhorse: it is how a skill "traverses up the graph
to find the setting name" or "finds the PR link" without ad-hoc file reads.

### Write tools (guarded, validated, event-emitting)

| Tool | Input | Effect / guard |
|------|-------|----------------|
| `claim_task(id)` | `{ id, skill }` | Marks node claimed by the agent for `skill`. Rejects if node not `agent.actionable` or already claimed. Prevents double-work. |
| `request_transition(id, to, cause, evidence?)` | `{ id, to, evidence? }` | The ONLY status mutator. Runs engine logic (escalation, cancellation, frontier advance). Emits a `GraphEvent(causedBy:"agent")`. Validates `to` is a legal transition for the node. |
| `set_awaiting(id, reason)` | `{ id, reason }` | Convenience for `request_transition(id,"Awaiting")` + notify. The agent/human handoff. |
| `complete_with_verify(id, verifyResult, evidence)` | `{ id, verifyResult, evidence }` | **Autopilot-only self-completion.** Guard: node `autonomy === "autopilot"` AND `verifyResult === true`. On pass → `Completed`, engine advances frontier, returns the new frontier so the loop can continue. Else → stays `Awaiting`, no completion. |
| `report_failure(id, reason)` | `{ id, reason }` | `request_transition(id,"Failed")`; triggers the existing escalation + parallel-cancellation. |
| `create_node(spec)` | `{ title, type, parent?, dependsOn?, agent? }` | Narrow create (e.g. spawn a downstream "Disable" node, or an "Impact" node). Validated against allowed types. Emits `created` event. |
| `create_link(from, to, kind)` | `{ from, to, kind }` | Guarded link create (subprocess/gating/break/restart) via existing reference writers. Emits `linked` event. |
| `notify_user(message, level?)` | `{ message, level? }` | Surfaces a notice/notification (PR ready for review, etc.). No graph mutation. |

### Explicitly NOT exposed

- No raw `write_file` / frontmatter editor.
- No `merge_pr`, no push to `main` — code execution surfaces (Copilot agent /
  custom skill) handle git, scoped to branch + PR only.
- No `delete_node` for the agent in v1 (human-only).

## Guardrails enforced by the server

1. **Autonomy ladder.** `propose` → may only read + `notify_user` + `create_node`
   in a draft/proposal sense; never transitions. `execute` → may transition up
   to `Awaiting`. `autopilot` → may `complete_with_verify`.
2. **`verify()` is the completion key.** A skill self-completes only when its
   own deterministic acceptance test passes; otherwise it parks at `Awaiting`.
   Verifiable nodes (kusto rollout %, build-green, flag-propagated) are autopilot
   candidates; judgment nodes (writing a PR) stay at `execute`.
3. **Episode cap + kill switch.** Server enforces max N autopilot advances per
   run and honors a global "pause automation" flag in vault/plugin config.
4. **Per-skill promotion.** `autopilot` is granted to one skill at a time, after
   the event log shows its `verify()` consistently matched human approvals.
5. **All writes are events.** Undo/redo and timeline replay both consume the
   same log; an agent run is as recoverable as a human action.

## Build sequence (lowest risk → highest value)

1. **Event log first** — append-only `GraphEvent` per transition (extend the
   existing `state_history`/`status_history` pattern). Source of truth; unlocks
   timestamps, history, replay, and the agent trust record.
2. **`Awaiting` state + `agent:` capability block** — status + node-state + CSS
   (mirror the `Cancelled` work), plus the `autonomy` field and the per-skill
   `verify()` contract concept. Lifecycle becomes manually dry-runnable.
3. **MCP server (read tools only)** — expose the read surface; point Spark at it
   in read-only "advisor" mode to validate context-gathering quality at zero
   risk.
4. **Add guarded write tools at `execute`** — `claim_task`, `request_transition`,
   `set_awaiting`, `report_failure`, `notify_user`. One Spark skill/automation
   end-to-end, parks at `Awaiting` for human sign-off.
5. **Enable `complete_with_verify` (autopilot)** — promote one proven skill once
   the event log shows its `verify()` matched approvals; it self-completes and
   the Spark frontier loop chains to the next node.

## Open questions to resolve before building

- Where does the vault-level event log live? (single `*.md`/JSON log file vs.
  only per-node `state_history`, with a derived aggregate.)
- Stable node identity for events: rely on frontmatter `id` (already present on
  most nodes) — backfill where missing.
- Transport: confirm Spark speaks MCP (stdio/local server). If Spark uses a
  native tool/function-calling format, expose the same surface in that format —
  design unchanged, only the adapter differs.
- Does the frontier loop live in a Spark automation, or in the MCP server? Lean
  toward Spark hosting the loop, but keep the autonomy/verify/episode-cap guards
  in the server regardless.
- How `verify()` is declared per skill (Spark skill code keyed by `agent.skill`,
  not in the vault) and how its result is attested in the event.
