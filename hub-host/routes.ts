import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IConfidentialClientApplication } from "@azure/msal-node";
import {
  RecordNotFoundError,
  StateIntegrityError,
  type HubStore,
  type StaffActor,
} from "./store";
import type { HubBackupManager } from "./backups";
import { claimString, type EntraOptions } from "./entra";

const sessionCookieName = "hh_hub_session";
const kioskSessionCookieName = "hh_hub_kiosk";

/** Default cap for request bodies; endpoints needing more pass an explicit limit. */
const defaultMaxBodyBytes = 1024 * 1024;

/** Everything a per-endpoint handler needs to answer a request. */
export type RouteContext = {
  request: IncomingMessage;
  response: ServerResponse;
  store: HubStore;
  backupManager: HubBackupManager;
  networkMode: "loopback_only" | "https_lan_configured";
  secure: boolean;
  entraClient: IConfidentialClientApplication | null;
  entraOptions: EntraOptions | null;
  allowNamedProfileFallback: boolean;
  namedProfileFallbackApprovedForRealData: boolean;
  staticDirectory: string | null;
  actor: StaffActor | null;
  kioskToken: string | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonRequest(
  request: IncomingMessage,
  maxBytes = defaultMaxBodyBytes,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  ) {
    throw new TypeError("json_required");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) throw new TypeError("request_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new TypeError("invalid_json");
  }
}

export function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readCookie(request: IncomingMessage, name: string) {
  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function readSessionCookie(request: IncomingMessage) {
  return readCookie(request, sessionCookieName);
}

export function readHubKioskSessionCookie(request: IncomingMessage) {
  return readCookie(request, kioskSessionCookieName);
}

export function sessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
) {
  return `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function hubKioskSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
) {
  return `${kioskSessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/v1/kiosk; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function sessionResponse(actor: StaffActor) {
  const identityVerified = actor.authMethod === "microsoft-entra-oidc";
  return {
    sessionId: actor.sessionId,
    staffId: actor.staffId,
    displayName: actor.displayName,
    role: actor.role,
    authMethod: actor.authMethod,
    identityVerified,
    mfaVerified: identityVerified,
    expiresAt: actor.expiresAt,
  };
}

/** Writes a 401 when no staff session is present. Returns true when handled. */
export function requireStaff(context: RouteContext): boolean {
  if (!context.actor) {
    writeJson(context.response, 401, { error: "staff_session_required" });
    return true;
  }
  return false;
}

/** The authenticated guardedActor(context) after a requireStaff/requireTic guard passed. */
export function guardedActor(context: RouteContext): StaffActor {
  return context.actor as StaffActor;
}

/** Writes a 401/403 unless a TIC staff session is present. */
export function requireTic(context: RouteContext): boolean {
  if (requireStaff(context)) return true;
  if (guardedActor(context).role !== "tic") {
    writeJson(context.response, 403, { error: "tic_role_required" });
    return true;
  }
  return false;
}

function isSaveRequest(value: unknown): value is {
  expectedRevision: number;
  snapshot: Record<string, unknown>;
  baseSnapshot?: Record<string, unknown>;
} {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.expectedRevision) &&
    (value.expectedRevision as number) >= 0 &&
    isRecord(value.snapshot) &&
    (value.baseSnapshot === undefined || isRecord(value.baseSnapshot))
  );
}

