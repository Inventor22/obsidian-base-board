# Maintaining Dustin's Work Graph

This is an editable agent playbook, not a workflow engine. Use
[GRAPH_SEMANTICS_SPEC.md](GRAPH_SEMANTICS_SPEC.md) for data meanings and
[GRAPH_AGENT_MCP_PLAN.md](GRAPH_AGENT_MCP_PLAN.md) for local commands.

## Interpret an Update

1. Read the active Base configuration, named notes, recent history, and relevant
   evidence. Use stable IDs/full paths; distinguish duplicate titles.
2. Separate observed activity from planned work, suggestions, unresolved issues,
   and decisions. Preserve the user's exact uncertainty.
3. Name only the records and fields supported by the update. Starting one item
   does not prove predecessors completed; failure does not prove successors are
   cancelled. Containers can have independent assertions.
4. Keep detailed domain reasoning in Markdown. Add queryable fields only when
   a view needs them. Never invent an approval or historical timestamp.
5. Query fresh revisions, propose a small explicit batch with attribution,
   reason and evidence, inspect its before/after preview, then apply within the
   user's graph-maintenance authorization. Requery and verify the result.

## Partial Progress and Decisions

For "Stage is mostly deployed and sufficiently baked, but west is broken;
promote Canary": keep Stage incomplete, retain/create the residual issue only
when the update authorizes it, and record the promotion rationale/evidence on
Canary or in a linked note. An action-specific assessment may be satisfied or
waived only when that assessment was actually stated. Set Canary In Progress
without changing other statuses. Do not insert a mandatory approval node.

Retries and parallel activities can coexist. Record a new attempt in Markdown,
an explicit retry note, or appropriate custom metadata; do not reset an entire
branch or rewrite older outcomes to make a neat progression.

## Suggested Next

Suggestions are persisted `suggested_next` entries with scope, rank, reason,
author, timestamp, and evidence. Explain why the item is useful next. They do
not exclude concurrent work or expire automatically. Remove/reorder entries
explicitly, using a reviewed batch when more than one note is affected.
Never promote an old daily-priority bucket or a dependency graph into fresh
recommendations without contextual review.

Recovery links can motivate suggestions. Do not mark recovery active, hide it,
or declare it complete merely because another task failed or recovered.

## Conflicts and Corrections

On a revision conflict, reread the note and revise the proposal; do not force
the old content over a new edit. Undo uses a field-level inverse and appends
reversal history. Preserve failures and partial receipts. For uncertain legacy
dependencies/container statuses, retain the migration's source values and flag
the issue until Dustin or new evidence resolves it.

Before migration, produce an inventory and verified backups of notes, Bases,
and plugin data. Use the native app path for an open vault. Do not use browser
tests to mutate real notes. Do not infer history from file timestamps.

## Production Is Separate

A graph update, recommendation, status, or assessment is not permission to
deploy, change flags, push code, or merge a PR. Apply the production system's
normal authorization and safeguards separately. No hosted model, scheduler,
or new MCP service is needed to maintain this graph from VS Code.