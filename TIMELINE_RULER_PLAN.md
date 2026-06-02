# Timeline Ruler Plan

Current local direction for the Base Board timeline ruler work.

## Context

The timeline ruler has been hard to tune because two behaviors were mixed together:

- toolbar zoom presets: Day, Week, Month, Year
- wheel zoom stops: 1d, 2d, 3d, 4d, 5d, 1w, 2w, 3w, 1mo, 2mo, 3mo, 4mo, 5mo, 6mo, 1y, 2y, 3y, 4y, 5y, 10y, 20y, 40y

The intended direction is to make the 22 wheel stops the source of truth. The four toolbar buttons should be shortcuts to stops in that same table:

- Day -> 1d
- Week -> 1w
- Month -> 1mo
- Year -> 1y

## Design Rules

- Each zoom stop should have an explicit ruler policy.
- Do not infer ruler behavior from broad duration buckets.
- Do not mix multiple vertical grid cadences in one visible ruler.
- Minor grid lines must be evenly spaced within a zoom stop.
- Major labels must not introduce extra off-cadence vertical lines.
- Labels and grid lines should be treated as separate concepts.
- Label text should progressively simplify before disappearing.

Suggested label fallback examples:

- Month: January 2026 -> January -> Jan -> hidden
- Day/week: May 4 -> 4 -> hidden
- Hour: 2 PM -> 2 -> hidden
- Year: 2026 -> hidden

## Implementation Direction

Use an explicit zoom-stop table, for example:

```ts
interface TimelineZoomStop {
  id: string;
  durationMs: number;
  ruler: TimelineRulerPolicy;
}

interface TimelineRulerPolicy {
  gridUnit: "hour" | "day" | "week" | "month" | "year";
  gridEvery: number;
  majorLabelUnit: "day" | "week" | "month" | "year";
  minorLabelUnit?: "hour" | "day" | "week" | "month";
}
```

The active zoom stop should drive:

- wheel zoom next/previous behavior
- toolbar button target durations
- ruler grid generation
- major/minor label generation

## Proposed Policies

- 1d-2d: grid = hour, major labels = day, minor labels = hour
- 3d-5d: grid = hour at a larger interval or day-only if hourly is too noisy, major labels = day
- 1w-3w: grid = day, major labels = week, minor labels = day
- 1mo-6mo: grid = week, major labels = month, minor labels = week if useful
- 1y-5y: grid = month, major labels = year, minor labels = month
- 10y-40y: grid = year or multi-year, major labels = year/decade, minor labels usually hidden

Important unresolved choice: month grid lines in a real time-proportional timeline are not pixel-equal because months have different lengths. If strict equal pixel spacing is required, avoid month as a drawn grid cadence and use day/week/year-style fixed intervals instead.

## Validation Loop

After changes:

```powershell
npm run build
npm run deploy -- Q:\Obsidian\obsidian-msft
```

Then reload Base Board in Obsidian and inspect at least these stops:

- 1w
- 1mo
- 3mo
- 6mo
- 1y
- 5y

The installed plugin folder should be:

```text
Q:\Obsidian\obsidian-msft\.obsidian\plugins\base-board
```

The repo currently uses a local deploy helper at `scripts/deploy-plugin.mjs`.