/** Strips staff-only fields (PINs, kiosk secrets) before sending state to non-TIC staff. */
export function stateForStaff<T extends { snapshot: Record<string, unknown> | null }>(
  actor: StaffActor,
  stored: T,
): T {
  if (actor.role === "tic" || !stored.snapshot) return stored;
  const snapshot = JSON.parse(JSON.stringify(stored.snapshot)) as Record<string, unknown>;
  snapshot.pin = "";
  snapshot.replacedKiosks = [];
  snapshot.claims = [];
  if (Array.isArray(snapshot.roster)) {
    snapshot.roster = snapshot.roster.map((value) => {
      if (!isRecord(value)) return value;
      const student = { ...value };
      delete student.pin;
      return student;
    });
  }
  if (isRecord(snapshot.kiosk)) {
    const kiosk = { ...snapshot.kiosk };
    delete kiosk.secret;
    snapshot.kiosk = kiosk;
  }
  const studentLink = snapshot.studentLink;
  const studentRoom = isRecord(studentLink) ? studentLink.room : null;
  if (isRecord(studentLink) && isRecord(studentRoom)) {
    const room = { ...studentRoom };
    delete room.code;
    snapshot.studentLink = {
      ...studentLink,
      room,
    };
  }
  return { ...stored, snapshot };
}

export function isFavouriteStudentIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 500 &&
    value.every(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 128 &&
        id.trim() === id,
    )
  );
}

function isHubKioskActivationRequest(
  value: unknown,
): value is { token: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.token === "string" &&
    value.token.length >= 32 &&
    value.token.length <= 128
  );
}

export function isHubPromptOverrideRequest(
  value: unknown,
): value is {
  studentId: string;
  destinationId: string;
  stage: "arrival" | "departure";
  reason: string;
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    typeof value.studentId === "string" &&
    value.studentId.length > 0 &&
    value.studentId.length <= 128 &&
    typeof value.destinationId === "string" &&
    value.destinationId.length > 0 &&
    value.destinationId.length <= 128 &&
    (value.stage === "arrival" || value.stage === "departure") &&
    typeof value.reason === "string" &&
    value.reason.trim().length >= 3 &&
    value.reason.trim().length <= 300
  );
}

export function isHubConcernPolicyRequest(
  value: unknown,
): value is {
  availableScopes: ("tic" | "all-staff" | "selected")[];
  defaultScope: "tic" | "all-staff" | "selected";
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.availableScopes) &&
    value.availableScopes.every(isHubConcernScope) &&
    isHubConcernScope(value.defaultScope)
  );
}

function isHubConcernScope(
  value: unknown,
): value is "tic" | "all-staff" | "selected" {
  return value === "tic" || value === "all-staff" || value === "selected";
}

export function isHubConcernRequest(
  value: unknown,
): value is {
  visitId: string;
  note: string;
  scope: "tic" | "all-staff" | "selected";
  recipientIds: string[];
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    typeof value.visitId === "string" &&
    value.visitId.length > 0 &&
    value.visitId.length <= 128 &&
    typeof value.note === "string" &&
    (value.scope === "tic" ||
      value.scope === "all-staff" ||
      value.scope === "selected") &&
    Array.isArray(value.recipientIds) &&
    value.recipientIds.length <= 200 &&
    value.recipientIds.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 128,
    )
  );
}

function isHubKioskMovementRequest(
  value: unknown,
): value is Parameters<HubStore["recordHubKioskAction"]>[1] {
  if (
    !isRecord(value) ||
    (value.pin !== undefined &&
      (typeof value.pin !== "string" || !/^\d{3,6}$/.test(value.pin)))
  ) {
    return false;
  }
  if (
    value.action === "arrive" ||
    value.action === "leave" ||
    value.action === "temporary-return"
  ) {
    return (
      Object.keys(value).every((key) =>
        ["action", "visitId", "pin", "promptVersion", "promptAnswers"].includes(
          key,
        ),
      ) &&
      typeof value.visitId === "string" &&
      value.visitId.length > 0 &&
      value.visitId.length <= 128 &&
      (value.action === "temporary-return"
        ? value.promptVersion === undefined &&
          value.promptAnswers === undefined
        : isHubKioskPromptData(value))
    );
  }
  if (value.action === "prompts") {
    return (
      Object.keys(value).every((key) => ["action", "visitId", "stage", "pin", "promptVersion", "promptAnswers"].includes(key)) &&
      typeof value.visitId === "string" && value.visitId.length > 0 && value.visitId.length <= 128 &&
      (value.stage === "arrival" || value.stage === "departure") && isHubKioskPromptData(value)
    );
  }
  if (value.action === "direct-arrive") {
    return (
      Object.keys(value).every((key) =>
        [
          "action",
          "studentId",
          "destinationId",
          "pin",
          "promptVersion",
          "promptAnswers",
        ].includes(key),
      ) &&
      typeof value.studentId === "string" &&
      value.studentId.length > 0 &&
      value.studentId.length <= 128 &&
      typeof value.destinationId === "string" &&
      value.destinationId.length > 0 &&
      value.destinationId.length <= 128 &&
      isHubKioskPromptData(value)
    );
  }
  if (value.action === "temporary-start") {
    return (
      Object.keys(value).every((key) =>
        ["action", "visitId", "destinationId", "pin"].includes(key),
      ) &&
      typeof value.visitId === "string" &&
      value.visitId.length > 0 &&
      value.visitId.length <= 128 &&
      typeof value.destinationId === "string" &&
      value.destinationId.length > 0 &&
      value.destinationId.length <= 128
    );
  }
  return false;
}

