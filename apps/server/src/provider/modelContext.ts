/**
 * Model-specific context window sizes and output token limits.
 *
 * Derived from Claude Code CLI patterns. Used by auto-compaction and
 * context-window tracking to compute accurate fill-level thresholds
 * instead of hardcoding 200k for every model.
 *
 * @module modelContext
 */

// ── Model → context window size ──────────────────────────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

// ── Model → max output tokens ────────────────────────────────────────

interface OutputTokenLimits {
  readonly default: number;
  readonly upperLimit: number;
}

const MODEL_OUTPUT_TOKENS: Record<string, OutputTokenLimits> = {
  "claude-opus-4-6": { default: 64_000, upperLimit: 128_000 },
  "claude-sonnet-4-6": { default: 32_000, upperLimit: 128_000 },
  "claude-opus-4-5": { default: 32_000, upperLimit: 64_000 },
  "claude-sonnet-4": { default: 32_000, upperLimit: 64_000 },
  "claude-haiku-4-5": { default: 32_000, upperLimit: 64_000 },
  "claude-haiku-4": { default: 32_000, upperLimit: 64_000 },
};

const DEFAULT_OUTPUT_TOKENS: OutputTokenLimits = {
  default: 32_000,
  upperLimit: 64_000,
};

/**
 * Maximum output tokens reserved when computing the effective context window.
 * Matches the Claude Code CLI constant.
 */
const MAX_OUTPUT_TOKEN_RESERVE = 20_000;

// ── Public helpers ───────────────────────────────────────────────────

/**
 * Normalize a model slug for lookup. Strips common variations so
 * "opus-4-6", "claude-opus-4-6", and "claude-opus-4-6:thinking" all
 * resolve the same way.
 */
function normalizeModelSlug(model: string): string {
  let slug = model.toLowerCase().trim();

  // Strip trailing modifiers like ":thinking", "[1m]", etc.
  slug = slug.replace(/:\w+$/, "").replace(/\[.*\]$/, "");

  // Ensure "claude-" prefix
  if (!slug.startsWith("claude-")) {
    slug = `claude-${slug}`;
  }

  return slug;
}

/**
 * Return the raw context window for a model (before output-token reserve).
 */
export function getContextWindowForModel(model: string): number {
  const slug = normalizeModelSlug(model);
  return MODEL_CONTEXT_WINDOWS[slug] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Return the max output token limits for a model.
 */
export function getOutputTokenLimitsForModel(model: string): OutputTokenLimits {
  const slug = normalizeModelSlug(model);
  return MODEL_OUTPUT_TOKENS[slug] ?? DEFAULT_OUTPUT_TOKENS;
}

/**
 * Return the effective context window after reserving space for output tokens.
 *
 * `effectiveWindow = contextWindow - min(defaultOutputTokens, MAX_OUTPUT_TOKEN_RESERVE)`
 *
 * This is the maximum number of input tokens the model can consume before
 * the context is considered full.
 */
export function getEffectiveContextWindow(model: string): number {
  const contextWindow = getContextWindowForModel(model);
  const outputLimits = getOutputTokenLimitsForModel(model);
  const reserve = Math.min(outputLimits.default, MAX_OUTPUT_TOKEN_RESERVE);
  return contextWindow - reserve;
}
