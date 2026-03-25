import {
  type ChatAttachment,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type ProviderModelOptions,
  type ProviderKind,
  type ProviderStartOptions,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const WORKTREE_BRANCH_PREFIX = "t3code";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isUnknownPendingApprovalRequestError(error: unknown): boolean {
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadProviderOptions = new Map<string, ProviderStartOptions>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly provider?: ProviderKind;
      readonly model?: string;
      readonly modelOptions?: ProviderModelOptions;
      readonly providerOptions?: ProviderStartOptions;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined =
      thread.session?.providerName === "codex" ||
      thread.session?.providerName === "claudeCode" ||
      thread.session?.providerName === "cursor"
        ? thread.session.providerName
        : undefined;
    const preferredProvider: ProviderKind | undefined = options?.provider ?? currentProvider;
    const desiredModel = options?.model ?? thread.model;
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...((input?.provider ?? preferredProvider)
          ? { provider: input?.provider ?? preferredProvider }
          : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(desiredModel ? { model: desiredModel } : {}),
        ...(options?.modelOptions !== undefined ? { modelOptions: options.modelOptions } : {}),
        ...(options?.providerOptions !== undefined
          ? { providerOptions: options.providerOptions }
          : {}),
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        options?.provider !== undefined && options.provider !== currentProvider;
      const activeSession = yield* resolveActiveSession(existingSessionThreadId);
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged = options?.model !== undefined && options.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";

      // If the orchestration read model still shows a running session but no
      // live provider session exists (e.g. after app restart), fall through to
      // start a fresh provider session instead of returning the stale id.
      if (!activeSession) {
        yield* Effect.logInfo(
          "provider command reactor detected stale session after restart; starting fresh",
          {
            threadId,
            existingSessionThreadId,
            currentProvider,
          },
        );
      } else if (!runtimeModeChanged && !providerChanged && !shouldRestartForModelChange) {
        return existingSessionThreadId;
      }

      // When resuming after an app restart the in-memory session is gone, so
      // `activeSession?.resumeCursor` would be undefined.  Read the persisted
      // resume cursor from the session directory so the provider adapter can
      // rejoin the existing Claude conversation instead of starting fresh.
      const persistedBinding = yield* providerSessionDirectory.getBinding(threadId).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      const persistedResumeCursor = Option.match(persistedBinding, {
        onNone: () => undefined,
        onSome: (binding) => binding.resumeCursor ?? undefined,
      });

      // When restarting after an error with no live provider session, the
      // persisted `resumeSessionAt` (message UUID) may reference a message
      // that no longer exists in the Claude backend (e.g. "No message found
      // with message.uuid").  Strip it so the adapter resumes the session
      // without trying to skip to a specific message offset.
      const isErrorRecovery = !activeSession && thread.session?.status === "error";
      const rawResumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? persistedResumeCursor);
      const resumeCursor =
        isErrorRecovery && rawResumeCursor && typeof rawResumeCursor === "object"
          ? (() => {
              const { resumeSessionAt: _stale, ...rest } = rawResumeCursor as Record<string, unknown>;
              return Object.keys(rest).length > 0 ? rest : undefined;
            })()
          : rawResumeCursor;
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: options?.provider ?? currentProvider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession({
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        ...(options?.provider !== undefined ? { provider: options.provider } : {}),
      });
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(
      options?.provider !== undefined ? { provider: options.provider } : undefined,
    );
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly provider?: ProviderKind;
    readonly model?: string;
    readonly modelOptions?: ProviderModelOptions;
    readonly providerOptions?: ProviderStartOptions;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    if (input.providerOptions !== undefined) {
      threadProviderOptions.set(input.threadId, input.providerOptions);
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
    });
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const modelForTurn = sessionModelSwitch === "unsupported" ? activeSession?.model : input.model;

    yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { model: modelForTurn } : {}),
      ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const userMessages = thread.messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "provider command reactor failed to generate worktree branch name; skipping rename",
            { threadId: input.threadId, cwd, oldBranch, reason: error.message },
          ),
        ),
        Effect.flatMap((generated) => {
          if (!generated) return Effect.void;

          const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
          if (targetBranch === oldBranch) return Effect.void;

          return Effect.flatMap(
            git.renameBranch({ cwd, oldBranch, newBranch: targetBranch }),
            (renamed) =>
              orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("worktree-branch-rename"),
                threadId: input.threadId,
                branch: renamed.branch,
                worktreePath: cwd,
              }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            { threadId: input.threadId, cwd, oldBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
  });

  // ── Compaction ────────────────────────────────────────────────────
  // Build a concise summary of thread messages for context compaction.

  const COMPACT_MAX_SUMMARY_CHARS = 50_000;

  function buildCompactionSummary(
    messages: ReadonlyArray<{ role: string; text: string }>,
  ): string {
    const lines: string[] = [];
    lines.push("=== CONVERSATION SUMMARY (compacted) ===");
    lines.push("");
    lines.push(
      "The following is a summary of the conversation so far. " +
        "Continue from where we left off. Maintain all context about " +
        "files modified, decisions made, and current task state.",
    );
    lines.push("");

    let totalChars = 0;
    for (const msg of messages) {
      if (!msg.text || msg.text.trim().length === 0) continue;
      const prefix = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
      const line = `[${prefix}]: ${msg.text.trim()}`;
      if (totalChars + line.length > COMPACT_MAX_SUMMARY_CHARS) {
        lines.push("... (earlier messages truncated for brevity) ...");
        break;
      }
      lines.push(line);
      lines.push("");
      totalChars += line.length;
    }

    lines.push("=== END SUMMARY ===");
    return lines.join("\n");
  }

  const handleCompaction = Effect.fnUntraced(function* (
    threadId: ThreadId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thread: any,
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const now = event.payload.createdAt;

    // Build a summary from the thread's messages (last N messages, most recent first).
    const recentMessages = [...(thread.messages as ReadonlyArray<{ role: string; text: string }>)]
      .reverse()
      .slice(0, 100)
      .reverse();
    const summary = buildCompactionSummary(recentMessages);

    yield* Effect.logInfo("provider command reactor: compacting thread context", {
      threadId,
      messageCount: thread.messages.length,
      summaryLength: summary.length,
    });

    // Emit an activity so the UI shows compaction feedback to the user.
    yield* appendProviderFailureActivity({
      threadId,
      kind: "provider.turn.start.failed",
      summary: "Compacting context…",
      detail: `Restarting session with a ${Math.round(summary.length / 1024)}KB summary of the conversation.`,
      turnId: null,
      createdAt: now,
    }).pipe(Effect.catchCause(() => Effect.void));

    // 1. Stop the existing provider session.
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("compaction: failed to stop existing session", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    // 2. Mark the session as stopped in the orchestration read model.
    yield* setThreadSession({
      threadId,
      session: {
        threadId,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    // 3. Collect provider options, injecting the summary as appendSystemPrompt.
    const existingProviderOptions = threadProviderOptions.get(threadId);
    const compactProviderOptions: ProviderStartOptions = {
      ...existingProviderOptions,
      claudeCode: {
        ...existingProviderOptions?.claudeCode,
        appendSystemPrompt: summary,
      },
    };

    // 4. Start a fresh provider session (no resumeCursor → fresh context) with the summary.
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: (yield* orchestrationEngine.getReadModel()).projects,
    });
    const newSession = yield* providerService.startSession(threadId, {
      threadId,
      ...(thread.session?.providerName
        ? { provider: thread.session.providerName as ProviderKind }
        : {}),
      ...(cwd ? { cwd } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      providerOptions: compactProviderOptions,
      runtimeMode: thread.runtimeMode,
    });

    yield* setThreadSession({
      threadId,
      session: {
        threadId,
        status: mapProviderSessionStatusToOrchestrationStatus(newSession.status),
        providerName: newSession.provider,
        runtimeMode: thread.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    });

    // 5. Clear old conversation from the read model and replace with a summary marker.
    yield* orchestrationEngine.dispatch({
      type: "thread.context.compact",
      commandId: serverCommandId("context-compact"),
      threadId,
      summary,
      createdAt: now,
    });

    // 6. Send a follow-up turn so the model acknowledges the compacted context.
    //    This goes directly to the provider — the orchestration will pick up the
    //    turn via ProviderRuntimeIngestion when the provider emits events.
    yield* sendTurnForThread({
      threadId,
      messageText:
        "Context has been compacted. Please briefly acknowledge what you remember " +
        "from the conversation summary and confirm you're ready to continue.",
      interactionMode: event.payload.interactionMode,
      createdAt: now,
    });

    yield* Effect.logInfo("provider command reactor: compaction complete", {
      threadId,
      newSessionThreadId: newSession.threadId,
    });
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // ── Handle /compact command ──────────────────────────────────────
    if (message.text.trim() === "/compact") {
      yield* handleCompaction(event.payload.threadId, thread, event);
      return;
    }

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.provider !== undefined ? { provider: event.payload.provider } : {}),
      ...(event.payload.model !== undefined ? { model: event.payload.model } : {}),
      ...(event.payload.modelOptions !== undefined
        ? { modelOptions: event.payload.modelOptions }
        : {}),
      ...(event.payload.providerOptions !== undefined
        ? { providerOptions: event.payload.providerOptions }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    });
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
        ...(event.payload.message !== undefined ? { message: event.payload.message } : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause);
            const detail = toErrorMessage(error);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(error)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToUserInput({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: toErrorMessage(error),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });
          }),
        ),
      );
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(
            event.payload.threadId,
            event.occurredAt,
            cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : undefined,
          );
          return;
        }
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
      }
    });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ProviderCommandReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderIntentEvent>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue).pipe(Effect.asVoid));

    yield* Effect.forkScoped(
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap(processDomainEventSafely))),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.runtime-mode-set" &&
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.turn-interrupt-requested" &&
          event.type !== "thread.approval-response-requested" &&
          event.type !== "thread.user-input-response-requested" &&
          event.type !== "thread.session-stop-requested"
        ) {
          return Effect.void;
        }

        return Queue.offer(queue, event).pipe(Effect.asVoid);
      }),
    );
  });

  return {
    start,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
