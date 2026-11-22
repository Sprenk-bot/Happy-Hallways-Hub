import { hubRuntime } from "./hub-runtime.svelte";

const localKey = "happy-hallways.hub-favourites.v1";
const maximumFavourites = 500;

export const staffPreferences = $state({
  loaded: false,
  saving: false,
  favouriteStudentIds: [] as string[],
  error: "",
});

let loadedOwner: string | null = null;
let loadingOwner: string | null = null;
let loading: Promise<void> | null = null;
let loadGeneration = 0;

export async function loadStaffPreferences() {
  const owner = currentOwner();
  if (!owner || (hubRuntime.hosted && !hubRuntime.session)) {
    clearStaffPreferences();
    return;
  }
  if (staffPreferences.loaded && loadedOwner === owner) return;
  if (loading && loadingOwner === owner) return loading;

  const generation = ++loadGeneration;
  loadingOwner = owner;
  if (loadedOwner !== owner) {
    staffPreferences.favouriteStudentIds = [];
    staffPreferences.loaded = false;
  }
  const operation = (async () => {
    staffPreferences.loaded = false;
    staffPreferences.error = "";
    try {
      if (hubRuntime.hosted) {
        const result = await requestPreferences("GET");
        staffPreferences.favouriteStudentIds = checkedIds(
          result.favouriteStudentIds,
        );
      } else {
        const stored = localStorage.getItem(localKey);
        staffPreferences.favouriteStudentIds = stored
          ? checkedIds(JSON.parse(stored))
          : [];
      }
      if (generation !== loadGeneration || currentOwner() !== owner) return;
      loadedOwner = owner;
      staffPreferences.loaded = true;
    } catch (error) {
      if (generation === loadGeneration && currentOwner() === owner) {
        staffPreferences.error =
          error instanceof Error
            ? error.message
            : "Favourites could not be loaded.";
      }
    } finally {
      if (generation === loadGeneration) {
        loading = null;
        loadingOwner = null;
      }
    }
  })();
  loading = operation;
  await operation;
}

export async function toggleFavouriteStudent(studentId: string) {
  const owner = currentOwner();
  if (
    !owner ||
    !staffPreferences.loaded ||
    staffPreferences.saving ||
    !isValidId(studentId)
  ) {
    return;
  }
  const current = staffPreferences.favouriteStudentIds;
  const next = current.includes(studentId)
    ? current.filter((id) => id !== studentId)
    : [...current, studentId];
  if (next.length > maximumFavourites) {
    staffPreferences.error = "You can favourite up to 500 students.";
    return;
  }

  const generation = loadGeneration;
  staffPreferences.saving = true;
  staffPreferences.error = "";
  try {
    if (hubRuntime.hosted) {
      if (hubRuntime.status !== "ready") {
        throw new Error("Reconnect to the Hub Host before saving favourites.");
      }
      const saved = await requestPreferences("PUT", next);
      if (generation !== loadGeneration || currentOwner() !== owner) return;
      staffPreferences.favouriteStudentIds = checkedIds(
        saved.favouriteStudentIds,
      );
    } else {
      localStorage.setItem(localKey, JSON.stringify(next));
      if (generation !== loadGeneration || currentOwner() !== owner) return;
      staffPreferences.favouriteStudentIds = next;
    }
  } catch (error) {
    if (generation === loadGeneration && currentOwner() === owner) {
      staffPreferences.error =
        error instanceof Error
          ? error.message
          : "The favourite could not be saved.";
    }
  } finally {
    if (generation === loadGeneration) staffPreferences.saving = false;
  }
}

export function clearStaffPreferences() {
  loadGeneration += 1;
  loadedOwner = null;
  loading = null;
  loadingOwner = null;
  staffPreferences.loaded = false;
  staffPreferences.saving = false;
  staffPreferences.favouriteStudentIds = [];
  staffPreferences.error = "";
}

async function requestPreferences(method: "GET" | "PUT", ids?: string[]) {
  const response = await fetch("/api/v1/preferences", {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "PUT" ? { "Content-Type": "application/json" } : {},
    body:
      method === "PUT"
        ? JSON.stringify({ favouriteStudentIds: ids })
        : undefined,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorCode =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "";
    throw new Error(
      errorCode === "staff_session_required"
        ? "Your staff session ended. Sign in again to use favourites."
        : errorCode === "staff_preferences_integrity_failed"
          ? "Saved favourites failed an integrity check. Ask the TIC for support."
          : errorCode || `Host request failed (${response.status}).`,
    );
  }
  if (typeof body !== "object" || body === null || !("favouriteStudentIds" in body)) {
    throw new Error("The Hub Host returned invalid staff preferences.");
  }
  return { favouriteStudentIds: body.favouriteStudentIds };
}

function checkedIds(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length > maximumFavourites ||
    !value.every(isValidId)
  ) {
    throw new Error("Saved favourites are invalid and were not changed.");
  }
  return [...new Set(value)];
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value
  );
}

function currentOwner() {
  return hubRuntime.hosted
    ? hubRuntime.session?.staffId ?? null
    : "local";
}
