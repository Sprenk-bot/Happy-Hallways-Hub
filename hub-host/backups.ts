import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { gunzipSync } from "node:zlib";
import {
  backupEncryptionKeyId,
  decryptBackupFileSync,
  encryptBackupFileSync,
} from "./backup-crypto";
import {
  RecordNotFoundError,
  RevisionConflictError,
  type StaffActor,
  type HubStore,
} from "./store";

const localSnapshotIntervalMs = 15 * 60_000;
const healthPollIntervalMs = 60_000;
const restoreTestIntervalMs = 7 * 24 * 60 * 60_000;

type BackupManifest = {
  formatVersion: 1;
  application: "happy-hallways-hub";
  kind?: "local_snapshot" | "pre_migration";
  schemaVersion: number;
  backupId: string;
  fileName: string;
  createdAt: string;
  revision: number;
  dataRange: { earliest: string | null; latest: string | null };
  recordCounts: Record<string, number>;
  databaseSha256: string;
  backupFileSha256?: string;
  encrypted?: boolean;
  encryptionKeyId?: string | null;
  integrityCheck: "ok";
};

type RestoreTestReport = {
  reportVersion: 1;
  backupId: string;
  testedAt: string;
  result: "passed";
  integrityCheck: "ok";
  snapshotChecksumValid: boolean;
  revisionHistoryValid: boolean;
  revisionCount: number;
};

type RestoreStage = {
  formatVersion: 1;
  stageId: string;
  backupId: string;
  stagedAt: string;
  stagedFile: string;
  stagedFileSha256: string;
  encrypted: boolean;
  encryptionKeyId?: string | null;
  expectedCurrentRevision: number;
  preview: {
    backupCreatedAt: string;
    snapshotRevision: number;
    dataRange: { earliest: string | null; latest: string | null };
    recordCounts: Record<string, number>;
    integrityCheck: "ok";
    snapshotChecksumValid: true;
  };
};

export type BackupHealth = {
  encryption: {
    status: "enabled" | "disabled" | "key_mismatch" | "key_unavailable";
    keyId: string | null;
    legacyUnencryptedBackups: number;
    unavailableEncryptedBackups: number;
  };
  local: {
    status: "healthy" | "degraded";
    latestSnapshotAt: string | null;
    latestRevision: number | null;
    error: string | null;
  };
  offHost: {
    status: "not_configured" | "healthy" | "degraded";
    latestCopyAt: string | null;
    latestCopyLagMs: number | null;
    pendingCopies: number;
    independentStorageVerified: false;
    error: string | null;
    fallbackOperational: boolean;
    destinations: Array<{
      role: "preferred" | "fallback";
      path: string | null;
      status: "not_configured" | "healthy" | "degraded";
      latestCopyAt: string | null;
      latestCopyLagMs: number | null;
      pendingCopies: number;
      error: string | null;
    }>;
  };
  restoreTest: {
    status: "not_run" | "healthy" | "degraded";
    lastTestAt: string | null;
    backupId: string | null;
    error: string | null;
  };
  localSnapshotIntervalMinutes: 15;
  targetOffHostLagMinutes: 5;
  retention: "no automatic deletion";
};

