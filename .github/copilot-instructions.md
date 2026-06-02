# Copilot Project Instructions

This repository is an Obsidian plugin named Base Board. It adds Kanban and Timeline views for Obsidian Bases.

## Project Context

- Source TypeScript lives in `src/`.
- The bundled plugin entrypoint is generated as `main.js` from `src/main.ts` via esbuild.
- The Obsidian plugin files deployed to a vault are `main.js`, `manifest.json`, and `styles.css`.
- Use the existing deploy helper: `npm run deploy -- "<path-to-obsidian-vault>"`.
- Do not hard-code personal vault paths. Check Obsidian's local vault registry or ask if the vault path is unclear.

## Development Commands

- Install dependencies with `npm install` when needed.
- Build with `npm run build`.
- Deploy with `npm run deploy -- "<path-to-obsidian-vault>"` after identifying the local vault path.
- `npm run lint` may report repo-wide CRLF/Prettier noise in untouched files on Windows. For focused timeline work, verify the edited file with `npx eslint "src/timeline-view.ts"` plus `npm run build`.

## Working Guidelines

- Preserve user edits and synced changes. If the workspace reports that a file changed externally, reread it before editing.
- Keep changes focused. Avoid broad formatting or line-ending churn unless the user asks for repository-wide cleanup.
- Generated `main.js` changes come from builds; source changes should usually be made in `src/`.
- After each Copilot implementation turn that changes behavior, bump the relevant version/build marker so the loaded deployed build is identifiable. For timeline-only work, bump `TIMELINE_BUILD_VERSION` in `src/timeline-view.ts`; only bump package/manifest versions when release/versioning work is intended.
- After deploying plugin changes, tell the user to reload or toggle the Base Board plugin in Obsidian.

## Timeline Ruler Context

- The timeline ruler plan is tracked in `TIMELINE_RULER_PLAN.md`.
- Current ruler work is centered in `src/timeline-view.ts` and related CSS in `styles.css`.
- The intended ruler architecture uses the wheel zoom stops as the source of truth.
- Toolbar zoom buttons are shortcuts into the same stop table: Day -> `1d`, Week -> `1w`, Month -> `1mo`, Year -> `1y`.
- Each zoom stop should have an explicit ruler policy.
- Grid lines and labels are separate concepts: labels must not introduce extra off-cadence vertical lines.
- Keep one visible grid cadence per zoom stop.
- Label text should simplify progressively before disappearing.
- Validate timeline changes with at least `1w`, `1mo`, `3mo`, `6mo`, `1y`, and `5y` after deploy.