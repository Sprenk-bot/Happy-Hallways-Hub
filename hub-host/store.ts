import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  isHubKioskChime,
  type HubKioskChime,
  type HubKioskSoundSettings,
  type HubPromptOverride,
  type HubPromptOverrideSnapshot,
  type HubPromptResponseSnapshot,
  type HubPromptStage,
  type HubVisitPrompt,
} from "../src/lib/types";
import {
  backupEncryptionKeyId,
  encryptBackupFileSync,
} from "./backup-crypto";
import { deepEqualJson, mergeSnapshots } from "./merge-state";

export type StateSnapshot = Record<string, unknown>;
export type StaffRole = "ea" | "tic";

export type StoredSnapshot = {
  revision: number;
  savedAt: string;
  checksum: string;
  snapshot: StateSnapshot;
};

export type StaffActor = {
  sessionId: string;
  staffId: string;
  displayName: string;
  role: StaffRole;
  authMethod:
    "named-profile-device-enrolment-fallback" | "microsoft-entra-oidc";
  expiresAt: string;
};

export type HubKioskSession = {
  id: string;
  token: string;
  expiresAt: string;
};

export type HubKioskActivation = {
  token: string;
  expiresAt: string;
};

export type HubKioskStudent = {
  id: string;
  studentName: string;
  categoryName?: string;
  categoryColor?: string;
  status:
    | "in-class"
    | "on-the-way"
    | "at-hub"
    | "on-temporary-trip"
    | "left-hub-awaiting-class"
    | "needs-staff";
  pinRequired: boolean;
  visitId?: string;
  destinationLabel?: string;
  temporaryTripId?: string;
  temporaryTripLabel?: string;
  promptVersion?: number;
  arrivalPrompts?: HubVisitPrompt[];
  departurePrompts?: HubVisitPrompt[];
  timerStartedAt?: string;
  timerMinutes?: number;
  overdueCountsUp?: boolean;
  timerWarningMinutes?: number;
};

export type HubKioskDestination = {
  id: string;
  label: string;
  promptVersion: number;
  arrivalPrompts: HubVisitPrompt[];
};

export type HubPromptOverrideRequest = {
  studentId: string;
  destinationId: string;
  stage: HubPromptStage;
  reason: string;
};

type HubKioskPromptData = {
  promptVersion?: number;
  promptAnswers?: Record<string, string | number>;
};

type HubPromptCollection = {
  responses: HubPromptResponseSnapshot[];
  overrideSnapshot?: HubPromptOverrideSnapshot;
  overrideId?: string;
};

export type HubKioskMovementRequest =
  | ({ action: "prompts"; visitId: string; stage: HubPromptStage; pin?: string } & HubKioskPromptData)
  | ({
      action: "arrive" | "leave";
      visitId: string;
      pin?: string;
    } & HubKioskPromptData)
  | {
      action: "temporary-return";
      visitId: string;
      pin?: string;
    }
  | ({
      action: "direct-arrive";
      studentId: string;
      destinationId: string;
      pin?: string;
    } & HubKioskPromptData)
  | {
      action: "temporary-start";
      visitId: string;
      destinationId: string;
      pin?: string;
    };

export type HubKioskState = {
  revision: number;
  savedAt: string | null;
  students: HubKioskStudent[];
  destinations: HubKioskDestination[];
  temporaryDestinations: HubKioskDestination[];
  soundSettings: HubKioskSoundSettings;
  promptOverrides: {
    studentId: string;
    destinationId: string;
    stage: HubPromptStage;
  }[];
};

