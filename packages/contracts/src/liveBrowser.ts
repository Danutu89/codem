import { Schema } from "effect";

// ── Live Browser Inspect Result ────────────────────────────────────

export const LiveBrowserBoundingBox = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type LiveBrowserBoundingBox = typeof LiveBrowserBoundingBox.Type;

export const LiveBrowserFramework = Schema.Literals(["react", "vue", "svelte"]);
export type LiveBrowserFramework = typeof LiveBrowserFramework.Type;

export const LiveBrowserSourceLocation = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.optional(Schema.Number),
});
export type LiveBrowserSourceLocation = typeof LiveBrowserSourceLocation.Type;

export const LiveBrowserInspectResult = Schema.Struct({
  /** CDP backend node ID */
  nodeId: Schema.Number,
  /** Generated unique CSS selector */
  selector: Schema.String,
  /** HTML tag name (lowercase) */
  tagName: Schema.String,
  /** Element id attribute */
  id: Schema.optional(Schema.String),
  /** Element class names */
  classes: Schema.Array(Schema.String),
  /** Truncated text content */
  textContent: Schema.optional(Schema.String),
  /** Element bounding box in viewport coordinates */
  boundingBox: LiveBrowserBoundingBox,
  /** HTML attributes */
  attributes: Schema.Record(Schema.String, Schema.String),
  /** Detected frontend framework */
  framework: Schema.optional(LiveBrowserFramework),
  /** Component name from framework internals */
  componentName: Schema.optional(Schema.String),
  /** Source code location (resolved from framework debug info) */
  sourceLocation: Schema.optional(LiveBrowserSourceLocation),
});
export type LiveBrowserInspectResult = typeof LiveBrowserInspectResult.Type;

// ── Live Browser State ─────────────────────────────────────────────

export const LiveBrowserStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "stopped",
  "error",
]);
export type LiveBrowserStatus = typeof LiveBrowserStatus.Type;

export const LiveBrowserState = Schema.Struct({
  isOpen: Schema.Boolean,
  status: LiveBrowserStatus,
  url: Schema.String,
  title: Schema.String,
  isInspecting: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type LiveBrowserState = typeof LiveBrowserState.Type;

// ── Live Browser Element Screenshot ────────────────────────────────

export const LiveBrowserElementScreenshot = Schema.Struct({
  /** Base64-encoded PNG screenshot */
  screenshot: Schema.String,
  /** CSS selector of the captured element */
  selector: Schema.String,
  /** Bounding box of the captured element */
  boundingBox: LiveBrowserBoundingBox,
});
export type LiveBrowserElementScreenshot = typeof LiveBrowserElementScreenshot.Type;

// ── Source Map Resolution Input ────────────────────────────────────

export const LiveBrowserResolveSourceInput = Schema.Struct({
  /** File path or URL from framework debug info */
  filePath: Schema.String,
  /** Line number (1-based) */
  line: Schema.Number,
  /** Column number (0-based) */
  column: Schema.optional(Schema.Number),
});
export type LiveBrowserResolveSourceInput = typeof LiveBrowserResolveSourceInput.Type;

export const LiveBrowserResolveSourceResult = Schema.Struct({
  /** Resolved file path relative to workspace root */
  file: Schema.String,
  /** Line number (1-based) */
  line: Schema.Number,
  /** Column number (0-based) */
  column: Schema.optional(Schema.Number),
  /** Whether the file was found on disk */
  exists: Schema.Boolean,
});
export type LiveBrowserResolveSourceResult = typeof LiveBrowserResolveSourceResult.Type;
