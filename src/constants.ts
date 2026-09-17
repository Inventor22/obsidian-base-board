/** Column label used when an entry has no value for the groupBy property. */
export const NO_VALUE_COLUMN = "(No value)";

/** Frontmatter property that controls card ordering within a column. */
export const ORDER_PROPERTY = "kanban_order";

/** Key used by BasesViewConfig.set/get to persist column order in the .base file. */
export const CONFIG_KEY_COLUMNS = "boardColumns";

/** Key used by BasesViewConfig.set/get to persist collapsed column state. */
export const CONFIG_KEY_COLLAPSED_COLUMNS = "collapsedColumns";

/** Key used by BasesViewConfig.set/get to persist custom tag colors in the .base file. */
export const CONFIG_KEY_TAG_COLORS = "tagColors";

/** Key used by BasesViewConfig.set/get to persist card click behavior in the .base file. */
export const CONFIG_KEY_OPEN_BEHAVIOR = "cardOpenBehavior";

/** Key used by BasesViewConfig.set/get to choose which hierarchy nodes appear on Kanban. */
export const CONFIG_KEY_BOARD_PROJECTION = "boardProjection";

/** Key used by BasesViewConfig.set/get to persist the active frontier lens scope (Step E). */
export const CONFIG_KEY_FRONTIER_SCOPE = "frontierScope";

/** Key used by BasesViewConfig.set/get to persist the ephemeral per-(scope, day) frontier priority overlay (Step F). */
export const CONFIG_KEY_FRONTIER_PRIORITY = "frontierPriority";

/** Key used by BasesViewConfig.set/get to persist column colors in the .base file. */
export const CONFIG_KEY_COLUMN_COLORS = "columnColors";

/** Frontmatter property that controls vertical task order in Timeline. */
export const TIMELINE_ORDER_PROPERTY = "timeline_order";

/** Key used by BasesViewConfig.set/get to persist the selected Timeline zoom preset. */
export const CONFIG_KEY_TIMELINE_PRESET = "timelinePreset";

/** Key used by BasesViewConfig.set/get to persist the continuous Timeline zoom duration. */
export const CONFIG_KEY_TIMELINE_ZOOM_DURATION = "timelineZoomDuration";

/** Key used by BasesViewConfig.set/get to persist Timeline label column width. */
export const CONFIG_KEY_TIMELINE_LABEL_WIDTH = "timelineLabelWidth";

/** Key used by BasesViewConfig.set/get to persist per-column WIP limits. */
export const CONFIG_KEY_WIP_LIMITS = "wipLimits";

/** Key used by BasesViewConfig.set/get to persist card cover property key in the .base file. */
export const CONFIG_KEY_COVER_PROPERTY = "cardCoverProperty";

/** Key used by BasesViewConfig.set/get to persist if new cards should be added to the top in the .base file. */
export const CONFIG_KEY_ADD_TO_TOP = "newCardsToTop";

/**
 * Regex matching characters that are invalid in file/folder names.
 * Used when sanitizing user input before creating vault items.
 */
export const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * Sanitize a string for use as a file or folder name by stripping
 * characters that are not allowed on common operating systems.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, "");
}
