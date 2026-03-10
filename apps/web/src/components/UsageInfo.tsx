import { useEffect, useState } from "react";
import type { UsageRateWindow } from "@t3tools/contracts";
import {
  useUsageInfo,
  windowLabel,
  resetCountdown,
  utilizationBarColor,
  utilizationColor,
} from "../hooks/useUsageInfo";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// ── Window row ──────────────────────────────────────────────────────

function WindowRow({ window }: { window: UsageRateWindow }) {
  const [countdown, setCountdown] = useState(() => resetCountdown(window.resetsAt));

  // Update countdown every 30 seconds
  useEffect(() => {
    if (!window.resetsAt) return;
    const id = setInterval(() => {
      setCountdown(resetCountdown(window.resetsAt));
    }, 30_000);
    return () => clearInterval(id);
  }, [window.resetsAt]);

  const remaining = Math.max(0, 100 - window.utilization);
  const barColor = utilizationBarColor(window.utilization);
  const statusWarning = window.status === "rejected";
  const statusCaution = window.status === "allowed_warning";

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground font-medium">
          {windowLabel(window.type)}
        </span>
        <span className={utilizationColor(window.utilization)}>
          {Math.round(remaining)}% left
        </span>
      </div>

      {/* Progress bar */}
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(100, window.utilization)}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
        {statusWarning ? (
          <span className="text-red-400 font-medium">Rate limited</span>
        ) : statusCaution ? (
          <span className="text-amber-400">Approaching limit</span>
        ) : (
          <span />
        )}
        {countdown && <span>Resets {countdown}</span>}
      </div>
    </div>
  );
}

// ── Compact inline badge for sidebar / header ───────────────────────

export function UsageInfoBadge() {
  const snapshot = useUsageInfo();
  const [, forceUpdate] = useState(0);

  // Force re-render every 30s for countdown updates
  useEffect(() => {
    const id = setInterval(() => forceUpdate((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!snapshot || snapshot.windows.length === 0) return null;

  // Show the most relevant window (five_hour first, then seven_day)
  const sessionWindow = snapshot.windows.find((w) => w.type === "five_hour");
  const weeklyWindow = snapshot.windows.find((w) => w.type === "seven_day");

  const primaryWindow = sessionWindow ?? snapshot.windows[0];
  if (!primaryWindow) return null;

  const remaining = Math.max(0, 100 - primaryWindow.utilization);
  const isWarning = primaryWindow.status === "rejected" || primaryWindow.status === "allowed_warning";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={`
              flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium
              transition-colors hover:bg-muted/60
              ${isWarning ? "text-amber-400" : "text-muted-foreground/70"}
            `}
          >
            {/* Mini progress indicator */}
            <div className="relative h-1 w-8 overflow-hidden rounded-full bg-muted/40">
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${utilizationBarColor(primaryWindow.utilization)}`}
                style={{ width: `${Math.min(100, primaryWindow.utilization)}%` }}
              />
            </div>
            <span>{Math.round(remaining)}%</span>
            {weeklyWindow && (
              <>
                <span className="text-muted-foreground/30">|</span>
                <span>{Math.round(Math.max(0, 100 - weeklyWindow.utilization))}%</span>
              </>
            )}
          </button>
        }
      />
      <TooltipPopup side="bottom" sideOffset={8} className="w-64 p-0">
        <UsageInfoPanel />
      </TooltipPopup>
    </Tooltip>
  );
}

// ── Full panel (used in tooltip and optionally standalone) ──────────

export function UsageInfoPanel() {
  const snapshot = useUsageInfo();

  const hasCost = snapshot?.sessionCostUsd != null && snapshot.sessionCostUsd > 0;
  const hasTokens = snapshot?.sessionTokens != null &&
    (snapshot.sessionTokens.inputTokens > 0 || snapshot.sessionTokens.outputTokens > 0);
  const hasWindows = snapshot != null && snapshot.windows.length > 0;

  if (!snapshot || (!hasWindows && !hasCost && !hasTokens)) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground/50">
        No usage data yet. Usage info appears after the first Claude Code interaction.
      </div>
    );
  }

  // Sort windows: five_hour first, then seven_day, then model-specific, then overage
  const sortOrder: Record<string, number> = {
    five_hour: 0,
    seven_day: 1,
    seven_day_sonnet: 2,
    seven_day_opus: 3,
    overage: 4,
  };
  const sortedWindows = [...snapshot.windows].sort(
    (a, b) => (sortOrder[a.type] ?? 99) - (sortOrder[b.type] ?? 99),
  );

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-muted-foreground">
          Claude Code Usage
        </span>
        <span className="text-[9px] text-muted-foreground/40">
          {new Date(snapshot.updatedAt).toLocaleTimeString()}
        </span>
      </div>

      {sortedWindows.map((window) => (
        <WindowRow key={window.type} window={window} />
      ))}

      {/* Session cost / tokens summary */}
      {(snapshot.sessionCostUsd != null || snapshot.sessionTokens != null) && (
        <div className="border-t border-muted/30 pt-2 space-y-0.5">
          {snapshot.sessionCostUsd != null && (
            <div className="flex justify-between text-[10px] text-muted-foreground/60">
              <span>Session cost</span>
              <span>${snapshot.sessionCostUsd.toFixed(4)}</span>
            </div>
          )}
          {snapshot.sessionTokens != null && (
            <div className="flex justify-between text-[10px] text-muted-foreground/60">
              <span>Tokens (in/out)</span>
              <span>
                {formatTokenCount(snapshot.sessionTokens.inputTokens)} /{" "}
                {formatTokenCount(snapshot.sessionTokens.outputTokens)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
