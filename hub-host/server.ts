import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { HubStore, RevisionConflictError, RolePermissionError, RecordNotFoundError, HubKioskPinError, HubKioskPromptError, InvitationError, StateIntegrityError, type StaffActor } from "./store";
import { HubBackupManager } from "./backups";
import { createEntraClient, type EntraOptions } from "./entra";
import type { IConfidentialClientApplication } from "@azure/msal-node";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStatic } from "./static";
import {
  isHubConcernPolicyRequest,
  isHubConcernRequest,
  isHubPromptOverrideRequest,
  isFavouriteStudentIds,
  isRecord,
  readHubKioskSessionCookie,
  readJsonRequest,
  readSessionCookie,
  requireStaff,
  routeAuditState,
  routeBackups,
  routeInvitations,
  routeKiosk,
  routeMail,
  routePublic,
  routeSessions,
  sessionCookie,
  sessionResponse,
  stateForStaff,
  writeJson,
  type RouteContext,
} from "./routes";

export type HubHostOptions = {
  databasePath: string;
  localBackupDirectory?: string;
  offHostBackupDirectory?: string | null;
  fallbackBackupDirectory?: string | null;
  backupEncryptionKey?: Buffer;
  allowNamedProfileFallback?: boolean;
  namedProfileFallbackApprovedForRealData?: boolean;
  /** Exact HTTPS browser origin for an Access-protected tunnel terminating at this Host. */
  trustedProxyOrigin?: string;
  host?: string;
  port?: number;
  allowLan?: boolean;
  tls?: {
    certificate: string | Buffer;
    privateKey: string | Buffer;
    publicHost: string;
  };
  entra?: EntraOptions;
  staticDirectory?: string | null;
};

export type RunningHubHost = {
  server: HttpServer | HttpsServer;
  url: string;
  close: () => Promise<void>;
};

