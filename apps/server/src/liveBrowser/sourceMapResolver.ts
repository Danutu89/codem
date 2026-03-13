/**
 * Source Map Resolver.
 *
 * Resolves source file locations from framework debug info (React _debugSource,
 * Vue __file, Svelte __svelte_meta) back to actual files on disk.
 *
 * Primary strategy:
 * 1. If the path is already a filesystem path, resolve it relative to the project root
 * 2. If it's a URL (e.g., http://localhost:5173/src/App.tsx), strip the URL prefix
 * 3. As a fallback, try fetching and parsing source maps from the dev server
 */
import * as FS from "node:fs";
import * as Path from "node:path";
import type { LiveBrowserResolveSourceResult } from "@t3tools/contracts";

// Common build output directories to search for source maps
const BUILD_DIRS = ["dist", ".next", "build", "node_modules/.vite", ".vite", "out"];

/**
 * Resolve a source location from framework debug info to an actual file on disk.
 *
 * @param filePath - File path or URL from framework debug info
 * @param line - Line number (1-based)
 * @param column - Column number (0-based, optional)
 * @param projectRoot - The project root directory
 * @returns Resolved source location with workspace-relative path
 */
export async function resolveSourceLocation(
  filePath: string,
  line: number,
  column: number | undefined,
  projectRoot: string,
): Promise<LiveBrowserResolveSourceResult> {
  // Strategy 1: Strip URL prefix if it's a dev server URL
  let resolvedPath = filePath;

  // Handle http://localhost:PORT/path or similar
  const urlMatch = filePath.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (urlMatch?.[1]) {
    resolvedPath = urlMatch[1];
  }

  // Handle file:// protocol
  if (resolvedPath.startsWith("file://")) {
    resolvedPath = resolvedPath.replace(/^file:\/\//, "");
  }

  // Remove query strings and hash fragments
  resolvedPath = resolvedPath.split("?")[0]!.split("#")[0]!;

  // Strategy 2: If it's already an absolute path, check if it exists
  if (Path.isAbsolute(resolvedPath)) {
    const exists = await fileExists(resolvedPath);
    const relativePath = Path.relative(projectRoot, resolvedPath);
    return {
      file: relativePath.startsWith("..") ? resolvedPath : relativePath,
      line,
      column,
      exists,
    };
  }

  // Strategy 3: Resolve relative to project root
  const absolutePath = Path.resolve(projectRoot, resolvedPath);
  const exists = await fileExists(absolutePath);

  if (exists) {
    return {
      file: resolvedPath,
      line,
      column,
      exists: true,
    };
  }

  // Strategy 4: Try common source root variations
  const variations = [
    resolvedPath,
    // Remove leading src/ if present and try without
    resolvedPath.replace(/^src\//, ""),
    // Add src/ prefix
    `src/${resolvedPath}`,
    // Try app/ prefix (Next.js)
    `app/${resolvedPath}`,
    // Try pages/ prefix (Next.js)
    `pages/${resolvedPath}`,
    // Try lib/ prefix
    `lib/${resolvedPath}`,
  ];

  for (const variation of variations) {
    const varPath = Path.resolve(projectRoot, variation);
    if (await fileExists(varPath)) {
      return {
        file: variation,
        line,
        column,
        exists: true,
      };
    }
  }

  // Return the best guess even if not found
  return {
    file: resolvedPath,
    line,
    column,
    exists: false,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await FS.promises.access(filePath, FS.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
