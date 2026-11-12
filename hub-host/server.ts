import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  HubStore,
  RevisionConflictError,
  StateIntegrityError,
  type StateSnapshot,
} from "./store";

export type HubHostOptions = {
  databasePath: string;
  host?: string;
  port?: number;
};

export type RunningHubHost = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

export async function startHubHost(
  options: HubHostOptions,
): Promise<RunningHubHost> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (host !== "127.0.0.1") {
    throw new Error(
      "This development host only binds to 127.0.0.1. LAN binding requires authenticated TLS first.",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new TypeError("port must be an integer from 0 to 65535.");

  const store = new HubStore(options.databasePath);
  let activePort = port;
  const server = createServer((request, response) => {
    void route(request, response, store, () => activePort).catch(() => {
      if (!response.headersSent)
        writeJson(response, 500, { error: "host_error" });
      else response.destroy();
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    store.close();
    throw new Error("The host did not open a TCP address.");
  }
  activePort = address.port;

  let closed = false;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          store.close();
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: HubStore,
  activePort: () => number,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const expectedHost = `127.0.0.1:${activePort()}`;

  if (request.headers.host !== expectedHost)
    return writeJson(response, 421, { error: "host_mismatch" });
  const origin = request.headers.origin;
  if (origin && origin !== `http://${expectedHost}`)
    return writeJson(response, 403, { error: "origin_not_allowed" });

  if (url.pathname === "/api/v1/health" && request.method === "GET") {
    try {
      const saved = store.read();
      return writeJson(response, 200, {
        status: "ready",
        storage: "sqlite",
        revision: saved?.revision ?? 0,
        lastSavedAt: saved?.savedAt ?? null,
      });
    } catch (error) {
      if (error instanceof StateIntegrityError)
        return writeJson(response, 503, {
          status: "degraded",
          error: "state_integrity_failed",
        });
      throw error;
    }
  }

  if (url.pathname === "/api/v1/state" && request.method === "GET") {
    try {
      const saved = store.read();
      return writeJson(
        response,
        200,
        saved ?? { revision: 0, savedAt: null, checksum: null, snapshot: null },
      );
    } catch (error) {
      if (error instanceof StateIntegrityError)
        return writeJson(response, 503, { error: "state_integrity_failed" });
      throw error;
    }
  }

  if (url.pathname === "/api/v1/state" && request.method === "PUT") {
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers["content-type"] ?? "",
      )
    ) {
      return writeJson(response, 415, { error: "json_required" });
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch {
      return writeJson(response, 400, { error: "invalid_json" });
    }
    if (!isSaveRequest(body))
      return writeJson(response, 400, { error: "invalid_state_request" });

    try {
      const saved = store.save(body.snapshot, body.expectedRevision);
      return writeJson(response, 200, saved);
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return writeJson(response, 409, {
          error: "revision_conflict",
          currentRevision: error.currentRevision,
        });
      }
      if (error instanceof StateIntegrityError)
        return writeJson(response, 503, { error: "state_integrity_failed" });
      if (error instanceof TypeError)
        return writeJson(response, 400, { error: "invalid_state_request" });
      throw error;
    }
  }

  if (url.pathname === "/api/v1/health" || url.pathname === "/api/v1/state") {
    response.setHeader(
      "Allow",
      url.pathname.endsWith("/health") ? "GET" : "GET, PUT",
    );
    return writeJson(response, 405, { error: "method_not_allowed" });
  }
  return writeJson(response, 404, { error: "not_found" });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isSaveRequest(
  value: unknown,
): value is { expectedRevision: number; snapshot: StateSnapshot } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const request = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(request.expectedRevision) &&
    (request.expectedRevision as number) >= 0 &&
    isRecord(request.snapshot)
  );
}

function isRecord(value: unknown): value is StateSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
