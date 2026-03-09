import { Schema } from "effect";

// ── Rate Window ─────────────────────────────────────────────────────
// Mirrors CodexBar's RateWindow concept: a usage window with utilization
// percentage and optional reset timestamp.

export const UsageRateWindow = Schema.Struct({
  /** The kind of rate limit window. */
  type: Schema.Literals([
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "overage",
  ]),
  /** Utilization percentage (0–100). */
  utilization: Schema.Number,
  /** ISO-8601 timestamp when this window resets, if available. */
  resetsAt: Schema.NullOr(Schema.String),
  /** Current limit status. */
  status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
});
export type UsageRateWindow = typeof UsageRateWindow.Type;

// ── Provider Usage Snapshot ──────────────────────────────────────────
// Aggregated usage state pushed to the web client.

export const ProviderUsageSnapshot = Schema.Struct({
  /** Which provider this usage belongs to. */
  provider: Schema.Literals(["claudeCode", "codex", "cursor"]),
  /** All known rate-limit windows, keyed by type. */
  windows: Schema.Array(UsageRateWindow),
  /** Total cost in USD for the active session (from turn completions). */
  sessionCostUsd: Schema.optional(Schema.Number),
  /** Cumulative token usage for the active session. */
  sessionTokens: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cacheReadInputTokens: Schema.Number,
      cacheCreationInputTokens: Schema.Number,
    }),
  ),
  /** ISO-8601 timestamp of the last update. */
  updatedAt: Schema.String,
});
export type ProviderUsageSnapshot = typeof ProviderUsageSnapshot.Type;
