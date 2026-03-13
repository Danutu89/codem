/**
 * Live Browser Panel — Electron-only right sidebar panel.
 *
 * Displays the browser toolbar (URL bar, navigation buttons, inspect toggle)
 * and selected element info. The actual browser viewport is rendered by
 * Electron's WebContentsView, positioned over this panel's content area.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type ThreadId } from "@t3tools/contracts";
import { useLiveBrowserStore } from "../liveBrowserStore";
import { useComposerDraftStore, type ComposerImageAttachment } from "../composerDraftStore";
import { Button } from "./ui/button";
import type { LiveBrowserInspectResult } from "@t3tools/contracts";

// ── Icons (inline SVGs to avoid dependencies) ─────────────────────

function ArrowLeftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 5 7 7-7 7" /><path d="M5 12h14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" /><path d="M16 16h5v5" />
    </svg>
  );
}

function CrosshairIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="22" x2="18" y1="12" y2="12" /><line x1="6" x2="2" y1="12" y2="12" /><line x1="12" x2="12" y1="2" y2="6" /><line x1="12" x2="12" y1="18" y2="22" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  );
}

function FileCodeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="m10 13-2 2 2 2" /><path d="m14 17 2-2-2-2" />
    </svg>
  );
}

function MessageSquarePlusIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v6" /><path d="M9 10h6" />
    </svg>
  );
}

// ── Selected Element Card ──────────────────────────────────────────

const SelectedElementCard = memo(function SelectedElementCard({
  element,
  onAddToComposer,
  onScreenshot,
  onOpenSource,
  onClear,
}: {
  element: LiveBrowserInspectResult;
  onAddToComposer: () => void;
  onScreenshot: () => void;
  onOpenSource: () => void;
  onClear: () => void;
}) {
  return (
    <div className="border-t border-border bg-card p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-foreground">Selected Element</span>
        <Button variant="ghost" size="icon-xs" onClick={onClear}>
          <XIcon />
        </Button>
      </div>

      {/* Tag and selector */}
      <div className="mb-1.5 font-mono text-xs text-muted-foreground">
        <span className="text-blue-500">&lt;{element.tagName}</span>
        {element.id && <span className="text-green-500"> #{element.id}</span>}
        {element.classes.length > 0 && (
          <span className="text-yellow-600 dark:text-yellow-400">
            .{element.classes.slice(0, 3).join(".")}
          </span>
        )}
        <span className="text-blue-500">&gt;</span>
      </div>

      {/* Framework component info */}
      {element.componentName && (
        <div className="mb-1.5 flex items-center gap-1.5 text-xs">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
            {element.framework === "react" ? "⚛" : element.framework === "vue" ? "🟢" : "🟠"}{" "}
            {element.componentName}
          </span>
        </div>
      )}

      {/* Source location */}
      {element.sourceLocation && (
        <button
          type="button"
          className="mb-2 flex items-center gap-1 text-xs text-blue-500 hover:underline"
          onClick={onOpenSource}
        >
          <FileCodeIcon />
          <span className="truncate">
            {element.sourceLocation.file}:{element.sourceLocation.line}
          </span>
        </button>
      )}

      {/* Truncated text content */}
      {element.textContent && (
        <div className="mb-2 truncate text-xs text-muted-foreground/70">
          "{element.textContent.slice(0, 100)}"
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5">
        <Button variant="outline" size="xs" onClick={onAddToComposer}>
          <MessageSquarePlusIcon />
          Add to Composer
        </Button>
        <Button variant="outline" size="xs" onClick={onScreenshot}>
          <CameraIcon />
          Screenshot
        </Button>
      </div>
    </div>
  );
});

// ── Main Panel Component ───────────────────────────────────────────