export async function startHubHost(
  options: HubHostOptions,
): Promise<RunningHubHost> {
  const host = options.host ?? "127.0.0.1";
  const allowNamedProfileFallback = options.allowNamedProfileFallback ?? false;
  const namedProfileFallbackApprovedForRealData =
    options.namedProfileFallbackApprovedForRealData ?? false;
  const port = options.port ?? 8787;
  const isLoopback = host === "127.0.0.1" || host === "::1";
  const trustedProxyOrigin = options.trustedProxyOrigin;
  if (trustedProxyOrigin) {
    let parsed: URL;
    try { parsed = new URL(trustedProxyOrigin); }
    catch { throw new TypeError("trustedProxyOrigin must be a valid HTTPS origin."); }
    if (parsed.protocol !== "https:" || parsed.origin !== trustedProxyOrigin || parsed.username || parsed.password) {
      throw new TypeError("trustedProxyOrigin must be one exact HTTPS origin without a path.");
    }
    if (!isLoopback && !options.allowLan) {
      throw new Error("A trusted proxy origin requires a loopback listener or explicitly configured HTTPS LAN mode.");
    }
  }
  if (!isLoopback && !options.allowLan) {
    throw new Error(
      "LAN binding is disabled. Explicit approval and HTTPS certificate settings are required.",
    );
  }
  if (options.allowLan && (!options.tls || !options.tls.publicHost)) {
    throw new Error(
      "LAN mode requires HTTPS certificate, key, and public host settings.",
    );
  }
  if (options.allowLan && isLoopback) {
    throw new Error("LAN mode requires a non-loopback bind address.");
  }
  const publicHost = options.tls?.publicHost ?? host;
  if (
    publicHost.includes("/") ||
    publicHost.includes(":") ||
    publicHost.trim() !== publicHost ||
    publicHost.length > 253
  ) {
    throw new TypeError(
      "publicHost must be a DNS name or IP address without a port.",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port must be an integer from 0 to 65535.");
  }
  if (options.entra) {
    if (
      !options.allowLan ||
      !options.tls ||
      !options.entra.mfaPolicyConfirmed ||
      !options.backupEncryptionKey
    ) {
      throw new Error(
        "Entra sign-in requires ICT-confirmed MFA policy, the HTTPS LAN listener, and an ICT-managed backup encryption key.",
      );
    }
    const callback = new URL(options.entra.redirectUri);
    const expectedCallback = `https://${publicHost}:${port}/api/v1/auth/entra/callback`;
    if (
      callback.toString() !== expectedCallback ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash
    ) {
      throw new Error(
        "The Entra redirect URI must exactly match the HTTPS Hub Host callback URL.",
      );
    }
  }

  const entraClient: IConfidentialClientApplication | null = options.entra
    ? createEntraClient(options.entra)
    : null;
  const staticDirectory = options.staticDirectory
    ? resolve(options.staticDirectory)
    : null;
  if (
    staticDirectory &&
    (!existsSync(staticDirectory) ||
      !statSync(staticDirectory).isDirectory() ||
      !existsSync(resolve(staticDirectory, "index.html")) ||
      !existsSync(resolve(staticDirectory, "_app")))
  ) {
    throw new Error(
      "The static application directory must contain index.html and _app output from a Happy Hallways build.",
    );
  }
  const localBackupDirectory =
    options.localBackupDirectory ?? ".hub-data/backups/local";
  const store = new HubStore(
    options.databasePath,
    localBackupDirectory,
    options.backupEncryptionKey,
  );
  const backupManager = new HubBackupManager(
    store,
    localBackupDirectory,
    [
      { role: "preferred", directory: options.offHostBackupDirectory ?? null },
      { role: "fallback", directory: options.fallbackBackupDirectory ?? null },
    ],
    options.backupEncryptionKey,
  );
  let activePort = port;
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void route(
      request,
      response,
      store,
      backupManager,
      publicHost,
      options.allowLan ? "https_lan_configured" : "loopback_only",
      Boolean(options.tls || trustedProxyOrigin),
      entraClient,
      options.entra ?? null,
      allowNamedProfileFallback,
      namedProfileFallbackApprovedForRealData,
      trustedProxyOrigin,
      staticDirectory,
      () => activePort,
    ).catch((error: unknown) => {
      if (!response.headersSent) writeError(response, error);
      else response.destroy();
    });
  };
  const server = options.tls
    ? createHttpsServer(
      { cert: options.tls.certificate, key: options.tls.privateKey },
      handler,
    )
    : createHttpServer(handler);

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
  await backupManager.start();

  let closed = false;
  return {
    server,
    url: `${options.tls ? "https" : "http"}://${publicHost}:${address.port}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          backupManager.stop();
          store.close();
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

/** Public health/auth endpoints, then per-resource handlers behind session guards. */
async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: HubStore,
  backupManager: HubBackupManager,
  expectedHostName: string,
  networkMode: "loopback_only" | "https_lan_configured",
  secure: boolean,
  entraClient: IConfidentialClientApplication | null,
  entraOptions: EntraOptions | null,
  allowNamedProfileFallback: boolean,
  namedProfileFallbackApprovedForRealData: boolean,
  trustedProxyOrigin: string | undefined,
  staticDirectory: string | null,
  activePort: () => number,
) {
  if (secure) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  const sessionActor = store.getSession(readSessionCookie(request));
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const expectedHost = `${expectedHostName}:${activePort()}`;
  if (request.headers.host !== expectedHost) {
    return writeJson(response, 421, { error: "host_mismatch" });
  }
  const origin = request.headers.origin;
  const localOrigin = `${secure ? "https" : "http"}://${expectedHost}`;
  if (origin && origin !== localOrigin && origin !== trustedProxyOrigin) {
    return writeJson(response, 403, { error: "origin_not_allowed" });
  }

  // The kiosk routes authenticate by cookie, so staff sessions stay optional here.
  const actor: StaffActor | null = sessionActor;
  const context: RouteContext = {
    request,
    response,
    store,
    backupManager,
    networkMode,
    secure,
    entraClient,
    entraOptions,
    allowNamedProfileFallback,
    namedProfileFallbackApprovedForRealData,
    staticDirectory,
    actor,
    kioskToken: readHubKioskSessionCookie(request),
  };

  // Endpoints reachable without any session.
  if (await routePublic(context, url)) return;

  // Kiosk routes authenticate with their own cookie, not a staff session.
  if (url.pathname.startsWith("/api/v1/kiosk/")) {
    if (await routeKiosk(context, url)) return;
  }

  // Everything below needs a staff session.
  if (!actor) {
    if (
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/v1/kiosk/") &&
      url.pathname !== "/api/turn"
    ) {
      return writeJson(response, 401, { error: "staff_session_required" });
    }
    if (url.pathname === "/api/turn") {
      return writeJson(response, 503, { error: "turn_credentials_unavailable" });
    }
    if (staticDirectory && serveStatic(request, response, staticDirectory, url.pathname)) {
      return;
    }
    return writeJson(response, 404, { error: "not_found" });
  }

  if (await routeBackups(context, url)) return;
  if (routeMail(context, url)) return;
  if (routeInvitations(context, url)) return;
  if (routeSessions(context, url)) return;
  if (await routeAuditState(context, url)) return;

  if (
    url.pathname === "/api/v1/hub/prompt-overrides" &&
    request.method === "POST"
  ) {
    if (requireStaff(context)) return;
    const body = await readJsonRequest(request, 2 * 1024);
    if (!isHubPromptOverrideRequest(body)) {
      return writeJson(response, 400, {
        error: "invalid_hub_prompt_override_request",
      });
    }
    return writeJson(response, 201, store.createHubPromptOverride(actor, body));
  }

  if (url.pathname === "/api/v1/session" && request.method === "GET") {
    if (requireStaff(context)) return;
    return writeJson(response, 200, sessionResponse(actor));
  }

  if (url.pathname === "/api/v1/preferences") {
    if (requireStaff(context)) return;
    if (request.method === "GET") {
      return writeJson(response, 200, store.readStaffPreferences(actor));
    }
    if (request.method === "PUT") {
      const body = await readJsonRequest(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        !isFavouriteStudentIds(body.favouriteStudentIds)
      ) {
        return writeJson(response, 400, {
          error: "invalid_staff_preferences",
        });
      }
      return writeJson(
        response,
        200,
        store.saveStaffPreferences(actor, body.favouriteStudentIds),
      );
    }
  }

  if (url.pathname === "/api/v1/concerns/settings") {
    if (requireStaff(context)) return;
    if (request.method === "GET") {
      return writeJson(response, 200, store.readHubConcernPolicy());
    }
    if (request.method === "PUT") {
      const body = await readJsonRequest(request);
      if (!isHubConcernPolicyRequest(body)) {
        return writeJson(response, 400, {
          error: "invalid_hub_concern_policy",
        });
      }
      return writeJson(response, 200, store.saveHubConcernPolicy(actor, body));
    }
  }

  if (url.pathname === "/api/v1/concerns" && request.method === "POST") {
    if (requireStaff(context)) return;
    const body = await readJsonRequest(request);
    if (!isHubConcernRequest(body)) {
      return writeJson(response, 400, { error: "invalid_hub_concern_request" });
    }
    return writeJson(response, 201, store.createHubConcern(actor, body));
  }

  if (url.pathname === "/api/v1/sign-out" && request.method === "POST") {
    if (requireStaff(context)) return;
    store.revokeSession(actor.sessionId, actor, "staff_session_signed_out");
    return writeJson(
      response,
      200,
      { signedOut: true },
      { "Set-Cookie": sessionCookie("", 0, secure) },
    );
  }

  if (url.pathname === "/api/v1/profile" && request.method === "PATCH") {
    if (requireStaff(context)) return;
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.displayName !== "string") {
      return writeJson(response, 400, { error: "invalid_profile_request" });
    }
    return writeJson(
      response,
      200,
      store.renameProfile(actor.staffId, body.displayName, actor),
    );
  }

  if (url.pathname === "/api/v1/state" && request.method === "GET") {
    if (requireStaff(context)) return;
    try {
      const saved = store.read();
      return writeJson(
        response,
        200,
        stateForStaff(
          actor,
          saved ?? {
            revision: 0,
            savedAt: null,
            checksum: null,
            snapshot: null,
          },
        ),
      );
    } catch (error) {
      if (error instanceof StateIntegrityError) {
        return writeJson(response, 503, { error: "state_integrity_failed" });
      }
      throw error;
    }
  }

  if (url.pathname === "/api/v1/state" && request.method === "PUT") {
    if (requireStaff(context)) return;
    const body = await readJsonRequest(request);
    if (!isRecord(body)) {
      return writeJson(response, 400, { error: "invalid_state_request" });
    }
    const saved = store.save(
      body.snapshot as Record<string, unknown>,
      body.expectedRevision as number,
      actor,
      body.baseSnapshot as Record<string, unknown> | undefined,
    );
    return writeJson(response, 200, stateForStaff(actor, saved));
  }

  if (url.pathname === "/api/turn") {
    return writeJson(response, 503, { error: "turn_credentials_unavailable" });
  }

  if (url.pathname.startsWith("/api/")) {
    return writeJson(response, 404, { error: "not_found" });
  }
  if (
    staticDirectory &&
    serveStatic(request, response, staticDirectory, url.pathname)
  ) {
    return;
  }
  return writeJson(response, 404, { error: "not_found" });
}

