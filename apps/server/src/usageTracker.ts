/**
 * UsageTracker – Lightweight in-memory accumulator for provider usage / rate-limit
 * data that is pushed to connected web clients via the `provider.usageUpdated`
 * WebSocket channel.
 *
 * Design:
 *   - Keeps one `ProviderUsageSnapshot` per provider (currently only `claudeCode`).
 *   - Updated every time the adapter emits `account.rate-limits.updated` or a turn
 *     completes with cost/token data.
 *   - Also proactively polls the Anthropic OAuth API for rate-limit windows when
 *     the SDK stream doesn't provide `rate_limit_event` messages.
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
>()("t3/usageTracker/UsageTrackerService") {}

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
  if (!info.rateLimitType) return null;
  // The SDK often omits `utilization` — infer from status when missing.
  const utilization =
    typeof info.utilization === "number"
      ? info.utilization
      : info.status === "rejected"
        ? 100
        : info.status === "allowed_warning"
          ? 80
          : 0;
  return {
    type: info.rateLimitType,
    utilization,
    resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
    status: info.status,
  };
}

// ── OAuth usage fetcher ──────────────────────────────────────────────
// Fetches rate-limit windows from the Anthropic OAuth API as a fallback
// when the SDK doesn't stream `rate_limit_event` messages.

interface OAuthUsageWindow {
  utilization?: number;
  /** The API returns snake_case and the value is an ISO-8601 string, not epoch. */
  resets_at?: string;
}

interface OAuthUsageResponse {
  five_hour?: OAuthUsageWindow;
  seven_day?: OAuthUsageWindow;
  seven_day_opus?: OAuthUsageWindow;
  seven_day_sonnet?: OAuthUsageWindow;
  seven_day_oauth_apps?: OAuthUsageWindow;
  iguana_necktie?: OAuthUsageWindow;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number;
    currency?: string;
  };
}

