import { Schema } from "effect";

// ── Browser Test Input ──────────────────────────────────────────────

export const BrowserTestRunInput = Schema.Struct({
  /** URL of the running application to test */
  appUrl: Schema.String,
  /** LM Studio (OpenAI-compatible) endpoint */
  lmStudioEndpoint: Schema.String,
  /** Model ID loaded in LM Studio */
  lmStudioModelId: Schema.String,
  /** Optional natural-language instructions for the AI tester (agent summary) */
  instructions: Schema.optional(Schema.String),
  /** The user's original prompt / bug description that triggered the coding turn */
  userPrompt: Schema.optional(Schema.String),
});
export type BrowserTestRunInput = typeof BrowserTestRunInput.Type;

// ── Browser Test Progress (pushed over WS) ──────────────────────────

export const BrowserTestStepResult = Schema.Struct({
  stepNumber: Schema.Number,
  action: Schema.String,
  target: Schema.String,
  success: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type BrowserTestStepResult = typeof BrowserTestStepResult.Type;

export const BrowserTestProgress = Schema.Struct({
  status: Schema.Literals(["running", "step", "completed", "error"]),
  /** Human-readable message */
  message: Schema.String,
  /** Populated for status === "step" */
  step: Schema.optional(BrowserTestStepResult),
  /** Final summary (populated for status === "completed") */
  summary: Schema.optional(
    Schema.Struct({
      passed: Schema.Boolean,
      totalSteps: Schema.Number,
      durationMs: Schema.Number,
      aiSummary: Schema.String,
    }),
  ),
  /** Error message (populated for status === "error") */
  error: Schema.optional(Schema.String),
});
export type BrowserTestProgress = typeof BrowserTestProgress.Type;

// ── Browser Test Result ─────────────────────────────────────────────

export const BrowserTestResult = Schema.Struct({
  passed: Schema.Boolean,
  totalSteps: Schema.Number,
  durationMs: Schema.Number,
  aiSummary: Schema.String,
  steps: Schema.Array(BrowserTestStepResult),
  consoleLogs: Schema.Array(
    Schema.Struct({
      level: Schema.String,
      text: Schema.String,
    }),
  ),
  screenshots: Schema.Array(Schema.String),
});
export type BrowserTestResult = typeof BrowserTestResult.Type;

// ── WS Method & Channel names ───────────────────────────────────────

export const BROWSER_TEST_WS_METHODS = {
  run: "browserTest.run",
  stop: "browserTest.stop",
} as const;

export const BROWSER_TEST_WS_CHANNELS = {
  progress: "browserTest.progress",
} as const;
