/**
 * Browser Test Panel — shown after a coding turn completes.
 *
 * Provides a "Test" button that triggers AI-powered browser verification
 * using a local LM Studio instance. Displays real-time progress and results.
 *
 * The test app URL is stored per-project in localStorage so that multiple
 * projects can be tested in parallel with different URLs.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BrowserTestProgress, BrowserTestResult } from "@t3tools/contracts";
import { useAppSettings } from "../appSettings";
import { ensureNativeApi } from "../nativeApi";
import { Button } from "./ui/button";

type TestPhase = "idle" | "running" | "completed" | "error";

interface StepInfo {
  readonly stepNumber: number;
  readonly action: string;
  readonly target: string;
  readonly success: boolean;
  readonly detail?: string | undefined;
}

interface BrowserTestState {
  phase: TestPhase;
  message: string;
  steps: StepInfo[];
  result: BrowserTestResult | null;
  error: string | null;
}

const INITIAL_STATE: BrowserTestState = {
  phase: "idle",
  message: "",
  steps: [],
  result: null,
  error: null,
};

// ── Per-project test URL helpers ──────────────────────────────────────

function storageKey(projectId: string): string {
  return `t3code:project-test-url:${projectId}`;
}

function loadProjectTestUrl(projectId: string | undefined): string {
  if (!projectId) return "";
  try {
    return localStorage.getItem(storageKey(projectId)) ?? "";
  } catch {
    return "";
  }
}

function saveProjectTestUrl(projectId: string, url: string): void {
  try {
    if (url) {
      localStorage.setItem(storageKey(projectId), url);
    } else {
      localStorage.removeItem(storageKey(projectId));
    }
  } catch {
    // Ignore storage errors
  }
}

// ── Component ─────────────────────────────────────────────────────────

function BrowserTestPanel({ projectId, agentSummary, userPrompt }: { projectId: string | undefined; agentSummary?: string | undefined; userPrompt?: string | undefined }) {
  const { settings } = useAppSettings();
  const [state, setState] = useState<BrowserTestState>(INITIAL_STATE);
  const [appUrl, setAppUrl] = useState(() => loadProjectTestUrl(projectId));
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Sync URL from localStorage when projectId changes
  useEffect(() => {
    setAppUrl(loadProjectTestUrl(projectId));
  }, [projectId]);

  // Persist URL to localStorage on change
  const handleUrlChange = useCallback(
    (value: string) => {
      setAppUrl(value);
      if (projectId) {
        saveProjectTestUrl(projectId, value);
      }
    },
    [projectId],
  );

  // Clean up progress listener on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const handleRunTest = useCallback(() => {
    const trimmedUrl = appUrl.trim();
    if (!trimmedUrl) {
      setState({
        ...INITIAL_STATE,
        phase: "error",
        error: "Enter an App URL above before running tests.",
      });
      return;
    }

    const endpoint = settings.lmStudioEndpoint || "http://localhost:1234/v1";
    const modelId = settings.lmStudioModelId || "";

    setState({
      phase: "running",
      message: "Starting browser test...",
      steps: [],
      result: null,
      error: null,
    });

    const api = ensureNativeApi();

    // Subscribe to progress events
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }
    unsubscribeRef.current = api.browserTest.onProgress((progress: BrowserTestProgress) => {
      setState((prev) => {
        if (progress.status === "running") {
          return { ...prev, message: progress.message };
        }
        if (progress.status === "step" && progress.step) {
          return {
            ...prev,
            message: progress.message,
            steps: [...prev.steps, progress.step],
          };
        }
        if (progress.status === "completed" && progress.summary) {
          return {
            ...prev,
            phase: "completed",
            message: progress.message,
            result: {
              passed: progress.summary.passed,
              totalSteps: progress.summary.totalSteps,
              durationMs: progress.summary.durationMs,
              aiSummary: progress.summary.aiSummary,
              steps: prev.steps,
              consoleLogs: [],
              screenshots: [],
            },
          };
        }
        if (progress.status === "error") {
          return {
            ...prev,
            phase: "error",
            error: progress.error ?? progress.message,
          };
        }
        return prev;
      });
    });

    // Fire off the test (don't await — results come from WS push + the promise)
    api.browserTest
      .run({
        appUrl: trimmedUrl,
        lmStudioEndpoint: endpoint,
        lmStudioModelId: modelId,
        instructions: agentSummary || undefined,
        userPrompt: userPrompt || undefined,
      })
      .then((result) => {
        setState((prev) => ({
          ...prev,
          phase: "completed",
          message: result.passed ? "Tests passed" : "Tests failed",
          result,
        }));
      })
      .catch((err) => {
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        }));
      })
      .finally(() => {
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
      });
  }, [appUrl, agentSummary, settings.lmStudioEndpoint, settings.lmStudioModelId]);

  const handleStopTest = useCallback(() => {
    const api = ensureNativeApi();
    api.browserTest.stop().catch(() => {});
  }, []);

  const handleReset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const { phase, message, steps, result, error } = state;

  // No project selected — can't store per-project URL
  if (!projectId) {
    return null;
  }

  // Idle: show URL input + Test button
  if (phase === "idle") {
    return (
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={appUrl}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="http://localhost:3000"
            className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button type="button" size="sm" variant="outline" onClick={handleRunTest}>
            <TestTubeIcon className="mr-1.5 h-3.5 w-3.5" />
            Test in Browser
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <TestTubeIcon className="mr-1 inline-block h-3 w-3" />
          Browser Test
        </p>
        <div className="flex items-center gap-1.5">
          {phase === "running" && (
            <Button type="button" size="xs" variant="outline" onClick={handleStopTest}>
              Stop
            </Button>
          )}
          {(phase === "completed" || phase === "error") && (
            <Button type="button" size="xs" variant="outline" onClick={handleReset}>
              Dismiss
            </Button>
          )}
          {(phase === "completed" || phase === "error") && (
            <Button type="button" size="xs" variant="outline" onClick={handleRunTest}>
              Re-run
            </Button>
          )}
        </div>
      </div>

      {/* Running state */}
      {phase === "running" && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            <span className="text-xs text-foreground">{message}</span>
          </div>
          {steps.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded border border-border/50 bg-background/50 p-1.5">
              {steps.map((step) => (
                <div
                  key={step.stepNumber}
                  className="flex items-start gap-1.5 py-0.5 text-[11px]"
                >
                  <span className={step.success ? "text-green-500" : "text-red-500"}>
                    {step.success ? "✓" : "✗"}
                  </span>
                  <span className="text-muted-foreground">
                    {step.action}
                    {step.target ? ` → ${step.target.slice(0, 60)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {phase === "error" && error && (
        <div className="rounded border border-red-500/30 bg-red-500/8 px-2.5 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Completed state */}
      {phase === "completed" && result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                result.passed ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-sm font-medium text-foreground">
              {result.passed ? "All checks passed" : "Issues detected"}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {result.totalSteps} steps • {formatMs(result.durationMs)}
            </span>
          </div>

          {/* AI Summary */}
          <div className="rounded border border-border/50 bg-background/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {result.aiSummary.slice(0, 2000)}
          </div>

          {/* Step details (collapsed by default) */}
          {result.steps.length > 0 && (
            <StepDetails steps={[...result.steps]} />
          )}
        </div>
      )}
    </div>
  );
}

function StepDetails({
  steps,
}: {
  steps: readonly StepInfo[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? "Hide" : "Show"} step details ({steps.length})
      </button>
      {expanded && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border border-border/50 bg-background/50 p-1.5">
          {steps.map((step) => (
            <div key={step.stepNumber} className="flex items-start gap-1.5 py-0.5 text-[11px]">
              <span className={step.success ? "text-green-500" : "text-red-500"}>
                {step.success ? "✓" : "✗"}
              </span>
              <span className="text-muted-foreground">
                <span className="font-medium">{step.action}</span>
                {step.target ? ` → ${step.target.slice(0, 80)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function TestTubeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5V2" />
      <path d="M8.5 2h7" />
      <path d="M14.5 16h-5" />
    </svg>
  );
}

export default memo(BrowserTestPanel);
