import { TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diff?: "1";
  diffTurnId?: TurnId;
  diffFilePath?: string;
  browser?: "1";
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "browser"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, browser: _browser, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath" | "browser">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const browser = isDiffOpenValue(search.browser) ? "1" : undefined;
  // Diff and browser are mutually exclusive — browser takes precedence
  const diff = browser ? undefined : isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(browser ? { browser } : {}),
  };
}