function LiveBrowserPanel({
  onClose,
  threadId,
}: {
  onClose: () => void;
  threadId?: string;
}) {
  const {
    isOpen,
    status,
    url,
    title,
    isInspecting,
    selectedElement,
    error,
    open,
    close,
    navigate,
    back,
    forward,
    reload,
    toggleInspect,
    clearSelectedElement,
    screenshotSelectedElement,
    setBounds,
  } = useLiveBrowserStore();

  const addImage = useComposerDraftStore((s) => s.addImage);
  const setPrompt = useComposerDraftStore((s) => s.setPrompt);

  const [urlInput, setUrlInput] = useState(url);
  const contentRef = useRef<HTMLDivElement>(null);

  // Close the native WebContentsView when this panel unmounts (thread change,
  // sidebar closed via navigation, etc.) so the overlay doesn't linger.
  useEffect(() => {
    return () => {
      void useLiveBrowserStore.getState().close();
    };
  }, []);

  // Sync URL input when URL changes externally
  useEffect(() => {
    setUrlInput(url);
  }, [url]);

  // Report content area bounds to Electron for WebContentsView positioning
  useEffect(() => {
    if (!isOpen || !contentRef.current) return;

    const updateBounds = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    // Initial bounds
    updateBounds();

    // Watch for resizes
    const observer = new ResizeObserver(updateBounds);
    observer.observe(contentRef.current);

    // Also update on window resize (for macOS traffic light area changes etc.)
    window.addEventListener("resize", updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [isOpen, setBounds]);

  const handleUrlSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      let targetUrl = urlInput.trim();
      if (!targetUrl) return;
      // Auto-prefix with http:// if no protocol
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = `http://${targetUrl}`;
      }
      if (isOpen) {
        void navigate(targetUrl);
      } else {
        void open(targetUrl);
      }
    },
    [urlInput, isOpen, navigate, open],
  );

  const handleClose = useCallback(() => {
    void close();
    onClose();
  }, [close, onClose]);

  const handleAddToComposer = useCallback(() => {
    if (!selectedElement || !threadId) return;

    // Build a descriptive text for the composer
    let description = `[Element: <${selectedElement.tagName}`;
    if (selectedElement.id) description += ` id="${selectedElement.id}"`;
    if (selectedElement.classes.length > 0) {
      description += ` class="${selectedElement.classes.slice(0, 3).join(" ")}"`;
    }
    description += ">";
    if (selectedElement.componentName) {
      description += ` in ${selectedElement.componentName}`;
    }
    if (selectedElement.sourceLocation) {
      description += ` (${selectedElement.sourceLocation.file}:${selectedElement.sourceLocation.line})`;
    }
    description += "]";

    // Append to existing prompt
    const currentDraft = useComposerDraftStore.getState().draftsByThreadId[threadId as ThreadId];
    const currentPrompt = currentDraft?.prompt ?? "";
    const separator = currentPrompt.length > 0 ? "\n" : "";
    setPrompt(threadId as ThreadId, currentPrompt + separator + description);
  }, [selectedElement, threadId, setPrompt]);

  const handleScreenshot = useCallback(async () => {
    if (!selectedElement || !threadId) return;
    const result = await screenshotSelectedElement();
    if (result) {
      // Convert base64 PNG to a File object and add as image attachment
      const byteString = atob(result.screenshot);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: "image/png" });
      const file = new File([blob], `element-${Date.now()}.png`, { type: "image/png" });
      const previewUrl = URL.createObjectURL(blob);

      const attachment: ComposerImageAttachment = {
        type: "image",
        id: `lb-screenshot-${Date.now()}`,
        name: file.name,
        mimeType: "image/png",
        sizeBytes: file.size,
        previewUrl,
        file,
      };
      addImage(threadId as ThreadId, attachment);
    }
  }, [selectedElement, threadId, screenshotSelectedElement, addImage]);

  const handleOpenSource = useCallback(() => {
    if (!selectedElement?.sourceLocation) return;
    // Use shell.openInEditor via the native API
    const api = (window as unknown as { nativeApi?: { shell?: { openInEditor?: (cwd: string, editor: string) => void } } }).nativeApi;
    if (api?.shell?.openInEditor) {
      // For now, just open externally — source resolution would be done server-side
      void (window.desktopBridge as { openExternal?: (url: string) => Promise<boolean> })?.openExternal?.(
        `vscode://file/${selectedElement.sourceLocation.file}:${selectedElement.sourceLocation.line}`,
      );
    }
  }, [selectedElement]);

  return (
    <div className="flex h-full flex-col bg-card text-foreground">
      {/* Header / Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {/* Navigation buttons */}
        <Button variant="ghost" size="icon-xs" onClick={() => void back()} title="Back">
          <ArrowLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => void forward()} title="Forward">
          <ArrowRightIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => void reload()} title="Reload">
          <RefreshIcon />
        </Button>

        {/* URL bar */}
        <form onSubmit={handleUrlSubmit} className="flex min-w-0 flex-1">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL (e.g. localhost:3000)"
            className="h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-1 focus:ring-ring"
          />
        </form>

        {/* Inspect mode toggle */}
        <Button
          variant={isInspecting ? "default" : "ghost"}
          size="icon-xs"
          onClick={() => void toggleInspect()}
          title="Inspect element"
        >
          <CrosshairIcon />
        </Button>

        {/* Close button */}
        <Button variant="ghost" size="icon-xs" onClick={handleClose} title="Close browser">
          <XIcon />
        </Button>
      </div>

      {/* Browser viewport area — Electron's WebContentsView overlays this */}
      <div
        ref={contentRef}
        className="relative min-h-0 flex-1"
      >
        {/* Status overlays (shown when browser is not yet running or has error) */}
        {status === "idle" && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
            <div className="text-center">
              <p className="mb-2">Enter a URL to start browsing</p>
              <p className="text-xs">The browser will appear here</p>
            </div>
          </div>
        )}
        {status === "starting" && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
            Loading...
          </div>
        )}
        {status === "error" && error && (
          <div className="flex h-full items-center justify-center p-4 text-sm text-destructive">
            <div className="text-center">
              <p className="mb-1 font-medium">Browser Error</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          </div>
        )}
        {/* When running, this area is overlaid by the WebContentsView — it's transparent */}
      </div>

      {/* Selected element info */}
      {selectedElement && (
        <SelectedElementCard
          element={selectedElement}
          onAddToComposer={handleAddToComposer}
          onScreenshot={() => void handleScreenshot()}
          onOpenSource={handleOpenSource}
          onClear={clearSelectedElement}
        />
      )}
    </div>
  );
}

export default memo(LiveBrowserPanel);
