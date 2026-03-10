import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";

interface HttpResponse {
  statusCode: number;
  contentType: string | null;
  body: string;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function withRouteServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (tryHandleProjectFaviconRequest(url, res)) {
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected server address to be an object");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function request(baseUrl: string, pathname: string): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

describe("tryHandleProjectFaviconRequest", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 when cwd is missing", async () => {
    await withRouteServer(async (baseUrl) => {
      const response = await request(baseUrl, "/api/project-favicon");
      expect(response.statusCode).toBe(400);
      expect(response.body).toBe("Missing cwd parameter");
    });
  });

  it("serves a well-known favicon file from the project root", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-root-");
    fs.writeFileSync(path.join(projectDir, "favicon.svg"), "<svg>favicon</svg>", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>favicon</svg>");
    });
  });

  it("resolves icon href from source files when no well-known favicon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-source-");
    const iconPath = path.join(projectDir, "public", "brand", "logo.svg");
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "index.html"),
      '<link rel="icon" href="/brand/logo.svg">',
    );
    fs.writeFileSync(iconPath, "<svg>brand</svg>", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand</svg>");
    });
  });

  it("resolves icon link when href appears before rel in HTML", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-html-order-");
    const iconPath = path.join(projectDir, "public", "brand", "logo.svg");
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "index.html"),
      '<link href="/brand/logo.svg" rel="icon">',
    );
    fs.writeFileSync(iconPath, "<svg>brand-html-order</svg>", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-html-order</svg>");
    });
  });

  it("resolves object-style icon metadata when href appears before rel", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-obj-order-");
    const iconPath = path.join(projectDir, "public", "brand", "obj.svg");
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "src", "root.tsx"),
      'const links = [{ href: "/brand/obj.svg", rel: "icon" }];',
      "utf8",
    );
    fs.writeFileSync(iconPath, "<svg>brand-obj-order</svg>", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>brand-obj-order</svg>");
    });
  });

  it("serves a fallback favicon when no icon exists", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-fallback-");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });

  it("finds a favicon in a deeply nested directory", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-deep-");
    const deepPath = path.join(projectDir, "src", "assets", "images");
    fs.mkdirSync(deepPath, { recursive: true });
    fs.writeFileSync(path.join(deepPath, "favicon.png"), "PNG-DEEP", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/png");
      expect(response.body).toBe("PNG-DEEP");
    });
  });

  it("prefers favicon name over logo name at shallower depth", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-priority-name-");
    const deepDir = path.join(projectDir, "deep", "nested", "dir");
    const shallowDir = path.join(projectDir, "shallow");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.mkdirSync(shallowDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "favicon.ico"), "FAVICON-DEEP", "utf8");
    fs.writeFileSync(path.join(shallowDir, "logo.svg"), "LOGO-SHALLOW", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("FAVICON-DEEP");
    });
  });

  it("prefers svg over png for the same favicon name", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-priority-ext-");
    const dir = path.join(projectDir, "resources", "icons");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg>SVG</svg>", "utf8");
    fs.writeFileSync(path.join(dir, "favicon.png"), "PNG", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>SVG</svg>");
    });
  });

  it("ignores favicons inside node_modules", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-skip-nodemod-");
    const nmDir = path.join(projectDir, "node_modules", "some-pkg");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, "favicon.png"), "NM-FAVICON", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });

  it("ignores favicons inside dot-prefixed directories", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-skip-dotdir-");
    const hiddenDir = path.join(projectDir, ".hidden", "assets");
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, "favicon.png"), "HIDDEN", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });

  it("static candidates take precedence over deep search results", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-static-wins-");
    fs.writeFileSync(path.join(projectDir, "favicon.svg"), "<svg>ROOT</svg>", "utf8");
    const deepDir = path.join(projectDir, "deep", "nested");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(deepDir, "favicon.png"), "DEEP", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.contentType).toContain("image/svg+xml");
      expect(response.body).toBe("<svg>ROOT</svg>");
    });
  });

  it("respects depth limit and ignores favicons beyond max depth", async () => {
    const projectDir = makeTempDir("t3code-favicon-route-depth-limit-");
    // Create a favicon at depth 7 (beyond the max depth of 5)
    const deepPath = path.join(projectDir, "a", "b", "c", "d", "e", "f", "g");
    fs.mkdirSync(deepPath, { recursive: true });
    fs.writeFileSync(path.join(deepPath, "favicon.png"), "TOO-DEEP", "utf8");

    await withRouteServer(async (baseUrl) => {
      const pathname = `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`;
      const response = await request(baseUrl, pathname);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-fallback="project-favicon"');
    });
  });
});
