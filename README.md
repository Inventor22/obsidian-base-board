<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-dark.svg">
    <img alt="Base Board Logo" src="https://raw.githubusercontent.com/mderazon/obsidian-base-board/HEAD/logo-light.svg">
  </picture>
</p>

# Base Board

**Base Board** is an interactive, property-driven Kanban board view for [Obsidian Bases](https://obsidian.md). It allows you to organize your notes into visual columns based on any property in your frontmatter, providing a seamless drag-and-drop experience for managing tasks and structured data.

![Base Board demo](demo.gif)

## Key Features

- **Property-Based Columns**: Instantly generate columns from any frontmatter property.
- **Intuitive Drag & Drop**: Move cards between columns to update their properties automatically, and reorder cards within a column.
- **Inline Power**: Rename cards or column titles directly on the board.
- **Native Editing Modal**: Open any card into a fully-functional Obsidian editor floating directly over your workspace.
- **Rich Cards**: View key metadata fields as chips on each card for a quick overview.
- **Configurable Card Title**: Set `cardTitleProperty: note.title` in your `.base` file to use a frontmatter property (e.g. `title`) as the card heading instead of the filename.
- **Tags**: Color-coded tag chips on cards with a clickable filter bar to narrow the board by tag.
- **Hover Preview**: Native note previews on hover (uses the **Page preview** core plugin).
- **One-Click Creation**: Add new notes directly to a specific column without leaving the board view.
- **Transition History**: Optionally append timestamped frontmatter entries when cards move between columns.
- **Data First**: All changes are written directly to your Markdown files.

## Usage

Open the **Command palette** (`Ctrl/Cmd + P`) and run **"Base Board: Create new board"**. Enter a name, choose a folder, and the plugin will scaffold everything for you — a `.base` file, a tasks folder, and sample task notes. The board opens automatically.

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

## Installation

### From Obsidian Community Plugins

Search for **Base Board** in the Obsidian Community Plugins browser and click **Install**.

### Using BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Go to **Settings → BRAT → Add Beta Plugin**.
3. Enter `mderazon/obsidian-base-board` and click **Add Plugin**.

## Development

1. Clone this repo.
2. Run `npm install`.
3. Run `npm run dev` to start the build process in watch mode.

## License

This plugin is licensed under the [MIT License](LICENSE).
