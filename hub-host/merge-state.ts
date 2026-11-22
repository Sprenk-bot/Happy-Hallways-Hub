import type { StateSnapshot } from "./store";

const missing = Symbol("missing");
type Value = unknown | typeof missing;

export type SnapshotMerge = {
  snapshot: StateSnapshot;
  conflicts: string[];
};

export function deepEqualJson(left: unknown, right: unknown) {
  return equal(left as Value, right as Value);
}

/**
 * Conservatively combine a stale full-account save with the current Host state.
 * Objects merge by field. Arrays of records with stable `id` values merge by id.
 * Any overlapping edit that cannot be combined safely is reported as a conflict.
 */
export function mergeSnapshots(
  base: StateSnapshot,
  submitted: StateSnapshot,
  current: StateSnapshot,
): SnapshotMerge {
  const conflicts: string[] = [];
  const merged = mergeValue(base, submitted, current, "$", conflicts);
  return {
    snapshot: isRecord(merged) ? merged : current,
    conflicts: [...new Set(conflicts)],
  };
}

function mergeValue(
  base: Value,
  submitted: Value,
  current: Value,
  path: string,
  conflicts: string[],
): Value {
  if (equal(submitted, base)) return current;
  if (equal(current, base) || equal(submitted, current)) return submitted;

  if (
    isRecordOrMissing(base) &&
    isRecordOrMissing(submitted) &&
    isRecordOrMissing(current)
  ) {
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set([
      ...recordKeys(base),
      ...recordKeys(submitted),
      ...recordKeys(current),
    ]);
    for (const key of keys) {
      const next = mergeValue(
        recordValue(base, key),
        recordValue(submitted, key),
        recordValue(current, key),
        `${path}.${key}`,
        conflicts,
      );
      if (next !== missing) result[key] = next;
    }
    return result;
  }

  if (isArray(base) && isArray(submitted) && isArray(current)) {
    const merged = mergeIdentifiedArrays(
      base,
      submitted,
      current,
      path,
      conflicts,
    );
    if (merged) return merged;
  }

  conflicts.push(path);
  return current;
}

function mergeIdentifiedArrays(
  base: unknown[],
  submitted: unknown[],
  current: unknown[],
  path: string,
  conflicts: string[],
) {
  const all = [...base, ...submitted, ...current];
  if (!all.every(isRecord)) return null;
  const key = ["id", "studentId", "token"].find((candidate) =>
    all.every((item) => typeof item[candidate] === "string"),
  );
  if (!key) return null;
  const baseById = indexById(base as Record<string, unknown>[], key);
  const submittedById = indexById(submitted as Record<string, unknown>[], key);
  const currentById = indexById(current as Record<string, unknown>[], key);
  if (!baseById || !submittedById || !currentById) return null;

  const ids = new Set([
    ...baseById.keys(),
    ...submittedById.keys(),
    ...currentById.keys(),
  ]);
  const mergedById = new Map<string, unknown>();
  for (const id of ids) {
    const item = mergeValue(
      baseById.get(id) ?? missing,
      submittedById.get(id) ?? missing,
      currentById.get(id) ?? missing,
      `${path}[id=${id}]`,
      conflicts,
    );
    if (item !== missing) mergedById.set(id, item);
  }

  const baseIds = base.map((item) =>
    String((item as Record<string, unknown>)[key]),
  );
  const submittedIds = submitted.map((item) =>
    String((item as Record<string, unknown>)[key]),
  );
  const currentIds = current.map((item) =>
    String((item as Record<string, unknown>)[key]),
  );
  const submittedBaseOrder = submittedIds.filter((id) => baseById.has(id));
  const currentBaseOrder = currentIds.filter((id) => baseById.has(id));
  const originalSubmittedOrder = baseIds.filter((id) => submittedById.has(id));
  const originalCurrentOrder = baseIds.filter((id) => currentById.has(id));
  const submittedReordered = !sameList(
    submittedBaseOrder,
    originalSubmittedOrder,
  );
  const currentReordered = !sameList(currentBaseOrder, originalCurrentOrder);

  if (
    submittedReordered &&
    currentReordered &&
    !sameList(submittedBaseOrder, currentBaseOrder)
  ) {
    conflicts.push(`${path}.$order`);
    return current;
  }

  const preferred = submittedReordered ? submittedIds : currentIds;
  const secondary = submittedReordered ? currentIds : submittedIds;
  const ordered = new Set<string>();
  const result: unknown[] = [];
  for (const id of [...preferred, ...secondary, ...baseIds]) {
    const item = mergedById.get(id);
    if (item !== undefined && !ordered.has(id)) {
      ordered.add(id);
      result.push(item);
    }
  }
  return result;
}

function indexById(items: Record<string, unknown>[], key: string) {
  const result = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = item[key] as string;
    if (result.has(id)) return null;
    result.set(id, item);
  }
  return result;
}

function sameList(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function equal(left: Value, right: Value): boolean {
  if (left === missing || right === missing) return left === right;
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
      )
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOrMissing(
  value: Value,
): value is Record<string, unknown> | typeof missing {
  return value === missing || isRecord(value);
}

function isArray(value: Value): value is unknown[] {
  return Array.isArray(value);
}

function recordKeys(value: Record<string, unknown> | typeof missing) {
  return value === missing ? [] : Object.keys(value);
}

function recordValue(
  value: Record<string, unknown> | typeof missing,
  key: string,
): Value {
  return value === missing || !Object.hasOwn(value, key) ? missing : value[key];
}