function isHubKioskPromptData(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  promptVersion?: number;
  promptAnswers?: Record<string, string | number>;
} {
  if (
    value.promptVersion !== undefined &&
    (typeof value.promptVersion !== "number" ||
      !Number.isSafeInteger(value.promptVersion) ||
      value.promptVersion < 1)
  ) {
    return false;
  }
  if (value.promptAnswers === undefined) return true;
  return (
    isRecord(value.promptAnswers) &&
    Object.keys(value.promptAnswers).length <= 8 &&
    Object.entries(value.promptAnswers).every(
      ([id, answer]) =>
        id.length > 0 &&
        id.length <= 128 &&
        ((typeof answer === "string" && answer.length <= 2000) ||
          (typeof answer === "number" &&
            Number.isSafeInteger(answer) &&
            answer >= 1 &&
            answer <= 10)),
    )
  );
}

/** Endpoints reachable without any session: health, auth options, sign-in flows. */
export async function routePublic(
  context: RouteContext,
  url: URL,
): Promise<boolean> {
  const {
    request,
    response,
    store,
    backupManager,
    entraClient,
    entraOptions,
    secure,
    allowNamedProfileFallback,
    namedProfileFallbackApprovedForRealData,
  } = context;

  if (url.pathname === "/api/v1/health" && request.method === "GET") {
    try {
      const saved = store.read();
      const backupHealth = backupManager.health();
      writeJson(response, 200, {
        status: "ready",
        storage: "sqlite",
        application: context.staticDirectory ? "served_from_host" : "api_only",
        network: {
          mode: context.networkMode,
          schoolLanTest: "not_verified",
        },
        revision: saved?.revision ?? 0,
        lastSavedAt: saved?.savedAt ?? null,
        backups: {
          local: {
            status: backupHealth.local.status,
            latestSnapshotAt: backupHealth.local.latestSnapshotAt,
            latestRevision: backupHealth.local.latestRevision,
          },
          offHost: {
            status: backupHealth.offHost.status,
            latestCopyAt: backupHealth.offHost.latestCopyAt,
            pendingCopies: backupHealth.offHost.pendingCopies,
            independentStorageVerified:
              backupHealth.offHost.independentStorageVerified,
            fallbackOperational: backupHealth.offHost.fallbackOperational,
            destinations: backupHealth.offHost.destinations.map(
              ({ role, status, latestCopyAt, pendingCopies }) => ({
                role,
                status,
                latestCopyAt,
                pendingCopies,
              }),
            ),
          },
          restoreTest: {
            status: backupHealth.restoreTest.status,
            lastTestAt: backupHealth.restoreTest.lastTestAt,
          },
          localSnapshotIntervalMinutes:
            backupHealth.localSnapshotIntervalMinutes,
          targetOffHostLagMinutes: backupHealth.targetOffHostLagMinutes,
          retention: backupHealth.retention,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof StateIntegrityError) {
        writeJson(response, 503, {
          status: "degraded",
          error: "state_integrity_failed",
        });
        return true;
      }
      throw error;
    }
  }

  if (url.pathname === "/api/v1/auth/options" && request.method === "GET") {
    writeJson(response, 200, {
      preferred: {
        id: "microsoft-entra-oidc",
        status: entraClient
          ? "configured_ict_mfa_policy_required"
          : "pending_configuration",
        enabled: Boolean(entraClient && entraOptions?.mfaPolicyConfirmed),
        mfaPolicy:
          entraClient && entraOptions?.mfaPolicyConfirmed
            ? "ict_confirmed"
            : "unconfirmed",
      },
      fallback: {
        id: "tic-approved-named-profile-device-enrolment",
        status: allowNamedProfileFallback
          ? namedProfileFallbackApprovedForRealData
            ? "ict_approved_compensating_control"
            : "development_only"
          : "disabled_pending_configuration",
        enabled: allowNamedProfileFallback,
        identityVerified: false,
        mfaVerified: false,
        realStudentDataAllowed:
          allowNamedProfileFallback && namedProfileFallbackApprovedForRealData,
      },
      note: namedProfileFallbackApprovedForRealData
        ? "ICT has approved the named-profile fallback as a compensating control for real data at this Host. It does not verify a staff member's identity and is not MFA. Entra remains a separate sign-in option."
        : "The named-profile fallback is for fictional development data unless ICT has approved it as a compensating control. It does not verify identity or provide MFA.",
    });
    return true;
  }

  if (url.pathname === "/api/v1/auth/entra/start" && request.method === "POST") {
    if (!entraClient || !entraOptions?.mfaPolicyConfirmed) {
      writeJson(response, 503, {
        error: "entra_sign_in_not_configured",
      });
      return true;
    }
    const body = await readJsonRequest(request);
    if (
      !isRecord(body) ||
      (body.invitationToken !== undefined &&
        typeof body.invitationToken !== "string")
    ) {
      writeJson(response, 400, { error: "invalid_sign_in_request" });
      return true;
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    store.beginEntraLogin(
      state,
      nonce,
      body.invitationToken as string | undefined,
    );
    const location = await entraClient.getAuthCodeUrl({
      scopes: ["openid", "profile", "email"],
      redirectUri: entraOptions.redirectUri,
      responseMode: "query",
      prompt: "select_account",
      state,
      nonce,
    });
    writeJson(response, 200, { authorizationUrl: location });
    return true;
  }

  if (
    url.pathname === "/api/v1/auth/entra/callback" &&
    request.method === "GET"
  ) {
    if (!entraClient || !entraOptions?.mfaPolicyConfirmed) {
      writeJson(response, 503, {
        error: "entra_sign_in_not_configured",
      });
      return true;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error")) {
      response.writeHead(303, {
        Location: "/hub-admin?signIn=failed",
        "Cache-Control": "no-store",
      });
      response.end();
      return true;
    }
    if (!state || !code) {
      writeJson(response, 400, { error: "invalid_sign_in_response" });
      return true;
    }
    const nonce = store.getEntraAuthNonce(state);
    if (!nonce) {
      writeJson(response, 401, { error: "sign_in_state_expired" });
      return true;
    }
    const result = await entraClient.acquireTokenByCode({
      code,
      scopes: ["openid", "profile", "email"],
      redirectUri: entraOptions.redirectUri,
      state,
      nonce,
    });
    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
    const tenantId = claimString(claims, "tid");
    const objectId = claimString(claims, "oid");
    const displayName = claimString(claims, "name");
    const email =
      claimString(claims, "preferred_username") ??
      claimString(claims, "email") ??
      claimString(claims, "upn");
    if (
      tenantId?.toLowerCase() !== entraOptions.tenantId.toLowerCase() ||
      !objectId ||
      !displayName ||
      !email
    ) {
      writeJson(response, 403, {
        error: "required_staff_identity_claim_missing",
      });
      return true;
    }
    const session = store.completeEntraLogin(state, {
      tenantId,
      objectId,
      displayName,
      email,
    });
    const maxAge = Math.max(
      0,
      Math.floor((Date.parse(session.actor.expiresAt) - Date.now()) / 1000),
    );
    response.writeHead(303, {
      Location: "/hub-admin?signIn=complete",
      "Set-Cookie": sessionCookie(session.sessionToken, maxAge, true),
      "Cache-Control": "no-store",
    });
    response.end();
    return true;
  }

  if (url.pathname === "/api/v1/enroll" && request.method === "POST") {
    if (!allowNamedProfileFallback) {
      writeJson(response, 503, { error: "fallback_sign_in_not_configured" });
      return true;
    }
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.invitationToken !== "string") {
      writeJson(response, 400, { error: "invalid_enrollment_request" });
      return true;
    }
    if (body.displayName !== undefined && typeof body.displayName !== "string") {
      writeJson(response, 400, { error: "invalid_enrollment_request" });
      return true;
    }
    const result = store.enroll(
      body.invitationToken,
      body.displayName as string | undefined,
    );
    const maxAge = Math.max(
      0,
      Math.floor((Date.parse(result.actor.expiresAt) - Date.now()) / 1000),
    );
    writeJson(response, 201, sessionResponse(result.actor), {
      "Set-Cookie": sessionCookie(result.sessionToken, maxAge, secure),
    });
    return true;
  }

  return false;
}

/** Kiosk activation, start/stop, and the cookie-guarded kiosk session endpoints. */
export async function routeKiosk(
  context: RouteContext,
  url: URL,
): Promise<boolean> {
  const { request, response, store, secure, kioskToken } = context;

  if (url.pathname === "/api/v1/kiosk/activate" && request.method === "POST") {
    if (context.actor) {
      writeJson(response, 409, { error: "use_separate_kiosk_browser" });
      return true;
    }
    const body = await readJsonRequest(request);
      if (!isHubKioskActivationRequest(body)) {
        writeJson(response, 400, {
          error: "invalid_kiosk_activation_request",
        });
        return true;
      }
      let kioskSession;
      try {
        kioskSession = store.redeemHubKioskActivation(body.token);
      } catch (error) {
        if (error instanceof RecordNotFoundError) {
          writeJson(response, 401, { error: "invalid_kiosk_activation" });
          return true;
        }
        throw error;
      }
      const maxAge = Math.max(
        0,
        Math.floor((Date.parse(kioskSession.expiresAt) - Date.now()) / 1000),
      );
      writeJson(
        response,
        201,
        { expiresAt: kioskSession.expiresAt },
        {
        "Set-Cookie": hubKioskSessionCookie(kioskSession.token, maxAge, secure),
      },
    );
    return true;
  }

  if (url.pathname === "/api/v1/kiosk/start" && request.method === "POST") {
    if (requireTic(context)) return true;
    writeJson(response, 201, store.createHubKioskActivation(guardedActor(context)));
    return true;
  }

  if (url.pathname === "/api/v1/kiosk/stop" && request.method === "POST") {
    if (requireTic(context)) return true;
    const stopped = store.stopHubKioskSessions(guardedActor(context));
    writeJson(response, 200, stopped, {
      "Set-Cookie": hubKioskSessionCookie("", 0, secure),
    });
    return true;
  }

  if (
    url.pathname.startsWith("/api/v1/kiosk/") &&
    url.pathname !== "/api/v1/kiosk/activate" &&
    url.pathname !== "/api/v1/kiosk/start" &&
    url.pathname !== "/api/v1/kiosk/stop"
  ) {
    if (!store.getHubKioskSession(kioskToken)) {
      writeJson(response, 401, { error: "kiosk_session_required" });
      return true;
    }
    if (url.pathname === "/api/v1/kiosk/session" && request.method === "GET") {
      writeJson(response, 200, store.getHubKioskSession(kioskToken));
      return true;
    }
    if (url.pathname === "/api/v1/kiosk/state" && request.method === "GET") {
      writeJson(response, 200, store.readHubKioskState());
      return true;
    }
    if (url.pathname === "/api/v1/kiosk/movements" && request.method === "POST") {
      const body = await readJsonRequest(request, 72 * 1024);
      if (!isHubKioskMovementRequest(body)) {
        writeJson(response, 400, {
          error: "invalid_kiosk_movement_request",
        });
        return true;
      }
      const saved = store.recordHubKioskAction(kioskToken ?? "", body);
      writeJson(response, 200, {
        accepted: true,
        revision: saved.revision,
        savedAt: saved.savedAt,
        chime: saved.chime,
        ...(saved.confirmationMessage
          ? { confirmationMessage: saved.confirmationMessage }
          : {}),
      });
      return true;
    }
    writeJson(response, 404, { error: "not_found" });
    return true;
  }

  return false;
}

/** TIC-only backup health, runs, restore points and staged restores. */
export async function routeBackups(
  context: RouteContext,
  url: URL,
): Promise<boolean> {
  const { request, response, store, backupManager } = context;

  if (url.pathname === "/api/v1/backups/health" && request.method === "GET") {
    if (requireTic(context)) return true;
    writeJson(response, 200, backupManager.health());
    return true;
  }

  if (url.pathname === "/api/v1/backups/run" && request.method === "POST") {
    if (requireTic(context)) return true;
    store.recordAdministrativeEvent("backup_run_requested", guardedActor(context), {});
    const health = await backupManager.runNow();
    store.recordAdministrativeEvent("backup_run_completed", guardedActor(context), {
      localStatus: health.local.status,
      offHostStatus: health.offHost.status,
      restoreTestStatus: health.restoreTest.status,
    });
    writeJson(response, 200, health);
    return true;
  }

  if (
    url.pathname === "/api/v1/backups/restore-points" &&
    request.method === "GET"
  ) {
    if (requireTic(context)) return true;
    writeJson(response, 200, {
      restorePoints: backupManager.restorePoints(),
    });
    return true;
  }

  if (
    url.pathname === "/api/v1/backups/restore/stage" &&
    request.method === "POST"
  ) {
    if (requireTic(context)) return true;
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.backupId !== "string") {
      writeJson(response, 400, {
        error: "invalid_restore_stage_request",
      });
      return true;
    }
    store.recordAdministrativeEvent("backup_restore_stage_requested", guardedActor(context), {
      backupId: body.backupId,
    });
    const stage = backupManager.stageRestore(body.backupId);
    store.recordAdministrativeEvent("backup_restore_staged", guardedActor(context), {
      backupId: stage.backupId,
      stageId: stage.stageId,
      preview: stage.preview,
    });
    writeJson(response, 201, { stage });
    return true;
  }

  if (
    url.pathname === "/api/v1/backups/restore/promote" &&
    request.method === "POST"
  ) {
    if (requireTic(context)) return true;
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.stageId !== "string") {
      writeJson(response, 400, {
        error: "invalid_restore_promotion_request",
      });
      return true;
    }
    writeJson(response, 200, backupManager.promoteRestore(body.stageId, guardedActor(context)));
    return true;
  }

  return false;
}

