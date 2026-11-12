import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type StateSnapshot = Record<string, unknown>;

export type StoredSnapshot = {
  revision: number;
  savedAt: string;
  checksum: string;
  snapshot: StateSnapshot;
};

type StoredRow = {
  schema_version: number;
  revision: number;
  saved_at: string;
  snapshot_json: string;
  checksum: string;
};

const schemaVersion = 1;

export class RevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("The host state changed after this client read it.");
    this.name = "RevisionConflictError";
  }
}

export class StateIntegrityError extends Error {
  constructor() {
    super("The saved host state failed its checksum check.");
    this.name = "StateIntegrityError";
  }
}

export class HubStore {
  private readonly database: Database;

  constructor(databasePath: string) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database = new Database(absolutePath, { create: true });
    this.database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  read(): StoredSnapshot | null {
    const row = this.database
      .query(
        "SELECT schema_version, revision, saved_at, snapshot_json, checksum FROM hub_state WHERE id = 1",
      )
      .get<StoredRow>();
    return row ? this.fromRow(row) : null;
  }

  save(snapshot: StateSnapshot, expectedRevision: number): StoredSnapshot {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError(
        "expectedRevision must be a non-negative safe integer.",
      );
    }
    if (!isRecord(snapshot))
      throw new TypeError("snapshot must be a JSON object.");

    const snapshotJson = JSON.stringify(snapshot);
    if (typeof snapshotJson !== "string")
      throw new TypeError("snapshot could not be encoded as JSON.");
    const checksum = checksumOf(snapshotJson);
    const savedAt = new Date().toISOString();

    return this.database.transaction(() => {
      const previous = this.database
        .query(
          "SELECT schema_version, revision, saved_at, snapshot_json, checksum FROM hub_state WHERE id = 1",
        )
        .get<StoredRow>();

      const verifiedPrevious = previous ? this.fromRow(previous) : null;
      const currentRevision = verifiedPrevious?.revision ?? 0;
      if (expectedRevision !== currentRevision)
        throw new RevisionConflictError(currentRevision);

      const revision = currentRevision + 1;
      this.database
        .query(
          `INSERT INTO hub_state (id, schema_version, revision, saved_at, snapshot_json, checksum)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             schema_version = excluded.schema_version,
             revision = excluded.revision,
             saved_at = excluded.saved_at,
             snapshot_json = excluded.snapshot_json,
             checksum = excluded.checksum`,
        )
        .run(schemaVersion, revision, savedAt, snapshotJson, checksum);

      return { revision, savedAt, checksum, snapshot };
    })();
  }

  close() {
    this.database.close();
  }

  private migrate() {
    const currentVersion =
      this.database.query("PRAGMA user_version").get<{ user_version: number }>()
        ?.user_version ?? 0;
    if (currentVersion > schemaVersion) {
      this.database.close();
      throw new Error(
        `Database schema ${currentVersion} is newer than this host supports (${schemaVersion}).`,
      );
    }
    if (currentVersion === schemaVersion) return;

    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS hub_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          saved_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          checksum TEXT NOT NULL
        );
        PRAGMA user_version = ${schemaVersion};
      `);
    })();
  }

  private fromRow(row: StoredRow): StoredSnapshot {
    if (
      row.schema_version !== schemaVersion ||
      checksumOf(row.snapshot_json) !== row.checksum
    ) {
      throw new StateIntegrityError();
    }

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(row.snapshot_json);
    } catch {
      throw new StateIntegrityError();
    }
    if (!isRecord(snapshot)) throw new StateIntegrityError();
    return {
      revision: row.revision,
      savedAt: row.saved_at,
      checksum: row.checksum,
      snapshot,
    };
  }
}

function checksumOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function isRecord(value: unknown): value is StateSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
