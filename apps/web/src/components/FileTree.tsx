import { memo, useCallback, useMemo } from "react";
import type { ProjectEntry } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { basenameOfPath, getVscodeIconUrlForEntry } from "../vscode-icons";
import { useFileBrowserStore } from "../fileBrowserStore";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "~/lib/utils";

// ── Tree Building ────────────────────────────────────────────────────

interface TreeNode {
  entry: ProjectEntry;
  children: TreeNode[];
}

function buildTree(entries: readonly ProjectEntry[]): TreeNode[] {
  const childrenMap = new Map<string | undefined, ProjectEntry[]>();

  for (const entry of entries) {
    const parentKey = entry.parentPath ?? "__root__";
    const group = childrenMap.get(parentKey);
    if (group) {
      group.push(entry);
    } else {
      childrenMap.set(parentKey, [entry]);
    }
  }

  function buildNodes(parentPath: string | undefined): TreeNode[] {
    const key = parentPath ?? "__root__";
    const children = childrenMap.get(key) ?? [];

    // Sort: directories first, then alphabetical
    children.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }
      return basenameOfPath(a.path).localeCompare(basenameOfPath(b.path));
    });

    return children.map((entry) => ({
      entry,
      children: entry.kind === "directory" ? buildNodes(entry.path) : [],
    }));
  }

  return buildNodes(undefined);
}

// ── Tree Node Component ──────────────────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  onFileClick: (relativePath: string) => void;
}

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  onFileClick,
}: TreeNodeRowProps) {
  const { entry } = node;
  const isDirectory = entry.kind === "directory";
  const basename = basenameOfPath(entry.path);
  const expandedDirs = useFileBrowserStore((s) => s.expandedDirs);
  const toggleDir = useFileBrowserStore((s) => s.toggleDir);
  const openFilePath = useFileBrowserStore((s) => s.activeFile?.relativePath);
  const isExpanded = isDirectory && expandedDirs.has(entry.path);
  const isActive = !isDirectory && entry.path === openFilePath;

  const iconUrl = useMemo(
    () => getVscodeIconUrlForEntry(entry.path, entry.kind, "dark"),
    [entry.path, entry.kind],
  );

  const handleClick = useCallback(() => {
    if (isDirectory) {
      toggleDir(entry.path);
    } else {
      onFileClick(entry.path);
    }
  }, [isDirectory, entry.path, toggleDir, onFileClick]);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "group flex w-full items-center gap-1.5 rounded-sm px-1.5 py-[3px] text-left text-[12.5px] leading-tight hover:bg-accent/60",
          isActive && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        title={entry.path}
      >
        {isDirectory && (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150",
              isExpanded && "rotate-90",
            )}
          />
        )}
        {!isDirectory && <span className="w-3 shrink-0" />}
        <img
          src={iconUrl}
          alt=""
          className="size-3.5 shrink-0"
          loading="lazy"
          decoding="async"
        />
        <span className="truncate font-mono text-[11.5px] text-foreground/85 group-hover:text-foreground">
          {basename}
        </span>
      </button>
      {isDirectory && isExpanded && (
        <TreeChildren nodes={node.children} depth={depth + 1} onFileClick={onFileClick} />
      )}
    </>
  );
});

// ── Tree Children ────────────────────────────────────────────────────

const TreeChildren = memo(function TreeChildren({
  nodes,
  depth,
  onFileClick,
}: {
  nodes: TreeNode[];
  depth: number;
  onFileClick: (relativePath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.entry.path}
          node={node}
          depth={depth}
          onFileClick={onFileClick}
        />
      ))}
    </>
  );
});

// ── Main FileTree Component ──────────────────────────────────────────

interface FileTreeProps {
  entries: readonly ProjectEntry[];
  onFileClick: (relativePath: string) => void;
}

export const FileTree = memo(function FileTree({ entries, onFileClick }: FileTreeProps) {
  const tree = useMemo(() => buildTree(entries), [entries]);

  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground/70">
        No files found
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="py-1 px-1">
        <TreeChildren nodes={tree} depth={0} onFileClick={onFileClick} />
      </div>
    </ScrollArea>
  );
});