/** Mail recipient listing, inbox listing and mark-as-read. */
export async function routeMail(context: RouteContext, url: URL): Promise<boolean> {
  const { request, response, store } = context;

  if (url.pathname === "/api/v1/mail/recipients" && request.method === "GET") {
    if (requireStaff(context)) return true;
    writeJson(response, 200, { recipients: store.listMailRecipients() });
    return true;
  }

  if (url.pathname === "/api/v1/mail" && request.method === "GET") {
    if (requireStaff(context)) return true;
    writeJson(response, 200, store.listHubMail(guardedActor(context)));
    return true;
  }

  const mailReplyMatch = /^\/api\/v1\/mail\/([a-f0-9-]+)\/replies$/i.exec(url.pathname);
  if (mailReplyMatch && request.method === "POST") {
    if (requireStaff(context)) return true;
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.note !== "string") {
      writeJson(response, 400, { error: "invalid_mail_reply" });
      return true;
    }
    writeJson(response, 201, store.createHubMailReply(guardedActor(context), mailReplyMatch[1], body.note));
    return true;
  }

  const mailArchiveMatch = /^\/api\/v1\/mail\/([a-f0-9-]+)\/archive$/i.exec(url.pathname);
  if (mailArchiveMatch && request.method === "POST") {
    if (requireTic(context)) return true;
    const body = await readJsonRequest(request);
    if (!isRecord(body) || typeof body.archived !== "boolean") {
      writeJson(response, 400, { error: "invalid_mail_archive_request" });
      return true;
    }
    writeJson(response, 200, store.setHubMailArchived(guardedActor(context), mailArchiveMatch[1], body.archived));
    return true;
  }

  const mailReadMatch = /^\/api\/v1\/mail\/([a-f0-9-]+)\/read$/i.exec(
    url.pathname,
  );
  if (mailReadMatch && request.method === "POST") {
    if (requireStaff(context)) return true;
    writeJson(response, 200, store.markHubMailRead(guardedActor(context), mailReadMatch[1]));
    return true;
  }

  return false;
}

