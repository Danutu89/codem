import { create } from "zustand";

// ── State ────────────────────────────────────────────────────────────

export interface FileBrowserOpenFile {
  relativePath: string;
  contents: string;
  originalContents: string;
  dirty: boolean;
}

export interface FileBrowserState {
  /** Whether the file browser panel is visible */
  isOpen: boolean;
  /** Which project cwd the browser is showing */
  activeCwd: string | null;
  /** Set of expanded directory paths */
  expandedDirs: Set<string>;
  /** Currently open file */
  activeFile: FileBrowserOpenFile | null;
}

export interface FileBrowserActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setActiveCwd: (cwd: string | null) => void;
  toggleDir: (path: string) => void;
  expandDir: (path: string) => void;
  collapseDir: (path: string) => void;
  setActiveFile: (relativePath: string, contents: string) => void;
  updateFileContents: (contents: string) => void;
  markSaved: () => void;
  closeFile: () => void;
}

export type FileBrowserStore = FileBrowserState & FileBrowserActions;

// ── Persist helpers ──────────────────────────────────────────────────

const PERSISTED_STATE_KEY = "t3code:file-browser:v1";

interface PersistedFileBrowserState {
  isOpen?: boolean;
  expandedDirs?: string[];
}

function readPersistedState(): Pick<FileBrowserState, "isOpen" | "expandedDirs"> {
  if (typeof window === "undefined") return { isOpen: false, expandedDirs: new Set() };
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return { isOpen: false, expandedDirs: new Set() };
    const parsed = JSON.parse(raw) as PersistedFileBrowserState;
    return {
      isOpen: parsed.isOpen ?? false,
      expandedDirs: new Set(parsed.expandedDirs ?? []),
    };
  } catch {
    return { isOpen: false, expandedDirs: new Set() };
  }
}

function persistState(state: FileBrowserState): void {
  if (typeof window === "undefined") return;
  try {
    const data: PersistedFileBrowserState = {
      isOpen: state.isOpen,
      expandedDirs: [...state.expandedDirs],
    };
    window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

// ── Store ────────────────────────────────────────────────────────────

const persisted = readPersistedState();

export const useFileBrowserStore = create<FileBrowserStore>((set) => ({
  isOpen: persisted.isOpen,
  activeCwd: null,
  expandedDirs: persisted.expandedDirs,
  activeFile: null,

  toggle: () =>
    set((state) => ({ isOpen: !state.isOpen })),

  setOpen: (open) =>
    set({ isOpen: open }),

  setActiveCwd: (cwd) =>
    set({ activeCwd: cwd }),

  toggleDir: (path) =>
    set((state) => {
      const next = new Set(state.expandedDirs);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedDirs: next };
    }),

  expandDir: (path) =>
    set((state) => {
      if (state.expandedDirs.has(path)) return state;
      const next = new Set(state.expandedDirs);
      next.add(path);
      return { expandedDirs: next };
    }),

  collapseDir: (path) =>
    set((state) => {
      if (!state.expandedDirs.has(path)) return state;
      const next = new Set(state.expandedDirs);
      next.delete(path);
      return { expandedDirs: next };
    }),

  setActiveFile: (relativePath, contents) =>
    set({
      activeFile: {
        relativePath,
        contents,
        originalContents: contents,
        dirty: false,
      },
    }),

  updateFileContents: (contents) =>
    set((state) => {
      if (!state.activeFile) return state;
      return {
        activeFile: {
          ...state.activeFile,
          contents,
          dirty: contents !== state.activeFile.originalContents,
        },
      };
    }),

  markSaved: () =>
    set((state) => {
      if (!state.activeFile) return state;
      return {
        activeFile: {
          ...state.activeFile,
          originalContents: state.activeFile.contents,
          dirty: false,
        },
      };
    }),

  closeFile: () =>
    set({ activeFile: null }),
}));

// Persist on state changes
useFileBrowserStore.subscribe((state) => persistState(state));
