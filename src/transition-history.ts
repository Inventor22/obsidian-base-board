// Single canonical shape for a status-transition event, shared by every writer
// (graph, kanban drag-drop) so the `status_history` log has one common
// framework — no per-view variant shapes. Readers (timeline, card detail,
// graph history) consume this shape; older records are migrated to it.

export interface TransitionEvent {
  id: string;
  node: string | null;
  kind: string;
  from: string | null;
  to: string | null;
  at: string;
  property: string;
  causedBy: "human" | "agent";
  source: string;
  reason?: string;
}

/** Maps a target status to the canonical event `kind`. */
export function getTransitionEventKind(to: string | null): string {
  const status = (to ?? "").trim().toLowerCase();
  if (status === "in progress" || status === "doing" || status === "active") {
    return "activated";
  }
  if (status === "completed" || status === "done") return "completed";
  if (status === "interrupted" || status === "failed") return "failed";
  if (status === "invalidated" || status === "skipped") return "invalidated";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "awaiting") return "awaiting";
  if (status === "planned") return "planned";
  return "transition";
}

/** Generates a monotonic-ish unique event id. */
export function generateTransitionEventId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `evt-${time}-${rand}`;
}

/** Builds a canonical transition event from a transition's particulars. */
export function buildTransitionEvent(params: {
  node: string | null;
  from: string | null;
  to: string | null;
  property: string;
  source: string;
  causedBy?: "human" | "agent";
  reason?: string;
}): TransitionEvent {
  const event: TransitionEvent = {
    id: generateTransitionEventId(),
    node: params.node,
    kind: getTransitionEventKind(params.to),
    from: params.from,
    to: params.to,
    at: new Date().toISOString(),
    property: params.property,
    causedBy: params.causedBy ?? "human",
    source: params.source,
  };
  if (params.reason) event.reason = params.reason;
  return event;
}
