<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-dark.svg">
    <img alt="Base Board Logo" src="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-light.svg">
  </picture>
</p>

# Base Board

**Base Board** is Dustin's personal, agent-maintained work graph for [Obsidian Bases](https://obsidian.md), with Graph, Kanban, Timeline, and Rollout views over Markdown notes. It records what happened, what is happening, and what may happen next. It is not a workflow execution engine.

This development fork integrates upstream `2.5.1` and adds Timeline, Rollout,
Graph, and reviewed local agent commands. The community release described under
Installation does not include these fork-specific extensions. The current
implementation and remaining roadmap are tracked in [GRAPH_ARCHITECTURE_PLAN.md](GRAPH_ARCHITECTURE_PLAN.md).

![Base Board demo](demo.gif)

## Key Features

- **Property-Based Columns**: Instantly generate columns from any frontmatter property.
- **Intuitive Drag & Drop**: Move cards between columns to update their properties automatically, and reorder cards within a column.
- **Inline Power**: Rename cards or column titles directly on the board.
- **Native Editing Modal**: Open any card into a fully-functional Obsidian editor floating directly over your workspace.
- **Rich Cards**: View key metadata fields as chips on each card for a quick overview.
- **Task Hierarchy**: Cards with a `parent` property show their parent breadcrumb, and parent cards show a collapsible recursive outline of visible descendants.
- **Card Detail Outline**: The floating card modal shows the selected task's descendant outline above the embedded note content when child tasks exist.
- **Project Colors**: Root tasks can set `project_color` to give their hierarchy an inherited card tint that gets lighter for descendants.
- **Configurable Card Title**: Set `cardTitleProperty: note.title` in your `.base` file to use a frontmatter property (e.g. `title`) as the card heading instead of the filename.
- **Tags**: Color-coded tag chips on cards with a clickable filter bar to narrow the board by tag.
- **Hover Preview**: Native note previews on hover (uses the **Page preview** core plugin).
- **One-Click Creation**: Add new notes directly to a specific column without leaving the board view.
- **Transition History**: Optionally append timestamped frontmatter entries when cards move between columns.
- **Timeline View**: Distinguish planned dates from recorded history in configurable swimlanes.
- **Graph View**: Explore containment, sequence, specific dependencies, associations, scopes, and recovery relationships.
- **Local Status Edits**: Change only the named item, including containers. Counts and possible blockers remain separate.
- **Suggested Next**: Persist ordered, scoped recommendations with reasons and provenance, without excluding other work.
- **Reviewed Batches**: Preview multi-item edits, check revisions, record attribution, and undo without overwriting unrelated changes.
- **Rollout View**: Track rollout rings independently from task status and Kanban order.
- **WIP Limits**: Set per-column work-in-progress limits via the column header context menu. Columns that exceed their limit are highlighted in red.
- **Collapsible Columns**: Collapse any column to save space; the state is remembered per board.
- **Card Cover Images**: Display cover images at the top of cards by specifying an image frontmatter property (e.g., `cover: "[[image.png]]"` or a web URL). Defaults to the `cover` property.
- **Data First**: All changes are written directly to your Markdown files.

## Usage

Open the **Command palette** (`Ctrl/Cmd + P`) and run **"Base Board: Create new board"**. Enter a name, choose a folder, and the plugin will scaffold everything for you — a `.base` file, a tasks folder, and sample task notes. The board opens automatically.

### Card Navigation & Selection

By default, clicking a card opens it in Base Board's floating card modal. Modifier keys still respect native Obsidian conventions:

- **Click:** Open the card in a floating modal.
- **Ctrl/Cmd + Click:** Open the note in a new tab.
- **Ctrl/Cmd + Alt + Click** (or **Cmd + Option + Click** on macOS): Open the note to the side in a split pane.
- **Alt / Option + Click:** Toggle selection of a card (for bulk actions or dragging).
- **Shift + Click:** Select a range of cards.

