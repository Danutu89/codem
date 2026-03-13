/**
 * Dev Server URL Detector.
 *
 * Detects local dev server URLs in terminal output. Inspired by VS Code's
 * UrlFinder (src/vs/workbench/contrib/remote/browser/urlFinder.ts):
 *
 * 1. Strip ANSI escape codes
 * 2. Match any localhost/127.0.0.1/0.0.0.0 URL with a port
 * 3. Validate port range (1–65535)
 * 4. Normalize host to "localhost"
 *
 * No restrictive keyword pre-filter — just look for the URL.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g;

/**
 * Strip ANSI escape codes from terminal output.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Broad pattern matching any localhost-like URL with a port.
 * Modelled after VS Code's UrlFinder regex.
 * Captures the full URL including path/query/hash.
 */
const LOCAL_URL_RE =
  /\b(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})[\w\-._~:/?#[\]@!$&'()*+,;=%]*)/gi;

/**
 * Ports that are commonly used for debugging/tooling, not dev servers.
 * Exclude these to avoid false positives.
 */
const EXCLUDED_PORTS = new Set([
  9229, // Node.js inspector
  9222, // Chrome DevTools Protocol
]);

/**
 * Scan a block of terminal output text for local dev server URLs.
 * Returns the first valid URL found, or null if none detected.
 *
 * The input text should already have ANSI codes stripped for best results,
 * though the function will strip them if not.
 */
export function detectDevServerUrl(text: string): string | null {
  const cleanText = stripAnsi(text);

  // Reset regex state (it's global)
  LOCAL_URL_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LOCAL_URL_RE.exec(cleanText)) !== null) {
    const fullUrl = match[1]!;
    const portStr = match[2]!;
    const port = parseInt(portStr, 10);

    // Validate port range
    if (port < 1 || port > 65535) continue;

    // Skip known non-server ports
    if (EXCLUDED_PORTS.has(port)) continue;

    // Clean up trailing punctuation that shouldn't be part of the URL
    let url = fullUrl.replace(/[,;'")\]}>]+$/, "");

    // Normalize host to localhost
    url = url.replace(/127\.0\.0\.1/, "localhost").replace(/0\.0\.0\.0/, "localhost");

    return url;
  }

  return null;
}
