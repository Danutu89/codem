import { memo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpenIcon } from "lucide-react";
import { useFileBrowserStore } from "../fileBrowserStore";
import { workspaceTreeQueryOptions } from "../lib/fileBrowserReactQuery";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";

interface FileBrowserPanelProps {
  cwd: string | null;
}

export const FileBrowserPanel = memo(function FileBrowserPanel({
  cwd,
}: FileBrowserPanelProps) {
  const setActiveFile = useFileBrowserStore((s) => s.setActiveFile);
  const activeFilePath = useFileBrowserStore((s) => s.activeFile?.relativePath ?? null);

  // Fetch workspace tree
  const treeQuery = useQuery(workspaceTreeQueryOptions(cwd));

  // When file contents are loaded, update the store
  const handleFileClick = useCallback(
    async (relativePath: string) => {
      if (!cwd) return;
      // If the file is already open, do nothing
      const currentFile = useFileBrowserStore.getState().activeFile;
      if (currentFile?.relativePath === relativePath) return;

      try {
        const { ensureNativeApi } = await import("../nativeApi");
        const api = ensureNativeApi();
        const result = await api.projects.readFile({ cwd, relativePath });
        setActiveFile(result.relativePath, result.contents);
      } catch (error) {
        console.error("Failed to read file:", error);
      }
    },
    [cwd, setActiveFile],
  );

  const entries = treeQuery.data?.entries ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FolderOpenIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Explorer</span>
        {treeQuery.isLoading && (
          <span className="ml-auto text-[10px] text-muted-foreground">Loading...</span>
        )}
      </div>

      {/* Content */}
      {activeFilePath ? (
        // Split view: tree + editor
        <div className="flex flex-1 min-h-0 flex-col">
          {/* File tree - compact when editor is open */}
          <div className="shrink-0 max-h-[40%] min-h-[120px] overflow-y-auto border-b border-border">
            <div className="py-1 px-1">
              <FileTree entries={entries} onFileClick={handleFileClick} />
            </div>
          </div>
          {/* Editor */}
          {cwd && <FileEditor cwd={cwd} />}
        </div>
      ) : (
        // Full tree view
        <FileTree entries={entries} onFileClick={handleFileClick} />
      )}
    </div>
  );
});
