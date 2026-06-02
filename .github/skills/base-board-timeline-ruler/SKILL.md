---
name: base-board-timeline-ruler
description: "Use when: working on Base Board timeline ruler zoom stops, major/minor labels, grid cadence, label spacing, Timeline ruler policies, or TIMELINE_RULER_PLAN.md."
---

# Base Board Timeline Ruler Skill

Use this skill when continuing timeline ruler work in this repository.

## Goal

Keep timeline ruler behavior explicit and predictable across machines and sessions.

The 22 wheel zoom stops are the source of truth:

- `1d`, `2d`, `3d`, `4d`, `5d`
- `1w`, `2w`, `3w`
- `1mo`, `2mo`, `3mo`, `4mo`, `5mo`, `6mo`
- `1y`, `2y`, `3y`, `4y`, `5y`
- `10y`, `20y`, `40y`

Toolbar buttons are shortcuts to the same table:

- Day -> `1d`
- Week -> `1w`
- Month -> `1mo`
- Year -> `1y`

## Design Rules

- Each zoom stop should have an explicit ruler policy.
- Do not infer ruler behavior from broad duration buckets.
- Draw only one visible vertical grid cadence per zoom stop.
- Minor grid lines must be evenly spaced within a zoom stop policy.
- Major labels must not introduce extra off-cadence vertical lines.
- Treat labels and grid lines as separate model concepts.
- Do not show week text labels by default; use stronger week boundary lines instead.
- Keep the ruler to two label rows. Avoid three-level month/week/day or year/month/week stacks.
- Top ruler headers should show major boundary lines only; minor grid lines belong in the body grid.
- Label rows should use one consistent format per row. Avoid mixed fallbacks such as `Jun 2` beside `3`.
- Weekday/day rows should choose one format for the entire row: all full weekday names if every visible label fits, otherwise all abbreviated weekday names.
- Week-sized month major labels should consistently include the year. If they span two months, name both months, such as `April/May 2026`.
- Label text should progressively simplify before disappearing.

## Label Fallbacks

- Month: `January 2026` -> `January` -> `Jan` -> hidden.
- Day/week: `May 4` -> `4` -> hidden.
- Hour: `2 PM` -> hidden.
- Year: `2026` -> `'26` -> hidden.

## Current Implementation Notes

- Main implementation file: `src/timeline-view.ts`.
- Styling file: `styles.css`.
- The plan file is `TIMELINE_RULER_PLAN.md`.
- After each Copilot implementation turn that changes timeline behavior, bump `TIMELINE_BUILD_VERSION` in `src/timeline-view.ts` before building/deploying so the loaded Obsidian build is easy to identify.
- Prefer an explicit policy shape similar to:

```ts
interface TimelineRulerPolicy {
  gridUnit: "hour" | "day" | "week" | "month" | "year";
  gridEvery: number;
  majorLabelUnit: "day" | "week" | "month" | "year";
  minorLabelUnit?: "hour" | "day" | "week" | "month";
}
```

## Proposed Policies

- `1d`-`2d`: grid = hour, major labels = day, minor labels = hour.
- `3d`: grid = hour at a larger interval, major labels = day.
- `4d`-`3w`: major labels = month/year centered in week-sized cells, minor labels = weekday plus day (`Monday 18` if it fits, otherwise `Mon 18`), major boundary lines at week boundaries.
- `1mo`-`2mo`: grid = day, major week boundary lines, month-year labels in weekly major cells plus numeric day labels.
- `3mo`-`6mo`: grid = week, major month boundary lines, month labels only.
- `1y`-`5y`: grid = month, major year boundary lines, year labels plus month labels when useful.
- `10y`-`40y`: grid = year or multi-year, major labels = year/decade, minor labels usually hidden.

## Validation

Run:

```powershell
npm run build
npx eslint "src/timeline-view.ts"
npm run deploy -- "<path-to-obsidian-vault>"
```

If the vault path differs on another computer, find the open vault path before deploying.

After deploy, reload or toggle Base Board in Obsidian and inspect at least:

- `1w`
- `1mo`
- `3mo`
- `6mo`
- `1y`
- `5y`

## Known Environment Note

On Windows, full `npm run lint` may fail because of repo-wide CRLF/Prettier reports in untouched files. Avoid broad line-ending churn unless the user asks for it. For focused timeline changes, use `npm run build` and targeted ESLint on the edited file.