You can customize the default click behavior (e.g. to always open in a floating modal, split pane, or new tab) via the board toolbar under the view options menu.

### Transition History

Base Board can append a structured history entry when a card moves between columns. The live column value is still stored in your configured group-by property, while the movement journal is stored in `status_history` by default.

For example, moving a card from `In Progress` to `In Review` on a board grouped by `status` appends:

```yaml
status_history:
  - id: evt-example
    node: task-example
    kind: transition
    from: In Progress
    to: In Review
    at: 2026-05-29T20:12:49.000Z
    property: status
    source: baseboard-command
    causedBy: human
    by: Dustin
    batchId: ui-example
    reason: Record the reported review state.
    evidence: []
```

Moves into or out of the no-value column are recorded as `null`. Reordering cards inside the same column does not add a history entry.

### Column Colors

Base Board assigns visually distinct default colors to common Kanban columns such as `To Do`, `In Progress`, `In Review`, `Flighting`, and `Completed`. Right-click a Kanban column header and choose **Change color** to customize it. Timeline phase segments use the same column colors.

### Timeline View

Base Board also provides a `Timeline` Bases view for visualizing lifecycle history. Each task appears as a horizontal swimlane, and each lane is colored by the task phase recorded in `status_history`. Day, Week, Month, and Year buttons are shortcuts into 22 zoom stops, with the same tag filter pattern used by the Kanban view. Hold `Ctrl` or `Cmd` while scrolling over the timeline to step through the zoom stops.

The timeline uses the configured group-by property, normally `status`. Tasks without recorded transitions remain visible but have no invented past span. File creation and modification times are not activity evidence. Open tails are labeled as last-recorded state with unverified continuity, not actual duration.

`planned_start` and `planned_end` draw separate dashed planned bars. Set the Timeline view option `timelineSwimlaneProperty` to `owner`, `project`, `rollup_to`, `rollout_ring`, or another property; the default `parent` retains hierarchical lanes. Container lanes use their own recorded events, not their children's inferred duration.

Drag timeline lanes vertically to save a custom timeline order. This writes `timeline_order` to the affected task notes and does not change their Kanban column order.

Parent task pools are inferred from `parent` on child tasks:

```yaml
parent: [[Parent Task]]
```

If a task has children, the Timeline renders it as a parent lane and recursively indents descendants beneath it. Parent completion remains manual; the timeline only visualizes the recorded task movement history.

Use a parent property for feature/subtask relationships instead of a tag. Tags are best for filtering and cross-cutting labels; `parent` is better for hierarchy because it points to one owning feature task. Child relationships are inferred from `parent`, so separate child tags are not needed.

### Suggested Next

Use **All cards / Suggested Next** to switch between the editable board and
persisted recommendations. Each note's `suggested_next` entries carry scope,
rank, reason, author, timestamp, and evidence. Cards keep exact recorded status
columns. Recommendations persist until explicitly changed; they are not a
computed frontier, a daily priority reset, or permission to execute the work.

The Graph node menu can add suggestions; Graph and Kanban read the same entries.
All Cards and the full graph remain accessible. Recovery tasks remain visible
without being automatically activated by another task's failure.

### Graph View

Graph opens inside a scope, with its ancestry shown as breadcrumbs rather than
large cards. Workstreams are packed into readable columns. Click a container or
its chevron to expand it locally; use the focus icon to enter that branch and
the breadcrumbs to go back. The home icon shows All work. Loose items are kept
in a visual **Unassigned** group, reachable through the inbox icon without
changing note ownership.

Collapsed workstreams show summaries, expanded processes become compact headings,
and tasks remain small readable cards. Repeated single-child process layers fold
into clickable title trails. The note icon opens a note without expanding it.
Collapse-all and expand-all apply to the selected scope.

Collapse pulls the leaves inward before their parent nodes; expansion reveals
parents before children. Reduced-motion settings skip the animation.