export type StaffSessionView = {
  sessionId: string;
  staffId: string;
  displayName: string;
  role: StaffRole;
  authMethod: StaffActor["authMethod"];
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type StaffInvitationView = {
  id: string;
  role: StaffRole;
  invitedEmail: string | null;
  staffProfileId: string | null;
  createdByStaffId: string | null;
  createdByDisplayName: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  status: "pending" | "consumed" | "revoked" | "expired";
};

export type StaffPreferences = {
  favouriteStudentIds: string[];
  updatedAt: string | null;
};

export type HubConcernScope = "tic" | "all-staff" | "selected";

export type HubMailRecipient = {
  staffId: string;
  displayName: string;
  role: StaffRole;
};

export type HubMailReply = { id: string; senderStaffId: string; senderDisplayName: string; note: string; submittedAt: string };

export type HubConcernPolicy = {
  availableScopes: HubConcernScope[];
  defaultScope: HubConcernScope;
  updatedAt: string;
};

export type HubMailMessage = {
  id: string;
  visitId: string;
  studentId: string;
  studentName: string;
  destinationLabel: string;
  senderStaffId: string;
  senderDisplayName: string;
  scope: HubConcernScope;
  note: string;
  submittedAt: string;
  recipients: HubMailRecipient[];
  isSender: boolean;
  isRecipient: boolean;
  isTicOversight: boolean;
  readAt: string | null;
  replies: HubMailReply[];
  archivedAt: string | null;
};

export type IssuedInvitation = StaffInvitationView & { token: string };

type StoredRow = {
  schema_version: number;
  revision: number;
  saved_at: string;
  snapshot_json: string;
  checksum: string;
};

type InvitationRow = {
  id: string;
  token_hash: string;
  role: StaffRole;
  invited_email: string | null;
  staff_profile_id: string | null;
  created_by_staff_id: string | null;
  created_by_display_name: string | null;
  created_by_role: StaffRole | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_session_id: string | null;
  revoked_at: string | null;
  bootstrap: number;
};

type SessionRow = {
  session_id: string;
  staff_id: string;
  display_name: string;
  role: StaffRole;
  auth_method: StaffActor["authMethod"];
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type ProfileRow = {
  id: string;
  display_name: string;
  auth_method: StaffActor["authMethod"];
  entra_tenant_id?: string | null;
  entra_object_id?: string | null;
  role?: StaffRole | null;
};

export type EntraLogin = { actor: StaffActor; sessionToken: string };

const databaseSchemaVersion = 9;
export const invitationLifetimeMs = 10 * 60_000;
export const deviceSessionLifetimeMs = 30 * 24 * 60 * 60_000;
export const hubKioskActivationLifetimeMs = 10 * 60_000;
export const hubKioskSessionLifetimeMs = 24 * 60 * 60_000;
const fallbackAuthMethod = "named-profile-device-enrolment-fallback";
const eaEditableSnapshotFields = new Set([
  "passes",
  "line",
  "requests",
  "deniedRequests",
  "attendance",
  "attendanceLog",
  "claims",
  "hubVisits",
]);

/** What a kiosk action branch reports back for the audit event and kiosk feedback. */
type KioskActionOutcome = {
  eventType: string;
  details: Record<string, unknown>;
  chime: HubKioskChime;
  confirmationMessage?: string;
  promptOverrideToConsume?: string;
};

export class RevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly conflictingPaths: string[] = [],
  ) {
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

export class InvitationError extends Error {
  constructor(
    readonly status: 401 | 409 | 410,
    readonly code:
      "invalid_invitation" | "invitation_consumed" | "invitation_unavailable",
  ) {
    super(code);
    this.name = "InvitationError";
  }
}

export class RolePermissionError extends Error {
  constructor() {
    super("This action is not available to this staff role.");
    this.name = "RolePermissionError";
  }
}

export class RecordNotFoundError extends Error {
  constructor() {
    super("The requested record was not found.");
    this.name = "RecordNotFoundError";
  }
}

export class HubKioskPinError extends Error {
  constructor() {
    super("The student PIN did not match.");
    this.name = "HubKioskPinError";
  }
}

export class HubKioskPromptError extends Error {
  constructor(
    readonly code:
      | "required_hub_prompt_missing"
      | "invalid_hub_prompt_response"
      | "hub_prompt_configuration_changed"
      | "hub_prompt_responses_already_saved",
  ) {
    super(code);
    this.name = "HubKioskPromptError";
  }
}

export class HubStore {
  private readonly database: Database;

  constructor(
    databasePath: string,
    private readonly migrationBackupDirectory = `${resolve(databasePath)}.backups`,
    private readonly backupEncryptionKey?: Buffer,
  ) {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database = new Database(absolutePath, { create: true });
    this.database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    try {
      const existingVersion =
        this.database
          .query("PRAGMA user_version")
          .get<{ user_version: number }>()?.user_version ?? 0;
      if (existingVersion > 0 && existingVersion < databaseSchemaVersion) {
        this.createPreMigrationBackup(existingVersion);
      }
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  read(): StoredSnapshot | null {
    const row = this.database
      .query(
        "SELECT schema_version, revision, saved_at, snapshot_json, checksum FROM hub_state WHERE id = 1",
      )
      .get<StoredRow>();
    return row ? this.fromRow(row) : null;
  }

  /** Loads the single saved state row or throws when nothing has been saved yet. */
  private readStoredRowOrThrow(): StoredSnapshot {
    const stored = this.read();
    if (!stored) throw new RecordNotFoundError();
    return stored;
  }

  createHubKioskActivation(actor: StaffActor): HubKioskActivation {
    requireTic(actor);
    const saved = this.read();
    if (!saved) throw new RecordNotFoundError();

    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + hubKioskActivationLifetimeMs,
    ).toISOString();
    this.database.transaction(() => {
      this.database
        .query(
          "UPDATE hub_kiosk_tickets SET revoked_at = ? WHERE consumed_at IS NULL AND revoked_at IS NULL",
        )
        .run(createdAt);
      this.database
        .query(
          `INSERT INTO hub_kiosk_tickets
             (id, token_hash, created_by_staff_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, hashToken(token), actor.staffId, createdAt, expiresAt);
      this.appendAuditEvent("hub_kiosk_activation_issued", actor, {
        activationId: id,
        expiresAt,
      });
    })();
    return { token, expiresAt };
  }

  redeemHubKioskActivation(token: string): HubKioskSession {
    if (token.length < 32 || token.length > 128) {
      throw new RecordNotFoundError();
    }
    return this.database.transaction(() => {
      const ticket = this.database
        .query(
          `SELECT id, created_by_staff_id, expires_at, consumed_at, revoked_at
           FROM hub_kiosk_tickets WHERE token_hash = ?`,
        )
        .get<{
          id: string;
          created_by_staff_id: string;
          expires_at: string;
          consumed_at: string | null;
          revoked_at: string | null;
        }>(hashToken(token));
      if (
        !ticket ||
        ticket.consumed_at ||
        ticket.revoked_at ||
        Date.parse(ticket.expires_at) <= Date.now()
      ) {
        throw new RecordNotFoundError();
      }

      const consumedAt = new Date().toISOString();
      const updated = this.database
        .query(
          `UPDATE hub_kiosk_tickets SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
        )
        .run(consumedAt, ticket.id) as { changes?: number };
      if ((updated.changes ?? 0) !== 1) throw new RecordNotFoundError();

      const replacedSessions = this.database
        .query(
          `UPDATE hub_kiosk_sessions SET revoked_at = ?
           WHERE revoked_at IS NULL AND expires_at > ?`,
        )
        .run(consumedAt, consumedAt) as { changes?: number };
      const id = randomUUID();
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(
        Date.now() + hubKioskSessionLifetimeMs,
      ).toISOString();
      this.database
        .query(
          `INSERT INTO hub_kiosk_sessions
             (id, token_hash, created_by_staff_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          hashToken(sessionToken),
          ticket.created_by_staff_id,
          consumedAt,
          expiresAt,
        );
      this.appendAuditEvent("hub_kiosk_session_started", null, {
        kioskSessionId: id,
        activationId: ticket.id,
        createdByStaffId: ticket.created_by_staff_id,
        expiresAt,
        replacedSessionCount: replacedSessions.changes ?? 0,
      });
      return { id, token: sessionToken, expiresAt };
    })();
  }

  getHubKioskSession(token: string | null) {
    if (!token || token.length < 32 || token.length > 128) return null;
    const session = this.database
      .query(
        `SELECT id, expires_at, revoked_at
         FROM hub_kiosk_sessions WHERE token_hash = ?`,
      )
      .get<{ id: string; expires_at: string; revoked_at: string | null }>(
        hashToken(token),
      );
    if (
      !session ||
      session.revoked_at ||
      Date.parse(session.expires_at) <= Date.now()
    ) {
      return null;
    }
    return { id: session.id, expiresAt: session.expires_at };
  }

  stopHubKioskSessions(actor: StaffActor) {
    requireTic(actor);
    const revokedAt = new Date().toISOString();
    return this.database.transaction(() => {
      const sessions = this.database
        .query(
          "UPDATE hub_kiosk_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(revokedAt) as { changes?: number };
      const tickets = this.database
        .query(
          "UPDATE hub_kiosk_tickets SET revoked_at = ? WHERE consumed_at IS NULL AND revoked_at IS NULL",
        )
        .run(revokedAt) as { changes?: number };
      this.appendAuditEvent("hub_kiosk_stopped", actor, {
        revokedAt,
        sessionCount: sessions.changes ?? 0,
        activationCount: tickets.changes ?? 0,
      });
      return {
        stoppedCount: sessions.changes ?? 0,
        revokedActivationCount: tickets.changes ?? 0,
      };
    })();
  }

  createHubPromptOverride(
    actor: StaffActor,
    request: HubPromptOverrideRequest,
  ) {
    const reason = request.reason.trim();
    if (reason.length < 3 || reason.length > 300) {
      throw new TypeError("The prompt override reason must be 3–300 characters.");
    }
    return this.database.transaction(() => {
      const previous = this.readStoredRowOrThrow();
      const snapshot = previous.snapshot;
      const student = snapshotArray(snapshot.roster).find(
        (each) => each.id === request.studentId,
      );
      if (!student) throw new RecordNotFoundError();
      const isCurrentStudent = snapshotArray(snapshot.classes).some((cls) =>
        snapshotArray(cls.members).some(
          (member) =>
            member.studentId === request.studentId &&
            member.status === "current",
        ),
      );
      if (!isCurrentStudent) throw new RolePermissionError();
      const destination = snapshotArray(snapshot.destinations).find(
        (each) => each.id === request.destinationId,
      );
      if (
        !destination ||
        destination.kioskAvailable === false ||
        !hubPromptsForDestination(destination, request.stage).some(
          (prompt) => prompt.required,
        )
      ) {
        throw new RolePermissionError();
      }

      const activeVisits = snapshotArray(snapshot.hubVisits).filter(
        (visit) =>
          visit.studentId === request.studentId &&
          !visit.arrivedBackAtClassAt &&
          !visit.cancelledAt,
      );
      if (request.stage === "arrival") {
        if (
          activeVisits.length > 1 ||
          (activeVisits.length === 1 &&
            (activeVisits[0].arrivedAtHubAt ||
              activeVisits[0].leftHubAt ||
              activeVisits[0].destinationId !== request.destinationId))
        ) {
          throw new RolePermissionError();
        }
      } else if (
        activeVisits.length !== 1 ||
        !activeVisits[0].arrivedAtHubAt ||
        activeVisits[0].leftHubAt ||
        snapshotArray(activeVisits[0].temporaryTrips).some(
          (trip) => !trip.returnedAt,
        ) ||
        activeVisits[0].destinationId !== request.destinationId
      ) {
        throw new RolePermissionError();
      }

      const now = new Date();
      const pending = snapshotArray(snapshot.hubPromptOverrides).filter(
        (each) => {
          if (!isHubPromptOverride(each)) throw new RolePermissionError();
          return Date.parse(each.expiresAt) > now.getTime();
        },
      );
      if (
        pending.some(
          (each) =>
            each.studentId === request.studentId &&
            each.destinationId === request.destinationId &&
            each.stage === request.stage,
        )
      ) {
        throw new RolePermissionError();
      }
      const requestedAt = now.toISOString();
      const override: HubPromptOverride = {
        id: randomUUID(),
        studentId: request.studentId,
        destinationId: request.destinationId,
        stage: request.stage,
        reason,
        requestedAt,
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        requestedBy: {
          staffId: actor.staffId,
          displayName: actor.displayName,
          role: actor.role,
        },
      };
      const saved = this.commitStaffSnapshot(
        previous,
        { ...snapshot, hubPromptOverrides: [...pending, override] },
        actor,
        "hub_visit_prompt_override_issued",
        {
          overrideId: override.id,
          studentId: override.studentId,
          destinationId: override.destinationId,
          stage: override.stage,
          reason: override.reason,
          expiresAt: override.expiresAt,
        },
      );
      return { revision: saved.revision, expiresAt: override.expiresAt };
    })();
  }

  readHubKioskState(): HubKioskState {
    const stored = this.read();
    if (!stored) throw new RecordNotFoundError();
    const snapshot = stored.snapshot;
    const roster = snapshotArray(snapshot.roster);
    const classes = snapshotArray(snapshot.classes);
    const destinations = snapshotArray(snapshot.destinations);
    const movements = snapshotArray(snapshot.hubVisits).filter(
      (visit) => !visit.arrivedBackAtClassAt && !visit.cancelledAt,
    );
    const currentStudentIds = new Set(
      classes.flatMap((cls) =>
        snapshotArray(cls.members)
          .filter((member) => member.status === "current")
          .map((member) => member.studentId),
      ),
    );
    for (const visit of movements) {
      if (typeof visit.studentId === "string") {
        currentStudentIds.add(visit.studentId);
      }
    }

    const overrides = snapshotArray(snapshot.hubPromptOverrides)
      .map((override) => {
        if (!isHubPromptOverride(override)) throw new RolePermissionError();
        return override;
      })
      .filter((override) => Date.parse(override.expiresAt) > Date.now());
    const kioskDestinations = destinations
      .filter((destination) => destination.kioskAvailable !== false)
      .map((destination) => kioskDestinationView(destination));
    const temporaryDestinations = destinations
      .filter(
        (destination) =>
          destination.kioskAvailable !== false &&
          destination.temporaryTripAvailable === true,
      )
      .map((destination) => ({
        ...kioskDestinationView(destination),
        arrivalPrompts: [],
      }));

    const students = roster
      .filter(
        (student): student is Record<string, unknown> & {
          id: string;
          firstName: string;
        } =>
          typeof student.id === "string" &&
          currentStudentIds.has(student.id) &&
          typeof student.firstName === "string",
      )
      .map((student) =>
        buildKioskStudent(
          snapshot,
          student,
          movements,
          classes,
          destinations,
          overrides,
        ),
      )
      .sort((a, b) => a.studentName.localeCompare(b.studentName));

    return {
      revision: stored.revision,
      savedAt: stored.savedAt,
      students,
      destinations: kioskDestinations,
      temporaryDestinations,
      soundSettings: readHubKioskSoundSettings(snapshot),
      promptOverrides: overrides.map((override) => ({
        studentId: override.studentId,
        destinationId: override.destinationId,
        stage: override.stage,
      })),
    };
  }

  recordHubKioskAction(
    token: string,
    request: HubKioskMovementRequest,
  ) {
    const session = this.getHubKioskSession(token);
    if (!session) throw new RolePermissionError();
    return this.database.transaction(() => {
      const previous = this.readStoredRowOrThrow();
      const snapshot = previous.snapshot;
      const visits = snapshotArray(snapshot.hubVisits);
      const occurredAt = new Date().toISOString();

      // Shared prelude: each branch resolves, mutates `visits`, and reports
      // the audit event plus kiosk feedback for the committed snapshot.
      const outcome =
        request.action === "prompts"
          ? this.kioskPromptAnswers(snapshot, visits, request, occurredAt)
          : request.action === "direct-arrive"
          ? this.kioskDirectArrive(snapshot, visits, request, occurredAt)
          : this.kioskVisitAction(snapshot, visits, request, occurredAt);

      const nextSnapshot: StateSnapshot = { ...snapshot, hubVisits: visits };
      if (outcome.promptOverrideToConsume) {
        nextSnapshot.hubPromptOverrides = snapshotArray(
          snapshot.hubPromptOverrides,
        ).filter((override) => override.id !== outcome.promptOverrideToConsume);
      }
      const saved = this.commitHubKioskSnapshot(
        previous,
        nextSnapshot,
        session.id,
        outcome.eventType,
        outcome.details,
      );
      return {
        revision: saved.revision,
        savedAt: saved.savedAt,
        chime: outcome.chime,
        ...(outcome.confirmationMessage
          ? { confirmationMessage: outcome.confirmationMessage }
          : {}),
      };
    })();
  }

  extendHubVisitTimer(actor: StaffActor, visitId: string, minutes: number) {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) {
      throw new TypeError("Add between 1 and 60 minutes.");
    }
    return this.database.transaction(() => {
      const previous = this.readStoredRowOrThrow();
      const visits = snapshotArray(previous.snapshot.hubVisits);
      const index = visits.findIndex((visit) => visit.id === visitId);
      const visit = visits[index];
      if (!visit || typeof visit.arrivedAtHubAt !== "string" || visit.leftHubAt || visit.arrivedBackAtClassAt || visit.cancelledAt || typeof visit.hubTimerMinutes !== "number") {
        throw new RolePermissionError();
      }
      visits[index] = { ...visit, hubExtraMinutes: (typeof visit.hubExtraMinutes === "number" ? visit.hubExtraMinutes : 0) + minutes };
      const saved = this.commitStaffSnapshot(previous, { ...previous.snapshot, hubVisits: visits }, actor, "hub_visit_timer_extended", { hubVisitId: visitId, studentId: visit.studentId, addedMinutes: minutes });
      return { revision: saved.revision, savedAt: saved.savedAt, snapshot: saved.snapshot };
    })();
  }

  updateHubVisitStaffNote(actor: StaffActor, visitId: string, rawNote: string) {
    const note = rawNote.trim();
    if (note.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new TypeError("Hub staff notes must be 1,000 characters or fewer.");
    return this.database.transaction(() => {
      const previous = this.readStoredRowOrThrow();
      const visits = snapshotArray(previous.snapshot.hubVisits);
      const index = visits.findIndex((visit) => visit.id === visitId);
      const visit = visits[index];
      if (!visit || !visit.arrivedAtHubAt || visit.cancelledAt) throw new RolePermissionError();
      const updated = { ...visit };
      if (note) updated.hubStaffNote = note;
      else delete updated.hubStaffNote;
      visits[index] = updated;
      const saved = this.commitStaffSnapshot(previous, { ...previous.snapshot, hubVisits: visits }, actor, "hub_visit_staff_note_saved", { hubVisitId: visitId, studentId: visit.studentId, notePresent: !!note });
      return { revision: saved.revision, savedAt: saved.savedAt, snapshot: saved.snapshot };
    })();
  }

  private kioskPromptAnswers(
    snapshot: StateSnapshot,
    visits: Record<string, unknown>[],
    request: Extract<HubKioskMovementRequest, { action: "prompts" }>,
    occurredAt: string,
  ): KioskActionOutcome {
    const index = visits.findIndex((visit) => visit.id === request.visitId);
    const visit = visits[index];
    if (!visit || typeof visit.studentId !== "string") throw new RecordNotFoundError();
    const student = snapshotArray(snapshot.roster).find((entry) => entry.id === visit.studentId);
    if (!student || (hubKioskPinRequired(snapshot, student, typeof visit.classId === "string" ? visit.classId : undefined) && request.pin !== student.pin)) throw new HubKioskPinError();
    const movementExists = request.stage === "arrival" ? typeof visit.arrivedAtHubAt === "string" : typeof visit.leftHubAt === "string";
    if (!movementExists || visit.arrivedBackAtClassAt || visit.cancelledAt) throw new RolePermissionError();
    const completedStages = completedPromptStages(visit);
    const responses = snapshotArray(visit.promptResponses);
    if (completedStages.includes(request.stage) || responses.some((response) => response.stage === request.stage)) {
      throw new HubKioskPromptError("hub_prompt_responses_already_saved");
    }
    const destination = snapshotArray(snapshot.destinations).find((entry) => entry.id === visit.destinationId);
    const collection = collectHubPromptResponses(snapshot, typeof visit.destinationId === "string" ? visit.destinationId : undefined, destination, visit.studentId, request.stage, request, occurredAt);
    visits[index] = { ...visit, ...hubVisitPromptData(visit, collection), promptStagesCompleted: [...completedStages, request.stage] };
    if (request.stage === "arrival" && visit.timerStartsAfterArrivalPrompts && !visit.timerStartedAt) {
      visits[index] = { ...visits[index], timerStartedAt: occurredAt };
    }
    return {
      eventType: "hub_visit_kiosk_prompts_answered",
      details: { hubVisitId: visit.id, studentId: visit.studentId, stage: request.stage, ...hubPromptAuditDetails(collection) },
      chime: "none",
      promptOverrideToConsume: collection.overrideId,
    };
  }

  /** Resolves a visit-scoped kiosk action (arrive/leave/temporary trips). */
  private kioskVisitAction(
    snapshot: StateSnapshot,
    visits: Record<string, unknown>[],
    request: Exclude<HubKioskMovementRequest, { action: "direct-arrive" | "prompts" }>,
    occurredAt: string,
  ): KioskActionOutcome {
    const visitIndex = visits.findIndex((each) => each.id === request.visitId);
    const visit = visits[visitIndex];
    if (!visit) throw new RecordNotFoundError();
    const student = snapshotArray(snapshot.roster).find(
      (each) => each.id === visit.studentId,
    );
    if (!student || typeof student.id !== "string") {
      throw new RecordNotFoundError();
    }
    if (
      hubKioskPinRequired(
        snapshot,
        student,
        typeof visit.classId === "string" ? visit.classId : undefined,
      ) &&
      request.pin !== student.pin
    ) {
      throw new HubKioskPinError();
    }
    if (!Array.isArray(visit.temporaryTrips)) {
      throw new RolePermissionError();
    }
    const trips = snapshotArray(visit.temporaryTrips);

    let result: { visit: Record<string, unknown>; outcome: KioskActionOutcome };
    if (request.action === "arrive") {
      result = this.kioskArrive(
        snapshot,
        visit,
        occurredAt,
      );
    } else if (request.action === "temporary-start") {
      result = this.kioskTemporaryStart(
        snapshot,
        visits,
        visit,
        trips,
        request as Extract<HubKioskMovementRequest, { action: "temporary-start" }>,
        occurredAt,
      );
    } else if (request.action === "temporary-return") {
      result = this.kioskTemporaryReturn(snapshot, visit, trips, occurredAt);
    } else {
      result = this.kioskLeave(
        snapshot,
        visit,
        trips,
        occurredAt,
      );
    }
    visits[visitIndex] = result.visit;
    return result.outcome;
  }

  private kioskArrive(
    snapshot: StateSnapshot,
    visit: Record<string, unknown>,
    occurredAt: string,
  ): { visit: Record<string, unknown>; outcome: KioskActionOutcome } {
    if (
      visit.source !== "classroom-notification" ||
      typeof visit.leftClassAt !== "string" ||
      !isCanonicalTimestamp(visit.leftClassAt) ||
      visit.arrivedAtHubAt ||
      visit.leftHubAt ||
      visit.arrivedBackAtClassAt ||
      visit.cancelledAt ||
      Date.now() < Date.parse(visit.leftClassAt)
    ) {
      throw new RolePermissionError();
    }
    const destination = snapshotArray(snapshot.destinations).find(
      (each) => each.id === visit.destinationId,
    );
    return {
      visit: {
        ...visit,
        arrivedAtHubAt: occurredAt,
        arrivedBy: { type: "student-kiosk" },
        ...(typeof destination?.hubTimerMinutes === "number" ? {
          hubTimerMinutes: destination.hubTimerMinutes,
          hubTimerWarningMinutes: destination.hubTimerWarningMinutes ?? 2,
          hubOverdueCountsUp: destination.hubOverdueCountsUp === true,
          timerStartsAfterArrivalPrompts: destination.hubTimerStartsAfterArrivalPrompts === true && hubPromptsForDestination(destination, "arrival").length > 0,
          ...(destination.hubTimerStartsAfterArrivalPrompts !== true || !hubPromptsForDestination(destination, "arrival").length ? { timerStartedAt: occurredAt } : {}),
        } : {}),
      },
      outcome: {
        eventType: "hub_visit_kiosk_arrived",
        details: {
          hubVisitId: visit.id,
          studentId: visit.studentId,
        },
        chime: destination ? kioskArrivalChime(destination) : "none",
        confirmationMessage: destination
          ? kioskDestinationConfirmation(destination)
          : undefined,
      },
    };
  }

  private kioskTemporaryStart(
    snapshot: StateSnapshot,
    visits: Record<string, unknown>[],
    visit: Record<string, unknown>,
    trips: Record<string, unknown>[],
    request: Extract<HubKioskMovementRequest, { action: "temporary-start" }>,
    occurredAt: string,
  ): { visit: Record<string, unknown>; outcome: KioskActionOutcome } {
    const destination = snapshotArray(snapshot.destinations).find(
      (each) => each.id === request.destinationId,
    );
    if (
      !destination ||
      destination.kioskAvailable === false ||
      destination.temporaryTripAvailable !== true ||
      typeof destination.label !== "string" ||
      typeof visit.arrivedAtHubAt !== "string" ||
      !isCanonicalTimestamp(visit.arrivedAtHubAt) ||
      visit.leftHubAt ||
      visit.arrivedBackAtClassAt ||
      visit.cancelledAt ||
      Date.now() < Date.parse(visit.arrivedAtHubAt) ||
      visits.some(
        (each) =>
          each.studentId === visit.studentId &&
          snapshotArray(each.temporaryTrips).some((trip) => !trip.returnedAt),
      )
    ) {
      throw new RolePermissionError();
    }
    const tripId = randomUUID();
    return {
      visit: {
        ...visit,
        temporaryTrips: [
          ...trips,
          {
            id: tripId,
            destinationId: destination.id,
            destinationLabel: destination.label,
            startedAt: occurredAt,
            startedBy: { type: "student-kiosk" },
          },
        ],
      },
      outcome: {
        eventType: "hub_visit_kiosk_temporary_trip_started",
        details: {
          hubVisitId: visit.id,
          temporaryTripId: tripId,
          studentId: visit.studentId,
          destinationId: destination.id,
        },
        chime: "none",
      },
    };
  }

  private kioskTemporaryReturn(
    snapshot: StateSnapshot,
    visit: Record<string, unknown>,
    trips: Record<string, unknown>[],
    occurredAt: string,
  ): { visit: Record<string, unknown>; outcome: KioskActionOutcome } {
    const activeTrips = trips.filter((trip) => !trip.returnedAt);
    const activeTrip = activeTrips[0];
    if (
      !activeTrip ||
      activeTrips.length !== 1 ||
      typeof visit.arrivedAtHubAt !== "string" ||
      !isCanonicalTimestamp(visit.arrivedAtHubAt) ||
      visit.leftHubAt ||
      visit.arrivedBackAtClassAt ||
      visit.cancelledAt ||
      typeof activeTrip.startedAt !== "string" ||
      !isCanonicalTimestamp(activeTrip.startedAt) ||
      Date.now() < Date.parse(activeTrip.startedAt)
    ) {
      throw new RolePermissionError();
    }
    return {
      visit: {
        ...visit,
        temporaryTrips: trips.map((trip) =>
          trip.id === activeTrip.id
            ? {
                ...trip,
                returnedAt: occurredAt,
                returnedBy: { type: "student-kiosk" },
              }
            : trip,
        ),
      },
      outcome: {
        eventType: "hub_visit_kiosk_temporary_trip_returned",
        details: {
          hubVisitId: visit.id,
          temporaryTripId: activeTrip.id,
          studentId: visit.studentId,
        },
        chime: readHubKioskSoundSettings(snapshot).commonChime,
      },
    };
  }

  private kioskLeave(
    snapshot: StateSnapshot,
    visit: Record<string, unknown>,
    trips: Record<string, unknown>[],
    occurredAt: string,
  ): { visit: Record<string, unknown>; outcome: KioskActionOutcome } {
    if (
      typeof visit.arrivedAtHubAt !== "string" ||
      !isCanonicalTimestamp(visit.arrivedAtHubAt) ||
      visit.leftHubAt ||
      visit.arrivedBackAtClassAt ||
      visit.cancelledAt ||
      Date.now() < Date.parse(visit.arrivedAtHubAt) ||
      trips.some((trip) => !trip.returnedAt)
    ) {
      throw new RolePermissionError();
    }
    return {
      visit: {
        ...visit,
        leftHubAt: occurredAt,
        leftBy: { type: "student-kiosk" },
      },
      outcome: {
        eventType: "hub_visit_kiosk_left",
        details: {
          hubVisitId: visit.id,
          studentId: visit.studentId,
        },
        chime: readHubKioskSoundSettings(snapshot).commonChime,
      },
    };
  }

  private kioskDirectArrive(
    snapshot: StateSnapshot,
    visits: Record<string, unknown>[],
    request: Extract<HubKioskMovementRequest, { action: "direct-arrive" }>,
    occurredAt: string,
  ): KioskActionOutcome {
    const student = snapshotArray(snapshot.roster).find(
      (each) => each.id === request.studentId,
    );
    if (
      !student ||
      typeof student.id !== "string" ||
      typeof student.firstName !== "string" ||
      !student.firstName.trim()
    ) {
      throw new RecordNotFoundError();
    }
    const isCurrentStudent = snapshotArray(snapshot.classes).some((cls) =>
      snapshotArray(cls.members).some(
        (member) =>
          member.studentId === student.id && member.status === "current",
      ),
    );
    if (!isCurrentStudent) throw new RolePermissionError();
    if (hubKioskPinRequired(snapshot, student) && request.pin !== student.pin) {
      throw new HubKioskPinError();
    }
    if (
      visits.some(
        (visit) =>
          visit.studentId === request.studentId &&
          !visit.arrivedBackAtClassAt &&
          !visit.cancelledAt,
      )
    ) {
      throw new RolePermissionError();
    }
    const destination = snapshotArray(snapshot.destinations).find(
      (each) => each.id === request.destinationId,
    );
    if (
      !destination ||
      typeof destination.id !== "string" ||
      destination.kioskAvailable === false ||
      typeof destination.label !== "string"
    ) {
      throw new RolePermissionError();
    }
    const category = snapshotArray(snapshot.studentCategories).find(
      (each) => each.id === student.categoryId,
    );
    const lastName = typeof student.lastName === "string" ? student.lastName : "";
    const updated: Record<string, unknown> = {
      id: randomUUID(),
      studentId: student.id,
      studentName: `${String(student.firstName)}${lastName ? ` ${lastName}` : ""}`,
      ...(category
        ? {
            studentCategory: {
              id: category.id,
              name: category.name,
              color: category.color,
            },
          }
        : {}),
      destinationId: destination.id,
      destinationLabel: destination.label,
      source: "direct-kiosk-arrival",
      arrivedAtHubAt: occurredAt,
      arrivedBy: { type: "student-kiosk" },
      ...(typeof destination.hubTimerMinutes === "number" ? {
        hubTimerMinutes: destination.hubTimerMinutes,
        hubTimerWarningMinutes: destination.hubTimerWarningMinutes ?? 2,
        hubOverdueCountsUp: destination.hubOverdueCountsUp === true,
        timerStartsAfterArrivalPrompts: destination.hubTimerStartsAfterArrivalPrompts === true && hubPromptsForDestination(destination, "arrival").length > 0,
        ...(destination.hubTimerStartsAfterArrivalPrompts !== true || !hubPromptsForDestination(destination, "arrival").length ? { timerStartedAt: occurredAt } : {}),
      } : {}),
      temporaryTrips: [],
    };
    visits.push(updated);
    return {
      eventType: "hub_visit_kiosk_direct_arrived",
      details: {
        hubVisitId: updated.id,
        studentId: student.id,
        destinationId: destination.id,
      },
      chime: kioskArrivalChime(destination),
      confirmationMessage: kioskDestinationConfirmation(destination),
    };
  }


  readRevisionHistory() {
    return this.database
      .query(
        `SELECT revision, saved_at, checksum, actor_staff_id, actor_display_name, actor_role, change_type
         FROM hub_state_revisions ORDER BY revision DESC`,
      )
      .all<{
        revision: number;
        saved_at: string;
        checksum: string;
        actor_staff_id: string | null;
        actor_display_name: string | null;
        actor_role: StaffRole | null;
        change_type: "saved" | "restored" | "imported";
      }>()
      .map((row) => ({
        revision: row.revision,
        savedAt: row.saved_at,
        checksum: row.checksum,
        staffId: row.actor_staff_id,
        staffName: row.actor_display_name,
        staffRole: row.actor_role,
        changeType: row.change_type,
      }));
  }

  readRevision(revision: number): StoredSnapshot | null {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    const row = this.database
      .query(
        `SELECT revision, saved_at, snapshot_gzip, checksum FROM hub_state_revisions
         WHERE revision = ?`,
      )
      .get<{
        revision: number;
        saved_at: string;
        snapshot_gzip: Uint8Array;
        checksum: string;
      }>(revision);
    if (!row) return null;
    try {
      const snapshotJson = gunzipSync(row.snapshot_gzip).toString("utf8");
      if (checksumOf(snapshotJson) !== row.checksum) {
        throw new StateIntegrityError();
      }
      const snapshot: unknown = JSON.parse(snapshotJson);
      if (!isRecord(snapshot)) throw new StateIntegrityError();
      return {
        revision: row.revision,
        savedAt: row.saved_at,
        checksum: row.checksum,
        snapshot,
      };
    } catch (error) {
      if (error instanceof StateIntegrityError) throw error;
      throw new StateIntegrityError();
    }
  }

  createRevisionRestoreFile(targetPath: string, revision: number) {
    const stored = this.readRevision(revision);
    if (!stored) throw new RecordNotFoundError();
    this.createConsistentBackupFile(targetPath);
    const database = new Database(resolve(targetPath));
    try {
      database.transaction(() => {
        database
          .query(
            `UPDATE hub_state SET revision = ?, saved_at = ?, snapshot_json = ?, checksum = ? WHERE id = 1`,
          )
          .run(
            revision,
            stored.savedAt,
            JSON.stringify(stored.snapshot),
            stored.checksum,
          );
      })();
    } finally {
      database.close();
    }
  }

  schemaVersion() {
    return (
      this.database.query("PRAGMA user_version").get<{ user_version: number }>()
        ?.user_version ?? 0
    );
  }

  createConsistentBackupFile(targetPath: string) {
    const absolutePath = resolve(targetPath);
    if (existsSync(absolutePath)) {
      throw new TypeError("Backup target must be a new file.");
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    this.database.exec(`VACUUM INTO '${absolutePath.replaceAll("'", "''")}'`);
  }

  save(
    snapshot: StateSnapshot,
    expectedRevision: number,
    actor: StaffActor,
    baseSnapshot?: StateSnapshot,
  ): StoredSnapshot {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError(
        "expectedRevision must be a non-negative safe integer.",
      );
    }
    if (!isRecord(snapshot))
      throw new TypeError("snapshot must be a JSON object.");

    return this.database.transaction(() => {
      const verifiedPrevious = this.read();
      const currentRevision = verifiedPrevious?.revision ?? 0;
      let snapshotToSave = snapshot;
      let mergeMode: "direct" | "three_way" = "direct";
      const requiresMerge =
        actor.role === "ea" || expectedRevision !== currentRevision;
      if (requiresMerge) {
        if (
          (actor.role === "ea" && !verifiedPrevious) ||
          expectedRevision > currentRevision ||
          !baseSnapshot
        ) {
          throw new RevisionConflictError(currentRevision, ["$base"]);
        }
        const merged = mergeSnapshots(
          baseSnapshot,
          snapshot,
          verifiedPrevious?.snapshot ?? {},
        );
        if (merged.conflicts.length) {
          throw new RevisionConflictError(currentRevision, merged.conflicts);
        }
        snapshotToSave = merged.snapshot;
        mergeMode = "three_way";
      }

      if (actor.role === "ea") {
        const changedFields = changedTopLevelFields(
          verifiedPrevious?.snapshot ?? {},
          snapshotToSave,
        );
        if (
          changedFields.some((field) => !eaEditableSnapshotFields.has(field))
        ) {
          throw new RolePermissionError();
        }
        if (changedFields.includes("hubVisits")) {
          const result = validateAndAttributeEaHubVisitNotifications(
            verifiedPrevious?.snapshot ?? {},
            snapshotToSave,
            actor,
          );
          snapshotToSave = { ...snapshotToSave, hubVisits: result.visits };
          for (const visit of result.created) {
            this.appendAuditEvent("hub_visit_notification_created", actor, {
              hubVisitId: visit.id,
              studentId: visit.studentId,
              classId: visit.classId,
              destinationId: visit.destinationId,
            });
          }
          for (const visit of result.arrived) {
            this.appendAuditEvent("hub_visit_arrived", actor, {
              hubVisitId: visit.id,
              studentId: visit.studentId,
              classId: visit.classId,
              destinationId: visit.destinationId,
            });
          }
          for (const visit of result.departed) {
            this.appendAuditEvent("hub_visit_left", actor, {
              hubVisitId: visit.id,
              studentId: visit.studentId,
              classId: visit.classId,
              destinationId: visit.destinationId,
            });
          }
          for (const visit of result.returned) {
            this.appendAuditEvent("hub_visit_return_confirmed", actor, {
              hubVisitId: visit.id,
              studentId: visit.studentId,
              classId: visit.classId,
            });
          }
          for (const visit of result.cancelled) {
            this.appendAuditEvent("hub_visit_notification_cancelled", actor, {
              hubVisitId: visit.id,
              studentId: visit.studentId,
              classId: visit.classId,
              reason: visit.cancellationReason,
            });
          }
        }
      } else if (
        verifiedPrevious &&
        changedTopLevelFields(verifiedPrevious?.snapshot ?? {}, snapshotToSave)
          .includes("hubVisits")
      ) {
        const attributed = {
          ...snapshotToSave,
          hubVisits: attributeNewHubVisitNotifications(
            verifiedPrevious.snapshot,
            snapshotToSave,
            actor,
          ),
        };
        const arrivals = attributeHubVisitArrivals(
          verifiedPrevious.snapshot,
          attributed,
          actor,
        );
        const departures = attributeHubVisitDepartures(
          verifiedPrevious.snapshot,
          { ...attributed, hubVisits: arrivals.visits },
          actor,
        );
        const cancellations = attributeHubVisitCancellations(
          verifiedPrevious.snapshot,
          { ...attributed, hubVisits: departures.visits },
          actor,
        );
        const returns = attributeHubVisitReturns(
          verifiedPrevious.snapshot,
          { ...attributed, hubVisits: cancellations.visits },
          actor,
        );
        snapshotToSave = { ...attributed, hubVisits: returns.visits };
        for (const visit of arrivals.arrived) {
          this.appendAuditEvent("hub_visit_arrived", actor, {
            hubVisitId: visit.id,
            studentId: visit.studentId,
            classId: visit.classId,
            destinationId: visit.destinationId,
          });
        }
        for (const visit of departures.departed) {
          this.appendAuditEvent("hub_visit_left", actor, {
            hubVisitId: visit.id,
            studentId: visit.studentId,
            classId: visit.classId,
            destinationId: visit.destinationId,
          });
        }
        for (const visit of cancellations.cancelled) {
          this.appendAuditEvent("hub_visit_notification_cancelled", actor, {
            hubVisitId: visit.id,
            studentId: visit.studentId,
            classId: visit.classId,
            reason: visit.cancellationReason,
          });
        }
        for (const visit of returns.returned) {
          this.appendAuditEvent("hub_visit_return_confirmed", actor, {
            hubVisitId: visit.id,
            studentId: visit.studentId,
            classId: visit.classId,
          });
        }
      }

      const snapshotJson = JSON.stringify(snapshotToSave);
      if (typeof snapshotJson !== "string") {
        throw new TypeError("snapshot could not be encoded as JSON.");
      }
      const checksum = checksumOf(snapshotJson);
      const savedAt = new Date().toISOString();

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
        .run(databaseSchemaVersion, revision, savedAt, snapshotJson, checksum);

      this.insertRevision(
        revision,
        savedAt,
        snapshotJson,
        checksum,
        actor,
        "saved",
      );

      this.appendAuditEvent("host_snapshot_saved", actor, {
        revision,
        basedOnRevision: expectedRevision,
        mergeMode,
        previousChecksum: verifiedPrevious?.checksum ?? null,
        checksum,
      });
      return { revision, savedAt, checksum, snapshot: snapshotToSave };
    })();
  }

  restoreSnapshot(
    snapshot: StateSnapshot,
    expectedRevision: number,
    actor: StaffActor,
    sourceBackupId: string,
  ): StoredSnapshot {
    if (actor.role !== "tic") throw new RolePermissionError();
    if (!isRecord(snapshot))
      throw new TypeError("snapshot must be a JSON object.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError(
        "expectedRevision must be a non-negative safe integer.",
      );
    }
    const snapshotJson = JSON.stringify(snapshot);
    if (typeof snapshotJson !== "string") {
      throw new TypeError("snapshot could not be encoded as JSON.");
    }
    const checksum = checksumOf(snapshotJson);
    const savedAt = new Date().toISOString();

    return this.database.transaction(() => {
      const verifiedPrevious = this.read();
      const currentRevision = verifiedPrevious?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new RevisionConflictError(currentRevision);
      }

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
        .run(databaseSchemaVersion, revision, savedAt, snapshotJson, checksum);
      this.insertRevision(
        revision,
        savedAt,
        snapshotJson,
        checksum,
        actor,
        "restored",
      );
      this.appendAuditEvent("backup_restore_promoted", actor, {
        sourceBackupId,
        fromRevision: currentRevision,
        toRevision: revision,
        previousChecksum: verifiedPrevious?.checksum ?? null,
        restoredChecksum: checksum,
      });
      return { revision, savedAt, checksum, snapshot };
    })();
  }

  createBootstrapTicInvitation(
    lifetimeMs = invitationLifetimeMs,
    invitedEmail?: string,
  ): IssuedInvitation {
    if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
      throw new TypeError("Invitation lifetime must be positive.");
    }
    const normalizedEmail = invitedEmail ? normalizeEmail(invitedEmail) : null;
    const now = new Date();
    return this.database.transaction(() => {
      const activeInvitation = this.database
        .query(
          `SELECT expires_at FROM staff_invitations
           WHERE bootstrap = 1 AND consumed_at IS NULL AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get<{ expires_at: string }>();
      const profileCount =
        this.database
          .query("SELECT COUNT(*) AS count FROM staff_profiles")
          .get<{ count: number }>()?.count ?? 0;
      if (
        profileCount > 0 ||
        (activeInvitation &&
          Date.parse(activeInvitation.expires_at) > now.getTime())
      ) {
        throw new RolePermissionError();
      }

      const invitation = this.insertInvitation({
        role: "tic",
        staffProfileId: null,
        actor: null,
        invitedEmail: normalizedEmail,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
        bootstrap: true,
      });
      this.appendAuditEvent("bootstrap_tic_invitation_created", null, {
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt,
        identityMethod: normalizedEmail
          ? "microsoft-entra-oidc"
          : fallbackAuthMethod,
        invitedEmail: normalizedEmail,
      });
      return invitation;
    })();
  }

  createInvitation(
    role: StaffRole,
    actor: StaffActor,
    staffProfileId: string | null = null,
    invitedEmail: string | null = null,
  ): IssuedInvitation {
    if (actor.role !== "tic") throw new RolePermissionError();
    if (!isStaffRole(role)) throw new TypeError("role must be ea or tic.");
    if (staffProfileId && !this.getProfile(staffProfileId)) {
      throw new RecordNotFoundError();
    }
    const existingProfile = staffProfileId
      ? this.getProfile(staffProfileId)
      : null;
    if (existingProfile?.role && existingProfile.role !== role) {
      throw new TypeError(
        "An invitation linked to an existing profile must keep that profile's role.",
      );
    }
    const normalizedEmail = invitedEmail ? normalizeEmail(invitedEmail) : null;

    const createdAt = new Date().toISOString();
    return this.database.transaction(() => {
      const invitation = this.insertInvitation({
        role,
        staffProfileId,
        actor,
        invitedEmail: normalizedEmail,
        createdAt,
        expiresAt: new Date(Date.now() + invitationLifetimeMs).toISOString(),
        bootstrap: false,
      });
      this.appendAuditEvent("staff_invitation_created", actor, {
        invitationId: invitation.id,
        role,
        staffProfileId,
        expiresAt: invitation.expiresAt,
      });
      return invitation;
    })();
  }

  beginEntraLogin(state: string, nonce: string, invitationToken?: string) {
    if (!state || !nonce || state.length > 128 || nonce.length > 128) {
      throw new TypeError("Invalid sign-in state.");
    }
    const invitation = invitationToken
      ? this.findUsableInvitation(invitationToken)
      : null;
    if (invitationToken && !invitation) {
      throw new InvitationError(401, "invalid_invitation");
    }
    if (invitation && !invitation.invited_email) {
      throw new TypeError("This invitation is not linked to an Entra email.");
    }
    const createdAt = new Date();
    this.database
      .query("DELETE FROM entra_auth_states WHERE expires_at <= ?")
      .run(createdAt.toISOString());
    this.database
      .query(
        `INSERT INTO entra_auth_states (state_hash, nonce, invitation_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(state),
        nonce,
        invitation?.id ?? null,
        createdAt.toISOString(),
        new Date(createdAt.getTime() + 5 * 60_000).toISOString(),
      );
    return nonce;
  }

  getEntraAuthNonce(state: string) {
    return (
      this.database
        .query(
          "SELECT nonce FROM entra_auth_states WHERE state_hash = ? AND expires_at > ?",
        )
        .get<{ nonce: string }>(hashToken(state), new Date().toISOString())
        ?.nonce ?? null
    );
  }

  completeEntraLogin(
    state: string,
    identity: {
      tenantId: string;
      objectId: string;
      displayName: string;
      email: string;
    },
  ): EntraLogin {
    if (!state || state.length > 128)
      throw new InvitationError(401, "invalid_invitation");
    const tenantId = identity.tenantId.trim().toLowerCase();
    const objectId = identity.objectId.trim().toLowerCase();
    const email = normalizeEmail(identity.email);
    const displayName = normalizeDisplayName(identity.displayName);
    if (!tenantId || !objectId)
      throw new TypeError(
        "The identity provider did not return a stable staff identity.",
      );
    const now = new Date();
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(
      now.getTime() + deviceSessionLifetimeMs,
    ).toISOString();
    return this.database.transaction(() => {
      const authState = this.database
        .query("SELECT * FROM entra_auth_states WHERE state_hash = ?")
        .get<{
          state_hash: string;
          nonce: string;
          invitation_id: string | null;
          expires_at: string;
        }>(hashToken(state));
      if (!authState || Date.parse(authState.expires_at) <= now.getTime()) {
        throw new InvitationError(401, "invalid_invitation");
      }
      this.database
        .query("DELETE FROM entra_auth_states WHERE state_hash = ?")
        .run(authState.state_hash);
      let profile = this.database
        .query(
          "SELECT id, display_name, auth_method, entra_tenant_id, entra_object_id, role FROM staff_profiles WHERE entra_tenant_id = ? AND entra_object_id = ?",
        )
        .get<ProfileRow>(tenantId, objectId);
      let invitation: InvitationRow | null = null;
      if (!profile) {
        if (!authState.invitation_id)
          throw new InvitationError(401, "invalid_invitation");
        invitation =
          this.database
            .query("SELECT * FROM staff_invitations WHERE id = ?")
            .get<InvitationRow>(authState.invitation_id) ?? null;
        if (
          !invitation ||
          invitation.revoked_at ||
          invitation.consumed_at ||
          Date.parse(invitation.expires_at) <= now.getTime() ||
          invitation.invited_email !== email
        ) {
          throw new InvitationError(410, "invitation_unavailable");
        }
        if (invitation.staff_profile_id) {
          profile = this.getProfile(invitation.staff_profile_id) ?? undefined;
          if (
            !profile ||
            (profile.entra_object_id &&
              (profile.entra_tenant_id !== tenantId ||
                profile.entra_object_id !== objectId))
          ) {
            throw new InvitationError(410, "invitation_unavailable");
          }
        } else {
          profile = {
            id: randomUUID(),
            display_name: displayName,
            auth_method: "microsoft-entra-oidc",
            entra_tenant_id: tenantId,
            entra_object_id: objectId,
            role: invitation.role,
          };
          this.database
            .query(
              "INSERT INTO staff_profiles (id, display_name, auth_method, created_at, entra_tenant_id, entra_object_id, role) VALUES (?, ?, 'microsoft-entra-oidc', ?, ?, ?, ?)",
            )
            .run(
              profile.id,
              profile.display_name,
              now.toISOString(),
              tenantId,
              objectId,
              invitation.role,
            );
        }
      }
      if (!profile) throw new InvitationError(410, "invitation_unavailable");
      const role = profile.role ?? invitation?.role;
      if (!role) throw new InvitationError(401, "invalid_invitation");
      if (profile.auth_method !== "microsoft-entra-oidc") {
        this.database
          .query(
            "UPDATE staff_profiles SET auth_method = 'microsoft-entra-oidc', entra_tenant_id = ?, entra_object_id = ?, role = COALESCE(role, ?) WHERE id = ?",
          )
          .run(tenantId, objectId, role, profile.id);
      }
      this.database
        .query(
          "INSERT INTO staff_sessions (id, token_hash, staff_profile_id, role, auth_method, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, 'microsoft-entra-oidc', ?, ?, ?)",
        )
        .run(
          sessionId,
          hashToken(sessionToken),
          profile.id,
          role,
          now.toISOString(),
          now.toISOString(),
          expiresAt,
        );
      if (invitation)
        this.database
          .query(
            "UPDATE staff_invitations SET consumed_at = ?, consumed_session_id = ? WHERE id = ?",
          )
          .run(now.toISOString(), sessionId, invitation.id);
      const actor: StaffActor = {
        sessionId,
        staffId: profile.id,
        displayName: profile.display_name,
        role,
        authMethod: "microsoft-entra-oidc",
        expiresAt,
      };
      this.appendAuditEvent("staff_entra_signed_in", actor, {
        tenantId,
        identityMethod: "microsoft-entra-oidc",
        mfaVerified: true,
      });
      return { actor, sessionToken };
    })();
  }

  enroll(
    token: string,
    displayName: string | undefined,
  ): { actor: StaffActor; sessionToken: string } {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) {
      throw new InvitationError(401, "invalid_invitation");
    }

    const now = new Date();
    const tokenHash = hashToken(token);
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(
      now.getTime() + deviceSessionLifetimeMs,
    ).toISOString();

    return this.database.transaction(() => {
      const invitation = this.database
        .query("SELECT * FROM staff_invitations WHERE token_hash = ?")
        .get<InvitationRow>(tokenHash);
      if (!invitation) throw new InvitationError(401, "invalid_invitation");
      if (
        invitation.revoked_at ||
        Date.parse(invitation.expires_at) <= now.getTime()
      ) {
        throw new InvitationError(410, "invitation_unavailable");
      }
      if (invitation.consumed_at) {
        throw new InvitationError(409, "invitation_consumed");
      }

      let profile: ProfileRow;
      let createdProfile = false;
      if (invitation.staff_profile_id) {
        const existing = this.getProfile(invitation.staff_profile_id);
        if (!existing) throw new InvitationError(410, "invitation_unavailable");
        if (
          displayName &&
          normalizeDisplayName(displayName) !== existing.display_name
        ) {
          throw new TypeError(
            "This invitation is tied to a different staff profile.",
          );
        }
        profile = existing;
      } else {
        const safeName = normalizeDisplayName(displayName ?? "");
        profile = {
          id: randomUUID(),
          display_name: safeName,
          auth_method: fallbackAuthMethod,
          role: invitation.role,
        };
        this.database
          .query(
            "INSERT INTO staff_profiles (id, display_name, auth_method, created_at, role) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            profile.id,
            profile.display_name,
            profile.auth_method,
            now.toISOString(),
            invitation.role,
          );
        createdProfile = true;
      }

      this.database
        .query(
          "UPDATE staff_profiles SET role = COALESCE(role, ?) WHERE id = ?",
        )
        .run(invitation.role, profile.id);

      this.database
        .query(
          `INSERT INTO staff_sessions
             (id, token_hash, staff_profile_id, role, auth_method, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          hashToken(sessionToken),
          profile.id,
          invitation.role,
          fallbackAuthMethod,
          now.toISOString(),
          now.toISOString(),
          sessionExpiresAt,
        );
      this.database
        .query(
          "UPDATE staff_invitations SET consumed_at = ?, consumed_session_id = ? WHERE id = ?",
        )
        .run(now.toISOString(), sessionId, invitation.id);

      const actor: StaffActor = {
        sessionId,
        staffId: profile.id,
        displayName: profile.display_name,
        role: invitation.role,
        authMethod: fallbackAuthMethod,
        expiresAt: sessionExpiresAt,
      };
      this.appendAuditEvent("staff_device_enrolled", actor, {
        invitationId: invitation.id,
        createdProfile,
        identityMethod: fallbackAuthMethod,
        mfaVerified: false,
      });
      return { actor, sessionToken };
    })();
  }

  getSession(sessionToken: string | null): StaffActor | null {
    if (
      !sessionToken ||
      sessionToken.length < 32 ||
      sessionToken.length > 128
    ) {
      return null;
    }
    const row = this.database
      .query(
        `SELECT s.id AS session_id, p.id AS staff_id, p.display_name, s.role,
                s.auth_method, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
         FROM staff_sessions s JOIN staff_profiles p ON p.id = s.staff_profile_id
         WHERE s.token_hash = ?`,
      )
      .get<SessionRow>(hashToken(sessionToken));
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now())
      return null;

    const lastSeenAt = new Date().toISOString();
    this.database
      .query(
        "UPDATE staff_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(lastSeenAt, row.session_id);
    return {
      sessionId: row.session_id,
      staffId: row.staff_id,
      displayName: row.display_name,
      role: row.role,
      authMethod: row.auth_method,
      expiresAt: row.expires_at,
    };
  }

  listSessions(actor: StaffActor): StaffSessionView[] {
    requireTic(actor);
    return this.database
      .query(
        `SELECT s.id AS session_id, p.id AS staff_id, p.display_name, s.role,
                s.auth_method, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at
         FROM staff_sessions s JOIN staff_profiles p ON p.id = s.staff_profile_id
         ORDER BY s.created_at DESC`,
      )
      .all<SessionRow>()
      .map(sessionView);
  }

  listProfiles(actor: StaffActor) {
    requireTic(actor);
    return this.database
      .query(
        "SELECT id, display_name AS displayName, auth_method AS authMethod, role FROM staff_profiles ORDER BY display_name COLLATE NOCASE",
      )
      .all<{
        id: string;
        displayName: string;
        authMethod: string;
        role: StaffRole | null;
      }>();
  }

  readStaffPreferences(actor: StaffActor): StaffPreferences {
    const row = this.database
      .query(
        "SELECT favourite_student_ids, updated_at FROM staff_preferences WHERE staff_profile_id = ?",
      )
      .get<{ favourite_student_ids: string; updated_at: string }>(
        actor.staffId,
      );
    if (!row) return { favouriteStudentIds: [], updatedAt: null };
    let favouriteStudentIds: unknown;
    try {
      favouriteStudentIds = JSON.parse(row.favourite_student_ids);
    } catch {
      throw new StateIntegrityError();
    }
    if (
      !Array.isArray(favouriteStudentIds) ||
      !favouriteStudentIds.every(
        (id) => typeof id === "string" && isValidPreferenceId(id),
      )
    ) {
      throw new StateIntegrityError();
    }
    return {
      favouriteStudentIds: [...new Set(favouriteStudentIds)],
      updatedAt: row.updated_at,
    };
  }

  saveStaffPreferences(
    actor: StaffActor,
    favouriteStudentIds: string[],
  ): StaffPreferences {
    if (
      favouriteStudentIds.length > 500 ||
      !favouriteStudentIds.every(isValidPreferenceId)
    ) {
      throw new Error("Invalid staff preferences.");
    }
    const uniqueIds = [...new Set(favouriteStudentIds)];
    const updatedAt = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO staff_preferences (staff_profile_id, favourite_student_ids, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(staff_profile_id) DO UPDATE SET
           favourite_student_ids = excluded.favourite_student_ids,
           updated_at = excluded.updated_at`,
      )
      .run(actor.staffId, JSON.stringify(uniqueIds), updatedAt);
    return { favouriteStudentIds: uniqueIds, updatedAt };
  }

  listMailRecipients(): HubMailRecipient[] {
    return this.database
      .query(
        `SELECT id AS staffId, display_name AS displayName, role
         FROM staff_profiles WHERE role IN ('ea', 'tic')
         ORDER BY display_name COLLATE NOCASE`,
      )
      .all<HubMailRecipient>();
  }

  readHubConcernPolicy(): HubConcernPolicy {
    const row = this.database
      .query(
        `SELECT available_scopes AS availableScopes,
                default_scope AS defaultScope, updated_at AS updatedAt
         FROM hub_concern_routing WHERE id = 1`,
      )
      .get<{
        availableScopes: string;
        defaultScope: HubConcernScope;
        updatedAt: string;
      }>();
    if (!row) throw new StateIntegrityError();

    let availableScopes: unknown;
    try {
      availableScopes = JSON.parse(row.availableScopes);
    } catch {
      throw new StateIntegrityError();
    }
    if (
      !Array.isArray(availableScopes) ||
      !availableScopes.length ||
      availableScopes.length > 3 ||
      !availableScopes.every(isHubConcernScope) ||
      new Set(availableScopes).size !== availableScopes.length ||
      !availableScopes.includes(row.defaultScope) ||
      !isHubConcernScope(row.defaultScope)
    ) {
      throw new StateIntegrityError();
    }
    return {
      availableScopes,
      defaultScope: row.defaultScope,
      updatedAt: row.updatedAt,
    };
  }

  saveHubConcernPolicy(
    actor: StaffActor,
    input: {
      availableScopes: HubConcernScope[];
      defaultScope: HubConcernScope;
    },
  ): HubConcernPolicy {
    requireTic(actor);
    if (
      !Array.isArray(input.availableScopes) ||
      input.availableScopes.length < 1 ||
      input.availableScopes.length > 3 ||
      !input.availableScopes.every(isHubConcernScope) ||
      new Set(input.availableScopes).size !== input.availableScopes.length ||
      !isHubConcernScope(input.defaultScope) ||
      !input.availableScopes.includes(input.defaultScope)
    ) {
      throw new TypeError(
        "Choose at least one concern route and an available default.",
      );
    }
    const updatedAt = new Date().toISOString();
    this.database.transaction(() => {
      const previous = this.readHubConcernPolicy();
      this.database
        .query(
          `UPDATE hub_concern_routing
           SET available_scopes = ?, default_scope = ?, updated_at = ?,
               updated_by_staff_id = ?
           WHERE id = 1`,
        )
        .run(
          JSON.stringify(input.availableScopes),
          input.defaultScope,
          updatedAt,
          actor.staffId,
        );
      this.appendAuditEvent("hub_concern_routing_policy_changed", actor, {
        previousAvailableScopes: previous.availableScopes,
        previousDefaultScope: previous.defaultScope,
        availableScopes: input.availableScopes,
        defaultScope: input.defaultScope,
      });
    })();
    return this.readHubConcernPolicy();
  }

  createHubConcern(
    actor: StaffActor,
    input: {
      visitId: string;
      note: string;
      scope: HubConcernScope;
      recipientIds: string[];
    },
  ): HubMailMessage {
    const note = input.note.trim();
    if (
      note.length < 1 ||
      note.length > 2000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)
    ) {
      throw new TypeError(
        "Concern notes must be 1 to 2000 characters without control characters.",
      );
    }

    const stored = this.read();
    if (!stored) throw new RecordNotFoundError();
    const visit = snapshotArray(stored.snapshot.hubVisits).find(
      (item) => item.id === input.visitId,
    );
    if (
      !visit ||
      visit.source !== "classroom-notification" ||
      visit.hasConcern !== true ||
      typeof visit.studentId !== "string" ||
      typeof visit.studentName !== "string" ||
      typeof visit.destinationLabel !== "string" ||
      !isRecord(visit.notifiedBy) ||
      visit.notifiedBy.staffId !== actor.staffId
    ) {
      throw new RolePermissionError();
    }
    const alreadySaved = this.database
      .query(
        `SELECT concern_id AS id, sender_staff_id AS senderStaffId
         FROM hub_concerns WHERE hub_visit_id = ?`,
      )
      .get<{ id: string; senderStaffId: string }>(input.visitId);
    if (alreadySaved) {
      if (alreadySaved.senderStaffId !== actor.staffId) {
        throw new RolePermissionError();
      }
      const prior = this.listHubMail(actor).messages.find(
        (message) => message.id === alreadySaved.id,
      );
      if (!prior) throw new StateIntegrityError();
      return prior;
    }
    if (!this.readHubConcernPolicy().availableScopes.includes(input.scope)) {
      throw new TypeError("That concern route is not enabled by TIC policy.");
    }

    const recipientIds = [...new Set(input.recipientIds)];
    if (
      recipientIds.length !== input.recipientIds.length ||
      recipientIds.length > 200 ||
      !recipientIds.every(isValidPreferenceId)
    ) {
      throw new TypeError("Choose valid authorised staff recipients.");
    }

    const allRecipients = this.listMailRecipients();
    let recipients: HubMailRecipient[];
    if (input.scope === "tic") {
      if (recipientIds.length) {
        throw new TypeError("TIC-only concerns do not accept a custom list.");
      }
      recipients = allRecipients.filter((profile) => profile.role === "tic");
    } else if (input.scope === "all-staff") {
      if (recipientIds.length) {
        throw new TypeError("All-staff concerns do not accept a custom list.");
      }
      recipients = allRecipients;
    } else if (input.scope === "selected") {
      if (!recipientIds.length) {
        throw new TypeError("Choose at least one authorised staff recipient.");
      }
      const byId = new Map(allRecipients.map((profile) => [profile.staffId, profile]));
      recipients = recipientIds.map((id) => {
        const recipient = byId.get(id);
        if (!recipient) throw new TypeError("A selected staff profile is unavailable.");
        return recipient;
      });
    } else {
      throw new TypeError("Choose a valid concern routing scope.");
    }
    if (!recipients.length) {
      throw new TypeError("No staff profiles are available for this routing choice.");
    }

    const concernId = randomUUID();
    const submittedAt = new Date().toISOString();
    const savedConcernId = this.database.transaction(() => {
      const existing = this.database
        .query(
          `SELECT concern_id AS id, sender_staff_id AS senderStaffId
           FROM hub_concerns WHERE hub_visit_id = ?`,
        )
        .get<{ id: string; senderStaffId: string }>(input.visitId);
      if (existing) {
        if (existing.senderStaffId !== actor.staffId) {
          throw new RolePermissionError();
        }
        return existing.id;
      }

      this.database
        .query(
          `INSERT INTO hub_concerns
             (concern_id, hub_visit_id, student_id, student_name, destination_label,
              sender_staff_id, sender_display_name, routing_scope, note, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          concernId,
          input.visitId,
          String(visit.studentId),
          String(visit.studentName),
          String(visit.destinationLabel),
          actor.staffId,
          actor.displayName,
          input.scope,
          note,
          submittedAt,
        );
      const insertRecipient = this.database.query(
        `INSERT INTO hub_concern_recipients
           (concern_id, staff_profile_id, staff_display_name, staff_role)
         VALUES (?, ?, ?, ?)`,
      );
      for (const recipient of recipients) {
        insertRecipient.run(
          concernId,
          recipient.staffId,
          recipient.displayName,
          recipient.role,
        );
      }
      this.appendAuditEvent("hub_concern_sent", actor, {
        concernId,
        hubVisitId: input.visitId,
        studentId: visit.studentId,
        routingScope: input.scope,
        recipientStaffIds: recipients.map((recipient) => recipient.staffId),
      });
      return concernId;
    })();

    const message = this.listHubMail(actor).messages.find(
      (item) => item.id === savedConcernId,
    );
    if (!message) throw new StateIntegrityError();
    return message;
  }

  listHubMail(actor: StaffActor): {
    messages: HubMailMessage[];
    unreadCount: number;
  } {
    const rows = this.database
      .query(
        `SELECT c.concern_id AS id, c.hub_visit_id AS visitId,
                c.student_id AS studentId, c.student_name AS studentName,
                c.destination_label AS destinationLabel,
                c.sender_staff_id AS senderStaffId,
                c.sender_display_name AS senderDisplayName,
                c.routing_scope AS scope, c.note, c.submitted_at AS submittedAt
                , a.archived_at AS archivedAt
         FROM hub_concerns c
         LEFT JOIN hub_mail_archives a ON a.concern_id = c.concern_id
         WHERE (c.sender_staff_id = ?
            OR EXISTS (
              SELECT 1 FROM hub_concern_recipients r
              WHERE r.concern_id = c.concern_id AND r.staff_profile_id = ?
            )
            OR ? = 'tic')
           AND (? = 'tic' OR a.archived_at IS NULL)
         ORDER BY c.submitted_at DESC, c.concern_id`,
      )
      .all<Omit<HubMailMessage, "recipients" | "isSender" | "isRecipient" | "isTicOversight" | "readAt" | "replies">>(
        actor.staffId,
        actor.staffId,
        actor.role,
        actor.role,
      );
    const messages = rows.map((row): HubMailMessage => {
      const recipients = this.database
        .query(
          `SELECT staff_profile_id AS staffId,
                  staff_display_name AS displayName, staff_role AS role
           FROM hub_concern_recipients
           WHERE concern_id = ? ORDER BY staff_display_name COLLATE NOCASE`,
        )
        .all<HubMailRecipient>(row.id);
      const isSender = row.senderStaffId === actor.staffId;
      const recipient = this.database
        .query(
          `SELECT read_at AS readAt FROM hub_concern_recipients
           WHERE concern_id = ? AND staff_profile_id = ?`,
        )
        .get<{ readAt: string | null }>(row.id, actor.staffId);
      const isRecipient = !!recipient;
      const replies = this.database.query(`SELECT reply_id AS id, sender_staff_id AS senderStaffId, sender_display_name AS senderDisplayName, note, submitted_at AS submittedAt FROM hub_mail_replies WHERE concern_id = ? ORDER BY submitted_at, reply_id`).all<HubMailReply>(row.id);
      return {
        ...row,
        recipients,
        isSender,
        isRecipient,
        isTicOversight: actor.role === "tic" && !isSender && !isRecipient,
        readAt: recipient?.readAt ?? null,
        replies,
      };
    });
    const unreadCount =
      this.database
        .query(
          `SELECT COUNT(*) AS count FROM hub_concern_recipients
           WHERE staff_profile_id = ? AND read_at IS NULL`,
        )
        .get<{ count: number }>(actor.staffId)?.count ?? 0;
    return { messages, unreadCount };
  }

  setHubMailArchived(actor: StaffActor, concernId: string, archived: boolean) {
    requireTic(actor);
    const message = this.listHubMail(actor).messages.find((item) => item.id === concernId);
    if (!message) throw new RecordNotFoundError();
    this.database.transaction(() => {
      if (archived) {
        this.database.query(`INSERT OR REPLACE INTO hub_mail_archives (concern_id, archived_by_staff_id, archived_at) VALUES (?, ?, ?)`).run(concernId, actor.staffId, new Date().toISOString());
      } else {
        this.database.query(`DELETE FROM hub_mail_archives WHERE concern_id = ?`).run(concernId);
      }
      this.appendAuditEvent(archived ? "hub_mail_archived" : "hub_mail_unarchived", actor, { concernId });
    })();
    return { archived };
  }

  markHubMailRead(
    actor: StaffActor,
    concernId: string,
  ): { readAt: string } {
    return this.database.transaction(() => {
      const row = this.database
        .query(
          `SELECT read_at AS readAt FROM hub_concern_recipients
           WHERE concern_id = ? AND staff_profile_id = ?`,
        )
        .get<{ readAt: string | null }>(concernId, actor.staffId);
      if (!row) throw new RecordNotFoundError();
      if (row.readAt) return { readAt: row.readAt };

      const readAt = new Date().toISOString();
      this.database
        .query(
          `UPDATE hub_concern_recipients SET read_at = ?
           WHERE concern_id = ? AND staff_profile_id = ? AND read_at IS NULL`,
        )
        .run(readAt, concernId, actor.staffId);
      this.appendAuditEvent("hub_concern_read", actor, { concernId });
      return { readAt };
    })();
  }

  createHubMailReply(actor: StaffActor, concernId: string, rawNote: string) {
    const note = rawNote.trim();
    if (note.length < 1 || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
      throw new TypeError("Replies must be 1 to 2000 characters.");
    }
    const parent = this.listHubMail(actor).messages.find((message) => message.id === concernId);
    if (!parent) throw new RolePermissionError();
    const reply = { id: randomUUID(), senderStaffId: actor.staffId, senderDisplayName: actor.displayName, note, submittedAt: new Date().toISOString() };
    this.database.transaction(() => {
      this.database.query(`INSERT INTO hub_mail_replies (reply_id, concern_id, sender_staff_id, sender_display_name, note, submitted_at) VALUES (?, ?, ?, ?, ?, ?)`).run(reply.id, concernId, actor.staffId, actor.displayName, note, reply.submittedAt);
      this.appendAuditEvent("hub_mail_reply_sent", actor, { concernId, replyId: reply.id });
    })();
    return reply;
  }

  listInvitations(actor: StaffActor): StaffInvitationView[] {
    requireTic(actor);
    const now = Date.now();
    return this.database
      .query(
        `SELECT id, role, staff_profile_id, created_by_staff_id, created_by_display_name,
                invited_email, created_at, expires_at, consumed_at, revoked_at
         FROM staff_invitations ORDER BY created_at DESC`,
      )
      .all<
        Omit<
          InvitationRow,
          "token_hash" | "created_by_role" | "consumed_session_id" | "bootstrap"
        >
      >()
      .map((row) => ({
        id: row.id,
        role: row.role,
        staffProfileId: row.staff_profile_id,
        createdByStaffId: row.created_by_staff_id,
        createdByDisplayName: row.created_by_display_name,
        invitedEmail: row.invited_email,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
        revokedAt: row.revoked_at,
        status: invitationStatus(row, now),
      }));
  }

  revokeSession(
    sessionId: string,
    actor: StaffActor,
    eventType = "staff_session_revoked",
  ) {
    if (actor.role !== "tic" && actor.sessionId !== sessionId) {
      throw new RolePermissionError();
    }
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      const row = this.database
        .query(
          `SELECT s.id AS session_id, p.id AS staff_id, p.display_name, s.role
           FROM staff_sessions s JOIN staff_profiles p ON p.id = s.staff_profile_id WHERE s.id = ?`,
        )
        .get<
          Pick<SessionRow, "session_id" | "staff_id" | "display_name" | "role">
        >(sessionId);
      if (!row) throw new RecordNotFoundError();
      const changed = this.database
        .query(
          "UPDATE staff_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(now, sessionId) as { changes?: number };
      if ((changed.changes ?? 0) > 0) {
        this.appendAuditEvent(
          eventType,
          actor,
          { targetRole: row.role },
          { staffId: row.staff_id, sessionId },
        );
      }
      return (changed.changes ?? 0) > 0;
    })();
  }

  revokeAllSessions(actor: StaffActor) {
    requireTic(actor);
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      const rows = this.database
        .query("SELECT id FROM staff_sessions WHERE revoked_at IS NULL")
        .all<{ id: string }>();
      this.database
        .query(
          "UPDATE staff_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
        )
        .run(now);
      this.appendAuditEvent("all_staff_sessions_revoked", actor, {
        sessionCount: rows.length,
      });
      return rows.length;
    })();
  }

  revokeInvitation(invitationId: string, actor: StaffActor) {
    requireTic(actor);
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      const row = this.database
        .query(
          "SELECT role, staff_profile_id FROM staff_invitations WHERE id = ?",
        )
        .get<{ role: StaffRole; staff_profile_id: string | null }>(
          invitationId,
        );
      if (!row) throw new RecordNotFoundError();
      const changed = this.database
        .query(
          "UPDATE staff_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND consumed_at IS NULL",
        )
        .run(now, invitationId) as { changes?: number };
      if ((changed.changes ?? 0) > 0) {
        this.appendAuditEvent("staff_invitation_revoked", actor, {
          invitationId,
          role: row.role,
          staffProfileId: row.staff_profile_id,
        });
      }
      return (changed.changes ?? 0) > 0;
    })();
  }

  renameProfile(staffId: string, displayName: string, actor: StaffActor) {
    if (actor.role !== "tic" && actor.staffId !== staffId) {
      throw new RolePermissionError();
    }
    const safeName = normalizeDisplayName(displayName);
    const now = new Date().toISOString();
    return this.database.transaction(() => {
      const profile = this.getProfile(staffId);
      if (!profile) throw new RecordNotFoundError();
      this.database
        .query("UPDATE staff_profiles SET display_name = ? WHERE id = ?")
        .run(safeName, staffId);
      this.appendAuditEvent(
        "staff_display_name_changed",
        actor,
        { previousDisplayName: profile.display_name, displayName: safeName },
        { staffId },
      );
      return { staffId, displayName: safeName, updatedAt: now };
    })();
  }

  listAuditEvents(actor: StaffActor, limit = 100) {
    requireTic(actor);
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.database
      .query(
        `SELECT event_id, event_type, occurred_at, actor_staff_id,
                actor_display_name, actor_role, actor_session_id,
                target_staff_id, target_session_id, details_json
         FROM host_audit_events ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
      )
      .all<{
        event_id: string;
        event_type: string;
        occurred_at: string;
        actor_staff_id: string | null;
        actor_display_name: string | null;
        actor_role: StaffRole | null;
        actor_session_id: string | null;
        target_staff_id: string | null;
        target_session_id: string | null;
        details_json: string;
      }>(safeLimit)
      .map((event) => ({
        eventId: event.event_id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        actorStaffId: event.actor_staff_id,
        actorDisplayName: event.actor_display_name,
        actorRole: event.actor_role,
        actorSessionId: event.actor_session_id,
        targetStaffId: event.target_staff_id,
        targetSessionId: event.target_session_id,
        details: JSON.parse(event.details_json) as Record<string, unknown>,
      }));
  }

  recordAdministrativeEvent(
    eventType: string,
    actor: StaffActor,
    details: Record<string, unknown>,
  ) {
    requireTic(actor);
    this.database.transaction(() => {
      this.appendAuditEvent(eventType, actor, details);
    })();
  }

  close() {
    this.database.close();
  }

  private insertInvitation(options: {
    role: StaffRole;
    staffProfileId: string | null;
    actor: StaffActor | null;
    invitedEmail?: string | null;
    createdAt: string;
    expiresAt: string;
    bootstrap: boolean;
  }): IssuedInvitation {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.database
      .query(
        `INSERT INTO staff_invitations
           (id, token_hash, role, staff_profile_id, created_by_staff_id,
           created_by_display_name, created_by_role, invited_email, created_at, expires_at, bootstrap)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hashToken(token),
        options.role,
        options.staffProfileId,
        options.actor?.staffId ?? null,
        options.actor?.displayName ?? null,
        options.actor?.role ?? null,
        options.invitedEmail ?? null,
        options.createdAt,
        options.expiresAt,
        options.bootstrap ? 1 : 0,
      );
    return {
      id,
      token,
      role: options.role,
      invitedEmail: options.invitedEmail ?? null,
      staffProfileId: options.staffProfileId,
      createdByStaffId: options.actor?.staffId ?? null,
      createdByDisplayName: options.actor?.displayName ?? null,
      createdAt: options.createdAt,
      expiresAt: options.expiresAt,
      consumedAt: null,
      revokedAt: null,
      status: "pending",
    };
  }

  private getProfile(staffId: string) {
    return this.database
      .query(
        "SELECT id, display_name, auth_method, entra_tenant_id, entra_object_id, role FROM staff_profiles WHERE id = ?",
      )
      .get<ProfileRow>(staffId);
  }

  private findUsableInvitation(token: string) {
    if (token.length < 32 || token.length > 128) return null;
    const row = this.database
      .query("SELECT * FROM staff_invitations WHERE token_hash = ?")
      .get<InvitationRow>(hashToken(token));
    return row &&
      !row.revoked_at &&
      !row.consumed_at &&
      Date.parse(row.expires_at) > Date.now()
      ? row
      : null;
  }

  private createPreMigrationBackup(fromSchemaVersion: number) {
    mkdirSync(this.migrationBackupDirectory, { recursive: true });
    const createdAt = new Date().toISOString();
    const backupId = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const fileName = `pre-migration-v${fromSchemaVersion}-to-v${databaseSchemaVersion}-${backupId}.sqlite${this.backupEncryptionKey ? ".enc" : ""}`;
    const targetPath = resolve(this.migrationBackupDirectory, fileName);
    const temporaryPath = `${targetPath}.${randomUUID()}.database.partial`;
    const encryptedTemporaryPath = `${targetPath}.${randomUUID()}.partial`;
    const sourceState = this.database
      .query(
        "SELECT revision, saved_at, snapshot_json, checksum FROM hub_state WHERE id = 1",
      )
      .get<{
        revision: number;
        saved_at: string;
        snapshot_json: string;
        checksum: string;
      }>();

    try {
      this.database.exec(
        `VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`,
      );
      const backupDatabase = new Database(temporaryPath, { readonly: true });
      try {
        const integrity = backupDatabase
          .query("PRAGMA integrity_check")
          .get<{ integrity_check: string }>()?.integrity_check;
        if (integrity !== "ok") {
          throw new Error(
            "Pre-migration backup failed SQLite integrity_check.",
          );
        }
      } finally {
        backupDatabase.close();
      }

      const databaseChecksum = createHash("sha256")
        .update(readFileSync(temporaryPath))
        .digest("hex");
      let backupFileChecksum = databaseChecksum;
      if (this.backupEncryptionKey) {
        encryptBackupFileSync(
          temporaryPath,
          encryptedTemporaryPath,
          this.backupEncryptionKey,
        );
        backupFileChecksum = createHash("sha256")
          .update(readFileSync(encryptedTemporaryPath))
          .digest("hex");
        renameSync(encryptedTemporaryPath, targetPath);
        rmSync(temporaryPath, { force: true });
      } else {
        renameSync(temporaryPath, targetPath);
      }
      const manifest = {
        formatVersion: 1,
        application: "happy-hallways-hub",
        kind: "pre_migration",
        schemaVersion: fromSchemaVersion,
        backupId,
        fileName,
        createdAt,
        revision: sourceState?.revision ?? 0,
        dataRange: {
          earliest: sourceState?.saved_at ?? null,
          latest: sourceState?.saved_at ?? null,
        },
        recordCounts: { hub_state: sourceState ? 1 : 0 },
        fromSchemaVersion,
        toSchemaVersion: databaseSchemaVersion,
        sourceRevision: sourceState?.revision ?? null,
        sourceSavedAt: sourceState?.saved_at ?? null,
        sourceSnapshotChecksum: sourceState?.checksum ?? null,
        databaseSha256: databaseChecksum,
        backupFileSha256: backupFileChecksum,
        encrypted: Boolean(this.backupEncryptionKey),
        encryptionKeyId: this.backupEncryptionKey
          ? backupEncryptionKeyId(this.backupEncryptionKey)
          : null,
        integrityCheck: "ok",
      };
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
    } catch (error) {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
      if (existsSync(encryptedTemporaryPath)) {
        rmSync(encryptedTemporaryPath, { force: true });
      }
      throw error;
    }
  }

  private appendAuditEvent(
    eventType: string,
    actor: StaffActor | null,
    details: Record<string, unknown>,
    target: { staffId?: string; sessionId?: string } = {},
  ) {
    this.database
      .query(
        `INSERT INTO host_audit_events
           (event_id, event_type, occurred_at, actor_staff_id, actor_display_name,
            actor_role, actor_session_id, target_staff_id, target_session_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        eventType,
        new Date().toISOString(),
        actor?.staffId ?? null,
        actor?.displayName ?? null,
        actor?.role ?? null,
        actor?.sessionId ?? null,
        target.staffId ?? null,
        target.sessionId ?? null,
        JSON.stringify(details),
      );
  }

  private commitHubKioskSnapshot(
    previous: StoredSnapshot,
    snapshot: StateSnapshot,
    kioskSessionId: string,
    eventType: string,
    details: Record<string, unknown>,
  ): StoredSnapshot {
    const snapshotJson = JSON.stringify(snapshot);
    if (typeof snapshotJson !== "string") {
      throw new TypeError("snapshot could not be encoded as JSON.");
    }
    const checksum = checksumOf(snapshotJson);
    const savedAt = new Date().toISOString();
    const revision = previous.revision + 1;
    this.database
      .query(
        `UPDATE hub_state
         SET schema_version = ?, revision = ?, saved_at = ?, snapshot_json = ?, checksum = ?
         WHERE id = 1`,
      )
      .run(databaseSchemaVersion, revision, savedAt, snapshotJson, checksum);
    this.insertRevision(
      revision,
      savedAt,
      snapshotJson,
      checksum,
      null,
      "saved",
    );
    this.appendAuditEvent(eventType, null, {
      ...details,
      source: "student-kiosk",
      kioskSessionId,
    });
    this.appendAuditEvent("host_snapshot_saved", null, {
      revision,
      basedOnRevision: previous.revision,
      mergeMode: "direct",
      previousChecksum: previous.checksum,
      checksum,
      source: "student-kiosk",
      kioskSessionId,
    });
    return { revision, savedAt, checksum, snapshot };
  }

  private commitStaffSnapshot(
    previous: StoredSnapshot,
    snapshot: StateSnapshot,
    actor: StaffActor,
    eventType: string,
    details: Record<string, unknown>,
  ): StoredSnapshot {
    const snapshotJson = JSON.stringify(snapshot);
    if (typeof snapshotJson !== "string") {
      throw new TypeError("snapshot could not be encoded as JSON.");
    }
    const checksum = checksumOf(snapshotJson);
    const savedAt = new Date().toISOString();
    const revision = previous.revision + 1;
    this.database
      .query(
        `UPDATE hub_state
         SET schema_version = ?, revision = ?, saved_at = ?, snapshot_json = ?, checksum = ?
         WHERE id = 1`,
      )
      .run(databaseSchemaVersion, revision, savedAt, snapshotJson, checksum);
    this.insertRevision(revision, savedAt, snapshotJson, checksum, actor, "saved");
    this.appendAuditEvent(eventType, actor, details);
    this.appendAuditEvent("host_snapshot_saved", actor, {
      revision,
      basedOnRevision: previous.revision,
      mergeMode: "direct",
      previousChecksum: previous.checksum,
      checksum,
      source: "staff-operation",
    });
    return { revision, savedAt, checksum, snapshot };
  }

  private insertRevision(
    revision: number,
    savedAt: string,
    snapshotJson: string,
    checksum: string,
    actor: StaffActor | null,
    changeType: "saved" | "restored" | "imported",
  ) {
    this.database
      .query(
        `INSERT INTO hub_state_revisions
           (revision, saved_at, snapshot_gzip, checksum, actor_staff_id, actor_display_name, actor_role, change_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision,
        savedAt,
        gzipSync(snapshotJson),
        checksum,
        actor?.staffId ?? null,
        actor?.displayName ?? null,
        actor?.role ?? null,
        changeType,
      );
  }

  private fromRow(row: StoredRow): StoredSnapshot {
    if (
      row.schema_version !== databaseSchemaVersion ||
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

  private migrate() {
    let currentVersion =
      this.database.query("PRAGMA user_version").get<{ user_version: number }>()
        ?.user_version ?? 0;
    if (currentVersion > databaseSchemaVersion) {
      throw new Error(
        `Database schema ${currentVersion} is newer than this host supports (${databaseSchemaVersion}).`,
      );
    }

    if (currentVersion < 1) {
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
          PRAGMA user_version = 1;
        `);
      })();
      currentVersion = 1;
    }

    if (currentVersion < 2) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS staff_profiles (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            auth_method TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS staff_invitations (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('ea', 'tic')),
            staff_profile_id TEXT REFERENCES staff_profiles(id),
            created_by_staff_id TEXT,
            created_by_display_name TEXT,
            created_by_role TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            consumed_session_id TEXT,
            revoked_at TEXT,
            bootstrap INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap IN (0, 1))
          );
          CREATE INDEX IF NOT EXISTS staff_invitations_expiry
            ON staff_invitations (expires_at, consumed_at, revoked_at);
          CREATE TABLE IF NOT EXISTS staff_sessions (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id),
            role TEXT NOT NULL CHECK (role IN ('ea', 'tic')),
            auth_method TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE INDEX IF NOT EXISTS staff_sessions_expiry
            ON staff_sessions (expires_at, revoked_at);
          CREATE TABLE IF NOT EXISTS host_audit_events (
            event_id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            actor_staff_id TEXT,
            actor_display_name TEXT,
            actor_role TEXT,
            actor_session_id TEXT,
            target_staff_id TEXT,
            target_session_id TEXT,
            details_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS host_audit_events_time
            ON host_audit_events (occurred_at);
          UPDATE hub_state SET schema_version = 2 WHERE schema_version = 1;
          PRAGMA user_version = 2;
        `);
      })();
    }

    if (currentVersion < 3) {
      this.database.transaction(() => {
        this.database.exec(`
          ALTER TABLE staff_profiles ADD COLUMN entra_tenant_id TEXT;
          ALTER TABLE staff_profiles ADD COLUMN entra_object_id TEXT;
          ALTER TABLE staff_profiles ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('ea', 'tic'));
          ALTER TABLE staff_invitations ADD COLUMN invited_email TEXT;
          UPDATE staff_profiles
            SET role = (
              SELECT s.role FROM staff_sessions s
              WHERE s.staff_profile_id = staff_profiles.id
              ORDER BY s.created_at ASC LIMIT 1
            )
            WHERE role IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS staff_profiles_entra_identity
            ON staff_profiles (entra_tenant_id, entra_object_id)
            WHERE entra_tenant_id IS NOT NULL AND entra_object_id IS NOT NULL;
          CREATE TABLE IF NOT EXISTS entra_auth_states (
            state_hash TEXT PRIMARY KEY,
            nonce TEXT NOT NULL,
            invitation_id TEXT REFERENCES staff_invitations(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS entra_auth_states_expiry ON entra_auth_states (expires_at);
          UPDATE hub_state SET schema_version = 3 WHERE schema_version = 2;
          PRAGMA user_version = 3;
        `);
      })();
      currentVersion = 3;
    }

    if (currentVersion < 4) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS hub_state_revisions (
            revision INTEGER PRIMARY KEY CHECK (revision > 0),
            saved_at TEXT NOT NULL,
            snapshot_gzip BLOB NOT NULL,
            checksum TEXT NOT NULL,
            actor_staff_id TEXT,
            actor_display_name TEXT,
            actor_role TEXT CHECK (actor_role IS NULL OR actor_role IN ('ea', 'tic')),
            change_type TEXT NOT NULL CHECK (change_type IN ('saved', 'restored', 'imported'))
          );
          CREATE INDEX IF NOT EXISTS hub_state_revisions_saved_at
            ON hub_state_revisions (saved_at);
        `);
        const current = this.database
          .query(
            "SELECT revision, saved_at, snapshot_json, checksum FROM hub_state WHERE id = 1",
          )
          .get<StoredRow>();
        if (current) {
          const priorEvents = this.database
            .query(
              `SELECT actor_staff_id, actor_display_name, actor_role, details_json
               FROM host_audit_events WHERE event_type = 'host_snapshot_saved'
               ORDER BY rowid DESC`,
            )
            .all<{
              actor_staff_id: string | null;
              actor_display_name: string | null;
              actor_role: StaffRole | null;
              details_json: string;
            }>();
          const priorActor = priorEvents.find((event) => {
            try {
              const details = JSON.parse(event.details_json) as {
                revision?: number;
              };
              return details.revision === current.revision;
            } catch {
              return false;
            }
          });
          this.database
            .query(
              `INSERT OR IGNORE INTO hub_state_revisions
                 (revision, saved_at, snapshot_gzip, checksum, actor_staff_id, actor_display_name, actor_role, change_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'saved')`,
            )
            .run(
              current.revision,
              current.saved_at,
              gzipSync(current.snapshot_json),
              current.checksum,
              priorActor?.actor_staff_id ?? null,
              priorActor?.actor_display_name ?? null,
              priorActor?.actor_role ?? null,
            );
        }
        this.database.exec(
          "UPDATE hub_state SET schema_version = 4 WHERE schema_version = 3; PRAGMA user_version = 4;",
        );
      })();
    }

    if (currentVersion < 5) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS staff_preferences (
            staff_profile_id TEXT PRIMARY KEY REFERENCES staff_profiles(id),
            favourite_student_ids TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
          );
          UPDATE hub_state SET schema_version = 5 WHERE schema_version = 4;
          PRAGMA user_version = 5;
        `);
      })();
    }

    if (currentVersion < 6) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS hub_concerns (
            concern_id TEXT PRIMARY KEY,
            hub_visit_id TEXT NOT NULL UNIQUE,
            student_id TEXT NOT NULL,
            student_name TEXT NOT NULL,
            destination_label TEXT NOT NULL,
            sender_staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
            sender_display_name TEXT NOT NULL,
            routing_scope TEXT NOT NULL CHECK (routing_scope IN ('tic', 'all-staff', 'selected')),
            note TEXT NOT NULL,
            submitted_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS hub_concerns_submitted_at
            ON hub_concerns (submitted_at);
          CREATE TABLE IF NOT EXISTS hub_concern_recipients (
            concern_id TEXT NOT NULL REFERENCES hub_concerns(concern_id),
            staff_profile_id TEXT NOT NULL REFERENCES staff_profiles(id),
            staff_display_name TEXT NOT NULL,
            staff_role TEXT NOT NULL CHECK (staff_role IN ('ea', 'tic')),
            read_at TEXT,
            PRIMARY KEY (concern_id, staff_profile_id)
          );
          CREATE INDEX IF NOT EXISTS hub_concern_recipients_unread
            ON hub_concern_recipients (staff_profile_id, read_at);
          CREATE TABLE IF NOT EXISTS hub_concern_routing (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            available_scopes TEXT NOT NULL,
            default_scope TEXT NOT NULL CHECK (default_scope IN ('tic', 'all-staff', 'selected')),
            updated_at TEXT NOT NULL,
            updated_by_staff_id TEXT REFERENCES staff_profiles(id)
          );
          UPDATE hub_state SET schema_version = 6 WHERE schema_version = 5;
          PRAGMA user_version = 6;
        `);
        this.database
          .query(
            `INSERT OR IGNORE INTO hub_concern_routing
               (id, available_scopes, default_scope, updated_at)
             VALUES (1, ?, 'tic', ?)`,
          )
          .run(
            JSON.stringify(["tic", "all-staff", "selected"]),
            new Date().toISOString(),
          );
      })();
      currentVersion = 6;
    }

    if (currentVersion < 7) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS hub_kiosk_tickets (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            created_by_staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            revoked_at TEXT
          );
          CREATE INDEX IF NOT EXISTS hub_kiosk_tickets_expiry
            ON hub_kiosk_tickets (expires_at, consumed_at, revoked_at);
          CREATE TABLE IF NOT EXISTS hub_kiosk_sessions (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            created_by_staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT
          );
          CREATE INDEX IF NOT EXISTS hub_kiosk_sessions_expiry
            ON hub_kiosk_sessions (expires_at, revoked_at);
          UPDATE hub_state SET schema_version = 7 WHERE schema_version = 6;
          PRAGMA user_version = 7;
        `);
      })();
      currentVersion = 7;
    }

    if (currentVersion < 8) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS hub_mail_replies (
            reply_id TEXT PRIMARY KEY,
            concern_id TEXT NOT NULL REFERENCES hub_concerns(concern_id),
            sender_staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
            sender_display_name TEXT NOT NULL,
            note TEXT NOT NULL,
            submitted_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS hub_mail_replies_thread
            ON hub_mail_replies (concern_id, submitted_at);
          UPDATE hub_state SET schema_version = 8 WHERE schema_version = 7;
          PRAGMA user_version = 8;
        `);
      })();
      currentVersion = 8;
    }

    if (currentVersion < 9) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS hub_mail_archives (
            concern_id TEXT PRIMARY KEY REFERENCES hub_concerns(concern_id),
            archived_by_staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
            archived_at TEXT NOT NULL
          );
          UPDATE hub_state SET schema_version = 9 WHERE schema_version = 8;
          PRAGMA user_version = 9;
        `);
      })();
    }
  }
}

function sessionView(row: SessionRow): StaffSessionView {
  return {
    sessionId: row.session_id,
    staffId: row.staff_id,
    displayName: row.display_name,
    role: row.role,
    authMethod: row.auth_method,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function invitationStatus(
  invitation: Pick<InvitationRow, "expires_at" | "consumed_at" | "revoked_at">,
  now: number,
): StaffInvitationView["status"] {
  if (invitation.revoked_at) return "revoked";
  if (invitation.consumed_at) return "consumed";
  if (Date.parse(invitation.expires_at) <= now) return "expired";
  return "pending";
}

function requireTic(actor: StaffActor) {
  if (actor.role !== "tic") throw new RolePermissionError();
}

function isHubConcernScope(value: unknown): value is HubConcernScope {
  return value === "tic" || value === "all-staff" || value === "selected";
}

function isValidPreferenceId(id: string) {
  return id.length > 0 && id.length <= 128 && id.trim() === id;
}

function isStaffRole(value: unknown): value is StaffRole {
  return value === "ea" || value === "tic";
}

function normalizeDisplayName(value: string) {
  const name = value.trim();
  if (
    name.length < 1 ||
    name.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new TypeError(
      "Display name must be 1 to 80 characters without control characters.",
    );
  }
  return name;
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError("Enter a valid staff email address.");
  }
  return email;
}

function isRecord(value: unknown): value is StateSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checksumOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function changedTopLevelFields(before: StateSnapshot, after: StateSnapshot) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !deepEqualJson(before[key], after[key]));
}

function validateAndAttributeEaHubVisitNotifications(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const beforeVisits = snapshotArray(before.hubVisits);
  const afterVisits = snapshotArray(after.hubVisits);
  const beforeById = indexHubVisits(beforeVisits);
  const afterById = indexHubVisits(afterVisits);
  const created: Record<string, unknown>[] = [];
  const arrived: Record<string, unknown>[] = [];
  const departed: Record<string, unknown>[] = [];
  const returned: Record<string, unknown>[] = [];
  const cancelled: Record<string, unknown>[] = [];

  if (beforeById.size !== beforeVisits.length || afterById.size !== afterVisits.length) {
    throw new RolePermissionError();
  }
  for (const [id, prior] of beforeById) {
    const updated = afterById.get(id);
    if (!updated) {
      throw new RolePermissionError();
    }
    if (deepEqualJson(prior, updated)) continue;

    if (hubVisitArrivalChanged(prior, updated)) {
      arrived.push(attributeHubVisitArrival(prior, updated, actor));
      continue;
    }

    if (hubVisitDepartureChanged(prior, updated)) {
      departed.push(attributeHubVisitDeparture(prior, updated, actor));
      continue;
    }

    if (hubVisitCancellationChanged(prior, updated)) {
      cancelled.push(
        attributeHubVisitCancellation(prior, updated, after, actor),
      );
      continue;
    }

    const expected = { ...prior };
    const actual = { ...updated };
    delete expected.arrivedBackAtClassAt;
    delete expected.returnedBy;
    delete actual.arrivedBackAtClassAt;
    delete actual.returnedBy;
    const cls = snapshotArray(after.classes).find(
      (item) => item.id === prior.classId,
    );
    const classIsActive =
      isRecord(after.activeClass) &&
      after.activeClass.id === prior.classId &&
      snapshotArray(cls?.members).some(
        (member) =>
          member.studentId === prior.studentId && member.status === "current",
      );
    const trips = Array.isArray(prior.temporaryTrips)
      ? prior.temporaryTrips.filter(isRecord)
      : [];
    const returnTime = new Date();
    if (
      !deepEqualJson(expected, actual) ||
      typeof prior.arrivedAtHubAt !== "string" ||
      typeof prior.leftHubAt !== "string" ||
      prior.arrivedBackAtClassAt ||
      !isCanonicalTimestamp(prior.arrivedAtHubAt) ||
      !isCanonicalTimestamp(prior.leftHubAt) ||
      typeof updated.arrivedBackAtClassAt !== "string" ||
      !isCanonicalTimestamp(updated.arrivedBackAtClassAt) ||
      Date.parse(prior.leftHubAt) < Date.parse(prior.arrivedAtHubAt) ||
      Date.parse(updated.arrivedBackAtClassAt) < Date.parse(prior.leftHubAt) ||
      returnTime.getTime() < Date.parse(prior.leftHubAt) ||
      !Array.isArray(prior.temporaryTrips) ||
      trips.length !== prior.temporaryTrips.length ||
      trips.some((trip) => !trip.returnedAt) ||
      !classIsActive
    ) {
      throw new RolePermissionError();
    }
    returned.push({
      ...updated,
      arrivedBackAtClassAt: returnTime.toISOString(),
      returnedBy: {
        staffId: actor.staffId,
        displayName: actor.displayName,
        role: actor.role,
      },
    });
  }

  const students = snapshotArray(after.roster);
  const classes = snapshotArray(after.classes);
  const destinations = snapshotArray(after.destinations);
  const categories = snapshotArray(after.studentCategories);
  const occupiedStudents = new Set(
    beforeVisits
    .filter((visit) => !visit.arrivedBackAtClassAt && !visit.cancelledAt)
      .map((visit) => visit.studentId)
      .filter((id): id is string => typeof id === "string"),
  );
  const allowedVisitFields = new Set([
    "id",
    "studentId",
    "studentName",
    "studentCategory",
    "destinationId",
    "destinationLabel",
    "classId",
    "className",
    "periodName",
    "source",
    "leftClassAt",
    "hasConcern",
    "temporaryTrips",
  ]);

  for (const visit of afterVisits) {
    if (beforeById.has(String(visit.id))) continue;
    if (
      !visit.id ||
      typeof visit.id !== "string" ||
      Object.keys(visit).some((key) => !allowedVisitFields.has(key)) ||
      visit.source !== "classroom-notification" ||
      typeof visit.studentId !== "string" ||
      typeof visit.destinationId !== "string" ||
      typeof visit.classId !== "string" ||
      typeof visit.leftClassAt !== "string" ||
      (visit.hasConcern !== undefined && visit.hasConcern !== true) ||
      !Number.isFinite(Date.parse(visit.leftClassAt)) ||
      "arrivedAtHubAt" in visit ||
      "leftHubAt" in visit ||
      "arrivedBackAtClassAt" in visit ||
      !Array.isArray(visit.temporaryTrips) ||
      visit.temporaryTrips.length !== 0
    ) {
      throw new RolePermissionError();
    }

    const student = students.find((item) => item.id === visit.studentId);
    const cls = classes.find((item) => item.id === visit.classId);
    const member = snapshotArray(cls?.members).find(
      (item) => item.studentId === visit.studentId && item.status === "current",
    );
    const destination = destinations.find(
      (item) => item.id === visit.destinationId,
    );
    if (
      !student ||
      !cls ||
      !member ||
      !isRecord(after.activeClass) ||
      after.activeClass.id !== cls.id ||
      !destination ||
      destination.informHubAvailable !== true ||
      typeof student.firstName !== "string" ||
      typeof cls.name !== "string" ||
      visit.className !== cls.name ||
      visit.destinationLabel !== destination.label ||
      !isCanonicalTimestamp(visit.leftClassAt) ||
      occupiedStudents.has(visit.studentId)
    ) {
      throw new RolePermissionError();
    }

    const expectedStudentName = student.lastName
      ? `${student.firstName} ${student.lastName}`
      : `${student.firstName}${member.lastPrefix ? ` ${member.lastPrefix}.` : ""}`;
    if (visit.studentName !== expectedStudentName) {
      throw new RolePermissionError();
    }
    const category = categories.find((item) => item.id === student.categoryId);
    if (
      category
        ? !deepEqualJson(visit.studentCategory, category)
        : "studentCategory" in visit
    ) {
      throw new RolePermissionError();
    }
    if (visit.periodName !== undefined && typeof visit.periodName !== "string") {
      throw new RolePermissionError();
    }

    occupiedStudents.add(visit.studentId);
    created.push(visit);
  }

  const createdIds = new Set(created.map((visit) => visit.id));
  const arrivedById = new Map(arrived.map((visit) => [String(visit.id), visit]));
  const departedById = new Map(
    departed.map((visit) => [String(visit.id), visit]),
  );
  const returnedById = new Map(
    returned.map((visit) => [String(visit.id), visit]),
  );
  const cancelledById = new Map(
    cancelled.map((visit) => [String(visit.id), visit]),
  );
  const visits = afterVisits.map((visit) => {
    if (createdIds.has(visit.id)) {
      return {
          ...visit,
          notifiedBy: {
            staffId: actor.staffId,
            displayName: actor.displayName,
            role: actor.role,
          },
      };
    }
    const arrival = arrivedById.get(String(visit.id));
    if (arrival) return arrival;
    const departure = departedById.get(String(visit.id));
    if (departure) return departure;
    const returnedVisit = returnedById.get(String(visit.id));
    if (returnedVisit) return returnedVisit;
    return cancelledById.get(String(visit.id)) ?? visit;
  });
  return { visits, created, arrived, departed, returned, cancelled };
}

function attributeHubVisitArrivals(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const beforeVisits = snapshotArray(before.hubVisits);
  const afterVisits = snapshotArray(after.hubVisits);
  const beforeById = indexHubVisits(beforeVisits);
  const arrived: Record<string, unknown>[] = [];
  const visits = afterVisits.map((updated) => {
    const prior = beforeById.get(String(updated.id));
    if (!prior || !hubVisitArrivalChanged(prior, updated)) return updated;
    const attributed = attributeHubVisitArrival(prior, updated, actor);
    arrived.push(attributed);
    return attributed;
  });
  return { visits, arrived };
}

function attributeHubVisitDepartures(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const beforeById = indexHubVisits(snapshotArray(before.hubVisits));
  const departed: Record<string, unknown>[] = [];
  const visits = snapshotArray(after.hubVisits).map((updated) => {
    const prior = beforeById.get(String(updated.id));
    if (!prior || !hubVisitDepartureChanged(prior, updated)) return updated;
    const attributed = attributeHubVisitDeparture(prior, updated, actor);
    departed.push(attributed);
    return attributed;
  });
  return { visits, departed };
}

function hubVisitDepartureChanged(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  return ["leftHubAt", "leftBy"].some(
    (field) => !deepEqualJson(prior[field], updated[field]),
  );
}

function attributeHubVisitDeparture(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
  actor: StaffActor,
) {
  const expected = { ...prior };
  const actual = { ...updated };
  for (const field of ["leftHubAt", "leftBy"]) {
    delete expected[field];
    delete actual[field];
  }
  const trips = Array.isArray(prior.temporaryTrips)
    ? prior.temporaryTrips.filter(isRecord)
    : [];
  const departureTime = new Date();
  if (
    !deepEqualJson(expected, actual) ||
    typeof prior.arrivedAtHubAt !== "string" ||
    !isCanonicalTimestamp(prior.arrivedAtHubAt) ||
    prior.leftHubAt ||
    prior.arrivedBackAtClassAt ||
    prior.cancelledAt ||
    typeof updated.leftHubAt !== "string" ||
    !isCanonicalTimestamp(updated.leftHubAt) ||
    departureTime.getTime() < Date.parse(prior.arrivedAtHubAt) ||
    !Array.isArray(prior.temporaryTrips) ||
    trips.length !== prior.temporaryTrips.length ||
    trips.some((trip) => !trip.returnedAt)
  ) {
    throw new RolePermissionError();
  }
  return {
    ...updated,
    leftHubAt: departureTime.toISOString(),
    leftBy: {
      staffId: actor.staffId,
      displayName: actor.displayName,
      role: actor.role,
    },
  };
}

function attributeHubVisitReturns(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const beforeById = indexHubVisits(snapshotArray(before.hubVisits));
  const returned: Record<string, unknown>[] = [];
  const visits = snapshotArray(after.hubVisits).map((updated) => {
    const prior = beforeById.get(String(updated.id));
    if (!prior || !hubVisitReturnChanged(prior, updated)) return updated;
    const expected = { ...prior };
    const actual = { ...updated };
    delete expected.arrivedBackAtClassAt;
    delete expected.returnedBy;
    delete actual.arrivedBackAtClassAt;
    delete actual.returnedBy;
    if (!deepEqualJson(expected, actual)) throw new RolePermissionError();
    const cls = snapshotArray(after.classes).find(
      (item) => item.id === prior.classId,
    );
    const classIsActive =
      isRecord(after.activeClass) &&
      after.activeClass.id === prior.classId &&
      snapshotArray(cls?.members).some(
        (member) =>
          member.studentId === prior.studentId && member.status === "current",
      );
    const trips = Array.isArray(prior.temporaryTrips)
      ? prior.temporaryTrips.filter(isRecord)
      : [];
    const returnTime = new Date();
    if (
      typeof prior.arrivedAtHubAt !== "string" ||
      typeof prior.leftHubAt !== "string" ||
      prior.arrivedBackAtClassAt ||
      !isCanonicalTimestamp(prior.arrivedAtHubAt) ||
      !isCanonicalTimestamp(prior.leftHubAt) ||
      typeof updated.arrivedBackAtClassAt !== "string" ||
      !isCanonicalTimestamp(updated.arrivedBackAtClassAt) ||
      Date.parse(prior.leftHubAt) < Date.parse(prior.arrivedAtHubAt) ||
      Date.parse(updated.arrivedBackAtClassAt) < Date.parse(prior.leftHubAt) ||
      returnTime.getTime() < Date.parse(prior.leftHubAt) ||
      !Array.isArray(prior.temporaryTrips) ||
      trips.length !== prior.temporaryTrips.length ||
      trips.some((trip) => !trip.returnedAt) ||
      !classIsActive
    ) {
      throw new RolePermissionError();
    }
    const attributed = {
      ...updated,
      arrivedBackAtClassAt: returnTime.toISOString(),
      returnedBy: {
        staffId: actor.staffId,
        displayName: actor.displayName,
        role: actor.role,
      },
    };
    returned.push(attributed);
    return attributed;
  });
  return { visits, returned };
}

function hubVisitReturnChanged(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  return ["arrivedBackAtClassAt", "returnedBy"].some(
    (field) => !deepEqualJson(prior[field], updated[field]),
  );
}

function hubVisitArrivalChanged(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  return ["arrivedAtHubAt", "arrivedBy"].some(
    (field) => !deepEqualJson(prior[field], updated[field]),
  );
}

function attributeHubVisitArrival(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
  actor: StaffActor,
) {
  const expected = { ...prior };
  const actual = { ...updated };
  for (const field of ["arrivedAtHubAt", "arrivedBy"]) {
    delete expected[field];
    delete actual[field];
  }
  const arrivalTime = new Date();
  if (
    !deepEqualJson(expected, actual) ||
    prior.source !== "classroom-notification" ||
    typeof prior.leftClassAt !== "string" ||
    !isCanonicalTimestamp(prior.leftClassAt) ||
    prior.arrivedAtHubAt ||
    prior.arrivedBy ||
    prior.leftHubAt ||
    prior.arrivedBackAtClassAt ||
    prior.cancelledAt ||
    typeof updated.arrivedAtHubAt !== "string" ||
    !isCanonicalTimestamp(updated.arrivedAtHubAt) ||
    arrivalTime.getTime() < Date.parse(prior.leftClassAt)
  ) {
    throw new RolePermissionError();
  }
  return {
    ...updated,
    arrivedAtHubAt: arrivalTime.toISOString(),
    arrivedBy: {
      staffId: actor.staffId,
      displayName: actor.displayName,
      role: actor.role,
    },
  };
}

function attributeHubVisitCancellations(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const beforeVisits = snapshotArray(before.hubVisits);
  const afterVisits = snapshotArray(after.hubVisits);
  const beforeById = indexHubVisits(beforeVisits);
  const cancelled: Record<string, unknown>[] = [];
  const visits = afterVisits.map((updated) => {
    const prior = beforeById.get(String(updated.id));
    if (!prior || !hubVisitCancellationChanged(prior, updated)) return updated;
    const attributed = attributeHubVisitCancellation(
      prior,
      updated,
      after,
      actor,
    );
    cancelled.push(attributed);
    return attributed;
  });
  return { visits, cancelled };
}

function hubVisitCancellationChanged(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  return ["cancelledAt", "cancellationReason", "cancelledBy"].some(
    (field) => !deepEqualJson(prior[field], updated[field]),
  );
}

function attributeHubVisitCancellation(
  prior: Record<string, unknown>,
  updated: Record<string, unknown>,
  snapshot: StateSnapshot,
  actor: StaffActor,
) {
  const expected = { ...prior };
  const actual = { ...updated };
  for (const field of ["cancelledAt", "cancellationReason", "cancelledBy"]) {
    delete expected[field];
    delete actual[field];
  }
  const cls = snapshotArray(snapshot.classes).find(
    (item) => item.id === prior.classId,
  );
  const classIsActive =
    isRecord(snapshot.activeClass) &&
    snapshot.activeClass.id === prior.classId &&
    snapshotArray(cls?.members).some(
      (member) =>
        member.studentId === prior.studentId && member.status === "current",
    );
  if (
    !deepEqualJson(expected, actual) ||
    prior.source !== "classroom-notification" ||
    typeof prior.leftClassAt !== "string" ||
    !isCanonicalTimestamp(prior.leftClassAt) ||
    prior.arrivedAtHubAt ||
    prior.leftHubAt ||
    prior.arrivedBackAtClassAt ||
    prior.cancelledAt ||
    prior.cancellationReason ||
    prior.cancelledBy ||
    updated.arrivedAtHubAt ||
    updated.leftHubAt ||
    updated.arrivedBackAtClassAt ||
    updated.returnedBy ||
    typeof updated.cancelledAt !== "string" ||
    !isCanonicalTimestamp(updated.cancelledAt) ||
    (updated.cancellationReason !== "withdrawn" &&
      updated.cancellationReason !== "did-not-arrive") ||
    !Array.isArray(prior.temporaryTrips) ||
    prior.temporaryTrips.length !== 0 ||
    !classIsActive
  ) {
    throw new RolePermissionError();
  }
  return {
    ...updated,
    cancelledAt: new Date().toISOString(),
    cancelledBy: {
      staffId: actor.staffId,
      displayName: actor.displayName,
      role: actor.role,
    },
  };
}

function attributeNewHubVisitNotifications(
  before: StateSnapshot,
  after: StateSnapshot,
  actor: StaffActor,
) {
  const priorIds = new Set(
    snapshotArray(before.hubVisits).map((visit) => visit.id),
  );
  return snapshotArray(after.hubVisits).map((visit) =>
    !priorIds.has(visit.id) && visit.source === "classroom-notification"
      ? {
          ...visit,
          notifiedBy: {
            staffId: actor.staffId,
            displayName: actor.displayName,
            role: actor.role,
          },
        }
      : visit,
  );
}

function snapshotArray(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new RolePermissionError();
  }
  return value;
}

function completedPromptStages(visit: Record<string, unknown>) {
  return Array.isArray(visit.promptStagesCompleted)
    ? visit.promptStagesCompleted.filter((stage): stage is HubPromptStage => stage === "arrival" || stage === "departure")
    : [];
}

function hubKioskPinRequired(
  snapshot: StateSnapshot,
  student: Record<string, unknown>,
  classId?: string,
) {
  if (
    snapshot.studentPins !== true ||
    typeof student.pin !== "string" ||
    !student.pin
  ) {
    return false;
  }
  const cls = snapshotArray(snapshot.classes).find(
    (each) => each.id === classId,
  );
  return cls?.pinsOff !== true;
}

function kioskDestinationLabel(destination: Record<string, unknown>) {
  if (destination.private === true) {
    const kioskLabel =
      typeof destination.kioskLabel === "string"
        ? destination.kioskLabel.trim()
        : "";
    return kioskLabel.slice(0, 60) || "Private destination";
  }
  return typeof destination.label === "string"
    ? destination.label.slice(0, 60)
    : "Hub destination";
}

function kioskDestinationView(
  destination: Record<string, unknown>,
): HubKioskDestination {
  if (typeof destination.id !== "string" || !destination.id) {
    throw new RolePermissionError();
  }
  return {
    id: destination.id,
    label: kioskDestinationLabel(destination),
    promptVersion: destinationPromptVersion(destination),
    arrivalPrompts: promptsForKiosk(destination, "arrival"),
  };
}

function destinationPromptVersion(destination: Record<string, unknown>) {
  const version = destination.hubPromptVersion;
  if (version === undefined) return 1;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new RolePermissionError();
  }
  return version;
}

function hubPromptsForDestination(
  destination: Record<string, unknown>,
  stage: HubPromptStage,
): HubVisitPrompt[] {
  const raw =
    stage === "arrival"
      ? destination.hubArrivalPrompts
      : destination.hubDeparturePrompts;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 8) throw new RolePermissionError();
  const prompts = raw.map((prompt) => {
    if (!isHubVisitPrompt(prompt)) throw new RolePermissionError();
    return prompt;
  });
  if (new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length) {
    throw new RolePermissionError();
  }
  return prompts;
}

function promptsForKiosk(
  destination: Record<string, unknown>,
  stage: HubPromptStage,
  overridden = false,
) {
  const prompts = hubPromptsForDestination(destination, stage);
  return overridden
    ? prompts.map((prompt) => ({ ...prompt, required: false }))
    : prompts;
}

function collectHubPromptResponses(
  snapshot: StateSnapshot,
  destinationId: string | undefined,
  destination: Record<string, unknown> | undefined,
  studentId: string,
  stage: HubPromptStage,
  request: HubKioskPromptData,
  answeredAt: string,
): HubPromptCollection {
  const promptVersion = destination
    ? destinationPromptVersion(destination)
    : 1;
  const prompts = destination
    ? hubPromptsForDestination(destination, stage)
    : [];
  if (prompts.length > 0 && !destinationId) {
    throw new RolePermissionError();
  }
  const responseDestinationId = destinationId ?? "";
  if (
    (prompts.length > 0 && request.promptVersion !== promptVersion) ||
    (request.promptVersion !== undefined &&
      request.promptVersion !== promptVersion)
  ) {
    throw new HubKioskPromptError("hub_prompt_configuration_changed");
  }
  const answers = request.promptAnswers ?? {};
  const validIds = new Set(prompts.map((prompt) => prompt.id));
  if (
    Object.keys(answers).some((promptId) => !validIds.has(promptId))
  ) {
    throw new HubKioskPromptError("invalid_hub_prompt_response");
  }
  const override =
    destinationId === undefined
      ? undefined
      : activeHubPromptOverride(snapshot, studentId, destinationId, stage);
  let usedToSkip = false;
  const responses: HubPromptResponseSnapshot[] = [];
  for (const prompt of prompts) {
    const answer = answers[prompt.id];
    const blankWritten =
      prompt.responseType === "written" &&
      typeof answer === "string" &&
      !answer.trim();
    const missing = answer === undefined || blankWritten;
    if (missing && prompt.required) {
      if (!override) {
        throw new HubKioskPromptError("required_hub_prompt_missing");
      }
      usedToSkip = true;
      continue;
    }
    if (missing) continue;
    if (prompt.responseType === "written") {
      if (typeof answer !== "string" || answer.trim().length > 2000) {
        throw new HubKioskPromptError("invalid_hub_prompt_response");
      }
      responses.push({
        promptId: prompt.id,
        promptVersion,
        destinationId: responseDestinationId,
        stage,
        question: prompt.question,
        ...(prompt.guidance ? { guidance: prompt.guidance } : {}),
        responseType: "written",
        required: prompt.required,
        answer: answer.trim(),
        answeredAt,
      });
    } else {
      if (
        typeof answer !== "number" ||
        !Number.isInteger(answer) ||
        answer < 1 ||
        answer > (prompt.scaleMax ?? 5)
      ) {
        throw new HubKioskPromptError("invalid_hub_prompt_response");
      }
      responses.push({
        promptId: prompt.id,
        promptVersion,
        destinationId: responseDestinationId,
        stage,
        question: prompt.question,
        ...(prompt.guidance ? { guidance: prompt.guidance } : {}),
        responseType: "rating",
        required: prompt.required,
        scaleMax: prompt.scaleMax ?? 5,
        ratingStyle: prompt.ratingStyle ?? "numbers",
        ...(prompt.minLabel ? { minLabel: prompt.minLabel } : {}),
        ...(prompt.maxLabel ? { maxLabel: prompt.maxLabel } : {}),
        answer,
        answeredAt,
      });
    }
  }
  return {
    responses,
    ...(override
      ? {
          overrideId: override.id,
          overrideSnapshot: {
            overrideId: override.id,
            destinationId: override.destinationId,
            stage: override.stage,
            promptVersion,
            reason: override.reason,
            requestedAt: override.requestedAt,
            appliedAt: answeredAt,
            usedToSkip,
            requestedBy: override.requestedBy,
          },
        }
      : {}),
  };
}

function hubVisitPromptData(
  visit: Record<string, unknown>,
  collection: HubPromptCollection,
) {
  const responses = [
    ...snapshotArray(visit.promptResponses),
    ...collection.responses,
  ];
  const overrides = [
    ...snapshotArray(visit.promptOverrides),
    ...(collection.overrideSnapshot ? [collection.overrideSnapshot] : []),
  ];
  return {
    ...(responses.length ? { promptResponses: responses } : {}),
    ...(overrides.length ? { promptOverrides: overrides } : {}),
  };
}

function hubPromptAuditDetails(collection: HubPromptCollection) {
  return {
    ...(collection.responses.length
      ? { promptResponseCount: collection.responses.length }
      : {}),
    ...(collection.overrideId
      ? { promptOverrideId: collection.overrideId }
      : {}),
  };
}

function activeHubPromptOverride(
  snapshot: StateSnapshot,
  studentId: string,
  destinationId: string,
  stage: HubPromptStage,
) {
  const pending = snapshotArray(snapshot.hubPromptOverrides);
  for (const override of pending) {
    if (!isHubPromptOverride(override)) throw new RolePermissionError();
  }
  return pending.find(
    (override): override is HubPromptOverride =>
      isHubPromptOverride(override) &&
      override.studentId === studentId &&
      override.destinationId === destinationId &&
      override.stage === stage &&
      Date.parse(override.expiresAt) > Date.now(),
  );
}

function isHubVisitPrompt(value: unknown): value is HubVisitPrompt {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.question !== "string" ||
    !value.question.trim() ||
    value.question.length > 240 ||
    typeof value.required !== "boolean" ||
    (value.responseType !== "written" && value.responseType !== "rating")
  ) {
    return false;
  }
  if (
    value.guidance !== undefined &&
    (typeof value.guidance !== "string" || value.guidance.length > 240)
  ) {
    return false;
  }
  if (value.responseType === "rating") {
    return (
      (value.scaleMax === 5 || value.scaleMax === 10) &&
      (value.ratingStyle === undefined ||
        value.ratingStyle === "numbers" ||
        value.ratingStyle === "stars") &&
      (value.minLabel === undefined ||
        (typeof value.minLabel === "string" && value.minLabel.length <= 60)) &&
      (value.maxLabel === undefined ||
        (typeof value.maxLabel === "string" && value.maxLabel.length <= 60))
    );
  }
  return true;
}

function isHubPromptOverride(value: unknown): value is HubPromptOverride {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.studentId !== "string" ||
    !value.studentId ||
    value.studentId.length > 128 ||
    typeof value.destinationId !== "string" ||
    !value.destinationId ||
    value.destinationId.length > 128 ||
    (value.stage !== "arrival" && value.stage !== "departure") ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 3 ||
    value.reason.length > 300 ||
    typeof value.requestedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !isCanonicalTimestamp(value.requestedAt) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.requestedAt) ||
    !isRecord(value.requestedBy) ||
    typeof value.requestedBy.staffId !== "string" ||
    !value.requestedBy.staffId ||
    value.requestedBy.staffId.length > 128 ||
    typeof value.requestedBy.displayName !== "string" ||
    !value.requestedBy.displayName.trim() ||
    value.requestedBy.displayName.length > 120 ||
    (value.requestedBy.role !== "ea" && value.requestedBy.role !== "tic")
  ) {
    return false;
  }
  const duration =
    Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  return duration > 0 && duration <= 10 * 60_000;
}

/** Projects one roster student into the public kiosk view for the Hub screen. */
function buildKioskStudent(
  snapshot: StateSnapshot,
  student: Record<string, unknown> & { id: string; firstName: string },
  movements: Record<string, unknown>[],
  classes: Record<string, unknown>[],
  destinations: Record<string, unknown>[],
  overrides: HubPromptOverride[],
): HubKioskStudent {
  const category = snapshotArray(snapshot.studentCategories).find(
    (each) => each.id === student.categoryId,
  );
  const studentMovements = movements.filter(
    (visit) => visit.studentId === student.id,
  );
  const visit = studentMovements.length === 1 ? studentMovements[0] : undefined;
  const memberships = classes.flatMap((cls) =>
    snapshotArray(cls.members).filter(
      (member) =>
        member.studentId === student.id &&
        member.status === "current" &&
        typeof member.lastPrefix === "string",
    ),
  );
  const longestPrefix = memberships.reduce(
    (longest, member) =>
      typeof member.lastPrefix === "string" &&
      member.lastPrefix.length > longest.length
        ? member.lastPrefix
        : longest,
    "",
  );
  const prefix =
    longestPrefix.slice(0, 1) ||
    (typeof student.lastName === "string" ? student.lastName.slice(0, 1) : "");
  const activeTrip = visit
    ? snapshotArray(visit.temporaryTrips).find((trip) => !trip.returnedAt)
    : undefined;
  const visitDestination = visit
    ? destinations.find((destination) => destination.id === visit.destinationId)
    : undefined;
  const tripDestination = activeTrip
    ? destinations.find((destination) => destination.id === activeTrip.destinationId)
    : undefined;
  const promptOverrideFor = (stage: HubPromptStage) =>
    Boolean(
      visit &&
        overrides.some(
          (override) =>
            override.studentId === student.id &&
            override.destinationId === visit.destinationId &&
            override.stage === stage,
        ),
    );
  const promptVersion = visitDestination
    ? destinationPromptVersion(visitDestination)
    : undefined;

  let status: HubKioskStudent["status"] = "in-class";
  if (studentMovements.length > 1) status = "needs-staff";
  else if (visit?.leftHubAt) status = "left-hub-awaiting-class";
  else if (activeTrip) status = "on-temporary-trip";
  else if (visit?.arrivedAtHubAt) status = "at-hub";
  else if (visit?.source === "classroom-notification" && !visit.arrivedAtHubAt) {
    status = "on-the-way";
  } else if (visit) status = "needs-staff";
  return {
    id: student.id,
    studentName: `${student.firstName}${prefix ? ` ${prefix}.` : ""}`,
    ...(category && typeof category.name === "string"
      ? { categoryName: category.name, ...(typeof category.color === "string" ? { categoryColor: category.color } : {}) }
      : {}),
    status,
    pinRequired: hubKioskPinRequired(
      snapshot,
      student,
      typeof visit?.classId === "string" ? visit.classId : undefined,
    ),
    ...(visit && typeof visit.id === "string" ? { visitId: visit.id } : {}),
    ...(visit
      ? {
          destinationLabel: visitDestination
            ? kioskDestinationLabel(visitDestination)
            : "Hub visit",
        }
      : {}),
    ...(visitDestination && visit
      ? {
          promptVersion,
          ...(typeof visit.timerStartedAt === "string" && typeof visit.hubTimerMinutes === "number" ? { timerStartedAt: visit.timerStartedAt, timerMinutes: visit.hubTimerMinutes + (typeof visit.hubExtraMinutes === "number" ? visit.hubExtraMinutes : 0), overdueCountsUp: visit.hubOverdueCountsUp === true, timerWarningMinutes: typeof visit.hubTimerWarningMinutes === "number" ? visit.hubTimerWarningMinutes : 2 } : {}),
          ...((status === "on-the-way" || visit.arrivedAtHubAt) && !completedPromptStages(visit).includes("arrival") && !snapshotArray(visit.promptResponses).some((response) => response.stage === "arrival")
            ? { arrivalPrompts: promptsForKiosk(visitDestination, "arrival", promptOverrideFor("arrival")) }
            : {}),
          ...(visit.leftHubAt && !completedPromptStages(visit).includes("departure") && !snapshotArray(visit.promptResponses).some((response) => response.stage === "departure")
            ? { departurePrompts: promptsForKiosk(visitDestination, "departure", promptOverrideFor("departure")) }
            : status === "at-hub" && !completedPromptStages(visit).includes("departure") && !snapshotArray(visit.promptResponses).some((response) => response.stage === "departure")
              ? { departurePrompts: promptsForKiosk(visitDestination, "departure", promptOverrideFor("departure")) }
              : {}),
        }
      : {}),
    ...(activeTrip && typeof activeTrip.id === "string"
      ? { temporaryTripId: activeTrip.id }
      : {}),
    ...(activeTrip
      ? {
          temporaryTripLabel: tripDestination
            ? kioskDestinationLabel(tripDestination)
            : "Temporary destination",
        }
      : {}),
  } satisfies HubKioskStudent;
}

function readHubKioskSoundSettings(
  snapshot: StateSnapshot,
): HubKioskSoundSettings {
  const settings = snapshot.hubKioskSoundSettings;
  if (settings === undefined) {
    return { muted: false, volume: 70, commonChime: "soft" };
  }
  if (
    !isRecord(settings) ||
    typeof settings.muted !== "boolean" ||
    typeof settings.volume !== "number" ||
    !Number.isFinite(settings.volume) ||
    settings.volume < 0 ||
    settings.volume > 100 ||
    !isHubKioskChime(settings.commonChime)
  ) {
    throw new RolePermissionError();
  }
  return {
    muted: settings.muted,
    volume: settings.volume,
    commonChime: settings.commonChime,
  };
}

function kioskArrivalChime(destination: Record<string, unknown>): HubKioskChime {
  if (destination.hubArrivalChime === undefined) return "soft";
  if (!isHubKioskChime(destination.hubArrivalChime)) {
    throw new RolePermissionError();
  }
  return destination.hubArrivalChime;
}

function kioskDestinationConfirmation(destination: Record<string, unknown>) {
  const customMessage =
    typeof destination.kioskConfirmation === "string"
      ? destination.kioskConfirmation.trim()
      : "";
  if (customMessage) return customMessage.slice(0, 160);
  return `Your arrival at ${kioskDestinationLabel(destination)} was saved by the Hub Host.`;
}

function indexHubVisits(visits: Record<string, unknown>[]) {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const visit of visits) {
    if (typeof visit.id !== "string" || indexed.has(visit.id)) {
      throw new RolePermissionError();
    }
    indexed.set(visit.id, visit);
  }
  return indexed;
}

function isCanonicalTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function hashToken(token: string) {
  return checksumOf(token);
}

/** 
 * Verify staff password against stored account password.
 * Returns true if password matches or no password is required.
 */
function verifyStaffPassword(inputPassword: string, storedPassword: string | undefined): boolean {
  if (!storedPassword) return true; // No password set, allow access
  if (!inputPassword) return false; // No password entered, deny access
  // Simple string comparison
  return inputPassword === storedPassword;
}
