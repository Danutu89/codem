import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const FAVICON_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
	"favicon.svg",
	"favicon.ico",
	"favicon.png",
	"public/favicon.svg",
	"public/favicon.ico",
	"public/favicon.png",
	"static/favicon.svg",
	"static/favicon.ico",
	"static/favicon.png",
	"app/favicon.ico",
	"app/favicon.png",
	"app/icon.svg",
	"app/icon.png",
	"app/icon.ico",
	"src/favicon.ico",
	"src/favicon.svg",
	"src/app/favicon.ico",
	"src/app/icon.svg",
	"src/app/icon.png",
	"assets/icon.svg",
	"assets/icon.png",
	"assets/logo.svg",
	"assets/logo.png",
];

// Deep search configuration for finding favicons in nested directories.
const FAVICON_SEARCH_MAX_DEPTH = 5;
const FAVICON_SEARCH_MAX_FILES_SCANNED = 5000;

const FAVICON_SEARCH_SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
	"__pycache__",
]);

const FAVICON_SEARCH_NAMES = ["favicon", "icon", "logo"];
const FAVICON_SEARCH_EXTENSIONS = new Set([
	".svg",
	".png",
	".ico",
	".jpg",
	".jpeg",
]);

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
	"index.html",
	"public/index.html",
	"app/routes/__root.tsx",
	"src/routes/__root.tsx",
	"app/root.tsx",
	"src/root.tsx",
	"src/index.html",
];

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
	/<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
	/(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

function extractIconHref(source: string): string | null {
	const htmlMatch = source.match(LINK_ICON_HTML_RE);
	if (htmlMatch?.[1]) return htmlMatch[1];
	const objMatch = source.match(LINK_ICON_OBJ_RE);
	if (objMatch?.[1]) return objMatch[1];
	return null;
}

function resolveIconHref(projectCwd: string, href: string): string[] {
	const clean = href.replace(/^\//, "");
	return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
}

function isPathWithinProject(
	projectCwd: string,
	candidatePath: string,
): boolean {
	const relative = path.relative(
		path.resolve(projectCwd),
		path.resolve(candidatePath),
	);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function serveFaviconFile(filePath: string, res: http.ServerResponse): void {
	const ext = path.extname(filePath).toLowerCase();
	const contentType = FAVICON_MIME_TYPES[ext] ?? "application/octet-stream";
	fs.readFile(filePath, (readErr, data) => {
		if (readErr) {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Read error");
			return;
		}
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "public, max-age=3600",
		});
		res.end(data);
	});
}

interface FaviconMatch {
	filePath: string;
	score: number;
	depth: number;
}

function faviconSearchScore(basename: string): number | null {
	const ext = path.extname(basename).toLowerCase();
	if (!FAVICON_SEARCH_EXTENSIONS.has(ext)) return null;
	const stem = path.basename(basename, ext).toLowerCase();
	const nameIndex = FAVICON_SEARCH_NAMES.indexOf(stem);
	if (nameIndex === -1) return null;
	const extOrder = [".svg", ".png", ".ico", ".jpg", ".jpeg"];
	const extIndex = extOrder.indexOf(ext);
	return nameIndex * 10 + (extIndex === -1 ? 9 : extIndex);
}

function searchForFavicon(
	projectCwd: string,
	callback: (filePath: string | null) => void,
): void {
	const matches: FaviconMatch[] = [];
	let totalScanned = 0;

	interface QueueEntry {
		dir: string;
		depth: number;
	}

	function processLevel(queue: QueueEntry[]): void {
		if (queue.length === 0 || totalScanned >= FAVICON_SEARCH_MAX_FILES_SCANNED) {
			finalize();
			return;
		}

		const nextQueue: QueueEntry[] = [];
		let pending = queue.length;

		for (const entry of queue) {
			fs.readdir(entry.dir, { withFileTypes: true }, (err, dirents) => {
				if (!err && dirents) {
					for (const dirent of dirents) {
						totalScanned++;
						if (totalScanned > FAVICON_SEARCH_MAX_FILES_SCANNED) break;

						if (dirent.isDirectory()) {
							if (
								entry.depth + 1 <= FAVICON_SEARCH_MAX_DEPTH &&
								!dirent.name.startsWith(".") &&
								!FAVICON_SEARCH_SKIP_DIRS.has(dirent.name)
							) {
								nextQueue.push({
									dir: path.join(entry.dir, dirent.name),
									depth: entry.depth + 1,
								});
							}
						} else if (dirent.isFile()) {
							const score = faviconSearchScore(dirent.name);
							if (score !== null) {
								matches.push({
									filePath: path.join(entry.dir, dirent.name),
									score,
									depth: entry.depth,
								});
							}
						}
					}
				}

				pending--;
				if (pending === 0) {
					processLevel(nextQueue);
				}
			});
		}
	}

	function finalize(): void {
		if (matches.length === 0) {
			callback(null);
			return;
		}
		matches.sort((a, b) => a.score - b.score || a.depth - b.depth);
		callback(matches[0]!.filePath);
	}

	processLevel([{ dir: projectCwd, depth: 0 }]);
}

function serveFallbackFavicon(res: http.ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "image/svg+xml",
		"Cache-Control": "public, max-age=3600",
	});
	res.end(FALLBACK_FAVICON_SVG);
}

