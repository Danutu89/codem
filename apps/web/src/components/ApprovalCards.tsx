import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { FileIcon, TerminalIcon, FilePenIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import type { PendingApproval } from "../session-logic";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

// ---------------------------------------------------------------------------
// Shared CSS for inline diff rendering (mirrors DiffPanel theming)
// ---------------------------------------------------------------------------
const APPROVAL_DIFF_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}
`;

// ---------------------------------------------------------------------------
// Shared action buttons footer
// ---------------------------------------------------------------------------
interface ApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    message?: string,
  ) => Promise<void>;
}

function ApprovalActions({ requestId, isResponding, onRespondToApproval }: ApprovalActionsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-3">
      <Button
        size="xs"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommandApprovalCard — terminal-style rendering for Bash/command approvals
// ---------------------------------------------------------------------------
export const CommandApprovalCard = memo(function CommandApprovalCard({
  approval,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  isResponding: boolean;
  onRespondToApproval: ApprovalActionsProps["onRespondToApproval"];
}) {
  const command =
    (approval.toolInput?.command as string | undefined) ??
    (approval.toolInput?.cmd as string | undefined) ??
    "";
  const description = approval.toolInput?.description as string | undefined;
  const toolLabel = approval.toolName ?? "Bash";

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <TerminalIcon className="size-4 text-warning" />
        <span className="text-xs font-medium text-foreground">
          Command approval requested
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {toolLabel}
        </span>
      </div>

      {/* Description (if provided by the tool) */}
      {description && (
        <p className="mb-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
          {description}
        </p>
      )}

      {/* Terminal-style command display */}
      <div className="rounded-lg border border-border/60 bg-zinc-950 dark:bg-zinc-900/80 px-4 py-3 overflow-x-auto">
        <pre className="font-mono text-[12px] leading-relaxed text-emerald-400 whitespace-pre-wrap break-words">
          <span className="select-none text-zinc-500 mr-2">$</span>
          {command || approval.detail}
        </pre>
      </div>

      {/* Actions */}
      <ApprovalActions
        requestId={approval.requestId}
        isResponding={isResponding}
        onRespondToApproval={onRespondToApproval}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// FileChangeApprovalCard — diff panel for Edit/Write approvals
// ---------------------------------------------------------------------------

/** Build a minimal unified diff from old_string / new_string (Edit tool). */
function buildUnifiedDiff(
  filePath: string,
  oldString: string,
  newString: string,
): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const header = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  const removals = oldLines.map((line) => `-${line}`);
  const additions = newLines.map((line) => `+${line}`);
  return [...header, ...removals, ...additions].join("\n");
}

export const FileChangeApprovalCard = memo(function FileChangeApprovalCard({
  approval,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  isResponding: boolean;
  onRespondToApproval: ApprovalActionsProps["onRespondToApproval"];
}) {
  const { resolvedTheme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const toolInput = approval.toolInput ?? {};
  const filePath = (toolInput.file_path as string | undefined) ?? "";
  const oldString = (toolInput.old_string as string | undefined) ?? "";
  const newString = (toolInput.new_string as string | undefined) ?? "";
  const writeContent = (toolInput.content as string | undefined) ?? "";
  const isWrite = approval.toolName === "Write" || (!oldString && !!writeContent);
  const toolLabel = approval.toolName ?? "Edit";

  // Build a unified diff string for the @pierre/diffs renderer
  const patchText = useMemo(() => {
    if (isWrite) {
      // For Write, show the full content as additions
      const lines = writeContent.split("\n");
      const header = [
        `--- /dev/null`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
      ];
      const additions = lines.map((line) => `+${line}`);
      return [...header, ...additions].join("\n");
    }
    if (oldString || newString) {
      return buildUnifiedDiff(filePath, oldString, newString);
    }
    return null;
  }, [filePath, oldString, newString, writeContent, isWrite]);

  const parsedFiles: FileDiffMetadata[] = useMemo(() => {
    if (!patchText) return [];
    try {
      const cacheKey = buildPatchCacheKey(patchText, "approval-diff");
      const patches = parsePatchFiles(patchText, cacheKey);
      return patches.flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patchText]);

  const canCollapse = (patchText?.split("\n").length ?? 0) > 30;
  const showExpander = canCollapse && !expanded;

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <FilePenIcon className="size-4 text-warning" />
        <span className="text-xs font-medium text-foreground">
          File-change approval requested
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {toolLabel}
        </span>
      </div>

      {/* File path */}
      <div className="mb-2 rounded-md bg-muted/40 px-3 py-1.5 font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-all">
        {filePath || "unknown file"}
      </div>

      {/* Diff view */}
      {parsedFiles.length > 0 ? (
        <div
          className={cn(
            "relative rounded-lg border border-border/60 overflow-hidden",
            showExpander && "max-h-80",
          )}
        >
          {parsedFiles.map((fileDiff, index) => (
            <FileDiff
              key={fileDiff.cacheKey ?? index}
              fileDiff={fileDiff}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                theme: resolveDiffThemeName(resolvedTheme as "light" | "dark"),
                themeType: resolvedTheme as "light" | "dark",
                unsafeCSS: APPROVAL_DIFF_CSS,
              }}
            />
          ))}
          {showExpander && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
          )}
        </div>
      ) : patchText ? (
        /* Fallback: show raw patch as preformatted text */
        <div
          className={cn(
            "relative rounded-lg border border-border/60 bg-muted/20 overflow-hidden",
            showExpander && "max-h-80",
          )}
        >
          <pre className="p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">
            {patchText}
          </pre>
          {showExpander && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
          )}
        </div>
      ) : (
        /* No structured data — show the raw detail */
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <pre className="font-mono text-[11px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">
            {approval.detail ?? "File change details unavailable"}
          </pre>
        </div>
      )}

      {canCollapse && (
        <div className="flex justify-center mt-1">
          <Button size="xs" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show full diff"}
          </Button>
        </div>
      )}

      {/* Actions */}
      <ApprovalActions
        requestId={approval.requestId}
        isResponding={isResponding}
        onRespondToApproval={onRespondToApproval}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// FileReadApprovalCard — simple file-path display for read approvals
// ---------------------------------------------------------------------------
export const FileReadApprovalCard = memo(function FileReadApprovalCard({
  approval,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  isResponding: boolean;
  onRespondToApproval: ApprovalActionsProps["onRespondToApproval"];
}) {
  const filePath =
    (approval.toolInput?.file_path as string | undefined) ??
    (approval.toolInput?.path as string | undefined) ??
    "";
  const toolLabel = approval.toolName ?? "Read";

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <FileIcon className="size-4 text-warning" />
        <span className="text-xs font-medium text-foreground">
          File-read approval requested
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {toolLabel}
        </span>
      </div>

      {/* File path display */}
      <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
        <p className="font-mono text-[12px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-all">
          {filePath || approval.detail || "File path unavailable"}
        </p>
      </div>

      {/* Actions */}
      <ApprovalActions
        requestId={approval.requestId}
        isResponding={isResponding}
        onRespondToApproval={onRespondToApproval}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// GenericApprovalCard — fallback for any unrecognized tool type
// ---------------------------------------------------------------------------
export const GenericApprovalCard = memo(function GenericApprovalCard({
  approval,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  isResponding: boolean;
  onRespondToApproval: ApprovalActionsProps["onRespondToApproval"];
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <FileIcon className="size-4 text-warning" />
        <span className="text-xs font-medium text-foreground">
          {approval.requestKind === "command"
            ? "Command approval requested"
            : approval.requestKind === "file-read"
              ? "File-read approval requested"
              : "File-change approval requested"}
        </span>
        {approval.toolName && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {approval.toolName}
          </span>
        )}
      </div>

      {/* Detail */}
      {approval.detail && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
          <pre className="font-mono text-[11px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">
            {approval.detail}
          </pre>
        </div>
      )}

      {/* Actions */}
      <ApprovalActions
        requestId={approval.requestId}
        isResponding={isResponding}
        onRespondToApproval={onRespondToApproval}
      />
    </div>
  );
});