function writeError(response: ServerResponse, error: unknown) {
  if (error instanceof RevisionConflictError) {
    return writeJson(response, 409, {
      error: "revision_conflict",
      currentRevision: error.currentRevision,
      conflictingPaths: error.conflictingPaths,
    });
  }
  if (error instanceof StateIntegrityError) {
    return writeJson(response, 503, { error: "state_integrity_failed" });
  }
  if (error instanceof InvitationError) {
    return writeJson(response, error.status, { error: error.code });
  }
  if (error instanceof RolePermissionError) {
    return writeJson(response, 403, { error: "role_not_allowed" });
  }
  if (error instanceof HubKioskPinError) {
    return writeJson(response, 403, { error: "invalid_student_pin" });
  }
  if (error instanceof HubKioskPromptError) {
    const status =
      error.code === "hub_prompt_configuration_changed"
        ? 409
        : error.code === "invalid_hub_prompt_response"
          ? 400
          : 422;
    return writeJson(response, status, { error: error.code });
  }
  if (error instanceof RecordNotFoundError) {
    return writeJson(response, 404, { error: "record_not_found" });
  }
  if (error instanceof TypeError) {
    return writeJson(response, 400, {
      error: error.message || "invalid_request",
    });
  }
  return writeJson(response, 500, { error: "host_error" });
}
