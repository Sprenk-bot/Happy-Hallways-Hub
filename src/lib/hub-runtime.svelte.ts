import {
  accountSnapshot,
  isHubHostEdition,
  loadHubSnapshot,
  onSave,
} from "./account.svelte";

type StaffSession = {
  sessionId: string;
  staffId: string;
  displayName: string;
  role: "ea" | "tic";
  authMethod: string;
  identityVerified: boolean;
  mfaVerified: boolean;
  expiresAt: string;
};

type StoredState = {
  revision: number;
  savedAt: string | null;
  checksum: string | null;
  snapshot: Record<string, unknown> | null;
};

type HubStatus =
  | "local"
  | "checking"
  | "signed-out"
  | "no-data"
  | "ready"
  | "offline"
  | "conflict"
  | "error";
type SaveStatus =
  "idle" | "saved" | "saving" | "offline" | "conflict" | "forbidden";

export const hubRuntime = $state({
  hosted: isHubHostEdition(),
  status: (isHubHostEdition() ? "checking" : "local") as HubStatus,
  saveStatus: "idle" as SaveStatus,
  session: null as StaffSession | null,
  revision: 0,
  lastSavedAt: null as string | null,
  conflictPaths: [] as string[],
  message: "",
});

let baseline: Record<string, unknown> | null = null;
let starting: Promise<void> | null = null;
let draining: Promise<void> | null = null;
let pollTimer: number | null = null;
let retryTimer: number | null = null;
let pollActive = false;

onSave(() => {
  if (!hubRuntime.hosted || hubRuntime.status !== "ready") return;
  hubRuntime.saveStatus = "saving";
  void drainSaves();
});

export function startHubRuntime() {
  if (!hubRuntime.hosted) return Promise.resolve();
  if (hubRuntime.status === "offline" && hubRuntime.session) {
    return reconnectAfterFailure();
  }
  if (starting) return starting;
  starting = connectToHost().finally(() => (starting = null));
  return starting;
}

async function connectToHost() {
  hubRuntime.status = "checking";
  hubRuntime.message = "";
  try {
    hubRuntime.session = await request<StaffSession>("/api/v1/session");
  } catch (error) {
    if (isHttpError(error, 401)) {
      hubRuntime.session = null;
      hubRuntime.status = "signed-out";
      return;
    }
    setOffline(error);
    return;
  }

  try {
    const stored = await request<StoredState>("/api/v1/state");
    acceptHostState(stored);
    if (stored.snapshot === null) {
      baseline = null;
      hubRuntime.status = "no-data";
      hubRuntime.saveStatus = "idle";
      return;
    }
    loadHubSnapshot(stored.snapshot);
    baseline = accountSnapshot() as unknown as Record<string, unknown>;
    hubRuntime.status = "ready";
    hubRuntime.saveStatus = "saved";
    beginPolling();
  } catch (error) {
    if (isHttpError(error, 401)) {
      hubRuntime.session = null;
      hubRuntime.status = "signed-out";
      return;
    }
    setOffline(error);
  }
}

export async function importLocalAccountToHost() {
  if (hubRuntime.status !== "no-data" || hubRuntime.session?.role !== "tic") {
    throw new Error(
      "Only a signed-in TIC can initialise an empty Hub Host account.",
    );
  }
  const snapshot = accountSnapshot() as unknown as Record<string, unknown>;
  const saved = await request<StoredState>("/api/v1/state", {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: 0, snapshot }),
  });
  acceptHostState(saved);
  if (!saved.snapshot)
    throw new Error("The Host did not return the imported account.");
  loadHubSnapshot(saved.snapshot);
  baseline = accountSnapshot() as unknown as Record<string, unknown>;
  hubRuntime.status = "ready";
  hubRuntime.saveStatus = "saved";
  hubRuntime.message = "The account was saved to the Hub Host.";
  beginPolling();
}

export async function reloadFromHost() {
  if (!hubRuntime.hosted || !hubRuntime.session) return;
  const stored = await request<StoredState>("/api/v1/state");
  acceptHostState(stored);
  if (!stored.snapshot) {
    baseline = null;
    hubRuntime.status = "no-data";
    hubRuntime.saveStatus = "idle";
    return;
  }
  loadHubSnapshot(stored.snapshot);
  baseline = accountSnapshot() as unknown as Record<string, unknown>;
  hubRuntime.status = "ready";
  hubRuntime.saveStatus = "saved";
  hubRuntime.conflictPaths = [];
  hubRuntime.message = "";
  beginPolling();
}

export function signOutHubRuntime() {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  pollTimer = null;
  retryTimer = null;
  hubRuntime.session = null;
  hubRuntime.status = hubRuntime.hosted ? "signed-out" : "local";
  hubRuntime.saveStatus = "idle";
}

export function hasUnsavedHubChanges() {
  if (!hubRuntime.hosted || !baseline) return false;
  return encode(accountSnapshot()) !== encode(baseline);
}

export function flushHubSaves(): Promise<boolean> {
  if (draining) {
    return draining.then(() => hubRuntime.saveStatus === "saved");
  }
  if (hubRuntime.hosted && hubRuntime.status === "ready") {
    return drainSaves().then(() => hubRuntime.saveStatus === "saved");
  }
  return Promise.resolve(!hubRuntime.hosted);
}

