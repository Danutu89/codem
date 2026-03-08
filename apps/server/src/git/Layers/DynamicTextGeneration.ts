/**
 * DynamicTextGeneration - Dispatches git text generation to the active provider.
 *
 * Reads {@link ActiveTextGenProvider} at call time and delegates to either the
 * Claude CLI or the Codex CLI implementation accordingly.
 *
 * @module DynamicTextGeneration
 */
import { Effect, Layer } from "effect";

import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { ActiveTextGenProvider } from "../Services/ActiveTextGenProvider.ts";
import { ClaudeTextGenerationTag } from "../Services/TextGenerationTags.ts";
import { CodexTextGenerationTag } from "../Services/TextGenerationTags.ts";

/**
 * DynamicTextGenerationLive - Provides `TextGeneration` by dispatching to the
 * provider selected in {@link ActiveTextGenProvider}.
 *
 * Dependencies:
 * - {@link ActiveTextGenProvider}
 * - {@link ClaudeTextGenerationTag}
 * - {@link CodexTextGenerationTag}
 */
export const DynamicTextGenerationLive = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const activeProvider = yield* ActiveTextGenProvider;
    const claude = yield* ClaudeTextGenerationTag;
    const codex = yield* CodexTextGenerationTag;

    const resolve = Effect.map(activeProvider.get, (kind) =>
      kind === "codex" ? codex : claude,
    );

    return {
      generateCommitMessage: (input) =>
        Effect.flatMap(resolve, (impl) => impl.generateCommitMessage(input)),
      generatePrContent: (input) =>
        Effect.flatMap(resolve, (impl) => impl.generatePrContent(input)),
      generateBranchName: (input) =>
        Effect.flatMap(resolve, (impl) => impl.generateBranchName(input)),
    } satisfies TextGenerationShape;
  }),
);