/** Staff adjustments to an active Hub visit timer. */
export async function routeHubVisitActions(context: RouteContext, url: URL): Promise<boolean> {
  const { request, response, store } = context;
  const match = /^\/api\/v1\/hub-visits\/([A-Za-z0-9-]+)\/(time|note)$/.exec(url.pathname);
  if (!match || request.method !== "POST") return false;
  if (requireStaff(context)) return true;
  const body = await readJsonRequest(request);
  if (!isRecord(body)) { writeJson(response, 400, { error: "invalid_hub_visit_action" }); return true; }
  if (match[2] === "note") {
    if (typeof body.note !== "string") { writeJson(response, 400, { error: "invalid_hub_staff_note" }); return true; }
    const saved = store.updateHubVisitStaffNote(guardedActor(context), match[1], body.note);
    writeJson(response, 200, { revision: saved.revision, savedAt: saved.savedAt, snapshot: saved.snapshot });
    return true;
  }
  if (typeof body.minutes !== "number" || !Number.isSafeInteger(body.minutes)) { writeJson(response, 400, { error: "invalid_hub_timer_extension" }); return true; }
  const saved = store.extendHubVisitTimer(guardedActor(context), match[1], body.minutes);
  writeJson(response, 200, { revision: saved.revision, savedAt: saved.savedAt, snapshot: saved.snapshot });
  return true;
}

