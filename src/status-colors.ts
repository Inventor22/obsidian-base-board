import { CONFIG_KEY_COLUMN_COLORS, NO_VALUE_COLUMN } from "./constants";

interface ColorConfig {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
}

const DEFAULT_COLUMN_COLORS: Record<string, string> = {
  "to do": "#8b949e",
  todo: "#8b949e",
  backlog: "#6e7681",
  "in progress": "#2f81f7",
  doing: "#2f81f7",
  "in review": "#d29922",
  review: "#d29922",
  flighting: "#13a10e",
  done: "#238636",
  completed: "#238636",
  blocked: "#da3633",
};

const FALLBACK_COLORS = [
  "#2f81f7",
  "#13a10e",
  "#d29922",
  "#a371f7",
  "#db6d28",
  "#3fb950",
  "#f778ba",
  "#58a6ff",
];

export function getColumnColors(config: ColorConfig): Record<string, string> {
  const raw = config.get?.(CONFIG_KEY_COLUMN_COLORS);
  return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
}

export function setColumnColor(
  config: ColorConfig,
  columnName: string,
  color: string,
): void {
  const colors = getColumnColors(config);
  if (color) {
    colors[columnName] = color;
  } else {
    delete colors[columnName];
  }
  config.set?.(CONFIG_KEY_COLUMN_COLORS, colors);
}

export function getColumnColor(
  config: ColorConfig,
  columnName: string | null,
): string {
  const displayName = columnName ?? NO_VALUE_COLUMN;
  const colors = getColumnColors(config);
  if (colors[displayName]) return colors[displayName];

  const normalized = displayName.toLowerCase();
  if (DEFAULT_COLUMN_COLORS[normalized])
    return DEFAULT_COLUMN_COLORS[normalized];

  let hash = 0;
  for (let charIndex = 0; charIndex < normalized.length; charIndex++) {
    hash = normalized.charCodeAt(charIndex) + ((hash << 5) - hash);
  }
  return (
    FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length] ??
    FALLBACK_COLORS[0]
  );
}
