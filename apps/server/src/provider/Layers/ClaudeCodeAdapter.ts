/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeCodeAdapterLive
 */
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type McpServerConfig,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { execFileSync } from "node:child_process";
import { Cause, DateTime, Deferred, Effect, Layer, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;

function resolveSystemClaudePath(): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly assistantItemId: string;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly messageCompleted: boolean;
  readonly emittedTextDelta: boolean;
  readonly hadToolUseSinceLastText: boolean;
  readonly fallbackAssistantText: string;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  declineMessage?: string;
}

interface PendingUserInput {
  readonly questionIdToText: ReadonlyMap<string, string>;
  readonly answers: Deferred.Deferred<Record<string, unknown>>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  query: ClaudeQueryRuntime;
  readonly startedAt: string;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  permissionMode: PermissionMode | undefined;
  activePermissionMode: PermissionMode | undefined;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
  resumeRetried: boolean;
  readonly rebuildQueryWithoutResume: (() => ClaudeQueryRuntime) | undefined;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly applyFlagSettings: (settings: Record<string, unknown>) => Promise<void>;
  readonly close: () => void;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  if (toolName === "TodoWrite" || toolName === "TodoRead") {
    return "plan";
  }
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (toolName === "ExitPlanMode") {
    return "plan_approval";
  }
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized.includes("read file") || normalized.includes("view")) {
    return "file_read_approval";
  }
  return classifyToolItemType(toolName) === "command_execution"
    ? "command_execution_approval"
    : "file_change_approval";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  // For ExitPlanMode, extract the plan text as the detail
  if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
    return input.plan;
  }

  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // Try common parameter names for a human-readable summary
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
  if (filePath) {
    return `${toolName}: ${filePath}`;
  }
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  const path = typeof input.path === "string" ? input.path : undefined;
  if (pattern) {
    return path ? `${toolName}: /${pattern}/ in ${path}` : `${toolName}: /${pattern}/`;
  }
  if (path) {
    return `${toolName}: ${path}`;
  }
  const query = typeof input.query === "string" ? input.query : undefined;
  if (query) {
    return `${toolName}: ${query}`;
  }
  const url = typeof input.url === "string" ? input.url : undefined;
  if (url) {
    return `${toolName}: ${url}`;
  }
  const description = typeof input.description === "string" ? input.description : undefined;
  if (description) {
    return `${toolName}: ${description.slice(0, 400)}`;
  }
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  if (prompt) {
    return `${toolName}: ${prompt.slice(0, 200)}`;
  }

  const serialized = JSON.stringify(input);
  // Don't show empty objects — just return the tool name
  if (serialized === "{}" || serialized === "[]" || Object.keys(input).length === 0) {
    return toolName;
  }
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const PLAN_MODE_PREAMBLE = [
  "⚠️ PLAN MODE IS ACTIVE — You MUST follow these rules strictly:",
  "",
  "1. DO NOT execute any implementation tools (Edit, Write, Bash, etc.) — they will all be denied.",
  "2. Analyze the request and produce a detailed, step-by-step plan in markdown.",
  "3. When your plan is ready, call the `ExitPlanMode` tool to propose it for review.",
  "4. DO NOT write the plan as a free-text response — you MUST submit it through `ExitPlanMode`.",
  "5. The user will review your plan and can approve, deny, or request changes before any implementation begins.",
  "6. Do NOT attempt any implementation. Your ONLY job is to plan.",
  "",
  "---",
  "",
].join("\n");

