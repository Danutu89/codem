import { memo, useState, useCallback } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import ChatMarkdown from "./ChatMarkdown";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LoaderIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { formatTimestamp } from "../session-logic";
import type { ActivePlanState } from "../session-logic";
import type { LatestProposedPlanState } from "../session-logic";
import type { PendingApproval } from "../session-logic";
import {
  proposedPlanTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  downloadPlanAsTextFile,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "./ui/toast";
import type { ApprovalRequestId } from "@t3tools/contracts";
import type { ProviderApprovalDecision } from "@t3tools/contracts";

function stepStatusIcon(status: string): React.ReactNode {
  if (status === "completed") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
        <CheckIcon className="size-3" />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
        <LoaderIcon className="size-3 animate-spin" />
      </span>
    );
  }
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
      <span className="size-1.5 rounded-full bg-muted-foreground/30" />
    </span>
  );
}

interface PlanSidebarProps {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  onClose: () => void;
  /** Pending plan approval, if any. When set, the sidebar shows approval controls. */
  pendingPlanApproval: PendingApproval | null;
  /** Whether a response to the pending approval is currently in flight. */
  isRespondingToApproval: boolean;
  /** Callback to respond to the pending plan approval. */
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    detail?: string,
  ) => Promise<void>;
  /** The last approved plan markdown, persisted after approval. */
  lastApprovedPlanMarkdown: string | null;
}

