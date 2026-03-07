/**
 * ActiveTextGenProvider - Tracks which provider should be used for text generation.
 *
 * Holds a `Ref<ProviderKind>` that is updated whenever the active orchestration
 * provider changes (e.g. user switches from Codex to Claude Code).
 * The {@link DynamicTextGeneration} layer reads this to dispatch calls to the
 * correct provider-specific implementation.
 *
 * @module ActiveTextGenProvider
 */
import { Effect, Layer, Ref, ServiceMap } from "effect";
import { type ProviderKind, DEFAULT_PROVIDER_KIND } from "@t3tools/contracts";

/**
 * ActiveTextGenProviderShape - read/write access to the active text-generation provider.
 */
export interface ActiveTextGenProviderShape {
  /** Get the current provider kind used for text generation. */
  readonly get: Effect.Effect<ProviderKind>;
  /** Update the provider kind used for text generation. */
  readonly set: (provider: ProviderKind) => Effect.Effect<void>;
}

/**
 * ActiveTextGenProvider - Service tag.
 */
export class ActiveTextGenProvider extends ServiceMap.Service<
  ActiveTextGenProvider,
  ActiveTextGenProviderShape
>()("t3/git/Services/ActiveTextGenProvider") {}

/**
 * Live layer backed by an in-memory `Ref`.
 */
export const ActiveTextGenProviderLive = Layer.effect(
  ActiveTextGenProvider,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ProviderKind>(DEFAULT_PROVIDER_KIND);
    return {
      get: Ref.get(ref),
      set: (provider: ProviderKind) => Ref.set(ref, provider),
    } satisfies ActiveTextGenProviderShape;
  }),
);
