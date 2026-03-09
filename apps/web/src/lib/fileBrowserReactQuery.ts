import type { ProjectListEntriesResult, ProjectReadFileResult } from "@t3tools/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { projectQueryKeys } from "./projectReactQuery";

// ── Query Keys ───────────────────────────────────────────────────────

export const fileBrowserQueryKeys = {
  all: ["fileBrowser"] as const,
  tree: (cwd: string | null) => ["fileBrowser", "tree", cwd] as const,
  fileContents: (cwd: string | null, relativePath: string | null) =>
    ["fileBrowser", "file", cwd, relativePath] as const,
};

// ── Workspace Tree ───────────────────────────────────────────────────

const TREE_STALE_TIME = 15_000;
const EMPTY_TREE_RESULT: ProjectListEntriesResult = {
  entries: [],
  truncated: false,
};

export function workspaceTreeQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: fileBrowserQueryKeys.tree(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) {
        throw new Error("Workspace tree is unavailable.");
      }
      return api.projects.listEntries({ cwd });
    },
    enabled: cwd !== null,
    staleTime: TREE_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_TREE_RESULT,
  });
}

// ── File Contents ────────────────────────────────────────────────────

const EMPTY_FILE_RESULT: ProjectReadFileResult = {
  relativePath: "",
  contents: "",
};

export function fileContentsQueryOptions(
  cwd: string | null,
  relativePath: string | null,
) {
  return queryOptions({
    queryKey: fileBrowserQueryKeys.fileContents(cwd, relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd || !relativePath) {
        throw new Error("File read is unavailable.");
      }
      return api.projects.readFile({ cwd, relativePath });
    },
    enabled: cwd !== null && relativePath !== null && relativePath.length > 0,
    staleTime: 5_000,
    placeholderData: (previous) => previous ?? EMPTY_FILE_RESULT,
  });
}

// ── Write File Mutation ──────────────────────────────────────────────

export function useWriteFileMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { cwd: string; relativePath: string; contents: string }) => {
      const api = ensureNativeApi();
      return api.projects.writeFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
        contents: input.contents,
      });
    },
    onSuccess: (_data, variables) => {
      // Invalidate the file contents query so it refetches
      void queryClient.invalidateQueries({
        queryKey: fileBrowserQueryKeys.fileContents(variables.cwd, variables.relativePath),
      });
      // Also invalidate the tree and project search entries cache
      void queryClient.invalidateQueries({
        queryKey: fileBrowserQueryKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.all,
      });
    },
  });
}