const PlanSidebar = memo(function PlanSidebar({
  activePlan,
  activeProposedPlan,
  markdownCwd,
  workspaceRoot,
  onClose,
  pendingPlanApproval,
  isRespondingToApproval,
  onRespondToApproval,
  lastApprovedPlanMarkdown,
}: PlanSidebarProps) {
  const [proposedPlanExpanded, setProposedPlanExpanded] = useState(false);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState("");

  // When there's a pending plan approval, use the approval detail as the plan markdown.
  // Otherwise fall back to the proposed plan, then the last approved plan.
  const approvalPlanMarkdown = pendingPlanApproval?.detail ?? null;
  const planMarkdown =
    approvalPlanMarkdown ??
    activeProposedPlan?.planMarkdown ??
    lastApprovedPlanMarkdown ??
    null;
  const displayedPlanMarkdown = planMarkdown ? stripDisplayedPlanMarkdown(planMarkdown) : null;
  const planTitle = planMarkdown ? proposedPlanTitle(planMarkdown) : null;

  const handleCopyPlan = useCallback(() => {
    if (!planMarkdown) return;
    void navigator.clipboard.writeText(planMarkdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [planMarkdown]);

  const handleDownload = useCallback(() => {
    if (!planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    downloadPlanAsTextFile(filename, normalizePlanMarkdownForExport(planMarkdown));
  }, [planMarkdown]);

  const handleSaveToWorkspace = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot || !planMarkdown) return;
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .then(
        () => setIsSavingToWorkspace(false),
        () => setIsSavingToWorkspace(false),
      );
  }, [planMarkdown, workspaceRoot]);

  const handleRequestChanges = useCallback(() => {
    if (!pendingPlanApproval || !feedback.trim()) return;
    void onRespondToApproval(pendingPlanApproval.requestId, "decline", feedback.trim());
    setFeedback("");
  }, [pendingPlanApproval, feedback, onRespondToApproval]);

  const isAwaitingApproval = pendingPlanApproval !== null;

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-l border-border/70 bg-card/50">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={cn(
              "rounded-md px-1.5 py-0 text-[10px] font-semibold tracking-wide uppercase",
              isAwaitingApproval
                ? "bg-amber-500/10 text-amber-400"
                : "bg-blue-500/10 text-blue-400",
            )}
          >
            {isAwaitingApproval ? "Review" : "Plan"}
          </Badge>
          {activePlan ? (
            <span className="text-[11px] text-muted-foreground/60">
              {formatTimestamp(activePlan.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {planMarkdown ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground/50 hover:text-foreground/70"
                    aria-label="Plan actions"
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={handleCopyPlan}>
                  {copied ? "Copied!" : "Copy to clipboard"}
                </MenuItem>
                <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
                <MenuItem
                  onClick={handleSaveToWorkspace}
                  disabled={!workspaceRoot || isSavingToWorkspace}
                >
                  Save to workspace
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close plan sidebar"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3 space-y-4">
          {/* Approval status banner */}
          {isAwaitingApproval ? (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <p className="text-[12px] font-medium text-amber-400">Plan ready for review</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground/60">
                Review the plan below and approve, request changes, or decline.
              </p>
            </div>
          ) : null}

          {/* Explanation */}
          {activePlan?.explanation ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground/80">
              {activePlan.explanation}
            </p>
          ) : null}

          {/* Plan Steps */}
          {activePlan && activePlan.steps.length > 0 ? (
            <div className="space-y-1">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Steps
              </p>
              {activePlan.steps.map((step) => (
                <div
                  key={`${step.status}:${step.step}`}
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-200",
                    step.status === "inProgress" && "bg-blue-500/5",
                    step.status === "completed" && "bg-emerald-500/5",
                  )}
                >
                  <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
                  <p
                    className={cn(
                      "text-[13px] leading-snug",
                      step.status === "completed"
                        ? "text-muted-foreground/50 line-through decoration-muted-foreground/20"
                        : step.status === "inProgress"
                          ? "text-foreground/90"
                          : "text-muted-foreground/70",
                    )}
                  >
                    {step.step}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Plan Markdown — shown expanded by default during approval, collapsible otherwise */}
          {planMarkdown ? (
            <div className="space-y-2">
              {isAwaitingApproval ? (
                // During approval: show the full plan expanded inline
                <div>
                  <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                    {planTitle ?? "Full Plan"}
                  </p>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <ChatMarkdown
                      text={displayedPlanMarkdown ?? ""}
                      cwd={markdownCwd}
                      isStreaming={false}
                    />
                  </div>
                </div>
              ) : (
                // After approval or during execution: collapsible
                <>
                  <button
                    type="button"
                    className="group flex w-full items-center gap-1.5 text-left"
                    onClick={() => setProposedPlanExpanded((v) => !v)}
                  >
                    {proposedPlanExpanded ? (
                      <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                    ) : (
                      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40 transition-transform" />
                    )}
                    <span className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase group-hover:text-muted-foreground/60">
                      {planTitle ?? "Full Plan"}
                    </span>
                  </button>
                  {proposedPlanExpanded ? (
                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <ChatMarkdown
                        text={displayedPlanMarkdown ?? ""}
                        cwd={markdownCwd}
                        isStreaming={false}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {/* Empty state — only when there's no plan content at all */}
          {!activePlan && !planMarkdown ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No active plan yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Plans will appear here when generated.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {/* Approval controls — pinned to the bottom of the sidebar */}
      {isAwaitingApproval ? (
        <div className="shrink-0 border-t border-border/60 bg-card/80 p-3 space-y-3">
          {/* Feedback textarea */}
          <div>
            <label className="block mb-1 text-[11px] font-medium text-muted-foreground/70">
              Suggest changes
            </label>
            <Textarea
              size="sm"
              placeholder="Describe what you'd like changed..."
              value={feedback}
              disabled={isRespondingToApproval}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && feedback.trim()) {
                  handleRequestChanges();
                }
              }}
              className="min-h-[60px] max-h-[120px] text-[12px]"
            />
          </div>

          {/* Action buttons */}
          <div className="flex flex-col gap-1.5">
            <Button
              size="sm"
              variant="default"
              className="w-full"
              disabled={isRespondingToApproval}
              onClick={() =>
                void onRespondToApproval(pendingPlanApproval.requestId, "accept")
              }
            >
              Approve plan
            </Button>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={isRespondingToApproval || !feedback.trim()}
                onClick={handleRequestChanges}
                title={
                  !feedback.trim()
                    ? "Type feedback above to request changes"
                    : undefined
                }
              >
                Request changes
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                className="flex-1"
                disabled={isRespondingToApproval}
                onClick={() =>
                  void onRespondToApproval(pendingPlanApproval.requestId, "decline")
                }
              >
                Decline
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="w-full text-muted-foreground/60"
              disabled={isRespondingToApproval}
              onClick={() =>
                void onRespondToApproval(pendingPlanApproval.requestId, "cancel")
              }
            >
              Cancel turn
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default PlanSidebar;
export type { PlanSidebarProps };