/** Invitation listing, creation and revocation (TIC only). */
export function routeInvitations(context: RouteContext, url: URL): boolean {
  const { request, response, store, allowNamedProfileFallback } = context;

  if (url.pathname === "/api/v1/invitations") {
    if (requireTic(context)) return true;
    if (request.method === "GET") {
      writeJson(response, 200, { invitations: store.listInvitations(guardedActor(context)) });
      return true;
    }
    if (request.method === "POST") {
      void (async () => {
        const body = await readJsonRequest(request);
        if (!isRecord(body) || (body.role !== "ea" && body.role !== "tic")) {
          writeJson(response, 400, { error: "invalid_invitation_request" });
          return;
        }
        if (
          body.staffProfileId !== undefined &&
          body.staffProfileId !== null &&
          typeof body.staffProfileId !== "string"
        ) {
          writeJson(response, 400, { error: "invalid_invitation_request" });
          return;
        }
        if (
          body.invitedEmail !== undefined &&
          typeof body.invitedEmail !== "string"
        ) {
          writeJson(response, 400, { error: "invalid_invitation_request" });
          return;
        }
        if (!allowNamedProfileFallback && !body.invitedEmail) {
          writeJson(response, 503, {
            error: "fallback_sign_in_not_configured",
          });
          return;
        }
        const invitation = store.createInvitation(
          body.role,
          guardedActor(context),
          (body.staffProfileId as string | null | undefined) ?? null,
          (body.invitedEmail as string | undefined) ?? null,
        );
        writeJson(response, 201, {
          invitation: {
            id: invitation.id,
            token: invitation.token,
            role: invitation.role,
            invitedEmail: invitation.invitedEmail,
            staffProfileId: invitation.staffProfileId,
            expiresAt: invitation.expiresAt,
            status: invitation.status,
          },
        });
      })();
      return true;
    }
  }

  const invitationMatch = url.pathname.match(
    /^\/api\/v1\/invitations\/([^/]+)$/,
  );
  if (invitationMatch && request.method === "DELETE") {
    if (requireTic(context)) return true;
    const changed = store.revokeInvitation(
      decodeURIComponent(invitationMatch[1]),
      guardedActor(context),
    );
    writeJson(response, 200, { revoked: changed });
    return true;
  }

  return false;
}

