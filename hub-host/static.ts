import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

export function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  rootDirectory: string,
  requestPath: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (decodedPath.includes("\0")) {
    response.writeHead(400, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }
  if (decodedPath.split(/[\\/]/).some((part) => part.startsWith("."))) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }

  const root = realpathSync(rootDirectory);
  const requestedFile = resolve(root, `.${decodedPath}`);
  if (!isWithinRoot(root, requestedFile)) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    response.end();
    return true;
  }

  const candidates = [
    requestedFile,
    ...(extname(requestedFile)
      ? []
      : [`${requestedFile}.html`, resolve(requestedFile, "index.html")]),
  ];
  let filePath = candidates
    .map((candidate) => {
      if (!isWithinRoot(root, candidate) || !existsSync(candidate)) return null;
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(candidate);
      } catch {
        return null;
      }
      if (!isWithinRoot(root, canonicalPath)) return null;
      return canonicalPath;
    })
    .find((candidate) => {
      if (!candidate) return false;
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });

  if (!filePath && extname(requestedFile)) return false;
  if (!filePath) {
    const fallback = resolve(root, "index.html");
    if (!existsSync(fallback)) return false;
    filePath = realpathSync(fallback);
  }
  if (!isWithinRoot(root, filePath) || !existsSync(filePath)) return false;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const relativeFile = relative(root, filePath).replaceAll("\\", "/");
  const immutableAsset = relativeFile.startsWith("_app/immutable/");
  const isHtml = extname(filePath).toLowerCase() === ".html";
  let html: string | null = null;
  if (isHtml) {
    const source = readFileSync(filePath, "utf8");
    const marker = '<meta name="happy-hallways-hub-host" content="true">';
    html = source.includes(marker)
      ? source
      : source.replace(/<\/head>/i, `${marker}</head>`) === source
        ? `${marker}${source}`
        : source.replace(/<\/head>/i, `${marker}</head>`);
  }
  response.writeHead(200, {
    "Content-Type":
      contentTypes[extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "Content-Length": html === null ? stat.size : Buffer.byteLength(html),
    "Cache-Control": immutableAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
  } else if (html !== null) {
    response.end(html);
  } else {
    createReadStream(filePath).pipe(response);
  }
  return true;
}

function isWithinRoot(root: string, filePath: string) {
  const pathFromRoot = relative(root, filePath);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}
