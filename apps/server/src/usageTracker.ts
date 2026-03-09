/**
 * UsageTracker – Lightweight in-memory accumulator for provider usage / rate-limit
 * data that is pushed to connected web clients via the `provider.usageUpdated`
 * WebSocket channel.
 *
 * Design:
 *   - Keeps one `ProviderUsageSnapshot` per provider (currently only `claudeCode`).
 *   - Updated every time the adapter emits `account.rate-limits.updated` or a turn
 *     completes with cost/token data.
 *   - Exposes an Effect `Stream` so the WS server can subscribe and broadcast.
 *
 * @module UsageTracker
 */

import type { ProviderUsageSnapshot, UsageRateWindow } from "@t3tools/contracts";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

// ── Service interface ────────────────────────────────────────────────

export interface UsageTrackerShape {
  readonly ingestRateLimitEvent: (
    provider: "claudeCode" | "codex" | "cursor",
    rawRateLimitMessage: unknown,
  ) => Effect.Effect<void>;

  readonly ingestTurnUsage: (
    provider: "claudeCode" | "codex" | "cursor",
    data: {
      readonly totalCostUsd?: number | undefined;
      readonly usage?: {
        readonly input_tokens?: number | undefined;
        readonly output_tokens?: number | undefined;
        readonly cache_read_input_tokens?: number | undefined;
        readonly cache_creation_input_tokens?: number | undefined;
      } | undefined;
    },
  ) => Effect.Effect<void>;

  readonly stream: Stream.Stream<ProviderUsageSnapshot>;

  readonly getSnapshot: (
    provider: "claudeCode" | "codex" | "cursor",
  ) => Effect.Effect<ProviderUsageSnapshot | null>;
}

export class UsageTrackerService extends ServiceMap.Service<
  UsageTrackerService,
  UsageTrackerShape
>()("t3/UsageTracker") {}

// ── Helpers ──────────────────────────────────────────────────────────

interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt: number | undefined;
  rateLimitType:
    | "five_hour"
    | "seven_day"
    | "seven_day_opus"
    | "seven_day_sonnet"
    | "overage"
    | undefined;
  utilization: number | undefined;
}

function parseRateLimitInfo(raw: unknown): RateLimitInfo | null {
  if (raw == null || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;

  // The adapter wraps the SDKRateLimitEvent as { type, rate_limit_info, ... }
  const info =
    typeof msg.rate_limit_info === "object" && msg.rate_limit_info != null
      ? (msg.rate_limit_info as Record<string, unknown>)
      : msg;

  const type = info.rateLimitType ?? info.rate_limit_type;
  const validTypes = new Set([
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "overage",
  ]);
  if (typeof type !== "string" || !validTypes.has(type)) return null;

  return {
    status:
      info.status === "allowed" || info.status === "allowed_warning" || info.status === "rejected"
        ? info.status
        : "allowed",
    resetsAt:
      typeof info.resetsAt === "number"
        ? info.resetsAt
        : typeof info.resets_at === "number"
          ? info.resets_at
          : undefined,
    rateLimitType: type as RateLimitInfo["rateLimitType"],
    utilization: typeof info.utilization === "number" ? info.utilization : undefined,
  };
}

function toUsageRateWindow(info: RateLimitInfo): UsageRateWindow | null {
  if (!info.rateLimitType || info.utilization == null) return null;
  return {
    type: info.rateLimitType,
    utilization: info.utilization,
    resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    status: info.status,
  };
}

// ── Implementation ──────────────────────────────────────────────────

type ProviderKey = "claudeCode" | "codex" | "cursor";

interface ProviderUsageState {
  windows: Map<string, UsageRateWindow>;
  sessionCostUsd: number;
  sessionTokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

const emptyProviderState = (): ProviderUsageState => ({
  windows: new Map(),
  sessionCostUsd: 0,
  sessionTokens: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
});

function stateToSnapshot(
  provider: ProviderKey,
  state: ProviderUsageState,
): ProviderUsageSnapshot {
  return {
    provider,
    windows: [...state.windows.values()],
    sessionCostUsd: state.sessionCostUsd || undefined,
    sessionTokens:
      state.sessionTokens.inputTokens > 0 || state.sessionTokens.outputTokens > 0
        ? { ...state.sessionTokens }
        : undefined,
    updatedAt: new Date().toISOString(),
  };
}

const makeUsageTracker = Effect.gen(function* () {
  const stateRef = yield* Ref.make<Map<ProviderKey, ProviderUsageState>>(new Map());
  const pubsub = yield* PubSub.unbounded<ProviderUsageSnapshot>();

  const getOrCreate = (
    map: Map<ProviderKey, ProviderUsageState>,
    provider: ProviderKey,
  ): ProviderUsageState => {
    let state = map.get(provider);
    if (!state) {
      state = emptyProviderState();
      map.set(provider, state);
    }
    return state;
  };

  const publishSnapshot = (provider: ProviderKey, state: ProviderUsageState) =>
    PubSub.publish(pubsub, stateToSnapshot(provider, state));

  const ingestRateLimitEvent: UsageTrackerShape["ingestRateLimitEvent"] = (
    provider,
    rawRateLimitMessage,
  ) =>
    Ref.modify(stateRef, (map) => {
      const info = parseRateLimitInfo(rawRateLimitMessage);
      if (!info) return [null, map] as const;
      const window = toUsageRateWindow(info);
      if (!window) return [null, map] as const;

      const nextMap = new Map(map);
      const state = { ...getOrCreate(nextMap, provider) };
      state.windows = new Map(state.windows);
      state.windows.set(window.type, window);
      nextMap.set(provider, state);
      return [state, nextMap] as const;
    }).pipe(
      Effect.flatMap((state) => (state ? publishSnapshot(provider, state) : Effect.void)),
      Effect.asVoid,
    );

  const ingestTurnUsage: UsageTrackerShape["ingestTurnUsage"] = (provider, data) =>
    Ref.modify(stateRef, (map) => {
      const nextMap = new Map(map);
      const state = { ...getOrCreate(nextMap, provider) };

      if (typeof data.totalCostUsd === "number") {
        state.sessionCostUsd += data.totalCostUsd;
      }
      if (data.usage) {
        state.sessionTokens = {
          inputTokens: state.sessionTokens.inputTokens + (data.usage.input_tokens ?? 0),
          outputTokens: state.sessionTokens.outputTokens + (data.usage.output_tokens ?? 0),
          cacheReadInputTokens:
            state.sessionTokens.cacheReadInputTokens +
            (data.usage.cache_read_input_tokens ?? 0),
          cacheCreationInputTokens:
            state.sessionTokens.cacheCreationInputTokens +
            (data.usage.cache_creation_input_tokens ?? 0),
        };
      }
      nextMap.set(provider, state);
      return [state, nextMap] as const;
    }).pipe(
      Effect.flatMap((state) => (state ? publishSnapshot(provider, state) : Effect.void)),
      Effect.asVoid,
    );

  const stream = Stream.fromPubSub(pubsub);

  const getSnapshot: UsageTrackerShape["getSnapshot"] = (provider) =>
    Ref.get(stateRef).pipe(
      Effect.map((map) => {
        const state = map.get(provider);
        return state ? stateToSnapshot(provider, state) : null;
      }),
    );

  return {
    ingestRateLimitEvent,
    ingestTurnUsage,
    stream,
    getSnapshot,
  } satisfies UsageTrackerShape;
});

export const UsageTrackerLive = Layer.effect(UsageTrackerService, makeUsageTracker);
