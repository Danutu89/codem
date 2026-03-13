/**
 * Live Browser — Electron-native embedded browser view.
 *
 * Uses WebContentsView to embed a real Chromium browser in the app window,
 * with Chrome DevTools Protocol (CDP) access for element inspection,
 * framework component detection, and element screenshots.
 */
import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
} from "electron";
import type {
  LiveBrowserInspectResult,
  LiveBrowserState,
  LiveBrowserElementScreenshot,
} from "@t3tools/contracts";

// ── IPC Channel Names ──────────────────────────────────────────────

export const LIVE_BROWSER_CHANNELS = {
  start: "liveBrowser:start",
  stop: "liveBrowser:stop",
  navigate: "liveBrowser:navigate",
  back: "liveBrowser:back",
  forward: "liveBrowser:forward",
  reload: "liveBrowser:reload",
  startInspect: "liveBrowser:startInspect",
  stopInspect: "liveBrowser:stopInspect",
  screenshotElement: "liveBrowser:screenshotElement",
  getState: "liveBrowser:getState",
  setBounds: "liveBrowser:setBounds",
  // Events (main → renderer)
  urlChanged: "liveBrowser:urlChanged",
  titleChanged: "liveBrowser:titleChanged",
  elementInspected: "liveBrowser:elementInspected",
  stateChanged: "liveBrowser:stateChanged",
} as const;

// ── Component Info Extraction Script ───────────────────────────────

/**
 * JavaScript to inject into the inspected page to extract React/Vue/Svelte
 * component info from a DOM element. Runs in the page context via CDP
 * Runtime.evaluate.
 */
const EXTRACT_COMPONENT_INFO_SCRIPT = `
(function extractComponentInfo(element) {
  if (!element || !(element instanceof Element)) return null;

  // React: look for __reactFiber$ or __reactInternalInstance$ prefixed keys
  const reactFiberKey = Object.keys(element).find(
    k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );
  if (reactFiberKey) {
    const fiber = element[reactFiberKey];
    // Walk up the fiber tree to find the nearest component (non-host) fiber
    let current = fiber;
    while (current) {
      if (current._debugSource) {
        const ownerType = current.type;
        const name = typeof ownerType === 'function'
          ? (ownerType.displayName || ownerType.name)
          : typeof ownerType === 'string' ? null : (ownerType?.displayName || ownerType?.name || null);
        if (name) {
          return {
            framework: 'react',
            componentName: name,
            sourceLocation: current._debugSource
              ? {
                  file: current._debugSource.fileName,
                  line: current._debugSource.lineNumber,
                  column: current._debugSource.columnNumber || 0,
                }
              : null,
          };
        }
      }
      // Try _debugOwner first (points to the component that rendered this element)
      current = current._debugOwner || current.return;
    }
    return { framework: 'react', componentName: null, sourceLocation: null };
  }

  // Vue 3: __vueParentComponent
  const vueComponent = element.__vueParentComponent;
  if (vueComponent) {
    const type = vueComponent.type;
    const name = type?.__name || type?.name || null;
    const file = type?.__file || null;
    return {
      framework: 'vue',
      componentName: name,
      sourceLocation: file ? { file, line: 1, column: 0 } : null,
    };
  }

  // Vue 2: __vue__
  if (element.__vue__) {
    const vm = element.__vue__;
    const name = vm.$options?.name || vm.$options?._componentTag || null;
    const file = vm.$options?.__file || null;
    return {
      framework: 'vue',
      componentName: name,
      sourceLocation: file ? { file, line: 1, column: 0 } : null,
    };
  }

  // Svelte: __svelte_meta
  if (element.__svelte_meta) {
    const meta = element.__svelte_meta;
    return {
      framework: 'svelte',
      componentName: meta.loc?.file ? meta.loc.file.split('/').pop()?.replace('.svelte', '') : null,
      sourceLocation: meta.loc
        ? { file: meta.loc.file, line: meta.loc.line || 1, column: meta.loc.column || 0 }
        : null,
    };
  }

  return null;
})
`;

// ── CSS Selector Generation ────────────────────────────────────────