/** Staff directory and session administration (TIC only). */
export function routeSessions(context: RouteContext, url: URL): boolean {
  const { request, response, store, secure } = context;

  if (url.pathname === "/api/v1/staff" && request.method === "GET") {
    if (requireTic(context)) return true;
    writeJson(response, 200, { staff: store.listProfiles(guardedActor(context)) });
    return true;
  }

  if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
    if (requireTic(context)) return true;
    writeJson(response, 200, { sessions: store.listSessions(guardedActor(context)) });
    return true;
  }

  if (
    url.pathname === "/api/v1/sessions/revoke-all" &&
    request.method === "POST"
  ) {
    if (requireTic(context)) return true;
    const revokedCount = store.revokeAllSessions(guardedActor(context));
    writeJson(
      response,
      200,
      { revokedCount },
      { "Set-Cookie": sessionCookie("", 0, secure) },
    );
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    if (requireTic(context)) return true;
    const revoked = store.revokeSession(
      decodeURIComponent(sessionMatch[1]),
      guardedActor(context),
    );
    writeJson(response, 200, { revoked });
    return true;
  }

  return false;
}

/** Audit log listing and saved-state read/save. */
export async function routeAuditState(
  context: RouteContext,
  url: URL,
): Promise<boolean> {
  const { request, response, store } = context;

  if (url.pathname === "/api/v1/audit" && request.method === "GET") {
    if (requireTic(context)) return true;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit)) {
      writeJson(response, 400, { error: "invalid_limit" });
      return true;
    }
    writeJson(response, 200, {
      events: store.listAuditEvents(guardedActor(context), limit),
    });
    return true;
  }

  if (url.pathname === "/api/v1/state" && request.method === "GET") {
    if (requireStaff(context)) return true;
    try {
      const saved = store.read();
      writeJson(
        response,
        200,
        stateForStaff(
          guardedActor(context),
          saved ?? {
            revision: 0,
            savedAt: null,
            checksum: null,
            snapshot: null,
          },
        ),
      );
      return true;
    } catch (error) {
      if (error instanceof StateIntegrityError) {
        writeJson(response, 503, { error: "state_integrity_failed" });
        return true;
      }
      throw error;
    }
  }

  if (url.pathname === "/api/v1/state" && request.method === "PUT") {
    if (requireStaff(context)) return true;
    const body = await readJsonRequest(request);
    if (!isSaveRequest(body)) {
      writeJson(response, 400, { error: "invalid_state_request" });
      return true;
    }
    const saved = store.save(
      body.snapshot,
      body.expectedRevision,
      guardedActor(context),
      body.baseSnapshot,
    );
    writeJson(response, 200, stateForStaff(guardedActor(context), saved));
    return true;
  }

  return false;
}
