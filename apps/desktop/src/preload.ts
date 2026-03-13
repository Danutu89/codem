import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";

// Live Browser IPC channels
const LB_START = "liveBrowser:start";
const LB_STOP = "liveBrowser:stop";
const LB_NAVIGATE = "liveBrowser:navigate";
const LB_BACK = "liveBrowser:back";
const LB_FORWARD = "liveBrowser:forward";
const LB_RELOAD = "liveBrowser:reload";
const LB_START_INSPECT = "liveBrowser:startInspect";
const LB_STOP_INSPECT = "liveBrowser:stopInspect";
const LB_SCREENSHOT_ELEMENT = "liveBrowser:screenshotElement";
const LB_GET_STATE = "liveBrowser:getState";
const LB_SET_BOUNDS = "liveBrowser:setBounds";
const LB_URL_CHANGED = "liveBrowser:urlChanged";
const LB_TITLE_CHANGED = "liveBrowser:titleChanged";
const LB_ELEMENT_INSPECTED = "liveBrowser:elementInspected";
const LB_STATE_CHANGED = "liveBrowser:stateChanged";

const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

function createEventListener<T>(
  channel: string,
  listener: (data: T) => void,
): () => void {
  const wrappedListener = (_event: Electron.IpcRendererEvent, data: unknown) => {
    listener(data as T);
  };
  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  liveBrowser: {
    start: (url: string) => ipcRenderer.invoke(LB_START, url),
    stop: () => ipcRenderer.invoke(LB_STOP),
    navigate: (url: string) => ipcRenderer.invoke(LB_NAVIGATE, url),
    back: () => ipcRenderer.invoke(LB_BACK),
    forward: () => ipcRenderer.invoke(LB_FORWARD),
    reload: () => ipcRenderer.invoke(LB_RELOAD),
    startInspect: () => ipcRenderer.invoke(LB_START_INSPECT),
    stopInspect: () => ipcRenderer.invoke(LB_STOP_INSPECT),
    screenshotElement: (nodeId: number) => ipcRenderer.invoke(LB_SCREENSHOT_ELEMENT, nodeId),
    getState: () => ipcRenderer.invoke(LB_GET_STATE),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(LB_SET_BOUNDS, bounds),
    onUrlChanged: (listener: (url: string) => void) =>
      createEventListener(LB_URL_CHANGED, listener),
    onTitleChanged: (listener: (title: string) => void) =>
      createEventListener(LB_TITLE_CHANGED, listener),
    onElementInspected: (listener) =>
      createEventListener(LB_ELEMENT_INSPECTED, listener as (data: unknown) => void),
    onStateChanged: (listener) =>
      createEventListener(LB_STATE_CHANGED, listener as (data: unknown) => void),
  },
} satisfies DesktopBridge);