Containers retain their own explicitly recorded status and separately show completed/total work items and colored activity counts:
green for completed, yellow for awaiting, red for attention, blue for running,
with recommendations and dependency assessments kept advisory. Status words live in tooltips and accessible labels rather than
repeating on each card. Hidden descendants still contribute to progress and attention.
Impact nodes are excluded from completion counts; live rollbacks are reported
separately. Only completed work fills the green progress bar: `0 / n` stays empty.
Blocked work appears as an alert count in ancestors rather than coloring the
whole portfolio red. Counts are not estimates of effort.

Overview uses an automatic hierarchy layout and remembers expansion in the view
settings, without changing notes or manual positions. **Free layout** retains
the existing editable canvas and its saved camera. Its frontmatter relationships include:

```yaml
parent: [[Stage Flighting]]
```

```yaml
depends_on:
  - [[Enable using pfgold]]
```

`parent` expresses ownership. `sequence_after` expresses normal ordering, while `depends_on` expresses a specific requirement. Neither triggers status changes or prevents recording activity. Action-specific `dependency_assessments` can be unresolved, satisfied, or waived with provenance; satisfying a requirement does not complete its source note. `associations` adds context without execution implications.

**Fold downstream sequence** hides later sequence items without reparenting them; containment collapse remains a separate action. **Unfold downstream sequence** reverses it.

In **Free layout**, click a graph node to open its card detail modal. Right-click empty graph space to create a node or insert a top-level feature template. Right-click a node to create a child node, insert relevant downstream templates, or delete the node with graph reference cleanup. Hover near a node boundary to reveal a link anchor, then drag to another node to create a subprocess, dependency/gating, break, or restart link. New graph nodes are Markdown notes with normal task frontmatter, so they immediately participate in Kanban, Timeline, and Graph views.

`rollup_to` adds scope membership; `compensates` declares possible recovery work.
Any node kind can have a recorded status. A red dashed impact path does not
assert that its ancestors failed. Layout positions and undoable Organize actions
remain in view configuration.

For example, Stage can remain In Progress with a broken-zone residual while
Canary becomes In Progress. Record the promotion rationale/evidence on the note
or as decision metadata; no approval node or automatic predecessor completion
is required. See [GRAPH_SEMANTICS_SPEC.md](GRAPH_SEMANTICS_SPEC.md).

### Physics Experiment

Select the orbit icon in Graph to try **Physics layout (experimental)**. Visible
owning and execution links act as springs; cross-branch information links do not.
Nodes repel one another, including terminal children and rollback tasks. Circles
use state colors and numeric summaries without state badges.

Routes avoid node interiors and prefer paths with fewer edge crossings. Dense
graphs can still have crossings; relationships are never removed just to hide them.

The Physics toolbar offers four layouts: **Workflow**, **Hanging** (downward),
**Growing** (upward), and **Radial** (around the root). The configured root stays
fixed, and each layout remembers its positions while the view remains open.
Scope breadcrumbs and collapse controls remain available.

Wheel or toolbar zoom can pull back to **0.01%** in any Graph presentation.
**Zoom home** restores 100% and a readable frame around the current work/root.
Shorter springs and tighter layout spacing keep connected circles closer together
without shrinking nodes or changing their relationships.

Drag a node to pull the layout; release it to let it settle. Pause freezes motion,
resume restarts it, and reset rebuilds the current scope from its initial layout.
Escape cancels a drag. Reduced-motion preference starts physics paused.
A completed drag updates the node's layout guide, so redraws do not snap it back
to its original slot. It still settles under the connected spring forces.

The experiment does not change task notes or saved manual positions. Simulated
positions are kept only while the view remains open; Overview and Free layout
remain available. Historical browsing stays static and read-only. Physics motion
does not represent work progress, and large graphs may still need panning.

### Graph History

The strip below Graph lets you scrub recorded history, step backward/forward by
day, or jump between recorded changes. The radio icon returns to present.
In Overview, activity markers and change jumps follow the selected scope, while
the underlying journal still records the full graph. Changed branches are
highlighted while existing positions and collapse choices stay stable. Historical
focus changes do not replace your live focus, and an absent historical branch
stays empty rather than showing unrelated work. Historical items open as read-only metadata snapshots, including
items no longer in today's graph.

