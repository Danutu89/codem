/**
 * Zustand store for the Live Browser panel state.
 *
 * Manages the embedded browser's open/close state, URL, inspect mode,
 * and selected element info. Only functional in Electron (checks for
 * window.desktopBridge?.liveBrowser).
 */
import { create } from "zustand";
import type {
  LiveBrowserInspectResult,
  LiveBrowserState,
  LiveBrowserElementScreenshot,
} from "@t3tools/contracts";

interface LiveBrowserStoreState {
  /** Whether the live browser feature is available (Electron only) */
  isAvailable: boolean;
  /** Whether the browser panel is currently open */
  isOpen: boolean;
  /** Current browser status */
  status: LiveBrowserState["status"];
  /** Current URL loaded in the browser */
  url: string;
  /** Current page title */
  title: string;
  /** Whether element inspect mode is active */
  isInspecting: boolean;
  /** Currently selected/inspected element info */
  selectedElement: LiveBrowserInspectResult | null;
  /** Latest element screenshot */
  lastScreenshot: LiveBrowserElementScreenshot | null;
  /** Error message if any */
  error: string | null;
  /**
   * Whether a React overlay (e.g. image zoom) is currently covering the
   * browser area. When true, the WebContentsView bounds are collapsed to
   * 0×0 so the native view doesn't obscure the overlay.
   */
  overlayOpen: boolean;
  /** Last bounds reported by the panel — restored when overlay closes. */
  _lastBounds: { x: number; y: number; width: number; height: number } | null;

  // ── Actions ──────────────────────────────────────────────────────

  /** Initialize the store — subscribe to IPC events */
  init: () => () => void;
  /** Open the browser and navigate to a URL */
  open: (url: string) => Promise<void>;
  /** Close the browser */
  close: () => Promise<void>;
  /** Navigate to a new URL */
  navigate: (url: string) => Promise<void>;
  /** Go back in browser history */
  back: () => Promise<void>;
  /** Go forward in browser history */
  forward: () => Promise<void>;
  /** Reload the current page */
  reload: () => Promise<void>;
  /** Toggle element inspect mode */
  toggleInspect: () => Promise<void>;
  /** Clear the currently selected element */
  clearSelectedElement: () => void;
  /** Take a screenshot of the currently selected element */
  screenshotSelectedElement: () => Promise<LiveBrowserElementScreenshot | null>;
  /** Update the view bounds (called from panel resize observer) */
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  /**
   * Signal that a React overlay (modal, image zoom, etc.) is open or closed.
   * Hides/restores the WebContentsView so the overlay is not covered by the
   * native Electron view.
   */
  setOverlayOpen: (open: boolean) => void;
}

function getDesktopBridge(): typeof window.desktopBridge | undefined {
  return typeof window !== "undefined" ? window.desktopBridge : undefined;
}

export const useLiveBrowserStore = create<LiveBrowserStoreState>((set, get) => ({
  isAvailable: false,
  isOpen: false,
  status: "idle",
  url: "",
  title: "",
  isInspecting: false,
  selectedElement: null,
  lastScreenshot: null,
  error: null,
  overlayOpen: false,
  _lastBounds: null,

  init: () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) {
      return () => {};
    }

    set({ isAvailable: true });

    // Subscribe to IPC events from the Electron main process
    const unsubUrl = bridge.liveBrowser.onUrlChanged((url) => {
      set({ url });
    });

    const unsubTitle = bridge.liveBrowser.onTitleChanged((title) => {
      set({ title });
    });

    const unsubElement = bridge.liveBrowser.onElementInspected((result) => {
      set({
        selectedElement: result as LiveBrowserInspectResult,
        isInspecting: false,
      });
    });

    const unsubState = bridge.liveBrowser.onStateChanged((state) => {
      const s = state as LiveBrowserState;
      set({
        isOpen: s.isOpen,
        status: s.status,
        url: s.url,
        title: s.title,
        isInspecting: s.isInspecting,
        error: s.error ?? null,
      });
    });

    // Get initial state
    void bridge.liveBrowser.getState().then((state) => {
      set({
        isOpen: state.isOpen,
        status: state.status,
        url: state.url,
        title: state.title,
        isInspecting: state.isInspecting,
        error: state.error ?? null,
      });
    });

    return () => {
      unsubUrl();
      unsubTitle();
      unsubElement();
      unsubState();
    };
  },

  open: async (url: string) => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    set({ isOpen: true, status: "starting", url, error: null, selectedElement: null });
    try {
      await bridge.liveBrowser.start(url);
    } catch (err) {
      set({ isOpen: false, status: "error", error: String(err) });
    }
  },

  close: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    try {
      await bridge.liveBrowser.stop();
    } catch {
      // Ignore stop errors
    }
    set({
      isOpen: false,
      status: "idle",
      url: "",
      title: "",
      isInspecting: false,
      selectedElement: null,
      lastScreenshot: null,
      error: null,
    });
  },

  navigate: async (url: string) => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    set({ url });
    await bridge.liveBrowser.navigate(url);
  },

  back: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    await bridge.liveBrowser.back();
  },

  forward: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    await bridge.liveBrowser.forward();
  },

  reload: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    await bridge.liveBrowser.reload();
  },

  toggleInspect: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    const { isInspecting } = get();
    if (isInspecting) {
      await bridge.liveBrowser.stopInspect();
      set({ isInspecting: false });
    } else {
      await bridge.liveBrowser.startInspect();
      set({ isInspecting: true });
    }
  },

  clearSelectedElement: () => {
    set({ selectedElement: null, lastScreenshot: null });
  },

  screenshotSelectedElement: async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return null;
    const { selectedElement } = get();
    if (!selectedElement) return null;
    const result = await bridge.liveBrowser.screenshotElement(selectedElement.nodeId);
    if (result) {
      set({ lastScreenshot: result as LiveBrowserElementScreenshot });
    }
    return result as LiveBrowserElementScreenshot | null;
  },

  setBounds: (bounds) => {
    // Always remember the latest bounds so we can restore them after an overlay closes.
    set({ _lastBounds: bounds });
    // Don't move the native view while a React overlay is covering the area.
    if (get().overlayOpen) return;
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    void bridge.liveBrowser.setBounds(bounds);
  },

  setOverlayOpen: (open: boolean) => {
    const state = get();
    if (open === state.overlayOpen) return;
    set({ overlayOpen: open });
    const bridge = getDesktopBridge();
    if (!bridge?.liveBrowser) return;
    if (open) {
      // Collapse the native view so it doesn't sit above the overlay.
      void bridge.liveBrowser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    } else if (state._lastBounds) {
      // Restore the native view to its last known position.
      void bridge.liveBrowser.setBounds(state._lastBounds);
    }
  },
}));