async function readOAuthToken(): Promise<string | null> {
  // Read the OAuth token from the Claude Code credentials in the system keychain.
  // On macOS this uses `security`, on Linux it falls back to reading a credentials file.
  if (process.platform === "darwin") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      console.log("[UsageTracker] Reading OAuth token from macOS keychain...");
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s", "Claude Code-credentials",
        "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      const raw = stdout.trim();

      // The credential may be a JSON object with an accessToken field
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;

          // Direct token fields
          if (typeof parsed.accessToken === "string") {
            console.log("[UsageTracker] Found OAuth token (accessToken field)");
            return parsed.accessToken;
          }
          if (typeof parsed.access_token === "string") {
            console.log("[UsageTracker] Found OAuth token (access_token field)");
            return parsed.access_token;
          }

          // Claude Code stores OAuth creds under `claudeAiOauth` as a nested
          // object (or JSON-encoded string) containing the actual access token.
          const oauthEntry = parsed.claudeAiOauth;
          if (oauthEntry != null) {
            const oauthObj =
              typeof oauthEntry === "string"
                ? (JSON.parse(oauthEntry) as Record<string, unknown>)
                : typeof oauthEntry === "object"
                  ? (oauthEntry as Record<string, unknown>)
                  : null;
            if (oauthObj) {
              const token =
                typeof oauthObj.accessToken === "string"
                  ? oauthObj.accessToken
                  : typeof oauthObj.access_token === "string"
                    ? oauthObj.access_token
                    : typeof oauthObj.token === "string"
                      ? oauthObj.token
                      : null;
              if (token) {
                console.log("[UsageTracker] Found OAuth token (claudeAiOauth)");
                return token;
              }
              console.log("[UsageTracker] claudeAiOauth has no token field, keys:", Object.keys(oauthObj).join(", "));
            }
          }

          console.log("[UsageTracker] Keychain JSON has no token field, keys:", Object.keys(parsed).join(", "));
          // Don't return the whole JSON blob as a token
          return null;
        } catch {
          // Not JSON, treat as raw token
        }
      }
      console.log("[UsageTracker] Got raw keychain value, length:", raw.length);
      return raw.length > 0 ? raw : null;
    } catch (err) {
      console.log("[UsageTracker] Failed to read macOS keychain:", (err as Error).message);
      return null;
    }
  }

  // Linux: try reading from credential files
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const home = process.env.HOME ?? "";
    const credPaths = [
      path.join(home, ".config", "claude", "credentials.json"),
      path.join(home, ".claude", "credentials.json"),
    ];
    for (const credPath of credPaths) {
      try {
        const raw = await fs.readFile(credPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.accessToken === "string") return parsed.accessToken;
        if (typeof parsed.access_token === "string") return parsed.access_token;
        // Check nested claudeAiOauth
        const oauthEntry = parsed.claudeAiOauth;
        if (oauthEntry != null) {
          const oauthObj =
            typeof oauthEntry === "string"
              ? (JSON.parse(oauthEntry) as Record<string, unknown>)
              : typeof oauthEntry === "object"
                ? (oauthEntry as Record<string, unknown>)
                : null;
          const token = oauthObj
            ? (typeof oauthObj.accessToken === "string" ? oauthObj.accessToken
              : typeof oauthObj.access_token === "string" ? oauthObj.access_token
              : typeof oauthObj.token === "string" ? oauthObj.token
              : null)
            : null;
          if (token) return token;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

async function fetchOAuthUsage(): Promise<UsageRateWindow[]> {
  console.log("[UsageTracker] fetchOAuthUsage() called");
  const token = await readOAuthToken();
  if (!token) {
    console.log("[UsageTracker] No OAuth token available, skipping API fetch");
    return [];
  }
  console.log("[UsageTracker] Got token, fetching https://api.anthropic.com/api/oauth/usage ...");

  const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "t3code/0.1",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    console.log("[UsageTracker] OAuth API responded with status:", resp.status, resp.statusText);
    return [];
  }

  const data = (await resp.json()) as OAuthUsageResponse;
  console.log("[UsageTracker] OAuth API response keys:", Object.keys(data).join(", "));
  console.log("[UsageTracker] OAuth API response:", JSON.stringify(data, null, 2));
  const windows: UsageRateWindow[] = [];

  const windowKeys: Array<{ key: keyof OAuthUsageResponse; type: UsageRateWindow["type"] }> = [
    { key: "five_hour", type: "five_hour" },
    { key: "seven_day", type: "seven_day" },
    { key: "seven_day_opus", type: "seven_day_opus" },
    { key: "seven_day_sonnet", type: "seven_day_sonnet" },
  ];

  for (const { key, type } of windowKeys) {
    const window = data[key] as OAuthUsageWindow | undefined;
    if (window && typeof window.utilization === "number") {
      windows.push({
        type,
        utilization: window.utilization,
        resetsAt: typeof window.resets_at === "string"
          ? window.resets_at
          : null,
        status:
          window.utilization >= 100
            ? "rejected"
            : window.utilization >= 80
              ? "allowed_warning"
              : "allowed",
      });
    }
  }

  console.log("[UsageTracker] Parsed", windows.length, "rate windows:", windows.map(w => `${w.type}=${w.utilization}%`).join(", "));
  return windows;
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

  const publishSnapshot = (provider: ProviderKey, state: ProviderUsageState) => {
    const snap = stateToSnapshot(provider, state);
    console.log("[UsageTracker] Publishing snapshot:", snap.provider, "windows:", snap.windows.length, snap.windows.map(w => `${w.type}=${w.utilization}%`).join(", "), "cost:", snap.sessionCostUsd);
    return PubSub.publish(pubsub, snap);
  };

  // ── OAuth polling state ────────────────────────────────────────────
  const oauthPollingActiveRef = yield* Ref.make(false);
  const oauthHasWindowsRef = yield* Ref.make(false);

  const ingestRateLimitEvent: UsageTrackerShape["ingestRateLimitEvent"] = (
    provider,
    rawRateLimitMessage,
  ) =>
    Ref.modify(stateRef, (map) => {
      console.log("[UsageTracker] ingestRateLimitEvent from", provider, "raw:", JSON.stringify(rawRateLimitMessage));
      const info = parseRateLimitInfo(rawRateLimitMessage);
      if (!info) {
        console.log("[UsageTracker] parseRateLimitInfo returned null");
        return [null, map] as const;
      }
      console.log("[UsageTracker] Parsed rate limit:", info.rateLimitType, "utilization:", info.utilization, "status:", info.status);
      const window = toUsageRateWindow(info);
      if (!window) return [null, map] as const;

      const nextMap = new Map(map);
      const state = { ...getOrCreate(nextMap, provider) };
      state.windows = new Map(state.windows);
      state.windows.set(window.type, window);
      nextMap.set(provider, state);
      return [state, nextMap] as const;
    }).pipe(
      Effect.flatMap((state) => {
        if (!state) return Effect.void;
        // Only mark as having windows with real utilization data
        const hasUtilizationData = [...state.windows.values()].some(
          (w) => w.utilization > 0 || w.status !== "allowed",
        );
        return Effect.all([
          hasUtilizationData ? Ref.set(oauthHasWindowsRef, true) : Effect.void,
          publishSnapshot(provider, state),
        ]);
      }),
      // If the SDK didn't provide utilization, try OAuth to get real percentages
      Effect.tap(() => ensureOAuthPolling(provider)),
      Effect.asVoid,
    );

  /** Fetch usage from the OAuth API and merge windows into state. */
  const pollOAuthUsage = (provider: ProviderKey): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => fetchOAuthUsage(),
      catch: () => null,
    }).pipe(
      Effect.flatMap((windows) => {
        if (!windows || windows.length === 0) return Effect.void;
        return Ref.modify(stateRef, (map) => {
          const nextMap = new Map(map);
          const state = { ...getOrCreate(nextMap, provider) };
          state.windows = new Map(state.windows);
          for (const w of windows) {
            state.windows.set(w.type, w);
          }
          nextMap.set(provider, state);
          return [state, nextMap] as const;
        }).pipe(
          Effect.tap(() => Ref.set(oauthHasWindowsRef, true)),
          Effect.flatMap((state) => (state ? publishSnapshot(provider, state) : Effect.void)),
          Effect.asVoid,
        );
      }),
      Effect.orElseSucceed(() => undefined),
    );

  // Plain JS polling handle to avoid Effect scope requirements
  let oauthPollingStarted = false;
  let oauthPollingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start background polling for OAuth usage data (every 2 minutes).
   * Only starts once, and only if the SDK hasn't already provided rate-limit windows.
   * Runs the initial fetch asynchronously to avoid blocking event processing.
   */
  const ensureOAuthPolling = (provider: ProviderKey): Effect.Effect<void> =>
    Effect.gen(function* () {
      const hasWindows = yield* Ref.get(oauthHasWindowsRef);
      if (hasWindows || oauthPollingStarted) return;
      oauthPollingStarted = true;
      console.log("[UsageTracker] Starting OAuth polling for", provider);

      // Fire-and-forget: run the initial fetch without blocking the caller.
      Effect.runPromise(
        pollOAuthUsage(provider).pipe(Effect.orElseSucceed(() => undefined)),
      ).catch(() => {});

      // Then poll every 2 minutes using plain setInterval
      oauthPollingTimer = setInterval(() => {
        Effect.runPromise(
          pollOAuthUsage(provider).pipe(Effect.orElseSucceed(() => undefined)),
        ).catch(() => {});
      }, 2 * 60 * 1000);
    });

  const ingestTurnUsage: UsageTrackerShape["ingestTurnUsage"] = (provider, data) => {
    // Skip entirely when the turn provided no usage data at all (e.g. a
    // failed turn with no cost/token info).  This avoids publishing noisy
    // snapshots with undefined values.
    const hasCost = typeof data.totalCostUsd === "number" && data.totalCostUsd > 0;
    const hasTokens = data.usage !== undefined && data.usage !== null;
    if (!hasCost && !hasTokens) {
      // Still kick off OAuth polling so we get rate-limit windows.
      return ensureOAuthPolling(provider).pipe(Effect.asVoid);
    }

    return Ref.modify(stateRef, (map) => {
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
      // After first turn completes, start OAuth polling if we don't have windows yet
      Effect.tap(() => ensureOAuthPolling(provider)),
      Effect.asVoid,
    );
  };

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
