import * as http from "http";
import { createReadStream, existsSync, statSync } from "fs";
import { join, normalize, extname } from "path";
import type { AddressInfo } from "net";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".lang": "application/octet-stream",
};

let server: http.Server | null = null;
let servedRoot: string | null = null;

export function getStaticServerPort(): number | null {
  const addr = server?.address();
  return addr && typeof addr === "object" ? (addr as AddressInfo).port : null;
}

/** Serve `rootDir` on 127.0.0.1. Reuses the running server if it already serves the same root. */
export function startStaticServer(rootDir: string, preferredPort = 9982): Promise<number> {
  if (server && servedRoot === rootDir) {
    const port = getStaticServerPort();
    if (port) return Promise.resolve(port);
  }
  stopStaticServer();

  server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      let filePath = normalize(join(rootDir, urlPath));
      if (!filePath.startsWith(normalize(rootDir))) {
        res.writeHead(403).end();
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      }
      if (!existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(500).end();
    }
  });

  servedRoot = rootDir;
  return new Promise((resolve, reject) => {
    server!.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Preferred port taken — fall back to an ephemeral port
        server!.listen(0, "127.0.0.1", () => resolve(getStaticServerPort()!));
      } else {
        reject(err);
      }
    });
    server!.listen(preferredPort, "127.0.0.1", () => resolve(getStaticServerPort()!));
  });
}

export function stopStaticServer() {
  if (server) {
    try {
      server.close();
    } catch {}
    server = null;
    servedRoot = null;
  }
}