async function drainSaves() {
  if (draining) return draining;
  const operation = (async () => {
    while (hubRuntime.status === "ready" && baseline) {
      const snapshot = accountSnapshot() as unknown as Record<string, unknown>;
      if (encode(snapshot) === encode(baseline)) {
        hubRuntime.saveStatus = "saved";
        return;
      }
      const sent = JSON.parse(encode(snapshot)) as Record<string, unknown>;
      const baseSnapshot = JSON.parse(encode(baseline)) as Record<
        string,
        unknown
      >;
      hubRuntime.saveStatus = "saving";
      try {
        const stored = await request<StoredState>("/api/v1/state", {
          method: "PUT",
          body: JSON.stringify({
            expectedRevision: hubRuntime.revision,
            baseSnapshot,
            snapshot: sent,
          }),
        });
        if (!stored.snapshot)
          throw new Error("The Host returned no saved account.");
        acceptHostState(stored);
        baseline = JSON.parse(encode(stored.snapshot)) as Record<
          string,
          unknown
        >;
        if (encode(accountSnapshot()) === encode(sent)) {
          loadHubSnapshot(stored.snapshot);
          baseline = accountSnapshot() as unknown as Record<string, unknown>;
          hubRuntime.saveStatus = "saved";
          hubRuntime.message = "";
          return;
        }
      } catch (error) {
        if (isHttpError(error, 401)) {
          signOutHubRuntime();
        } else if (isHttpError(error, 409)) {
          hubRuntime.status = "conflict";
          hubRuntime.saveStatus = "conflict";
          hubRuntime.conflictPaths = error.paths;
          hubRuntime.message =
            "Another staff member changed the same record. Your in-memory changes are still here. Download them before reloading Host data.";
        } else if (isHttpError(error, 403)) {
          hubRuntime.status = "conflict";
          hubRuntime.saveStatus = "forbidden";
          hubRuntime.message =
            "Your staff role cannot change this part of the shared account.";
        } else {
          setOffline(error);
          planRetry();
        }
        return;
      }
    }
  })();
  draining = operation;
  try {
    await operation;
  } finally {
    if (draining === operation) draining = null;
  }
}

function beginPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => void pollHost(), 2500);
  window.addEventListener("online", () => void pollHost());
}

async function pollHost() {
  if (pollActive || hubRuntime.status === "signed-out" || !hubRuntime.session)
    return;
  pollActive = true;
  try {
    const stored = await request<StoredState>("/api/v1/state");
    if (stored.revision <= hubRuntime.revision) return;
    if (hasUnsavedHubChanges()) {
      hubRuntime.saveStatus = "saving";
      void drainSaves();
      return;
    }
    acceptHostState(stored);
    if (stored.snapshot) {
      loadHubSnapshot(stored.snapshot);
      baseline = accountSnapshot() as unknown as Record<string, unknown>;
      hubRuntime.status = "ready";
      hubRuntime.saveStatus = "saved";
    }
  } catch (error) {
    if (isHttpError(error, 401)) {
      signOutHubRuntime();
      return;
    }
    setOffline(error);
  } finally {
    pollActive = false;
  }
}

function acceptHostState(stored: StoredState) {
  hubRuntime.revision = stored.revision;
  hubRuntime.lastSavedAt = stored.savedAt;
}

function setOffline(error: unknown) {
  const hasPendingChanges = hasUnsavedHubChanges();
  hubRuntime.status = "offline";
  hubRuntime.saveStatus = hasPendingChanges ? "offline" : "idle";
  hubRuntime.message =
    error instanceof Error
      ? error.message
      : "The Hub Host could not be reached.";
  planRetry();
}

function planRetry() {
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (hubRuntime.status === "offline") void reconnectAfterFailure();
  }, 3000);
}

async function reconnectAfterFailure() {
  if (!hubRuntime.session) {
    await startHubRuntime();
    return;
  }
  try {
    const stored = await request<StoredState>("/api/v1/state");
    if (stored.revision > hubRuntime.revision && hasUnsavedHubChanges()) {
      // The next save sends the last acknowledged base and lets the Host merge it safely.
    } else if (stored.snapshot && !hasUnsavedHubChanges()) {
      acceptHostState(stored);
      loadHubSnapshot(stored.snapshot);
      baseline = accountSnapshot() as unknown as Record<string, unknown>;
    }
    hubRuntime.status = stored.snapshot ? "ready" : "no-data";
    if (hasUnsavedHubChanges()) void drainSaves();
    else hubRuntime.saveStatus = stored.snapshot ? "saved" : "idle";
    beginPolling();
  } catch (error) {
    if (isHttpError(error, 401)) {
      signOutHubRuntime();
      return;
    }
    setOffline(error);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body?.error ?? `Host request failed (${response.status}).`,
    ) as Error & {
      status: number;
      paths?: string[];
    };
    error.status = response.status;
    error.paths = Array.isArray(body?.conflictingPaths)
      ? body.conflictingPaths
      : [];
    throw error;
  }
  return body as T;
}

function isHttpError(
  error: unknown,
  status: number,
): error is Error & { status: number; paths: string[] } {
  return error instanceof Error && "status" in error && error.status === status;
}

function encode(value: unknown) {
  return JSON.stringify(value);
}