export class HubBackupManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localError: string | null = null;
  private offHostErrors = new Map<string, string>();
  private restoreError: string | null = null;
  private lastRestoreTest: RestoreTestReport | null = null;
  private working = false;

  constructor(
    private readonly store: HubStore,
    private readonly localDirectory: string,
    private readonly offHostTargets: Array<{
      role: "preferred" | "fallback";
      directory: string | null;
    }>,
    private readonly backupEncryptionKey?: Buffer,
  ) {}

  async start() {
    try {
      mkdirSync(this.localDirectory, { recursive: true });
      this.lastRestoreTest = this.readLatestRestoreReport();
    } catch (error) {
      this.localError = safeError(error);
    }
    await this.runCycle(true);
    this.timer = setInterval(() => {
      void this.runCycle(false);
    }, healthPollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow() {
    await this.runCycle(true);
    return this.health();
  }

  restorePoints() {
    const snapshots = this.readLocalManifests().map((manifest) => {
      const filePath = join(this.localDirectory, manifest.fileName);
      const fileAvailable = existsSync(filePath);
      const checksumValid = fileAvailable &&
        sha256File(filePath) === (manifest.backupFileSha256 ?? manifest.databaseSha256);
      return {
        backupId: manifest.backupId,
        kind: manifest.kind ?? "local_snapshot",
        createdAt: manifest.createdAt,
        revision: manifest.revision,
        schemaVersion: manifest.schemaVersion,
        dataRange: manifest.dataRange,
        recordCounts: manifest.recordCounts,
        integrityCheck: manifest.integrityCheck,
        checksumValid,
        restorable:
          manifest.schemaVersion === this.store.schemaVersion() &&
          (!manifest.encrypted ||
            (this.backupEncryptionKey !== undefined &&
              manifest.encryptionKeyId === backupEncryptionKeyId(this.backupEncryptionKey))),
      };
    });
    const revisions = this.store.readRevisionHistory().map((revision) => {
      let stored: ReturnType<HubStore["readRevision"]> = null;
      let error: string | null = null;
      try {
        stored = this.store.readRevision(revision.revision);
      } catch {
        error =
          "This revision failed its integrity check and cannot be restored.";
      }
      const metadata = snapshotMetadata(stored?.snapshot ?? null);
      return {
        backupId: `revision:${revision.revision}`,
        kind: "state_revision" as const,
        createdAt: revision.savedAt,
        revision: revision.revision,
        schemaVersion: this.store.schemaVersion(),
        dataRange: metadata.dataRange,
        recordCounts: metadata.recordCounts,
        integrityCheck: "ok" as const,
        checksumValid: stored !== null,
        restorable: stored !== null,
        error,
        staffName: revision.staffName,
        staffRole: revision.staffRole,
        changeType: revision.changeType,
      };
    });
    return [...snapshots, ...revisions].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  stageRestore(backupId: string) {
    const manifest = this.readLocalManifests().find(
      (entry) => entry.backupId === backupId,
    );
    const revisionMatch = /^revision:([1-9]\d*)$/.exec(backupId);
    const revisionNumber = revisionMatch ? Number(revisionMatch[1]) : null;
    const historicalRevision = revisionNumber
      ? this.store.readRevision(revisionNumber)
      : null;
    if (!manifest && !historicalRevision) throw new RecordNotFoundError();
    if (manifest && manifest.schemaVersion !== this.store.schemaVersion()) {
      throw new Error(
        "Selected backup uses a different database schema and cannot be restored by this host version.",
      );
    }
    if (manifest) {
      const sourcePath = join(this.localDirectory, manifest.fileName);
      const fileChecksum = manifest.backupFileSha256 ?? manifest.databaseSha256;
      if (sha256File(sourcePath) !== fileChecksum) {
        throw new Error(
          "Selected restore point checksum does not match its manifest.",
        );
      }
      const stageDirectory = join(this.localDirectory, "restore-staging");
      mkdirSync(stageDirectory, { recursive: true });
      const verificationPath = join(stageDirectory, `verify-${randomUUID()}.sqlite`);
      try {
        if (manifest.encrypted) {
          if (!this.backupEncryptionKey) {
            throw new Error("The encryption key for this backup is not configured on this Host.");
          }
          decryptBackupFileSync(sourcePath, verificationPath, this.backupEncryptionKey, manifest.encryptionKeyId ?? undefined);
        } else {
          copyFileSync(sourcePath, verificationPath);
        }
      const sourceSchemaVersion = readSchemaVersion(verificationPath);
      if (sourceSchemaVersion !== manifest.schemaVersion) {
        throw new Error(
          "Selected restore point schema does not match its manifest.",
        );
      }
      const verified = verifyDatabase(verificationPath);
      if (!verified.snapshotChecksumValid || !verified.revisionHistoryValid) {
        throw new Error(
          "Selected restore point account or revision-history checksum is invalid.",
        );
      }
      } finally {
        if (existsSync(verificationPath)) rmSync(verificationPath, { force: true });
      }
    }

    const stageId = randomUUID();
    const stageDirectory = join(this.localDirectory, "restore-staging");
    mkdirSync(stageDirectory, { recursive: true });
    const stagedFile = `restore-${stageId}.sqlite${this.backupEncryptionKey ? ".enc" : ""}`;
    const stagedFilePath = join(stageDirectory, stagedFile);
    const materializedPath = join(stageDirectory, `verify-${stageId}.sqlite`);
    try {
      if (manifest) {
        const sourcePath = join(this.localDirectory, manifest.fileName);
        if (manifest.encrypted) {
          if (!this.backupEncryptionKey) throw new Error("The encryption key for this backup is not configured on this Host.");
          decryptBackupFileSync(sourcePath, materializedPath, this.backupEncryptionKey, manifest.encryptionKeyId ?? undefined);
        } else {
          copyFileSync(sourcePath, materializedPath);
        }
      } else {
        this.store.createRevisionRestoreFile(materializedPath, revisionNumber!);
      }
      const materializedChecksum = sha256File(materializedPath);
      if (manifest && materializedChecksum !== manifest.databaseSha256) {
        throw new Error("Staged restore copy failed checksum verification.");
      }
      const stagedVerification = verifyDatabase(materializedPath);
      if (!stagedVerification.snapshotChecksumValid || !stagedVerification.revisionHistoryValid) {
        throw new Error("Staged restore copy failed account or revision-history checksum verification.");
      }
      if (this.backupEncryptionKey) {
        encryptBackupFileSync(materializedPath, stagedFilePath, this.backupEncryptionKey);
      } else {
        renameSync(materializedPath, stagedFilePath);
      }
    } catch (error) {
      if (existsSync(stagedFilePath)) rmSync(stagedFilePath, { force: true });
      throw error;
    } finally {
      if (existsSync(materializedPath)) rmSync(materializedPath, { force: true });
    }
    const stagedFileSha256 = sha256File(stagedFilePath);
    const current = this.store.read();
    const stage: RestoreStage = {
      formatVersion: 1,
      stageId,
      backupId,
      stagedAt: new Date().toISOString(),
      stagedFile,
      stagedFileSha256,
      encrypted: Boolean(this.backupEncryptionKey),
      encryptionKeyId: this.backupEncryptionKey
        ? backupEncryptionKeyId(this.backupEncryptionKey)
        : null,
      expectedCurrentRevision: current?.revision ?? 0,
      preview: {
        backupCreatedAt: manifest?.createdAt ?? historicalRevision!.savedAt,
        snapshotRevision: manifest?.revision ?? historicalRevision!.revision,
        dataRange:
          manifest?.dataRange ??
          snapshotMetadata(historicalRevision!.snapshot).dataRange,
        recordCounts:
          manifest?.recordCounts ??
          snapshotMetadata(historicalRevision!.snapshot).recordCounts,
        integrityCheck: "ok",
        snapshotChecksumValid: true,
      },
    };
    writeFileSync(
      join(stageDirectory, `restore-${stageId}.json`),
      `${JSON.stringify(stage, null, 2)}\n`,
      { flag: "wx" },
    );
    return stage;
  }

  promoteRestore(stageId: string, actor: StaffActor) {
    const stage = this.readRestoreStage(stageId);
    const current = this.store.read();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== stage.expectedCurrentRevision) {
      throw new RevisionConflictError(currentRevision);
    }
    const stagedPath = join(
      this.localDirectory,
      "restore-staging",
      stage.stagedFile,
    );
    if (sha256File(stagedPath) !== stage.stagedFileSha256) {
      throw new Error("Staged restore copy has changed since preview.");
    }
    const materializedPath = stage.encrypted
      ? join(tmpdir(), `hh-restore-promote-${randomUUID()}.sqlite`)
      : stagedPath;
    let snapshot: Record<string, unknown>;
    try {
      if (stage.encrypted) {
        if (!this.backupEncryptionKey) throw new Error("The restore-stage encryption key is not configured on this Host.");
        decryptBackupFileSync(stagedPath, materializedPath, this.backupEncryptionKey, stage.encryptionKeyId ?? undefined);
      }
      if (readSchemaVersion(materializedPath) !== this.store.schemaVersion()) {
        throw new Error("Restore point uses a different database schema version.");
      }
      const verified = verifyDatabase(materializedPath);
      if (!verified.snapshotChecksumValid || !verified.revisionHistoryValid) {
        throw new Error("Staged restore copy failed account or revision-history checksum verification.");
      }
      const backupDatabase = new Database(materializedPath, { readonly: true });
      try {
        const row = backupDatabase
          .query("SELECT snapshot_json FROM hub_state WHERE id = 1")
          .get<{ snapshot_json: string }>();
        if (!row) throw new Error("Selected restore point has no saved account.");
        const parsed: unknown = JSON.parse(row.snapshot_json);
        if (!isRecord(parsed))
          throw new Error("Selected restore point data is invalid.");
        snapshot = parsed;
      } finally {
        backupDatabase.close();
      }
    } finally {
      if (stage.encrypted && existsSync(materializedPath)) {
        rmSync(materializedPath, { force: true });
      }
    }

    const preRestoreManifest = this.createSnapshot();
    const restored = this.store.restoreSnapshot(
      snapshot,
      currentRevision,
      actor,
      stage.backupId,
    );
    this.createSnapshot();
    for (const target of this.offHostTargets) {
      if (!target.directory) continue;
      try {
        this.copyPendingSnapshots(target.directory);
        this.offHostErrors.delete(target.role);
      } catch (error) {
        this.offHostErrors.set(target.role, safeError(error));
      }
    }
    return {
      restored: true,
      backupId: stage.backupId,
      stageId,
      restoredRevision: restored.revision,
      restoredAt: restored.savedAt,
      preRestoreBackupId: preRestoreManifest.backupId,
    };
  }

  health(): BackupHealth {
    const manifests = this.readLocalManifests();
    const latest = manifests.at(-1) ?? null;
    const unavailableEncryptedBackups = manifests.filter(
      (manifest) =>
        manifest.encrypted &&
        (!this.backupEncryptionKey ||
          manifest.encryptionKeyId !== backupEncryptionKeyId(this.backupEncryptionKey)),
    ).length;
    const currentRevision = this.store.read()?.revision ?? 0;
    const destinations = this.offHostTargets.map((target) => {
      if (!target.directory) {
        return {
          role: target.role,
          path: null,
          status: "not_configured" as const,
          latestCopyAt: null,
          latestCopyLagMs: null,
          pendingCopies: 0,
          error: null,
        };
      }
      const sameAsLocal = samePath(target.directory, this.localDirectory);
      const pendingCopies = sameAsLocal
        ? manifests.length
        : manifests.filter(
            (manifest) => !this.offHostCopyExists(target.directory!, manifest),
          ).length;
      const latestCopiedManifest = sameAsLocal
        ? null
        : [...manifests]
            .reverse()
            .find((manifest) =>
              this.offHostCopyExists(target.directory!, manifest),
            );
      const latestCopiedRevision = latestCopiedManifest?.revision ?? 0;
      const currentRevisionNeedsCopy =
        !sameAsLocal && currentRevision > latestCopiedRevision;
      const currentRevisionHasManifest = manifests.some(
        (manifest) => manifest.revision === currentRevision,
      );
      const pendingCount =
        pendingCopies +
        (currentRevisionNeedsCopy && !currentRevisionHasManifest ? 1 : 0);
      const latestCopyAtMs =
        latestCopiedManifest && target.directory
          ? statSync(join(target.directory, latestCopiedManifest.fileName))
              .mtimeMs
          : null;
      const latestRevisionSavedAt =
        latestCopiedManifest?.revision === currentRevision &&
        currentRevision > 0
          ? this.store.readRevision(currentRevision)?.savedAt
          : latestCopiedManifest?.revision === 0
            ? latestCopiedManifest.createdAt
            : null;
      return {
        role: target.role,
        path: target.directory,
        status:
          sameAsLocal ||
          this.offHostErrors.has(target.role) ||
          pendingCount > 0 ||
          currentRevisionNeedsCopy
            ? ("degraded" as const)
            : ("healthy" as const),
        latestCopyAt:
          latestCopyAtMs === null
            ? null
            : new Date(latestCopyAtMs).toISOString(),
        latestCopyLagMs:
          latestCopyAtMs === null || !latestRevisionSavedAt
            ? null
            : Math.max(0, latestCopyAtMs - Date.parse(latestRevisionSavedAt)),
        pendingCopies: pendingCount,
        error: sameAsLocal
          ? "Backup path resolves to the local snapshot directory."
          : (this.offHostErrors.get(target.role) ?? null),
      };
    });
    const configuredTargets = destinations.filter(
      (target) => target.status !== "not_configured",
    );
    const preferred = destinations.find(
      (target) => target.role === "preferred",
    );
    const fallback = destinations.find((target) => target.role === "fallback");
    const fallbackOperational = fallback?.status === "healthy";
    const offHostStatus =
      configuredTargets.length === 0
        ? "not_configured"
        : preferred?.status === "healthy" ||
            (preferred?.status === "not_configured" && fallbackOperational)
          ? "healthy"
          : "degraded";
    return {
      encryption: {
        status: !this.backupEncryptionKey
          ? unavailableEncryptedBackups > 0 ? "key_unavailable" : "disabled"
          : unavailableEncryptedBackups > 0 ? "key_mismatch" : "enabled",
        keyId: this.backupEncryptionKey ? backupEncryptionKeyId(this.backupEncryptionKey) : null,
        legacyUnencryptedBackups: manifests.filter((manifest) => !manifest.encrypted).length,
        unavailableEncryptedBackups,
      },
      local: {
        status: this.localError || !latest ? "degraded" : "healthy",
        latestSnapshotAt: latest?.createdAt ?? null,
        latestRevision: latest?.revision ?? null,
        error: this.localError,
      },
      offHost: {
        status: offHostStatus,
        latestCopyAt:
          preferred?.latestCopyAt ??
          (fallbackOperational ? (fallback?.latestCopyAt ?? null) : null),
        latestCopyLagMs:
          preferred?.latestCopyLagMs ??
          (fallbackOperational ? (fallback?.latestCopyLagMs ?? null) : null),
        pendingCopies: configuredTargets.reduce(
          (total, target) => total + target.pendingCopies,
          0,
        ),
        independentStorageVerified: false,
        error: configuredTargets.find((target) => target.error)?.error ?? null,
        fallbackOperational,
        destinations,
      },
      restoreTest: {
        status: this.restoreError
          ? "degraded"
          : this.lastRestoreTest
            ? "healthy"
            : "not_run",
        lastTestAt: this.lastRestoreTest?.testedAt ?? null,
        backupId: this.lastRestoreTest?.backupId ?? null,
        error: this.restoreError,
      },
      localSnapshotIntervalMinutes: 15,
      targetOffHostLagMinutes: 5,
      retention: "no automatic deletion",
    };
  }

  private async runCycle(forceSnapshot: boolean) {
    if (this.working) return;
    this.working = true;
    try {
      const manifests = this.readLocalManifests();
      const newest = manifests.at(-1);
      const current = this.store.read();
      const replicationCheckpointDue =
        current !== null &&
        this.offHostTargets.some((target) => target.directory !== null) &&
        !manifests.some((manifest) => manifest.revision === current.revision);
      if (
        forceSnapshot ||
        !newest ||
        Date.now() - Date.parse(newest.createdAt) >= localSnapshotIntervalMs ||
        replicationCheckpointDue
      ) {
        this.createSnapshot();
      }
      this.localError = null;
    } catch (error) {
      this.localError = safeError(error);
    }

    for (const target of this.offHostTargets) {
      if (!target.directory) continue;
      try {
        this.copyPendingSnapshots(target.directory);
        this.offHostErrors.delete(target.role);
      } catch (error) {
        this.offHostErrors.set(target.role, safeError(error));
      }
    }

    try {
      this.runWeeklyRestoreTestIfDue();
      this.restoreError = null;
    } catch (error) {
      this.restoreError = safeError(error);
    }
    this.working = false;
  }

  private createSnapshot() {
    const current = this.store.read();
    const createdAt = new Date().toISOString();
    const backupId = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const fileName = `hub-${backupId}-r${current?.revision ?? 0}.sqlite${this.backupEncryptionKey ? ".enc" : ""}`;
    const targetPath = join(this.localDirectory, fileName);
    const temporaryPath = `${targetPath}.${randomUUID()}.partial`;
    const databaseTemporaryPath = `${temporaryPath}.sqlite`;
    try {
      this.store.createConsistentBackupFile(databaseTemporaryPath);
      const integrity = verifyDatabase(databaseTemporaryPath);
      const metadata = snapshotMetadata(current?.snapshot ?? null);
      const revisionCount = this.store.readRevisionHistory().length;
      const manifest: BackupManifest = {
        formatVersion: 1,
        application: "happy-hallways-hub",
        schemaVersion: readSchemaVersion(databaseTemporaryPath),
        backupId,
        fileName,
        createdAt,
        revision: current?.revision ?? 0,
        dataRange: metadata.dataRange,
        recordCounts: {
          ...metadata.recordCounts,
          hubStateRevisions: revisionCount,
        },
        databaseSha256: sha256File(databaseTemporaryPath),
        backupFileSha256: this.backupEncryptionKey ? undefined : sha256File(databaseTemporaryPath),
        encrypted: Boolean(this.backupEncryptionKey),
        encryptionKeyId: this.backupEncryptionKey ? backupEncryptionKeyId(this.backupEncryptionKey) : null,
        integrityCheck: integrity.integrityCheck,
      };
      if (this.backupEncryptionKey) {
        const encryptedMetadata = encryptBackupFileSync(databaseTemporaryPath, temporaryPath, this.backupEncryptionKey);
        manifest.backupFileSha256 = sha256File(temporaryPath);
        if (encryptedMetadata.plaintextSha256 !== manifest.databaseSha256) {
          throw new Error("Encrypted snapshot did not match its verified database checksum.");
        }
      } else {
        renameSync(databaseTemporaryPath, temporaryPath);
      }
      renameSync(temporaryPath, targetPath);
      const manifestPath = `${targetPath}.manifest.json`;
      const manifestTemporaryPath = `${manifestPath}.${randomUUID()}.partial`;
      writeFileSync(
        manifestTemporaryPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        {
          flag: "wx",
        },
      );
      renameSync(manifestTemporaryPath, manifestPath);
      return manifest;
    } catch (error) {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
      if (existsSync(databaseTemporaryPath)) rmSync(databaseTemporaryPath, { force: true });
      throw error;
    }
  }

  private readRestoreStage(stageId: string): RestoreStage {
    if (!/^[0-9a-f-]{36}$/i.test(stageId)) throw new RecordNotFoundError();
    const stagePath = join(
      this.localDirectory,
      "restore-staging",
      `restore-${stageId}.json`,
    );
    if (!existsSync(stagePath)) throw new RecordNotFoundError();
    const stage = JSON.parse(readFileSync(stagePath, "utf8")) as RestoreStage;
    if (
      stage.formatVersion !== 1 ||
      stage.stageId !== stageId ||
      stage.stagedFile !== `restore-${stageId}.sqlite${stage.encrypted ? ".enc" : ""}` ||
      !Number.isSafeInteger(stage.expectedCurrentRevision) ||
      !/^[a-f0-9]{64}$/.test(stage.stagedFileSha256) ||
      (stage.encrypted === true && !/^[a-f0-9]{24}$/.test(stage.encryptionKeyId ?? ""))
    ) {
      throw new Error("Restore stage metadata is invalid.");
    }
    return stage;
  }

  private copyPendingSnapshots(directory: string) {
    const destination = resolve(directory);
    if (samePath(destination, this.localDirectory)) {
      throw new Error(
        "Off-host path resolves to the local snapshot directory.",
      );
    }
    mkdirSync(destination, { recursive: true });
    const manifests = this.readLocalManifests();
    for (const manifest of manifests) {
      const sourcePath = join(this.localDirectory, manifest.fileName);
      const fileChecksum = manifest.backupFileSha256 ?? manifest.databaseSha256;
      if (sha256File(sourcePath) !== fileChecksum) {
        throw new Error(
          `Local backup checksum mismatch for ${manifest.fileName}.`,
        );
      }
      const targetPath = join(destination, manifest.fileName);
      const targetManifestPath = `${targetPath}.manifest.json`;
      if (existsSync(targetPath)) {
        if (sha256File(targetPath) !== fileChecksum) {
          throw new Error(`Off-host backup conflict for ${manifest.fileName}.`);
        }
        if (!existsSync(targetManifestPath)) {
          writeFileSync(
            targetManifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
            {
              flag: "wx",
            },
          );
        }
        continue;
      }

      const temporaryPath = `${targetPath}.${randomUUID()}.partial`;
      const temporaryManifestPath = `${targetManifestPath}.${randomUUID()}.partial`;
      copyFileSync(sourcePath, temporaryPath);
      if (sha256File(temporaryPath) !== fileChecksum) {
        rmSync(temporaryPath, { force: true });
        throw new Error(
          `Off-host copy verification failed for ${manifest.fileName}.`,
        );
      }
      writeFileSync(
        temporaryManifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        {
          flag: "wx",
        },
      );
      renameSync(temporaryPath, targetPath);
      renameSync(temporaryManifestPath, targetManifestPath);
    }
  }

  private runWeeklyRestoreTestIfDue() {
    const previous = this.readLatestRestoreReport();
    if (
      previous &&
      Date.now() - Date.parse(previous.testedAt) < restoreTestIntervalMs
    ) {
      this.lastRestoreTest = previous;
      return;
    }
    const manifest = this.readLocalManifests().at(-1);
    if (!manifest)
      throw new Error("No local snapshot is available to restore-test.");

    const sourcePath = join(this.localDirectory, manifest.fileName);
    const scratchDirectory = join(tmpdir(), `hh-restore-test-${randomUUID()}`);
    mkdirSync(scratchDirectory, { recursive: true });
    const isolatedPath = join(scratchDirectory, "restore-test.sqlite");
    try {
      const fileChecksum = manifest.backupFileSha256 ?? manifest.databaseSha256;
      if (sha256File(sourcePath) !== fileChecksum) {
        throw new Error(
          `Restore-test source checksum mismatch for ${manifest.fileName}.`,
        );
      }
      if (manifest.encrypted) {
        if (!this.backupEncryptionKey) throw new Error("The encryption key for this restore test is not configured.");
        decryptBackupFileSync(sourcePath, isolatedPath, this.backupEncryptionKey, manifest.encryptionKeyId ?? undefined);
      } else {
        copyFileSync(sourcePath, isolatedPath);
      }
      if (sha256File(isolatedPath) !== manifest.databaseSha256) {
        throw new Error("Restore-test plaintext checksum does not match the manifest.");
      }
      const verified = verifyDatabase(isolatedPath);
      const report: RestoreTestReport = {
        reportVersion: 1,
        backupId: manifest.backupId,
        testedAt: new Date().toISOString(),
        result: "passed",
        integrityCheck: verified.integrityCheck,
        snapshotChecksumValid: verified.snapshotChecksumValid,
        revisionHistoryValid: verified.revisionHistoryValid,
        revisionCount: verified.revisionCount,
      };
      const reportDirectory = join(this.localDirectory, "restore-tests");
      mkdirSync(reportDirectory, { recursive: true });
      const reportPath = join(
        reportDirectory,
        `restore-test-${report.testedAt.replace(/[:.]/g, "-")}.json`,
      );
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
      });
      this.lastRestoreTest = report;
    } finally {
      rmSync(scratchDirectory, { recursive: true, force: true });
    }
  }

  private readLatestRestoreReport(): RestoreTestReport | null {
    const directory = join(this.localDirectory, "restore-tests");
    if (!existsSync(directory)) return null;
    const files = readdirSync(directory)
      .filter((file) => /^restore-test-.*\.json$/.test(file))
      .sort();
    if (files.length === 0) return null;
    const report = JSON.parse(
      readFileSync(join(directory, files.at(-1)!), "utf8"),
    ) as RestoreTestReport;
    if (report.reportVersion !== 1 || report.result !== "passed") return null;
    return report;
  }

  private readLocalManifests(): BackupManifest[] {
    if (!existsSync(this.localDirectory)) return [];
    return readdirSync(this.localDirectory)
      .filter((file) => file.endsWith(".manifest.json"))
      .map((file) => {
        try {
          const value = JSON.parse(
            readFileSync(join(this.localDirectory, file), "utf8"),
          ) as BackupManifest;
          if (
            value.formatVersion !== 1 ||
            value.application !== "happy-hallways-hub" ||
            !Number.isSafeInteger(value.schemaVersion) ||
            value.fileName !== file.slice(0, -".manifest.json".length) ||
            basename(value.fileName) !== value.fileName ||
            !Number.isSafeInteger(value.revision) ||
            !/^[a-f0-9]{64}$/.test(value.databaseSha256) ||
            (value.backupFileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.backupFileSha256)) ||
            (value.encrypted === true && !/^[a-f0-9]{24}$/.test(value.encryptionKeyId ?? ""))
          ) {
            return null;
          }
          return value;
        } catch {
          return null;
        }
      })
      .filter((value): value is BackupManifest => value !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private offHostCopyExists(directory: string, manifest: BackupManifest) {
    const target = join(directory, manifest.fileName);
    const targetManifest = `${target}.manifest.json`;
    return (
      existsSync(target) &&
      existsSync(targetManifest) &&
      sha256File(target) === (manifest.backupFileSha256 ?? manifest.databaseSha256)
    );
  }
}