function buildUserMessage(input: ProviderSendTurnInput): SDKUserMessage {
  const fragments: string[] = [];

  // When in plan mode, prepend explicit instructions so the model knows
  // upfront that it must produce a plan via ExitPlanMode rather than
  // attempting to use implementation tools (which would be denied).
  if (input.interactionMode === "plan") {
    fragments.push(PLAN_MODE_PREAMBLE);
  }

  if (input.input && input.input.trim().length > 0) {
    fragments.push(input.input.trim());
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      fragments.push(
        `Attached image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes).`,
      );
    }
  }

  const text = fragments.join("\n\n");

  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  } as SDKUserMessage;
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = result.errors.join(" ").toLowerCase();
  if (errors.includes("interrupt")) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): "assistant_text" | "reasoning_text" {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function providerThreadRef(
  context: ClaudeSessionContext,
): { readonly providerThreadId: string } | {} {
  return context.resumeSessionId ? { providerThreadId: context.resumeSessionId } : {};
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments.join("");
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger
          .write(
            {
              observedAt,
              event: {
                id:
                  "uuid" in message && typeof message.uuid === "string"
                    ? message.uuid
                    : crypto.randomUUID(),
                kind: "notification",
                provider: PROVIDER,
                createdAt: observedAt,
                method: sdkNativeMethod(message),
                ...(typeof message.session_id === "string"
                  ? { providerThreadId: message.session_id }
                  : {}),
                ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
                ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
                payload: message,
              },
            },
            null,
          );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<{
      threadId: ThreadId;
      turns: ReadonlyArray<{
        id: TurnId;
        items: ReadonlyArray<unknown>;
      }>;
    }, ProviderAdapterValidationError> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(turnState ? { providerTurnId: String(turnState.turnId) } : {}),
          },
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(turnState ? { providerTurnId: String(turnState.turnId) } : {}),
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        if (!turnState.messageCompleted) {
          if (!turnState.emittedTextDelta && turnState.fallbackAssistantText.length > 0) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: turnState.turnId,
              itemId: asRuntimeItemId(turnState.assistantItemId),
              payload: {
                streamKind: "assistant_text",
                delta: turnState.fallbackAssistantText,
              },
              providerRefs: {
                ...providerThreadRef(context),
                providerTurnId: String(turnState.turnId),
                providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
              },
            });
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            itemId: asRuntimeItemId(turnState.assistantItemId),
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
            },
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            providerTurnId: turnState.turnId,
          },
        });

        const updatedAt = yield* nowIso;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        if (event.type === "content_block_delta") {
          if (
            event.delta.type === "text_delta" &&
            event.delta.text.length > 0 &&
            context.turnState
          ) {
            let deltaText = event.delta.text;
            if (context.turnState.hadToolUseSinceLastText) {
              deltaText = "\n\n" + deltaText;
              context.turnState = {
                ...context.turnState,
                hadToolUseSinceLastText: false,
              };
            }
            if (!context.turnState.emittedTextDelta) {
              context.turnState = {
                ...context.turnState,
                emittedTextDelta: true,
              };
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(context.turnState.assistantItemId),
              payload: {
                streamKind: streamKindFromDeltaType(event.delta.type),
                delta: deltaText,
              },
              providerRefs: {
                ...providerThreadRef(context),
                providerTurnId: context.turnState.turnId,
                providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
              },
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }

          if (context.turnState && context.turnState.emittedTextDelta) {
            context.turnState = {
              ...context.turnState,
              hadToolUseSinceLastText: true,
            };
          }

          const toolName = block.name;
          const itemType = classifyToolItemType(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);

          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType),
            detail,
            input: toolInput,
          };
          context.inFlightTools.set(index, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
              createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: toolInput,
              },
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
          context.inFlightTools.delete(index);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
              createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "completed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: tool.input,
              },
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_stop",
              payload: message,
            },
          });
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          const fallbackAssistantText = extractAssistantText(message);
          if (
            fallbackAssistantText.length > 0 &&
            fallbackAssistantText !== context.turnState.fallbackAssistantText
          ) {
            context.turnState = {
              ...context.turnState,
              fallbackAssistantText,
            };
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            turnId: context.turnState.turnId,
            itemId: asRuntimeItemId(context.turnState.assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              title: "Assistant message",
              data: message.message,
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: context.turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant",
              payload: message,
            },
          });
        }

        // Iterate through tool_use blocks in the assistant message to:
        // 1. Emit item.updated with the full (non-empty) input for each tool
        //    (content_block_start only has empty {} input; the real input arrives here)
        // 2. Detect TodoWrite for plan updates
        if (context.turnState) {
          const msgContent = (message.message as { content?: unknown })?.content;
          if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (
                !block ||
                typeof block !== "object" ||
                !("type" in block) ||
                !("name" in block)
              ) {
                continue;
              }
              const blockType = (block as { type: string }).type;
              const isToolBlock =
                blockType === "tool_use" ||
                blockType === "server_tool_use" ||
                blockType === "mcp_tool_use";
              if (!isToolBlock) {
                continue;
              }

              const toolBlock = block as {
                type: string;
                id?: string;
                name: string;
                input?: unknown;
              };
              const toolName = toolBlock.name;
              const toolInput =
                toolBlock.input && typeof toolBlock.input === "object"
                  ? (toolBlock.input as Record<string, unknown>)
                  : {};
              const hasNonEmptyInput = Object.keys(toolInput).length > 0;

              // Emit item.updated with the full input for each tool_use block
              // so the UI can display the actual parameters instead of "{}"
              if (hasNonEmptyInput && toolBlock.id) {
                const itemType = classifyToolItemType(toolName);
                const detail = summarizeToolRequest(toolName, toolInput);
                const toolUpdateStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "item.updated",
                  eventId: toolUpdateStamp.eventId,
                  provider: PROVIDER,
                  createdAt: toolUpdateStamp.createdAt,
                  threadId: context.session.threadId,
                  turnId: context.turnState.turnId,
                  itemId: asRuntimeItemId(toolBlock.id),
                  payload: {
                    itemType,
                    status: "completed",
                    title: titleForTool(itemType),
                    detail,
                    data: {
                      toolName,
                      input: toolInput,
                    },
                  },
                  providerRefs: {
                    ...providerThreadRef(context),
                    providerTurnId: String(context.turnState.turnId),
                    providerItemId: ProviderItemId.makeUnsafe(toolBlock.id),
                  },
                  raw: {
                    source: "claude.sdk.message",
                    method: "claude/assistant/tool_use_updated",
                    payload: toolBlock,
                  },
                });
              }

              // Detect TodoWrite for plan updates
              if (
                (blockType === "tool_use" || blockType === "server_tool_use") &&
                toolName === "TodoWrite" &&
                Array.isArray(toolInput.todos)
              ) {
                const todos = toolInput.todos as Array<Record<string, unknown>>;
                const planSteps = todos
                  .filter((todo) => typeof todo.content === "string")
                  .map((todo) => ({
                    step: todo.content as string,
                    status:
                      todo.status === "completed"
                        ? ("completed" as const)
                        : todo.status === "in_progress"
                          ? ("inProgress" as const)
                          : ("pending" as const),
                  }));

                if (planSteps.length > 0) {
                  const planStamp = yield* makeEventStamp();
                  yield* offerRuntimeEvent({
                    type: "turn.plan.updated",
                    eventId: planStamp.eventId,
                    provider: PROVIDER,
                    createdAt: planStamp.createdAt,
                    threadId: context.session.threadId,
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                    payload: {
                      explanation: "Task list",
                      plan: planSteps,
                    },
                    providerRefs: {
                      ...providerThreadRef(context),
                      providerTurnId: String(context.turnState.turnId),
                    },
                  });
                }
              }
            }
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status = turnStatusFromResult(message);
        const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        switch (message.subtype) {
          case "init":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
                ...(message.prompt ? { prompt: message.prompt } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          case "task_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                ...(message.summary ? { summary: message.summary } : {}),
              },
            });
            return;
          case "task_notification":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
              },
            });
            return;
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          case "api_retry":
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.warning",
              payload: {
                message: `API retry: attempt ${message.attempt}/${message.max_retries}, retrying in ${message.retry_delay_ms}ms${message.error_status ? ` (HTTP ${message.error_status})` : ""}`,
                detail: {
                  attempt: message.attempt,
                  maxRetries: message.max_retries,
                  retryDelayMs: message.retry_delay_ms,
                  errorStatus: message.error_status,
                  error: message.error,
                },
              },
            });
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Stream.fromAsyncIterable(context.query, (cause) => cause).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause) || context.stopped) {
              return;
            }
            const message = toMessage(Cause.squash(cause), "Claude runtime stream failed.");

            // If the stream failed before any SDK message was received and we
            // were attempting a session resume, the persisted resume cursor is
            // likely stale (e.g. app restart while Claude daemon recycled).
            // Automatically retry with a fresh session so the user doesn't have
            // to manually recover.
            if (
              !context.resumeRetried &&
              context.resumeSessionId &&
              !context.lastThreadStartedId &&
              context.rebuildQueryWithoutResume
            ) {
              context.resumeRetried = true;
              yield* emitRuntimeWarning(
                context,
                `Claude session resume failed: ${message}. Retrying with a fresh session.`,
              );

              context.query.close();
              context.resumeSessionId = undefined;
              context.session = {
                ...context.session,
                resumeCursor: undefined,
              };
              context.query = context.rebuildQueryWithoutResume();
              yield* runSdkStream(context);
              return;
            }

            yield* emitRuntimeError(context, message, cause);
            yield* completeTurn(context, "failed", message);

            // Mark the session as dead so requireSession() rejects future
            // calls and ensureSessionForThread() starts a fresh session
            // instead of sending turns into a dead query.
            context.stopped = true;
            sessions.delete(context.session.threadId);
          }),
        ),
      );

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
              createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerRequestId: requestId,
            },
          });
        }
        context.pendingApprovals.clear();

        for (const [, pendingInput] of context.pendingUserInputs) {
          yield* Deferred.succeed(pendingInput.answers, {});
        }
        context.pendingUserInputs.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        context.query.close();

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
              createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        sessions.delete(context.session.threadId);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // Intercept AskUserQuestion: surface questions via user-input event pipeline
              // and block until the user answers in the UI.
              if (toolName === "AskUserQuestion") {
                const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
                const questionIdToText = new Map<string, string>();
                const eventQuestions = rawQuestions
                  .map((q: Record<string, unknown>, idx: number) => {
                    if (!q || typeof q !== "object") return undefined;
                    const questionText =
                      typeof q.question === "string" ? q.question.trim() : undefined;
                    const header = typeof q.header === "string" ? q.header.trim() : undefined;
                    const options = Array.isArray(q.options)
                      ? q.options
                          .map((o: Record<string, unknown>) => {
                            if (!o || typeof o !== "object") return undefined;
                            const label =
                              typeof o.label === "string" ? o.label.trim() : undefined;
                            const description =
                              typeof o.description === "string"
                                ? o.description.trim()
                                : undefined;
                            return label && description ? { label, description } : undefined;
                          })
                          .filter(
                            (o): o is { label: string; description: string } => o !== undefined,
                          )
                      : [];
                    if (!questionText || !header || options.length === 0) return undefined;
                    const id = `q-${idx}`;
                    questionIdToText.set(id, questionText);
                    return { id, header, question: questionText, options };
                  })
                  .filter(
                    (
                      q,
                    ): q is {
                      id: string;
                      header: string;
                      question: string;
                      options: Array<{ label: string; description: string }>;
                    } => q !== undefined,
                  );

                if (eventQuestions.length === 0) {
                  return {
                    behavior: "allow",
                    updatedInput: toolInput,
                  } satisfies PermissionResult;
                }

                const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
                const answersDeferred = yield* Deferred.make<Record<string, unknown>>();
                const pending: PendingUserInput = {
                  questionIdToText,
                  answers: answersDeferred,
                };

                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.requested",
                  eventId: stamp.eventId,
                  provider: PROVIDER,
                  createdAt: stamp.createdAt,
                  threadId: context.session.threadId,
                  ...(context.turnState
                    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                    : {}),
                  requestId: asRuntimeRequestId(requestId),
                  payload: {
                    questions: eventQuestions,
                  },
                  providerRefs: {
                    ...(context.session.threadId
                      ? { providerThreadId: context.session.threadId }
                      : {}),
                    ...(context.turnState
                      ? { providerTurnId: String(context.turnState.turnId) }
                      : {}),
                    providerRequestId: requestId,
                  },
                  raw: {
                    source: "claude.sdk.permission",
                    method: "canUseTool/AskUserQuestion",
                    payload: { toolName, input: toolInput },
                  },
                });

                pendingUserInputs.set(requestId, pending);

                const onAbort = () => {
                  if (!pendingUserInputs.has(requestId)) return;
                  pendingUserInputs.delete(requestId);
                  Effect.runFork(Deferred.succeed(answersDeferred, {}));
                };
                callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

                const rawAnswers = yield* Deferred.await(answersDeferred);
                pendingUserInputs.delete(requestId);

                // Map answers from question IDs back to question text keys (SDK format)
                const sdkAnswers: Record<string, string> = {};
                for (const [qId, value] of Object.entries(rawAnswers)) {
                  const questionText = questionIdToText.get(qId);
                  if (questionText && typeof value === "string") {
                    sdkAnswers[questionText] = value;
                  }
                }

                // Emit resolved event
                const resolvedStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "user-input.resolved",
                  eventId: resolvedStamp.eventId,
                  provider: PROVIDER,
                  createdAt: resolvedStamp.createdAt,
                  threadId: context.session.threadId,
                  ...(context.turnState
                    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                    : {}),
                  requestId: asRuntimeRequestId(requestId),
                  payload: {
                    answers: sdkAnswers,
                  },
                  providerRefs: {
                    ...(context.session.threadId
                      ? { providerThreadId: context.session.threadId }
                      : {}),
                    ...(context.turnState
                      ? { providerTurnId: String(context.turnState.turnId) }
                      : {}),
                    providerRequestId: requestId,
                  },
                  raw: {
                    source: "claude.sdk.permission",
                    method: "canUseTool/AskUserQuestion/resolved",
                    payload: { answers: sdkAnswers },
                  },
                });

                return {
                  behavior: "allow",
                  updatedInput: { ...toolInput, answers: sdkAnswers },
                } satisfies PermissionResult;
              }

              // Tools that are allowed during plan mode for codebase exploration.
              const PLAN_MODE_ALLOWED_TOOLS = new Set([
                "ExitPlanMode",
                "EnterPlanMode",
                "Read",
                "Grep",
                "Glob",
                "AskUserQuestion",
                "TodoWrite",
              ]);

              // In plan mode, allow exploration/read-only tools and ExitPlanMode
              // but deny all implementation tools (Edit, Write, Bash, etc.).
              if (
                context.activePermissionMode === "plan" &&
                !PLAN_MODE_ALLOWED_TOOLS.has(toolName)
              ) {
                return {
                  behavior: "deny",
                  message:
                    `DENIED — Plan mode is active. You cannot use "${toolName}" or any other implementation tool right now. ` +
                    "You may use Read, Grep, Glob, and AskUserQuestion to explore the codebase, " +
                    "then call the ExitPlanMode tool to propose your plan for review. " +
                    "Do NOT attempt to use any implementation tool.",
                } satisfies PermissionResult;
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              // ExitPlanMode must go through the approval flow even in full-access
              // so the user can review and approve/deny the plan.
              // EnterPlanMode needs special handling to switch the permission mode.
              if (
                runtimeMode === "full-access" &&
                toolName !== "ExitPlanMode" &&
                toolName !== "EnterPlanMode"
              ) {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              // When the model self-enters plan mode via EnterPlanMode, update
              // the adapter's permission mode so subsequent tool calls are
              // correctly filtered to read-only/exploration tools.
              if (toolName === "EnterPlanMode") {
                context.activePermissionMode = "plan";
                yield* Effect.tryPromise({
                  try: () => context.query.setPermissionMode("plan"),
                  catch: (cause) =>
                    toRequestError(
                      context.session.threadId,
                      "turn/setPermissionMode/enterPlan",
                      cause,
                    ),
                });
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                      createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: {
                      ...(context.session.threadId
                    ? { providerThreadId: context.session.threadId }
                    : {}),
                  ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
                  providerRequestId: requestId,
                },
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred);
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                      createdAt: resolvedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  decision,
                },
                providerRefs: {
                      ...(context.session.threadId
                    ? { providerThreadId: context.session.threadId }
                    : {}),
                  ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
                  providerRequestId: requestId,
                },
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/decision",
                  payload: {
                    decision,
                  },
                },
              });

              if (decision === "accept" || decision === "acceptForSession") {
                // When ExitPlanMode is approved, switch out of plan mode so
                // the model can proceed with implementation tools in the same
                // turn rather than telling the user to "exit plan mode".
                if (toolName === "ExitPlanMode" && context.activePermissionMode === "plan") {
                  const restoredMode = context.permissionMode ?? "default";
                  context.activePermissionMode = restoredMode;
                  yield* Effect.tryPromise({
                    try: () => context.query.setPermissionMode(restoredMode),
                    catch: (cause) =>
                      toRequestError(
                        context.session.threadId,
                        "turn/setPermissionMode/exitPlan",
                        cause,
                      ),
                  });
                }

                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : pendingApproval.declineMessage
                      ? `User declined. Feedback: ${pendingApproval.declineMessage}`
                      : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const providerOptions = input.providerOptions?.claudeCode;
        // Only honour an explicitly-configured permission mode from provider
        // options.  We intentionally do NOT map full-access → bypassPermissions
        // here: bypassPermissions + allowDangerouslySkipPermissions causes the
        // SDK to skip the canUseTool callback entirely, which prevents plan-mode
        // enforcement when the user switches interaction modes mid-session.
        // Instead, canUseTool handles the full-access allow-all policy and the
        // plan-mode deny policy in one place.
        const permissionMode = toPermissionMode(providerOptions?.permissionMode);

        const claudeModelOptions = input.modelOptions?.claudeCode;
        const effortLevel = claudeModelOptions?.effort;

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...((() => {
            const execPath = providerOptions?.binaryPath ?? resolveSystemClaudePath();
            return execPath ? { pathToClaudeCodeExecutable: execPath } : {};
          })()),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(effortLevel ? { effort: effortLevel } : {}),
          ...(providerOptions?.appendSystemPrompt
            ? {
                systemPrompt: {
                  type: "preset" as const,
                  preset: "claude_code" as const,
                  append: providerOptions.appendSystemPrompt,
                },
              }
            : {}),
          ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          ...(providerOptions?.mcpServers &&
          Object.keys(providerOptions.mcpServers).length > 0
            ? {
                mcpServers: providerOptions.mcpServers as Record<string, McpServerConfig>,
              }
            : {}),
          includePartialMessages: true,
          agentProgressSummaries: true,
          canUseTool,
          env: process.env,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        const session: ProviderSession = {
          threadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(threadId ? { threadId } : {}),
          resumeCursor: {
            ...(threadId ? { threadId } : {}),
            ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        // Build a callback that can recreate the query without resume options.
        // Used by runSdkStream to retry when a stale resume cursor causes the
        // Claude process to exit immediately.
        // Build a callback that can recreate the query without resume options.
        // Used by runSdkStream to retry when a stale resume cursor causes the
        // Claude process to exit immediately.
        const rebuildQueryWithoutResume = resumeState?.resume
          ? () => {
              const { resume: _r, resumeSessionAt: _s, ...freshOptions } = queryOptions;
              return createQuery({ prompt, options: freshOptions });
            }
          : undefined;

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          startedAt,
          resumeSessionId: resumeState?.resume,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          inFlightTools,
          permissionMode,
          activePermissionMode: permissionMode,
          turnState: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
          resumeRetried: false,
          rebuildQueryWithoutResume,
        };
        yield* Ref.set(contextRef, context);
        sessions.set(threadId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: sessionStartedStamp.createdAt,
          threadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: {},
        });

        const configuredStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: configuredStamp.eventId,
          provider: PROVIDER,
          createdAt: configuredStamp.createdAt,
          threadId,
          payload: {
            config: {
              ...(input.model ? { model: input.model } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(providerOptions?.maxThinkingTokens !== undefined
                ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                : {}),
              ...(effortLevel ? { effort: effortLevel } : {}),
            },
          },
          providerRefs: {},
        });

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          createdAt: readyStamp.createdAt,
          threadId,
          payload: {
            state: "ready",
          },
          providerRefs: {},
        });

        Effect.runFork(runSdkStream(context));

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);

        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Thread '${input.threadId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }

        if (input.model) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(input.model),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
        }

        // Apply effort level changes mid-session via applyFlagSettings
        const turnEffort = input.modelOptions?.claudeCode?.effort;
        if (turnEffort) {
          yield* Effect.tryPromise({
            try: () =>
              context.query.applyFlagSettings({
                effortLevel: turnEffort === "max" ? "high" : turnEffort,
              }),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings/effort", cause),
          });
        }

        const desiredPermissionMode: PermissionMode | undefined =
          input.interactionMode === "plan"
            ? "plan"
            : input.interactionMode === "default"
              ? (context.permissionMode ?? "default")
              : undefined;
        if (desiredPermissionMode !== undefined) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(desiredPermissionMode),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
          context.activePermissionMode = desiredPermissionMode;
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          assistantItemId: yield* Random.nextUUIDv4,
          startedAt: yield* nowIso,
          items: [],
          messageCompleted: false,
          emittedTextDelta: false,
          hadToolUseSinceLastText: false,
          fallbackAssistantText: "",
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: input.model ? { model: input.model } : {},
          providerRefs: {
            providerTurnId: String(turnId),
          },
        });

        const message = buildUserMessage(input);

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
      message,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        if (message) {
          pending.declineMessage = message;
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/requestUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeCodeAdapterShape;
  });
}

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
