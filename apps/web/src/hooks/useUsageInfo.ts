import { useEffect, useState } from "react";
import type { ProviderUsageSnapshot } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";

/**
 * Subscribe to real-time provider usage updates (rate limits, token usage, cost).
 *
 * Returns `null` until the first usage event arrives from the server.
 */
export function useUsageInfo(): ProviderUsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<ProviderUsageSnapshot | null>(null);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.usage.onUsageUpdated(setSnapshot);
  }, []);

  return snapshot;
}

// ── Formatting helpers ──────────────────────────────────────────────

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session (5h)",
  seven_day: "Weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  overage: "Overage",
};

export function windowLabel(type: string): string {
  return WINDOW_LABELS[type] ?? type;
}

/**
 * Format a reset countdown from an ISO timestamp.
 * Returns strings like "in 2h 30m", "in 4d 12h", "in 45m", "now".
 */
export function resetCountdown(resetsAtIso: string | null): string | null {
  if (!resetsAtIso) return null;
  const now = Date.now();
  const resetMs = new Date(resetsAtIso).getTime();
  const seconds = Math.max(0, (resetMs - now) / 1000);
  if (seconds < 1) return "now";

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes / 60) % 24);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }
  return `in ${totalMinutes}m`;
}

/**
 * Return a color class for a utilization percentage.
 */
export function utilizationColor(percent: number): string {
  if (percent >= 90) return "text-red-400";
  if (percent >= 70) return "text-amber-400";
  return "text-emerald-400";
}

export function utilizationBarColor(percent: number): string {
  if (percent >= 90) return "bg-red-400";
  if (percent >= 70) return "bg-amber-400";
  return "bg-emerald-400";
}