function verifyDatabase(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    const integrity = database
      .query("PRAGMA integrity_check")
      .get<{ integrity_check: string }>()?.integrity_check;
    if (integrity !== "ok") {
      throw new Error("SQLite integrity_check failed for the backup.");
    }
    const state = database
      .query("SELECT snapshot_json, checksum FROM hub_state WHERE id = 1")
      .get<{ snapshot_json: string; checksum: string }>();
    const snapshotChecksumValid =
      !state || sha256Text(state.snapshot_json) === state.checksum;
    if (!snapshotChecksumValid) {
      throw new Error("Saved account checksum failed in the backup.");
    }
    const revisions = database
      .query("SELECT snapshot_gzip, checksum FROM hub_state_revisions")
      .all<{ snapshot_gzip: Uint8Array; checksum: string }>();
    for (const [index, revision] of revisions.entries()) {
      let snapshotJson: string;
      try {
        snapshotJson = gunzipSync(revision.snapshot_gzip).toString("utf8");
        JSON.parse(snapshotJson);
      } catch {
        throw new Error(
          `Compressed revision ${index + 1} could not be read from the backup.`,
        );
      }
      if (sha256Text(snapshotJson) !== revision.checksum) {
        throw new Error(`Revision ${index + 1} checksum failed in the backup.`);
      }
    }
    return {
      integrityCheck: "ok" as const,
      snapshotChecksumValid,
      revisionHistoryValid: true,
      revisionCount: revisions.length,
    };
  } finally {
    database.close();
  }
}