const GENERATE_SELECTOR_SCRIPT = `
(function generateSelector(element) {
  if (!element || !(element instanceof Element)) return '';
  if (element.id) return '#' + CSS.escape(element.id);

  const parts = [];
  let current = element;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = '#' + CSS.escape(current.id);
      parts.unshift(selector);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3);
      if (classes.length > 0) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
    }
    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(s => s.tagName === current.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += ':nth-child(' + index + ')';
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(' > ');
})
`;

// ── Highlight Config ───────────────────────────────────────────────

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: true,
  showAccessibilityInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.75 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

// ── LiveBrowserManager Class ───────────────────────────────────────

export class LiveBrowserManager {
  private view: WebContentsView | null = null;
  private parentWindow: BrowserWindow | null = null;
  private isInspecting = false;
  private debuggerAttached = false;
  private currentBounds = { x: 0, y: 0, width: 0, height: 0 };
  private _loadError: string | null = null;

  /**
   * Start the live browser, creating a WebContentsView and loading the URL.
   */
  async start(window: BrowserWindow, url: string): Promise<void> {
    // Clean up any existing view
    await this.stop();

    this.parentWindow = window;

    // Create WebContentsView with isolated session
    const partition = "persist:livebrowser";
    const ses = session.fromPartition(partition);

    this.view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        // Do NOT enable sandbox: combining sandbox:true with webSecurity:false
        // in newer Electron versions causes ERR_FAILED (-2) for HTTP localhost
        // URLs because the sandbox overrides the webSecurity relaxation.
        sandbox: false,
        // Allow loading localhost dev servers (no CORS / mixed-content blocking)
        webSecurity: false,
      },
    });

    // Set initial bounds (will be updated by renderer via setBounds IPC)
    this.view.setBounds(this.currentBounds);

    // Add to parent window
    window.contentView.addChildView(this.view);

    // Clear any previous load error on new navigations
    this._loadError = null;

    // Listen for navigation events
    this.view.webContents.on("did-navigate", () => {
      this._loadError = null;
      this.emitUrlChanged();
    });
    this.view.webContents.on("did-navigate-in-page", () => {
      this.emitUrlChanged();
    });
    this.view.webContents.on("page-title-updated", () => {
      this.emitTitleChanged();
    });

    // Report load failures to the renderer so the panel can show an error state.
    this.view.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      // ERR_ABORTED (-3) fires on every navigation that is superseded (e.g. a
      // redirect); it is not a real failure so we ignore it.
      if (errorCode === -3) return;
      this.emitError(`Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    });

    // Prevent new windows from opening — open externally instead
    this.view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      const { shell } = require("electron") as typeof import("electron");
      void shell.openExternal(targetUrl);
      return { action: "deny" as const };
    });

    // loadURL() can reject with ERR_FAILED even when the page ultimately loads
    // (e.g. during a redirect chain or on certain Electron/OS combinations).
    // We rely on did-fail-load for real error reporting instead of the promise.
    this.view.webContents.loadURL(url).catch((err: unknown) => {
      console.warn("[LiveBrowser] loadURL rejected (may be non-fatal):", err);
    });

    this.emitStateChanged();
  }

  /**
   * Stop and clean up the live browser view.
   */
  async stop(): Promise<void> {
    if (this.debuggerAttached && this.view) {
      try {
        this.view.webContents.debugger.detach();
      } catch {
        // Ignore detach errors
      }
      this.debuggerAttached = false;
    }

    this.isInspecting = false;
    this._loadError = null;

    if (this.view && this.parentWindow) {
      try {
        this.parentWindow.contentView.removeChildView(this.view);
      } catch {
        // Window may already be destroyed
      }
    }

    if (this.view) {
      // WebContentsView doesn't have a destroy method — setting to null lets GC handle it
      this.view = null;
    }

    // Emit state (isOpen: false) before clearing parentWindow so the renderer
    // is notified even when stop() is triggered outside the store's close().
    this.emitStateChanged();
    this.parentWindow = null;
  }

  /**
   * Navigate the embedded browser to a new URL.
   */
  async navigate(url: string): Promise<void> {
    if (!this.view) return;
    await this.view.webContents.loadURL(url);
  }

  /**
   * Go back in history.
   */
  goBack(): void {
    if (!this.view) return;
    this.view.webContents.goBack();
  }

  /**
   * Go forward in history.
   */
  goForward(): void {
    if (!this.view) return;
    this.view.webContents.goForward();
  }

  /**
   * Reload the current page.
   */
  reload(): void {
    if (!this.view) return;
    this.view.webContents.reload();
  }

  /**
   * Update the view bounds (called when the panel resizes).
   */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.currentBounds = bounds;
    if (this.view) {
      this.view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    }
  }

  /**
   * Enable CDP inspect mode — highlights elements on hover,
   * emits element info on click.
   */
  async startInspect(): Promise<void> {
    if (!this.view || this.isInspecting) return;

    await this.ensureDebugger();
    const dbg = this.view.webContents.debugger;

    // Enable required CDP domains
    await dbg.sendCommand("DOM.enable");
    await dbg.sendCommand("Overlay.enable");
    await dbg.sendCommand("Runtime.enable");

    // Set inspect mode — same as Chrome DevTools element picker
    await dbg.sendCommand("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: HIGHLIGHT_CONFIG,
    });

    this.isInspecting = true;
    this.emitStateChanged();
  }

  /**
   * Disable CDP inspect mode.
   */
  async stopInspect(): Promise<void> {
    if (!this.view || !this.isInspecting) return;

    try {
      const dbg = this.view.webContents.debugger;
      await dbg.sendCommand("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: HIGHLIGHT_CONFIG,
      });
      await dbg.sendCommand("Overlay.hideHighlight");
    } catch {
      // CDP commands may fail if page navigated
    }

    this.isInspecting = false;
    this.emitStateChanged();
  }

  /**
   * Take a screenshot of a specific element by its CDP node ID.
   */
  async screenshotElement(nodeId: number): Promise<LiveBrowserElementScreenshot | null> {
    if (!this.view) return null;

    await this.ensureDebugger();
    const dbg = this.view.webContents.debugger;

    try {
      // Get the box model for the element
      const boxResult = await dbg.sendCommand("DOM.getBoxModel", { backendNodeId: nodeId });
      const content = boxResult.model.content;
      // content is [x1,y1, x2,y2, x3,y3, x4,y4] — take bounding rect
      const x = Math.min(content[0], content[2], content[4], content[6]);
      const y = Math.min(content[1], content[3], content[5], content[7]);
      const maxX = Math.max(content[0], content[2], content[4], content[6]);
      const maxY = Math.max(content[1], content[3], content[5], content[7]);
      const width = maxX - x;
      const height = maxY - y;

      // Get device pixel ratio for accurate screenshots
      const metricsResult = await dbg.sendCommand("Page.getLayoutMetrics");
      const scale = metricsResult.visualViewport?.scale ?? 1;

      // Capture screenshot of just that region
      const screenshotResult = await dbg.sendCommand("Page.captureScreenshot", {
        format: "png",
        clip: {
          x,
          y,
          width,
          height,
          scale,
        },
      });

      // Resolve CSS selector for this node
      const resolveResult = await dbg.sendCommand("DOM.resolveNode", { backendNodeId: nodeId });
      const objectId = resolveResult.object.objectId;
      const selectorResult = await dbg.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: GENERATE_SELECTOR_SCRIPT,
        arguments: [{ objectId }],
        returnByValue: true,
      });

      return {
        screenshot: screenshotResult.data,
        selector: selectorResult.result?.value ?? "",
        boundingBox: { x, y, width, height },
      };
    } catch (err) {
      console.error("[LiveBrowser] screenshotElement failed:", err);
      return null;
    }
  }

  /**
   * Get current state.
   */
  getState(): LiveBrowserState {
    return {
      isOpen: this.view !== null,
      status: this.view ? "running" : "idle",
      url: this.view?.webContents.getURL() ?? "",
      title: this.view?.webContents.getTitle() ?? "",
      isInspecting: this.isInspecting,
      ...(this._loadError ? { error: this._loadError } : {}),
    };
  }

  /**
   * Check if the browser view is active.
   */
  get isActive(): boolean {
    return this.view !== null;
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private async ensureDebugger(): Promise<void> {
    if (!this.view) throw new Error("No live browser view");
    if (this.debuggerAttached) return;

    try {
      this.view.webContents.debugger.attach("1.3");
      this.debuggerAttached = true;

      // Listen for CDP events
      this.view.webContents.debugger.on("message", (_event, method, params) => {
        if (method === "Overlay.inspectNodeRequested") {
          void this.handleNodeInspected(params.backendNodeId);
        }
      });

      // Handle debugger detach (e.g., page crash)
      this.view.webContents.debugger.on("detach", () => {
        this.debuggerAttached = false;
        if (this.isInspecting) {
          this.isInspecting = false;
          this.emitStateChanged();
        }
      });
    } catch (err) {
      console.error("[LiveBrowser] Failed to attach debugger:", err);
      throw err;
    }
  }

  /**
   * Handle an element being clicked in inspect mode.
   * Extracts full element info and framework component data.
   */
  private async handleNodeInspected(backendNodeId: number): Promise<void> {
    if (!this.view || !this.debuggerAttached) return;

    const dbg = this.view.webContents.debugger;

    try {
      // Exit inspect mode after selection (like Chrome DevTools)
      await dbg.sendCommand("Overlay.setInspectMode", {
        mode: "none",
        highlightConfig: HIGHLIGHT_CONFIG,
      });

      // Keep the selected element highlighted
      await dbg.sendCommand("Overlay.highlightNode", {
        highlightConfig: HIGHLIGHT_CONFIG,
        backendNodeId,
      });

      // Get node description
      const descResult = await dbg.sendCommand("DOM.describeNode", {
        backendNodeId,
        depth: 0,
      });
      const node = descResult.node;

      // Get bounding box
      let boundingBox = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const boxResult = await dbg.sendCommand("DOM.getBoxModel", { backendNodeId });
        const content = boxResult.model.content;
        const x = Math.min(content[0], content[2], content[4], content[6]);
        const y = Math.min(content[1], content[3], content[5], content[7]);
        const maxX = Math.max(content[0], content[2], content[4], content[6]);
        const maxY = Math.max(content[1], content[3], content[5], content[7]);
        boundingBox = { x, y, width: maxX - x, height: maxY - y };
      } catch {
        // Box model may not be available for some elements
      }

      // Parse attributes from the flat array [name, value, name, value, ...]
      const attrs: Record<string, string> = {};
      const attrArray: string[] = node.attributes ?? [];
      for (let i = 0; i < attrArray.length; i += 2) {
        attrs[attrArray[i]!] = attrArray[i + 1] ?? "";
      }

      // Extract classes
      const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean);

      // Resolve node to a JS object for framework detection
      const resolveResult = await dbg.sendCommand("DOM.resolveNode", { backendNodeId });
      const objectId = resolveResult.object.objectId;

      // Get CSS selector
      const selectorResult = await dbg.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: GENERATE_SELECTOR_SCRIPT,
        arguments: [{ objectId }],
        returnByValue: true,
      });

      // Get text content (truncated)
      let textContent: string | undefined;
      try {
        const textResult = await dbg.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "(function(el) { return (el.textContent || '').trim().slice(0, 200); })",
          arguments: [{ objectId }],
          returnByValue: true,
        });
        const text = textResult.result?.value;
        if (text && typeof text === "string" && text.length > 0) {
          textContent = text;
        }
      } catch {
        // Text extraction may fail
      }

      // Extract framework component info
      let framework: LiveBrowserInspectResult["framework"];
      let componentName: string | undefined;
      let sourceLocation: LiveBrowserInspectResult["sourceLocation"];

      try {
        const componentResult = await dbg.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: EXTRACT_COMPONENT_INFO_SCRIPT,
          arguments: [{ objectId }],
          returnByValue: true,
        });
        const info = componentResult.result?.value;
        if (info && typeof info === "object") {
          framework = info.framework as LiveBrowserInspectResult["framework"];
          componentName = info.componentName ?? undefined;
          if (info.sourceLocation) {
            sourceLocation = {
              file: info.sourceLocation.file,
              line: info.sourceLocation.line,
              column: info.sourceLocation.column,
            };
          }
        }
      } catch {
        // Component extraction may fail (e.g., if page uses no framework)
      }

      const result: LiveBrowserInspectResult = {
        nodeId: backendNodeId,
        selector: selectorResult.result?.value ?? "",
        tagName: (node.localName ?? node.nodeName ?? "").toLowerCase(),
        id: attrs.id || undefined,
        classes,
        textContent,
        boundingBox,
        attributes: attrs,
        framework,
        componentName,
        sourceLocation,
      };

      // Emit to renderer
      this.emitElementInspected(result);

      // Stay in inspect mode but update the state
      this.isInspecting = false;
      this.emitStateChanged();
    } catch (err) {
      console.error("[LiveBrowser] handleNodeInspected failed:", err);
    }
  }

  // ── IPC Event Emitters ───────────────────────────────────────────

  private emitUrlChanged(): void {
    if (!this.parentWindow || this.parentWindow.isDestroyed()) return;
    const url = this.view?.webContents.getURL() ?? "";
    this.parentWindow.webContents.send(LIVE_BROWSER_CHANNELS.urlChanged, url);
  }

  private emitTitleChanged(): void {
    if (!this.parentWindow || this.parentWindow.isDestroyed()) return;
    const title = this.view?.webContents.getTitle() ?? "";
    this.parentWindow.webContents.send(LIVE_BROWSER_CHANNELS.titleChanged, title);
  }

  private emitElementInspected(result: LiveBrowserInspectResult): void {
    if (!this.parentWindow || this.parentWindow.isDestroyed()) return;
    this.parentWindow.webContents.send(LIVE_BROWSER_CHANNELS.elementInspected, result);
  }

  private emitStateChanged(): void {
    if (!this.parentWindow || this.parentWindow.isDestroyed()) return;
    this.parentWindow.webContents.send(LIVE_BROWSER_CHANNELS.stateChanged, this.getState());
  }

  private emitError(message: string): void {
    this._loadError = message;
    this.emitStateChanged();
  }
}

// ── IPC Handler Registration ───────────────────────────────────────

/**
 * Register all IPC handlers for the live browser feature.
 * Call this from main.ts registerIpcHandlers().
 */
export function registerLiveBrowserIpcHandlers(
  getWindow: () => BrowserWindow | null,
): LiveBrowserManager {
  const manager = new LiveBrowserManager();

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.start);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.start, async (_event, url: unknown) => {
    if (typeof url !== "string") return;
    const window = getWindow();
    if (!window) return;
    await manager.start(window, url);
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.stop);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.stop, async () => {
    await manager.stop();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.navigate);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.navigate, async (_event, url: unknown) => {
    if (typeof url !== "string") return;
    await manager.navigate(url);
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.back);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.back, async () => {
    manager.goBack();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.forward);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.forward, async () => {
    manager.goForward();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.reload);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.reload, async () => {
    manager.reload();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.startInspect);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.startInspect, async () => {
    await manager.startInspect();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.stopInspect);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.stopInspect, async () => {
    await manager.stopInspect();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.screenshotElement);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.screenshotElement, async (_event, nodeId: unknown) => {
    if (typeof nodeId !== "number") return null;
    return manager.screenshotElement(nodeId);
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.getState);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.getState, async () => {
    return manager.getState();
  });

  ipcMain.removeHandler(LIVE_BROWSER_CHANNELS.setBounds);
  ipcMain.handle(LIVE_BROWSER_CHANNELS.setBounds, async (_event, bounds: unknown) => {
    if (
      !bounds ||
      typeof bounds !== "object" ||
      typeof (bounds as Record<string, unknown>).x !== "number" ||
      typeof (bounds as Record<string, unknown>).y !== "number" ||
      typeof (bounds as Record<string, unknown>).width !== "number" ||
      typeof (bounds as Record<string, unknown>).height !== "number"
    ) {
      return;
    }
    const b = bounds as { x: number; y: number; width: number; height: number };
    manager.setBounds(b);
  });

  return manager;
}
