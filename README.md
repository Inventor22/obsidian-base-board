<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-dark.svg">
    <img alt="Base Board Logo" src="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-light.svg">
  </picture>
</p>

# Base Board

**Base Board** is an interactive, property-driven Kanban board view for [Obsidian Bases](https://obsidian.md). It allows you to organize your notes into visual columns based on any property in your frontmatter, providing a seamless drag-and-drop experience for managing tasks and structured data.

This development fork integrates upstream `2.5.1` and adds Timeline, Rollout,
Graph, and active-frontier workflows. The community release described under
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
- **Timeline View**: Visualize task lifecycle history as zoomable swimlanes grouped by parent task.
- **Graph View**: Explore the full work graph with requirement and gated-successor relationships.
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
  - from: In Progress
    to: In Review
    at: 2026-05-29T20:12:49.000Z
    property: status
    source: baseboard-drag-drop
```

Moves into or out of the no-value column are recorded as `null`. Reordering cards inside the same column does not add a history entry.

### Column Colors

Base Board assigns visually distinct default colors to common Kanban columns such as `To Do`, `In Progress`, `In Review`, `Flighting`, and `Completed`. Right-click a Kanban column header and choose **Change color** to customize it. Timeline phase segments use the same column colors.

### Timeline View

Base Board also provides a `Timeline` Bases view for visualizing lifecycle history. Each task appears as a horizontal swimlane, and each lane is colored by the task phase recorded in `status_history`. Day, Week, Month, and Year buttons are shortcuts into 22 zoom stops, with the same tag filter pattern used by the Kanban view. Hold `Ctrl` or `Cmd` while scrolling over the timeline to step through the zoom stops.

The timeline uses the same group-by property as the board, so a board grouped by `status` will visualize status transitions. Tasks without transition history still appear as a single segment from the note creation time to now using the current group-by value.

Drag timeline lanes vertically to save a custom timeline order. This writes `timeline_order` to the affected task notes and does not change their Kanban column order.

Parent task pools are inferred from `parent` on child tasks:

```yaml
parent: [[Parent Task]]
```

If a task has children, the Timeline renders it as a parent lane and recursively indents descendants beneath it. Parent completion remains manual; the timeline only visualizes the recorded task movement history.

Use a parent property for feature/subtask relationships instead of a tag. Tags are best for filtering and cross-cutting labels; `parent` is better for hierarchy because it points to one owning feature task. Child relationships are inferred from `parent`, so separate child tags are not needed.

### Active Frontier Kanban

Use the **All cards / Active frontier** toggle to switch between the editable
status board and a derived projection of actionable leaf work. The frontier
shows active, awaiting, blocked, or failed leaves, plus recent completion and
blocking history. Group containers and impact nodes do not become work cards.

Choose a scope to narrow the projection and pin cards into a daily priority
order for that scope. Priorities live in view configuration, not task metadata.
Compensations remain dormant until a completed effect needs rollback following
a failure in its containing scope; missing targets do not make them ordinary work.
The Graph and Kanban views use the same state derivation.

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

Containers show completed/total work items and icon-based activity counts:
a green circled check for completed, yellow clock for awaiting, red alert octagon
for attention, blue circled right arrow for running, and teal play circle for
ready work. Status words live in tooltips and accessible labels rather than
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

`parent` creates a requirement relationship below the current node. `depends_on` creates a gated successor relationship to the right: the successor waits until its dependency is completed. The graph highlights active frontier nodes, muted completed nodes, waiting nodes, and blocked nodes using the same status colors as the Kanban board.

In **Free layout**, click a graph node to open its card detail modal. Right-click empty graph space to create a node or insert a top-level feature template. Right-click a node to create a child node, insert relevant downstream templates, or delete the node with graph reference cleanup. Hover near a node boundary to reveal a link anchor, then drag to another node to create a subprocess, dependency/gating, break, or restart link. New graph nodes are Markdown notes with normal task frontmatter, so they immediately participate in Kanban, Timeline, and Graph views.

`rollup_to` adds scope membership, and `compensates` declares an out-of-band
rollback. `kind: impact` keeps an observational node visible without making it
participate in work execution. Layout positions and undoable Organize actions
are stored in the view configuration.

### Physics Experiment

Select the orbit icon in Graph to try **Physics layout (experimental)**. Visible
owning and execution links act as springs; cross-branch information links do not.
Nodes repel one another, including terminal children and rollback tasks. Circles
use state colors and numeric summaries without state badges.

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
future work. The existing Timeline and `status_history` are unchanged.

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