Recording starts with the first Graph observation after installing this build.
It records graph-relevant metadata while the view is open, not document contents
or every action elsewhere in the vault. Closed intervals are marked as coverage
gaps and show last-known state; earlier history is not invented. Ordinary note
edits do not become progress events, and notes are not copied each day.

Journals are stored in plugin data, so include plugin settings in your backups.
Timelapse playback, document revision history, and focus/result tracking remain
future work. Existing transition records are preserved; undo appends a reversal
instead of erasing history. New snapshots can record decisions, assessments,
suggestions, and relationship metadata without backfilling older frames.

### Local Agent Editing and Migration

Copilot in VS Code can query, preview, apply, and undo explicit graph changes
using [the local command interface](GRAPH_AGENT_MCP_PLAN.md). No hosted agent,
scheduler, or MCP server is needed. Editable guidance is in
[AI-INSTRUCTIONS-TEMPLATE.md](AI-INSTRUCTIONS-TEMPLATE.md).

Before migrating an existing vault, run the read-only inventory. Migration
backs up notes, all Bases configurations, and plugin data; it preserves unknown
fields, IDs, Markdown, layouts, and old history. Legacy dependency meanings and
possibly stale container statuses are retained and flagged, never guessed away.
Reruns are idempotent. Use the native app path for an open vault; offline writes
require Obsidian closed. See [WORK_GRAPH_DELIVERY.md](WORK_GRAPH_DELIVERY.md).

Graph edits are not production actions. A status, assessment, or recommendation
does not authorize deployment, flag changes, or bypass other safeguards.

### Card Ordering

Base Board uses manual drag order so cards remain exactly where you place them. This order is stored in each note's `kanban_order` property and overrides the native Bases **Sort by** setting.

Reordering converts legacy numeric order to fractional string keys. Timeline
and Rollout retain their independent ordering properties. Keep a vault backup
before first using the integrated build on existing boards.

### Default Card Properties (`newItemProperties`)

You can set board-specific default frontmatter properties for new cards created from **"+ Add card"** using `newItemProperties` in your `.base` file:

```yaml
views:
  - type: kanban
    name: Frontend Board
    newItemFolder: Tasks
    newItemTemplate: Templates/task.md
    newItemProperties:
      team: frontend
      category: alpha
```

This ensures new cards automatically receive required frontmatter fields, keeping them visible on filtered boards.

New tasks retain the fork's default task metadata and page outline. Board
defaults may override that metadata; the chosen destination column and order
always take precedence over configured defaults.

## Installation

### From Obsidian Community Plugins

Search for **Base Board** in the Obsidian Community Plugins browser and click **Install**, or view the plugin directly on the [Obsidian Community Plugins directory](https://community.obsidian.md/plugins/base-board).

### Using BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Go to **Settings → BRAT → Add Beta Plugin**.
3. Enter `mderazon/obsidian-base-board` and click **Add Plugin**.

## Development

1. Clone this repo.
2. Run `npm install`.
3. Run `npm run dev` to start the build process in watch mode.

Run `npm test` for regression tests and `npm run build` for the production
bundle. Deploy this fork with `npm run deploy -- "<vault path>"`, then reload the
Base Board plugin in Obsidian.

For an isolated renderer check, run `node tests/browser-fixture.mjs`; it prints a
loopback URL and uses synthetic notes rather than a vault. Stop it with Ctrl+C.
It is a test harness, not a replacement for Obsidian acceptance testing.

On Windows, npm `10.9.2` can crash with `edgesOut` while resolving updated Vitest
peers. A one-shot newer resolver avoids changing global tooling:
`npm exec --yes --package=npm@11.6.0 -- npm install`.

## License

This plugin is licensed under the [MIT License](LICENSE).