export function tryHandleProjectFaviconRequest(
	url: URL,
	res: http.ServerResponse,
): boolean {
	if (url.pathname !== "/api/project-favicon") {
		return false;
	}

	const projectCwd = url.searchParams.get("cwd");
	if (!projectCwd) {
		res.writeHead(400, { "Content-Type": "text/plain" });
		res.end("Missing cwd parameter");
		return true;
	}

	const tryResolvedPaths = (
		paths: string[],
		index: number,
		onExhausted: () => void,
	): void => {
		if (index >= paths.length) {
			onExhausted();
			return;
		}
		const candidate = paths[index]!;
		if (!isPathWithinProject(projectCwd, candidate)) {
			tryResolvedPaths(paths, index + 1, onExhausted);
			return;
		}
		fs.stat(candidate, (err, stats) => {
			if (err || !stats?.isFile()) {
				tryResolvedPaths(paths, index + 1, onExhausted);
				return;
			}
			serveFaviconFile(candidate, res);
		});
	};

	const trySourceFiles = (index: number): void => {
		if (index >= ICON_SOURCE_FILES.length) {
			searchForFavicon(projectCwd, (found) => {
				if (found && isPathWithinProject(projectCwd, found)) {
					serveFaviconFile(found, res);
				} else {
					serveFallbackFavicon(res);
				}
			});
			return;
		}
		const sourceFile = path.join(projectCwd, ICON_SOURCE_FILES[index]!);
		fs.readFile(sourceFile, "utf8", (err, content) => {
			if (err) {
				trySourceFiles(index + 1);
				return;
			}
			const href = extractIconHref(content);
			if (!href) {
				trySourceFiles(index + 1);
				return;
			}
			const candidates = resolveIconHref(projectCwd, href);
			tryResolvedPaths(candidates, 0, () => trySourceFiles(index + 1));
		});
	};

	const tryCandidates = (index: number): void => {
		if (index >= FAVICON_CANDIDATES.length) {
			trySourceFiles(0);
			return;
		}
		const candidate = path.join(projectCwd, FAVICON_CANDIDATES[index]!);
		if (!isPathWithinProject(projectCwd, candidate)) {
			tryCandidates(index + 1);
			return;
		}
		fs.stat(candidate, (err, stats) => {
			if (err || !stats?.isFile()) {
				tryCandidates(index + 1);
				return;
			}
			serveFaviconFile(candidate, res);
		});
	};

	tryCandidates(0);
	return true;
}
