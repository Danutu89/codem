/**
 * DynamicTextGeneration - Dispatches text generation to the active provider.
 *
 * Reads the current provider from {@link ActiveTextGenProvider} on every call
 * and delegates to the matching provider-specific implementation:
 *
 * - `codex`     → {@link CodexTextGenerationTag}
 * - `claudeCode`→ {@link ClaudeTextGenerationTag}
 * - `cursor`    → falls back to {@link CodexTextGenerationTag}
 *
 * @module DynamicTextGeneration
 */
import { Effect, Layer } from "effect";

import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ActiveTextGenProvider } from "../Services/ActiveTextGenProvider.ts";
import { CodexTextGenerationTag } from "../Services/TextGenerationTags.ts";
import { ClaudeTextGenerationTag } from "../Services/TextGenerationTags.ts";

const makeDynamicTextGeneration = Effect.gen(function* () {
  const activeProvider = yield* ActiveTextGenProvider;
  const codexImpl = yield* CodexTextGenerationTag;
  const claudeImpl = yield* ClaudeTextGenerationTag;

  const resolveImpl = Effect.gen(function* () {
    const provider = yield* activeProvider.get;
    switch (provider) {
      case "claudeCode":
        return claudeImpl;
      case "cursor":
        // Cursor supports codex models; fall back to codex for text generation
        return codexImpl;
      case "codex":
      default:
        return codexImpl;
    }
  });

  return {
    generateCommitMessage: (input) =>
      Effect.gen(function* () {
        const impl = yield* resolveImpl;
        return yield* impl.generateCommitMessage(input);
      }),

    generatePrContent: (input) =>
      Effect.gen(function* () {
        const impl = yield* resolveImpl;
        return yield* impl.generatePrContent(input);
      }),

    generateBranchName: (input) =>
      Effect.gen(function* () {
        const impl = yield* resolveImpl;
        return yield* impl.generateBranchName(input);
      }),
  } satisfies TextGenerationShape;
});

/**
 * DynamicTextGenerationLive - Provides `TextGeneration` that dispatches
 * to the provider-specific implementation based on the active provider.
 *
 * Dependencies:
 * - {@link ActiveTextGenProvider}
 * - {@link CodexTextGenerationTag}
 * - {@link ClaudeTextGenerationTag}
 */
export const DynamicTextGenerationLive = Layer.effect(TextGeneration, makeDynamicTextGeneration);
