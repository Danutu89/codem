/**
 * DynamicTextGeneration - Dispatches git text generation to the active provider.
 *
 * Reads {@link ActiveTextGenProvider} at call time and delegates to either the
 * Claude CLI or the Codex CLI implementation accordingly.
 *
 * When the caller provides an explicit `provider` field on the input, that
 * value takes precedence over the {@link ActiveTextGenProvider} Ref. This
 * avoids layer-memoization issues where the Ref instance visible to the
 * wsServer differs from the one captured here during layer construction.
 *
 * @module DynamicTextGeneration
 */
import { Effect, Layer } from "effect";
import type { ProviderKind } from "@t3tools/contracts";

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

    const resolveFromRef = Effect.map(activeProvider.get, (kind) => {
      console.log("[DynamicTextGeneration] active provider (from ref):", kind);
      return kind === "codex" ? codex : claude;
    });

    const resolveImpl = (explicitProvider: ProviderKind | undefined) => {
      if (explicitProvider !== undefined) {
        console.log("[DynamicTextGeneration] active provider (explicit):", explicitProvider);
        return Effect.succeed(explicitProvider === "codex" ? codex : claude);
      }
      return resolveFromRef;
    };

    return {
      generateCommitMessage: (input) =>
        Effect.flatMap(resolveImpl(input.provider), (impl) => impl.generateCommitMessage(input)),
      generatePrContent: (input) =>
        Effect.flatMap(resolveImpl(input.provider), (impl) => impl.generatePrContent(input)),
      generateBranchName: (input) =>
        Effect.flatMap(resolveImpl(input.provider), (impl) => impl.generateBranchName(input)),
      generateThreadTitle: (input) =>
        Effect.flatMap(resolveImpl(input.provider), (impl) => impl.generateThreadTitle(input)),
    } satisfies TextGenerationShape;
  }),
);
