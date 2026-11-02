import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMusicMiddleware } from "./music.mjs";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createHomeServer(env = process.env, options = {}) {
  const root = resolve(options.dist || "dist");
  const music = createMusicMiddleware(env, options);
  return createServer(async (request, response) => {
    try {
      await music(request, response, async () => {
        if (!["GET", "HEAD"].includes(request.method)) {
          response.writeHead(405, { Allow: "GET, HEAD" }).end();
          return;
        }
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
        if (!file.startsWith(root + sep)) {
          response.writeHead(404).end();
          return;
        }
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
          "Content-Length": info.size,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        });
        if (request.method === "HEAD") response.end();
        else {
          const stream = createReadStream(file);
          stream.on("error", () => response.destroy());
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        }
      });
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 12445);
  createHomeServer().listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(`Home listening on port ${port}`);
  });
}
