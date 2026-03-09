import { memo, useCallback, useEffect, useRef } from "react";
import { SaveIcon, XIcon } from "lucide-react";
import { basenameOfPath, getVscodeIconUrlForEntry } from "../vscode-icons";
import { useFileBrowserStore } from "../fileBrowserStore";
import { useWriteFileMutation } from "../lib/fileBrowserReactQuery";
import { cn } from "~/lib/utils";

interface FileEditorProps {
  cwd: string;
}

export const FileEditor = memo(function FileEditor({ cwd }: FileEditorProps) {
  const openFile = useFileBrowserStore((s) => s.activeFile);
  const updateFileContents = useFileBrowserStore((s) => s.updateFileContents);
  const markSaved = useFileBrowserStore((s) => s.markSaved);
  const closeFile = useFileBrowserStore((s) => s.closeFile);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const writeFileMutation = useWriteFileMutation();

  const handleSave = useCallback(() => {
    if (!openFile || !openFile.dirty) return;
    writeFileMutation.mutate(
      {
        cwd,
        relativePath: openFile.relativePath,
        contents: openFile.contents,
      },
      {
        onSuccess: () => {
          markSaved();
        },
      },
    );
  }, [cwd, openFile, writeFileMutation, markSaved]);

  // Cmd+S / Ctrl+S handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  if (!openFile) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">
        Select a file to edit
      </div>
    );
  }

  const basename = basenameOfPath(openFile.relativePath);
  const iconUrl = getVscodeIconUrlForEntry(openFile.relativePath, "file", "dark");

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* File tab bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/30 px-2 py-1">
        <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
        <span
          className={cn(
            "truncate font-mono text-[11.5px]",
            openFile.dirty ? "text-foreground" : "text-muted-foreground",
          )}
          title={openFile.relativePath}
        >
          {basename}
          {openFile.dirty && <span className="ml-0.5 text-amber-500">*</span>}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {openFile.dirty && (
            <button
              type="button"
              onClick={handleSave}
              disabled={writeFileMutation.isPending}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-accent disabled:opacity-50"
              title="Save (Cmd+S)"
            >
              <SaveIcon className="size-3" />
              Save
            </button>
          )}
          <button
            type="button"
            onClick={closeFile}
            className="flex items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Close file"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      </div>

      {/* Editor area */}
      <textarea
        ref={textareaRef}
        value={openFile.contents}
        onChange={(e) => updateFileContents(e.target.value)}
        className="flex-1 min-h-0 w-full resize-none bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground outline-none"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
});