function readSchemaVersion(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    const schemaVersion = database
      .query("PRAGMA user_version")
      .get<{ user_version: number }>()?.user_version;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion! < 1) {
      throw new Error("Backup has no valid database schema version.");
    }
    return schemaVersion!;
  } finally {
    database.close();
  }
}

function snapshotMetadata(snapshot: Record<string, unknown> | null) {
  const recordCounts: Record<string, number> = {};
  const timestamps: string[] = [];
  if (snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (Array.isArray(value)) recordCounts[key] = value.length;
    }
    collectTimestamps(snapshot, timestamps);
  }
  timestamps.sort();
  return {
    recordCounts,
    dataRange: {
      earliest: timestamps[0] ?? null,
      latest: timestamps.at(-1) ?? null,
    },
  };
}

function collectTimestamps(value: unknown, timestamps: string[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, timestamps);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      /(?:at|time|date|timestamp)$/i.test(key) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
        entry,
      ) &&
      Number.isFinite(Date.parse(entry))
    ) {
      timestamps.push(new Date(entry).toISOString());
    } else {
      collectTimestamps(entry, timestamps);
    }
  }
}

function sha256File(path: string) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256Text(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "unknown backup error";
}

function samePath(first: string, second: string) {
  const a = resolve(first);
  const b = resolve(second);
  return platform() === "win32"
    ? a.toLocaleLowerCase("en-AU") === b.toLocaleLowerCase("en-AU")
    : a === b;
}
