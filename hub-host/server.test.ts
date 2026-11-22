import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { startHubHost, type RunningHubHost } from "./server";
import { HubStore } from "./store";
import { HubBackupManager } from "./backups";
import { decryptBackupFileSync } from "./backup-crypto";

const temporaryDirectories: string[] = [];
const runningHosts: RunningHubHost[] = [];

afterEach(async () => {
  for (const host of runningHosts.splice(0)) await host.close();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function startTestHost(
  databasePath: string,
  offHostBackupDirectory: string | null = null,
  fallbackBackupDirectory: string | null = null,
  staticDirectory: string | null = null,
) {
  const host = await startHubHost({
    databasePath,
    allowNamedProfileFallback: true,
    backupEncryptionKey: createHash("sha256")
      .update(`${databasePath}:fictional-test-backup-key`)
      .digest(),
    localBackupDirectory: `${databasePath}.backups`,
    offHostBackupDirectory,
    fallbackBackupDirectory,
    staticDirectory,
    host: "127.0.0.1",
    port: 0,
  });
  runningHosts.push(host);
  return host;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "happy-hallways-hub-host-"));
  temporaryDirectories.push(directory);
  return join(directory, "hub.sqlite");
}

async function enroll(
  host: RunningHubHost,
  token: string,
  displayName?: string,
) {
  const response = await fetch(`${host.url}/api/v1/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitationToken: token, displayName }),
  });
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { response, body, cookie };
}

async function issueBootstrapTic(host: RunningHubHost, databasePath: string) {
  const store = new HubStore(databasePath);
  const invitation = store.createBootstrapTicInvitation();
  store.close();
  return enroll(host, invitation.token, "TIC Example");
}

describe("local Hub Host staff fallback and state service", () => {
  test("serves the static app and routes safely from the Hub Host origin", async () => {
    const path = temporaryDatabase();
    const staticDirectory = join(
      tmpdir(),
      `happy-hallways-static-${Date.now()}`,
    );
    temporaryDirectories.push(staticDirectory);
    mkdirSync(join(staticDirectory, "_app", "immutable"), { recursive: true });
    writeFileSync(
      join(staticDirectory, "index.html"),
      "<main>Fictional app shell</main>",
    );
    writeFileSync(
      join(staticDirectory, "about.html"),
      "<main>About page</main>",
    );
    writeFileSync(
      join(staticDirectory, "_app", "immutable", "app.js"),
      "export const ready = true;",
    );
    const host = await startTestHost(path, null, null, staticDirectory);

    const root = await fetch(host.url);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    const rootHtml = await root.text();
    expect(rootHtml).toContain("Fictional app shell");
    expect(rootHtml).toContain('name="happy-hallways-hub-host" content="true"');

    const knownPage = await fetch(`${host.url}/about`);
    expect(await knownPage.text()).toContain("About page");
    const appRoute = await fetch(`${host.url}/kiosk`);
    expect(await appRoute.text()).toContain("Fictional app shell");
    const adminRoute = await fetch(`${host.url}/hub-admin`);
    expect(await adminRoute.text()).toContain("Fictional app shell");
    expect(
      await fetch(`${host.url}/api/v1/health`).then((r) => r.json()),
    ).toMatchObject({
      application: "served_from_host",
      network: { mode: "loopback_only", schoolLanTest: "not_verified" },
    });

    const asset = await fetch(`${host.url}/_app/immutable/app.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toContain("ready = true");

    expect((await fetch(`${host.url}/_app/immutable/missing.js`)).status).toBe(
      404,
    );
    expect(
      (await fetch(`${host.url}/api/v1/health`)).headers.get("content-type"),
    ).toContain("application/json");
    expect((await fetch(`${host.url}/api/turn`)).status).toBe(503);
    expect((await fetch(`${host.url}/%2e%2e%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${host.url}/.git/config`)).status).toBe(404);
  });

  test("requires a staff session and lets an enrolled TIC save versioned state", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    expect(
      await fetch(`${host.url}/api/v1/auth/options`).then((response) =>
        response.json(),
      ),
    ).toMatchObject({
      preferred: { id: "microsoft-entra-oidc", enabled: false },
      fallback: {
        id: "tic-approved-named-profile-device-enrolment",
        enabled: true,
        identityVerified: false,
        mfaVerified: false,
        realStudentDataAllowed: false,
      },
    });
    expect(
      await fetch(`${host.url}/api/v1/auth/entra/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((response) => response.status),
    ).toBe(503);
    expect((await fetch(`${host.url}/api/v1/state`)).status).toBe(401);
    const tic = await issueBootstrapTic(host, path);
    expect(tic.response.status).toBe(201);
    expect(tic.body).toMatchObject({
      displayName: "TIC Example",
      role: "tic",
      identityVerified: false,
      mfaVerified: false,
    });
    const cookie = tic.cookie ?? "";
    const snapshot = {
      version: 4,
      roster: [
        {
          id: "fictional-student-1",
          firstName: "Avery",
          lastName: "Example",
          categoryId: "year-7",
        },
      ],
      studentCategories: [{ id: "year-7", name: "Year 7", color: "blue" }],
      hubVisits: [
        {
          id: "fictional-hub-visit-1",
          studentId: "fictional-student-1",
          studentName: "Avery Example",
          studentCategory: { id: "year-7", name: "Year 7", color: "blue" },
          destinationLabel: "Wellbeing",
          source: "classroom-notification",
          leftClassAt: "2026-11-12T00:55:00.000Z",
          temporaryTrips: [],
        },
      ],
      visits: [
        {
          id: "fictional-visit-1",
          staff: "TIC Example",
          timestamp: "2026-11-12T01:00:00.000Z",
        },
      ],
    };
    const savedResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json();
    expect(saved).toMatchObject({ revision: 1, snapshot });
    expect(saved.checksum).toMatch(/^[a-f0-9]{64}$/);

    const stale = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot: { version: 2 } }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "revision_conflict",
      currentRevision: 1,
    });
    const events = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: cookie },
    }).then((r) => r.json());
    expect(events.events[0]).toMatchObject({
      eventType: "host_snapshot_saved",
      actorDisplayName: "TIC Example",
      actorRole: "tic",
    });
  });

  test("keeps named-profile sign-in disabled unless Host configuration enables it", async () => {
    const path = temporaryDatabase();
    const host = await startHubHost({
      databasePath: path,
      localBackupDirectory: `${path}.backups`,
      host: "127.0.0.1",
      port: 0,
    });
    runningHosts.push(host);

    const options = await fetch(`${host.url}/api/v1/auth/options`).then((response) => response.json());
    expect(options.fallback).toMatchObject({
      status: "disabled_pending_configuration",
      enabled: false,
      identityVerified: false,
      mfaVerified: false,
      realStudentDataAllowed: false,
    });
    const enrollment = await fetch(`${host.url}/api/v1/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationToken: "fictional-disabled-token" }),
    });
    expect(enrollment.status).toBe(503);
    expect(await enrollment.json()).toEqual({ error: "fallback_sign_in_not_configured" });
  });

  test("allows one of two concurrent writes based on the same revision", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const write = (writer: string) =>
      fetch(`${host.url}/api/v1/state`, {
        method: "PUT",
        headers: {
          Cookie: tic.cookie ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 0,
          snapshot: { version: 2, writer },
        }),
      });
    const results = await Promise.all([
      write("fictional-staff-a"),
      write("fictional-staff-b"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  test("merges stale writes to separate records and audits the source revision", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const cookie = tic.cookie ?? "";
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const baseSnapshot = {
      version: 2,
      passes: [{ id: "fictional-pass-1", outAt: null }],
      settings: { room: "Learning Hub" },
    };
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 0, snapshot: baseSnapshot }),
    });

    const firstSnapshot = {
      ...baseSnapshot,
      passes: [...baseSnapshot.passes, { id: "fictional-pass-2", outAt: null }],
    };
    expect(
      (
        await fetch(`${host.url}/api/v1/state`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            expectedRevision: 1,
            baseSnapshot,
            snapshot: firstSnapshot,
          }),
        })
      ).status,
    ).toBe(200);

    const secondSnapshot = {
      ...baseSnapshot,
      passes: [...baseSnapshot.passes, { id: "fictional-pass-3", outAt: null }],
      settings: { room: "Quiet Room" },
    };
    const mergedResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        baseSnapshot,
        snapshot: secondSnapshot,
      }),
    });
    expect(mergedResponse.status).toBe(200);
    expect(await mergedResponse.json()).toMatchObject({
      revision: 3,
      snapshot: {
        passes: [
          { id: "fictional-pass-1", outAt: null },
          { id: "fictional-pass-2", outAt: null },
          { id: "fictional-pass-3", outAt: null },
        ],
        settings: { room: "Quiet Room" },
      },
    });
    const events = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    expect(events.events[0]).toMatchObject({
      eventType: "host_snapshot_saved",
      details: { basedOnRevision: 1, mergeMode: "three_way" },
    });
  });

  test("rejects overlapping stale edits without changing the acknowledged record", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const cookie = tic.cookie ?? "";
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const baseSnapshot = {
      version: 2,
      passes: [{ id: "fictional-pass-1", outAt: null }],
    };
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 0, snapshot: baseSnapshot }),
    });

    const savePass = (outAt: string) =>
      fetch(`${host.url}/api/v1/state`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedRevision: 1,
          baseSnapshot,
          snapshot: {
            version: 2,
            passes: [{ id: "fictional-pass-1", outAt }],
          },
        }),
      });
    expect((await savePass("2026-11-12T01:10:00.000Z")).status).toBe(200);
    const conflict = await savePass("2026-11-12T01:11:00.000Z");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "revision_conflict",
      currentRevision: 2,
      conflictingPaths: ["$.passes[id=fictional-pass-1].outAt"],
    });
    expect(
      await fetch(`${host.url}/api/v1/state`, {
        headers: { Cookie: cookie },
      }).then((response) => response.json()),
    ).toMatchObject({
      revision: 2,
      snapshot: {
        passes: [{ id: "fictional-pass-1", outAt: "2026-11-12T01:10:00.000Z" }],
      },
    });
  });

  test("limits EA account access to operational records and withholds PIN and pairing secrets", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    const invitationResult = await fetch(`${host.url}/api/v1/invitations`, {
      method: "POST",
      headers: { Cookie: ticCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ea" }),
    }).then((response) => response.json());
    const ea = await enroll(
      host,
      invitationResult.invitation.token,
      "EA Example",
    );
    expect(ea.response.status).toBe(201);
    const eaCookie = ea.cookie ?? "";
    const ticHeaders = {
      Cookie: ticCookie,
      "Content-Type": "application/json",
    };
    const initialSnapshot = {
      version: 4,
      pin: "0123",
      roster: [
        {
          id: "fictional-student-1",
          firstName: "Avery",
          lastName: "Example",
          pin: "4567",
          categoryId: "year-7",
        },
        {
          id: "fictional-student-2",
          firstName: "Riley",
          lastName: "Example",
        },
        {
          id: "fictional-student-3",
          firstName: "Jordan",
          lastName: "Example",
        },
      ],
      studentCategories: [{ id: "year-7", name: "Year 7", color: "blue" }],
      destinations: [
        {
          id: "wellbeing",
          label: "Wellbeing",
          informHubAvailable: true,
        },
        {
          id: "check-in",
          label: "Check-in",
          informHubAvailable: false,
        },
      ],
      hubVisits: [
        {
          id: "fictional-hub-visit-1",
          studentId: "fictional-student-1",
          studentName: "Avery Example",
          studentCategory: { id: "year-7", name: "Year 7", color: "blue" },
          destinationId: "wellbeing",
          destinationLabel: "Wellbeing",
          classId: "fictional-class-1",
          className: "Period A",
          source: "classroom-notification",
          leftClassAt: "2026-11-12T00:55:00.000Z",
          arrivedAtHubAt: "2026-11-12T01:00:00.000Z",
          leftHubAt: "2026-11-12T01:10:00.000Z",
          temporaryTrips: [],
        },
      ],
      classes: [
        {
          id: "fictional-class-1",
          name: "Period A",
          members: [
            {
              studentId: "fictional-student-1",
              lastPrefix: "E",
              status: "current",
            },
            {
              studentId: "fictional-student-2",
              lastPrefix: "E",
              status: "current",
            },
            {
              studentId: "fictional-student-3",
              lastPrefix: "E",
              status: "current",
            },
          ],
        },
      ],
      activeClass: {
        id: "fictional-class-1",
        changedAt: "2026-11-12T00:00:00.000Z",
      },
      passes: [
        {
          id: "fictional-pass-1",
          studentId: "fictional-student-1",
          outAt: null,
        },
      ],
      line: [],
      kiosk: {
        kind: "device",
        kioskId: "fictional-kiosk",
        secret: "fictional-secret",
      },
      replacedKiosks: [
        { kioskId: "fictional-old-kiosk", secret: "fictional-old-secret" },
      ],
      claims: [
        { token: "fictional-claim-token", studentId: "fictional-student-1" },
      ],
      studentLink: {
        open: true,
        room: { code: "fictional-room-code", classId: "fictional-class-1" },
      },
    };
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: ticHeaders,
      body: JSON.stringify({ expectedRevision: 0, snapshot: initialSnapshot }),
    });

    const eaRead = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: eaCookie },
    }).then((response) => response.json());
    expect(eaRead.snapshot).toMatchObject({
      kiosk: { kind: "device", kioskId: "fictional-kiosk" },
      studentLink: { open: true, room: { classId: "fictional-class-1" } },
    });
    expect(
      eaRead.snapshot.roster.some(
        (student: { id: string; firstName: string }) =>
          student.id === "fictional-student-1" &&
          student.firstName === "Avery",
      ),
    ).toBe(true);
    expect(eaRead.snapshot.pin).toBe("");
    expect(eaRead.snapshot.roster[0].pin).toBeUndefined();
    expect(eaRead.snapshot.kiosk.secret).toBeUndefined();
    expect(eaRead.snapshot.replacedKiosks).toEqual([]);
    expect(eaRead.snapshot.claims).toEqual([]);
    expect(eaRead.snapshot.studentLink.room.code).toBeUndefined();
    expect(eaRead.snapshot.studentCategories).toEqual([
      { id: "year-7", name: "Year 7", color: "blue" },
    ]);
    expect(eaRead.snapshot.hubVisits).toMatchObject([
      {
        id: "fictional-hub-visit-1",
        source: "classroom-notification",
        leftClassAt: "2026-11-12T00:55:00.000Z",
      },
    ]);

    const operationalSnapshot = {
      ...eaRead.snapshot,
      passes: [
        {
          id: "fictional-pass-1",
          studentId: "fictional-student-1",
          outAt: "2026-11-12T01:15:00.000Z",
        },
      ],
    };
    const savedResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        baseSnapshot: eaRead.snapshot,
        snapshot: operationalSnapshot,
      }),
    });
    expect(savedResponse.status).toBe(200);
    const eaSaved = await savedResponse.json();
    expect(eaSaved.snapshot.passes[0].outAt).toBe("2026-11-12T01:15:00.000Z");
    expect(eaSaved.snapshot.pin).toBe("");
    expect(eaSaved.snapshot.kiosk.secret).toBeUndefined();

    const newHubVisit = {
      id: "fictional-hub-visit-2",
      studentId: "fictional-student-2",
      studentName: "Riley Example",
      destinationId: "wellbeing",
      destinationLabel: "Wellbeing",
      classId: "fictional-class-1",
      className: "Period A",
      source: "classroom-notification",
      leftClassAt: "2026-11-12T01:20:00.000Z",
      temporaryTrips: [],
    };
    const arrivalHubVisit = {
      ...newHubVisit,
      id: "fictional-hub-visit-3",
      studentId: "fictional-student-3",
      studentName: "Jordan Example",
      leftClassAt: "2026-11-12T01:21:00.000Z",
    };
    const notificationResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 2,
        baseSnapshot: eaSaved.snapshot,
        snapshot: {
          ...eaSaved.snapshot,
          hubVisits: [...eaSaved.snapshot.hubVisits, newHubVisit, arrivalHubVisit],
        },
      }),
    });
    expect(notificationResponse.status).toBe(200);
    const notificationSaved = await notificationResponse.json();
    expect(notificationSaved.snapshot.hubVisits[1]).toMatchObject({
      ...newHubVisit,
      notifiedBy: {
        staffId: ea.body.staffId,
        displayName: "EA Example",
        role: "ea",
      },
    });
    const audit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      audit.events.some(
        (event: {
          eventType: string;
          actorStaffId: string;
          details: { hubVisitId: string; studentId: string };
        }) =>
          event.eventType === "hub_visit_notification_created" &&
          event.actorStaffId === ea.body.staffId &&
          event.details.hubVisitId === newHubVisit.id &&
          event.details.studentId === newHubVisit.studentId,
      ),
    ).toBe(true);

    const earlyReturn = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 3,
        baseSnapshot: notificationSaved.snapshot,
        snapshot: {
          ...notificationSaved.snapshot,
          hubVisits: notificationSaved.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-1"
                ? {
                    ...visit,
                    arrivedBackAtClassAt: "2026-11-12T01:05:00.000Z",
                  }
                : visit,
          ),
        },
      }),
    });
    expect(earlyReturn.status).toBe(403);

    const returnConfirmation = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 3,
        baseSnapshot: notificationSaved.snapshot,
        snapshot: {
          ...notificationSaved.snapshot,
          hubVisits: notificationSaved.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-1"
                ? {
                    ...visit,
                    arrivedBackAtClassAt: "2026-11-12T01:15:00.000Z",
                  }
                : visit,
          ),
        },
      }),
    });
    expect(returnConfirmation.status).toBe(200);
    const returned = await returnConfirmation.json();
    expect(returned.snapshot.hubVisits[0]).toMatchObject({
      id: "fictional-hub-visit-1",
      returnedBy: {
        staffId: ea.body.staffId,
        displayName: "EA Example",
        role: "ea",
      },
    });
    expect(typeof returned.snapshot.hubVisits[0].arrivedBackAtClassAt).toBe(
      "string",
    );
    expect(returned.snapshot.hubVisits[0].arrivedBackAtClassAt).not.toBe(
      "2026-11-12T01:15:00.000Z",
    );

    const cancellation = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 4,
        baseSnapshot: returned.snapshot,
        snapshot: {
          ...returned.snapshot,
          hubVisits: returned.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-2"
                ? {
                    ...visit,
                    cancelledAt: "2000-01-01T00:00:00.000Z",
                    cancellationReason: "did-not-arrive",
                    cancelledBy: {
                      staffId: "forged",
                      displayName: "Forged",
                      role: "ea",
                    },
                  }
                : visit,
          ),
        },
      }),
    });
    expect(cancellation.status).toBe(200);
    const cancelled = await cancellation.json();
    expect(cancelled.snapshot.hubVisits[1]).toMatchObject({
      id: "fictional-hub-visit-2",
      cancellationReason: "did-not-arrive",
      cancelledBy: {
        staffId: ea.body.staffId,
        displayName: "EA Example",
        role: "ea",
      },
    });
    expect(typeof cancelled.snapshot.hubVisits[1].cancelledAt).toBe("string");
    expect(cancelled.snapshot.hubVisits[1].cancelledAt).not.toBe(
      "2000-01-01T00:00:00.000Z",
    );
    expect(cancelled.snapshot.hubVisits[1].arrivedAtHubAt).toBeUndefined();
    expect(cancelled.snapshot.hubVisits[1].leftHubAt).toBeUndefined();
    expect(cancelled.snapshot.hubVisits[1].arrivedBackAtClassAt).toBeUndefined();
    const cancellationAudit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      cancellationAudit.events.some(
        (event: {
          eventType: string;
          actorStaffId: string;
          details: { hubVisitId: string; reason: string };
        }) =>
          event.eventType === "hub_visit_notification_cancelled" &&
          event.actorStaffId === ea.body.staffId &&
          event.details.hubVisitId === "fictional-hub-visit-2" &&
          event.details.reason === "did-not-arrive",
      ),
    ).toBe(true);

    const arrival = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 5,
        baseSnapshot: cancelled.snapshot,
        snapshot: {
          ...cancelled.snapshot,
          hubVisits: cancelled.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-3"
                ? {
                    ...visit,
                    arrivedAtHubAt: "2000-01-01T00:00:00.000Z",
                    arrivedBy: {
                      staffId: "forged",
                      displayName: "Forged",
                      role: "ea",
                    },
                  }
                : visit,
          ),
        },
      }),
    });
    expect(arrival.status).toBe(200);
    const arrived = await arrival.json();
    expect(arrived.snapshot.hubVisits[2]).toMatchObject({
      id: "fictional-hub-visit-3",
      arrivedBy: {
        staffId: ea.body.staffId,
        displayName: "EA Example",
        role: "ea",
      },
    });
    expect(typeof arrived.snapshot.hubVisits[2].arrivedAtHubAt).toBe("string");
    expect(arrived.snapshot.hubVisits[2].arrivedAtHubAt).not.toBe(
      "2000-01-01T00:00:00.000Z",
    );
    expect(arrived.snapshot.hubVisits[2].leftHubAt).toBeUndefined();
    const arrivalAudit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      arrivalAudit.events.some(
        (event: {
          eventType: string;
          actorStaffId: string;
          details: { hubVisitId: string; studentId: string };
        }) =>
          event.eventType === "hub_visit_arrived" &&
          event.actorStaffId === ea.body.staffId &&
          event.details.hubVisitId === "fictional-hub-visit-3" &&
          event.details.studentId === "fictional-student-3",
      ),
    ).toBe(true);

    const arrivalAfterCancellation = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          hubVisits: arrived.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-2"
                ? { ...visit, arrivedAtHubAt: "2026-11-12T01:22:00.000Z" }
                : visit,
          ),
        },
      }),
    });
    expect(arrivalAfterCancellation.status).toBe(403);

    const cancellationAfterArrival = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          hubVisits: arrived.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-1"
                ? {
                    ...visit,
                    cancelledAt: "2026-11-12T01:21:00.000Z",
                    cancellationReason: "withdrawn",
                  }
                : visit,
          ),
        },
      }),
    });
    expect(cancellationAfterArrival.status).toBe(403);

    const tamperedVisit = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          hubVisits: arrived.snapshot.hubVisits.map(
            (visit: { id: string; destinationLabel: string }) =>
              visit.id === "fictional-hub-visit-1"
                ? { ...visit, destinationLabel: "Changed by EA" }
                : visit,
          ),
        },
      }),
    });
    expect(tamperedVisit.status).toBe(403);

    const disabledDestination = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          hubVisits: [
            ...arrived.snapshot.hubVisits,
            {
              ...newHubVisit,
              id: "fictional-hub-visit-disabled",
              studentId: "fictional-student-3",
              studentName: "Jordan Example",
              destinationId: "check-in",
              destinationLabel: "Check-in",
            },
          ],
        },
      }),
    });
    expect(disabledDestination.status).toBe(403);

    const categoryEdit = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          studentCategories: [
            { id: "year-9", name: "Year 9", color: "purple" },
          ],
        },
      }),
    });
    expect(categoryEdit.status).toBe(403);

    const forbidden = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: { ...arrived.snapshot, classes: [] },
      }),
    });
    expect(forbidden.status).toBe(403);

    const departure = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: eaCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 6,
        baseSnapshot: arrived.snapshot,
        snapshot: {
          ...arrived.snapshot,
          hubVisits: arrived.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-3"
                ? {
                    ...visit,
                    leftHubAt: "2000-01-01T00:00:00.000Z",
                    leftBy: {
                      staffId: "forged",
                      displayName: "Forged",
                      role: "ea",
                    },
                  }
                : visit,
          ),
        },
      }),
    });
    expect(departure.status).toBe(200);
    const departed = await departure.json();
    expect(departed.snapshot.hubVisits[2]).toMatchObject({
      id: "fictional-hub-visit-3",
      leftBy: {
        staffId: ea.body.staffId,
        displayName: "EA Example",
        role: "ea",
      },
    });
    expect(typeof departed.snapshot.hubVisits[2].leftHubAt).toBe("string");
    expect(departed.snapshot.hubVisits[2].leftHubAt).not.toBe(
      "2000-01-01T00:00:00.000Z",
    );
    const departureAudit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      departureAudit.events.some(
        (event: {
          eventType: string;
          actorStaffId: string;
          details: { hubVisitId: string };
        }) =>
          event.eventType === "hub_visit_left" &&
          event.actorStaffId === ea.body.staffId &&
          event.details.hubVisitId === "fictional-hub-visit-3",
      ),
    ).toBe(true);

    const ticBeforeReturn = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const ticReturn = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: ticCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 7,
        baseSnapshot: ticBeforeReturn.snapshot,
        snapshot: {
          ...ticBeforeReturn.snapshot,
          hubVisits: ticBeforeReturn.snapshot.hubVisits.map(
            (visit: { id: string }) =>
              visit.id === "fictional-hub-visit-3"
                ? {
                    ...visit,
                    arrivedBackAtClassAt: new Date().toISOString(),
                  }
                : visit,
          ),
        },
      }),
    });
    expect(ticReturn.status).toBe(200);
    const ticReturned = await ticReturn.json();
    expect(ticReturned.snapshot.hubVisits[2]).toMatchObject({
      id: "fictional-hub-visit-3",
      returnedBy: {
        staffId: tic.body.staffId,
        displayName: "TIC Example",
        role: "tic",
      },
    });
    const returnAudit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      returnAudit.events.some(
        (event: {
          eventType: string;
          actorStaffId: string;
          details: { hubVisitId: string };
        }) =>
          event.eventType === "hub_visit_return_confirmed" &&
          event.actorStaffId === tic.body.staffId &&
          event.details.hubVisitId === "fictional-hub-visit-3",
      ),
    ).toBe(true);

    const ticFinal = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(ticFinal.revision).toBe(8);
    expect(ticFinal.snapshot.pin).toBe("0123");
    expect(ticFinal.snapshot.roster[0].pin).toBe("4567");
    expect(ticFinal.snapshot.kiosk.secret).toBe("fictional-secret");
    expect(ticFinal.snapshot.replacedKiosks[0].secret).toBe(
      "fictional-old-secret",
    );
    expect(ticFinal.snapshot.claims[0].token).toBe("fictional-claim-token");
    expect(ticFinal.snapshot.studentLink.room.code).toBe(
      "fictional-room-code",
    );
  });

  test("enrols an EA with a single-use invitation and lets TIC revoke the device session", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    const inviteResponse = await fetch(`${host.url}/api/v1/invitations`, {
      method: "POST",
      headers: { Cookie: ticCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ea" }),
    });
    const invitation = (await inviteResponse.json()).invitation;
    expect(inviteResponse.status).toBe(201);
    expect(invitation.token).toBeTruthy();

    const ea = await enroll(host, invitation.token, "EA Example");
    expect(ea.response.status).toBe(201);
    expect(ea.body).toMatchObject({
      role: "ea",
      identityVerified: false,
      mfaVerified: false,
    });
    expect(
      (await enroll(host, invitation.token, "EA Example")).response.status,
    ).toBe(409);
    expect(
      (
        await fetch(`${host.url}/api/v1/state`, {
          headers: { Cookie: ea.cookie ?? "" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${host.url}/api/v1/invitations`, {
          headers: { Cookie: ea.cookie ?? "" },
        })
      ).status,
    ).toBe(403);

    const sessions = await fetch(`${host.url}/api/v1/sessions`, {
      headers: { Cookie: ticCookie },
    }).then((r) => r.json());
    const eaSession = sessions.sessions.find(
      (session: { displayName: string }) =>
        session.displayName === "EA Example",
    );
    expect(eaSession).toBeTruthy();
    const revoked = await fetch(
      `${host.url}/api/v1/sessions/${eaSession.sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: ticCookie },
      },
    );
    expect(revoked.status).toBe(200);
    expect(
      (
        await fetch(`${host.url}/api/v1/session`, {
          headers: { Cookie: ea.cookie ?? "" },
        })
      ).status,
    ).toBe(401);
  });

  test("runs the Hub kiosk through a one-use activation without exposing staff access", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    const inviteResponse = await fetch(`${host.url}/api/v1/invitations`, {
      method: "POST",
      headers: { Cookie: ticCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "ea" }),
    });
    const invitation = (await inviteResponse.json()).invitation;
    const ea = await enroll(host, invitation.token, "EA Example");

    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/start`, { method: "POST" })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/start`, {
          method: "POST",
          headers: { Cookie: ea.cookie ?? "" },
        })
      ).status,
    ).toBe(403);

    const leftClassAt = new Date(Date.now() - 60_000).toISOString();
    const snapshot = {
      version: 4,
      studentPins: true,
      roster: [
        {
          id: "fictional-kiosk-student",
          firstName: "Avery",
          lastName: "Example",
          pin: "4567",
          heightenedMonitoring: true,
        },
        {
          id: "fictional-direct-student",
          firstName: "Riley",
          lastName: "Sample",
          pin: "7890",
        },
        {
          id: "fictional-former-student",
          firstName: "Former",
          lastName: "Student",
          pin: "1122",
        },
      ],
      classes: [
        {
          id: "fictional-kiosk-class",
          name: "Fictional Period",
          members: [
            {
              studentId: "fictional-kiosk-student",
              lastPrefix: "Example",
              status: "current",
            },
            {
              studentId: "fictional-direct-student",
              lastPrefix: "Sample",
              status: "current",
            },
          ],
        },
      ],
      destinations: [
        {
          id: "fictional-private-destination",
          label: "Fictional counselling room",
          private: true,
          kioskAvailable: true,
          hubArrivalChime: "bright",
          hubPromptVersion: 1,
          hubArrivalPrompts: [
            {
              id: "fictional-arrival-rating",
              question: "How are you feeling?",
              responseType: "rating",
              required: true,
              scaleMax: 5,
              ratingStyle: "numbers",
            },
          ],
          hubDeparturePrompts: [
            {
              id: "fictional-departure-reflection",
              question: "What would help next?",
              responseType: "written",
              required: true,
            },
          ],
        },
        {
          id: "fictional-temporary-destination",
          label: "Bathroom",
          kioskConfirmation: "Your Hub arrival is saved. Take a moment to settle in.",
          temporaryTripAvailable: true,
          hubArrivalChime: "soft",
          hubPromptVersion: 1,
          hubArrivalPrompts: [
            {
              id: "fictional-direct-arrival",
              question: "Are you ready to sign in?",
              responseType: "rating",
              required: true,
              scaleMax: 5,
              ratingStyle: "numbers",
            },
          ],
        },
      ],
      hubKioskSoundSettings: {
        muted: false,
        volume: 65,
        commonChime: "warm",
      },
      hubVisits: [
        {
          id: "fictional-kiosk-visit",
          studentId: "fictional-kiosk-student",
          studentName: "Avery Example",
          destinationId: "fictional-private-destination",
          destinationLabel: "Fictional counselling room",
          classId: "fictional-kiosk-class",
          className: "Fictional Period",
          source: "classroom-notification",
          leftClassAt,
          hasConcern: true,
          concernNote: "Fictional private concern",
          temporaryTrips: [],
        },
      ],
      visits: [],
    };
    const saved = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: {
        Cookie: ticCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 0, snapshot }),
    });
    expect(saved.status).toBe(200);

    const started = await fetch(`${host.url}/api/v1/kiosk/start`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    });
    expect(started.status).toBe(201);
    expect(started.headers.get("set-cookie")).toBeNull();
    const supersededTicket = await started.json();
    const currentActivation = await fetch(`${host.url}/api/v1/kiosk/start`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    });
    const activation = await currentActivation.json();
    expect(typeof activation.token).toBe("string");
    expect(activation.token.length).toBe(43);
    expect(typeof activation.expiresAt).toBe("string");
    expect(Date.parse(activation.expiresAt)).toBeGreaterThan(Date.now());
    const superseded = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: supersededTicket.token }),
    });
    expect(superseded.status).toBe(401);

    const useInStaffProfile = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: {
        Cookie: ticCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: activation.token }),
    });
    expect(useInStaffProfile.status).toBe(409);

    const activated = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: activation.token }),
    });
    expect(activated.status).toBe(201);
    const kioskCookie = activated.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(activated.headers.get("set-cookie")).toContain("HttpOnly");
    expect(activated.headers.get("set-cookie")).toContain("Path=/api/v1/kiosk");
    expect(activated.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(kioskCookie).toMatch(/^hh_hub_kiosk=/);

    const ticketDatabase = new Database(path);
    const ticketHash = createHash("sha256")
      .update(activation.token)
      .digest("hex");
    expect(
      ticketDatabase
        .query("SELECT token_hash FROM hub_kiosk_tickets WHERE token_hash = ?")
        .get(ticketHash),
    ).toBeTruthy();
    expect(ticketHash).not.toBe(activation.token);
    ticketDatabase.close();

    const kioskRequest = { Cookie: kioskCookie };
    expect(
      (
        await fetch(`${host.url}/api/v1/state`, { headers: kioskRequest })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${host.url}/api/v1/session`, { headers: kioskRequest })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/stop`, {
          method: "POST",
          headers: kioskRequest,
        })
      ).status,
    ).toBe(401);

    const kioskStateResponse = await fetch(
      `${host.url}/api/v1/kiosk/state`,
      { headers: kioskRequest },
    );
    const kioskState = await kioskStateResponse.json();
    expect(kioskStateResponse.status).toBe(200);
    expect(kioskState.students).toEqual([
      {
        id: "fictional-kiosk-student",
        studentName: "Avery E.",
        status: "on-the-way",
        pinRequired: true,
        visitId: "fictional-kiosk-visit",
        destinationLabel: "Private destination",
        promptVersion: 1,
        arrivalPrompts: [
          {
            id: "fictional-arrival-rating",
            question: "How are you feeling?",
            responseType: "rating",
            required: true,
            scaleMax: 5,
            ratingStyle: "numbers",
          },
        ],
      },
      {
        id: "fictional-direct-student",
        studentName: "Riley S.",
        status: "in-class",
        pinRequired: true,
      },
    ]);
    expect(kioskState.destinations).toEqual([
      {
        id: "fictional-private-destination",
        label: "Private destination",
        promptVersion: 1,
        arrivalPrompts: [
          {
            id: "fictional-arrival-rating",
            question: "How are you feeling?",
            responseType: "rating",
            required: true,
            scaleMax: 5,
            ratingStyle: "numbers",
          },
        ],
      },
      {
        id: "fictional-temporary-destination",
        label: "Bathroom",
        promptVersion: 1,
        arrivalPrompts: [
          {
            id: "fictional-direct-arrival",
            question: "Are you ready to sign in?",
            responseType: "rating",
            required: true,
            scaleMax: 5,
            ratingStyle: "numbers",
          },
        ],
      },
    ]);
    expect(kioskState.temporaryDestinations).toEqual([
      {
        id: "fictional-temporary-destination",
        label: "Bathroom",
        promptVersion: 1,
        arrivalPrompts: [],
      },
    ]);
    expect(kioskState.soundSettings).toEqual({
      muted: false,
      volume: 65,
      commonChime: "warm",
    });
    expect(JSON.stringify(kioskState)).not.toContain("Fictional private concern");
    expect(JSON.stringify(kioskState)).not.toContain("4567");
    expect(JSON.stringify(kioskState)).not.toContain("heightenedMonitoring");

    const arrive = async (
      pin: string,
      promptData: Record<string, unknown> = {},
    ) =>
      fetch(`${host.url}/api/v1/kiosk/movements`, {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          visitId: "fictional-kiosk-visit",
          action: "arrive",
          pin,
          ...promptData,
        }),
      });
    const wrongPin = await arrive("0000");
    expect(wrongPin.status).toBe(403);
    expect(await wrongPin.json()).toMatchObject({
      error: "invalid_student_pin",
    });
    const missingArrivalAnswer = await arrive("4567", {
      promptVersion: 1,
      promptAnswers: {},
    });
    expect(missingArrivalAnswer.status).toBe(422);
    expect(await missingArrivalAnswer.json()).toMatchObject({
      error: "required_hub_prompt_missing",
    });
    const staleArrivalAnswer = await arrive("4567", {
      promptVersion: 2,
      promptAnswers: { "fictional-arrival-rating": 4 },
    });
    expect(staleArrivalAnswer.status).toBe(409);
    expect(await staleArrivalAnswer.json()).toMatchObject({
      error: "hub_prompt_configuration_changed",
    });
    const invalidRating = await arrive("4567", {
      promptVersion: 1,
      promptAnswers: { "fictional-arrival-rating": 8 },
    });
    expect(invalidRating.status).toBe(400);
    expect(await invalidRating.json()).toMatchObject({
      error: "invalid_hub_prompt_response",
    });
    const arrived = await arrive("4567", {
      promptVersion: 1,
      promptAnswers: { "fictional-arrival-rating": 4 },
    });
    expect(arrived.status).toBe(200);
    expect(await arrived.json()).toMatchObject({
      accepted: true,
      revision: 2,
      chime: "bright",
      confirmationMessage:
        "Your arrival at Private destination was saved by the Hub Host.",
    });
    const stateAtHub = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const arrivedVisit = stateAtHub.snapshot.hubVisits[0];
    expect(arrivedVisit.arrivedBy).toEqual({ type: "student-kiosk" });
    expect(arrivedVisit.promptResponses).toEqual([
      {
        promptId: "fictional-arrival-rating",
        promptVersion: 1,
        destinationId: "fictional-private-destination",
        stage: "arrival",
        question: "How are you feeling?",
        responseType: "rating",
        required: true,
        scaleMax: 5,
        ratingStyle: "numbers",
        answer: 4,
        answeredAt: arrivedVisit.promptResponses[0].answeredAt,
      },
    ]);
    const updatedPromptSnapshot = stateAtHub.snapshot;
    updatedPromptSnapshot.destinations[0].hubPromptVersion = 2;
    updatedPromptSnapshot.destinations[0].hubArrivalPrompts[0].question =
      "How are you feeling now?";
    const promptEdit = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: {
        Cookie: ticCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: stateAtHub.revision,
        snapshot: updatedPromptSnapshot,
      }),
    });
    expect(promptEdit.status).toBe(200);
    const afterPromptEdit = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(afterPromptEdit.snapshot.hubVisits[0].promptResponses[0]).toMatchObject({
      question: "How are you feeling?",
      answer: 4,
      promptVersion: 1,
    });
    expect(afterPromptEdit.snapshot.destinations[0].hubArrivalPrompts[0]).toMatchObject({
      question: "How are you feeling now?",
    });
    expect(Date.parse(arrivedVisit.arrivedAtHubAt)).toBeGreaterThanOrEqual(
      Date.parse(leftClassAt),
    );
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: kioskRequest,
        }).then((response) => response.json())
      ).students.find(
        (student: { id: string }) =>
          student.id === "fictional-kiosk-student",
      ),
    ).toMatchObject({
      status: "at-hub",
      destinationLabel: "Private destination",
    });

    const temporaryStart = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "temporary-start",
          visitId: "fictional-kiosk-visit",
          destinationId: "fictional-temporary-destination",
          pin: "4567",
        }),
      },
    );
    expect(temporaryStart.status).toBe(200);
    const stateOnTrip = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const trip = stateOnTrip.snapshot.hubVisits[0].temporaryTrips[0];
    expect(trip).toMatchObject({
      destinationId: "fictional-temporary-destination",
      destinationLabel: "Bathroom",
      startedBy: { type: "student-kiosk" },
    });
    expect(Date.parse(trip.startedAt)).toBeGreaterThanOrEqual(
      Date.parse(arrivedVisit.arrivedAtHubAt),
    );
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: kioskRequest,
        }).then((response) => response.json())
      ).students.find(
        (student: { id: string }) =>
          student.id === "fictional-kiosk-student",
      ),
    ).toMatchObject({
      status: "on-temporary-trip",
      temporaryTripLabel: "Bathroom",
    });

    const temporaryReturn = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "temporary-return",
          visitId: "fictional-kiosk-visit",
          pin: "4567",
        }),
      },
    );
    expect(temporaryReturn.status).toBe(200);
    expect(await temporaryReturn.json()).toMatchObject({
      accepted: true,
      chime: "warm",
    });
    const stateAfterTrip = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const returnedTrip = stateAfterTrip.snapshot.hubVisits[0].temporaryTrips[0];
    expect(returnedTrip.returnedBy).toEqual({ type: "student-kiosk" });
    expect(Date.parse(returnedTrip.returnedAt)).toBeGreaterThanOrEqual(
      Date.parse(returnedTrip.startedAt),
    );

    const missingDepartureAnswer = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          visitId: "fictional-kiosk-visit",
          action: "leave",
          pin: "4567",
          promptVersion: 2,
          promptAnswers: {},
        }),
      },
    );
    expect(missingDepartureAnswer.status).toBe(422);
    const staleDepartureAnswer = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          visitId: "fictional-kiosk-visit",
          action: "leave",
          pin: "4567",
          promptVersion: 1,
          promptAnswers: {
            "fictional-departure-reflection": "Return to class calmly.",
          },
        }),
      },
    );
    expect(staleDepartureAnswer.status).toBe(409);
    const left = await fetch(`${host.url}/api/v1/kiosk/movements`, {
      method: "POST",
      headers: {
        ...kioskRequest,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        visitId: "fictional-kiosk-visit",
        action: "leave",
        pin: "4567",
        promptVersion: 2,
        promptAnswers: {
          "fictional-departure-reflection": "Return to class calmly.",
        },
      }),
    });
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({
      accepted: true,
      chime: "warm",
    });
    const afterLeave = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const leftVisit = afterLeave.snapshot.hubVisits[0];
    expect(Date.parse(leftVisit.leftHubAt)).toBeGreaterThanOrEqual(
      Date.parse(leftVisit.arrivedAtHubAt),
    );
    expect(leftVisit.leftBy).toEqual({ type: "student-kiosk" });
    expect(leftVisit.promptResponses).toHaveLength(2);
    expect(leftVisit.promptResponses[1]).toMatchObject({
      promptId: "fictional-departure-reflection",
      promptVersion: 2,
      stage: "departure",
      question: "What would help next?",
      answer: "Return to class calmly.",
    });
    expect(leftVisit.arrivedBackAtClassAt).toBeUndefined();
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: kioskRequest,
        }).then((response) => response.json())
      ).students.find(
        (student: { id: string }) =>
          student.id === "fictional-kiosk-student",
      ),
    ).toMatchObject({ status: "left-hub-awaiting-class" });

    const rejectedFormerStudent = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "direct-arrive",
          studentId: "fictional-former-student",
          destinationId: "fictional-private-destination",
          pin: "1122",
        }),
      },
    );
    expect(rejectedFormerStudent.status).toBe(403);

    const unauthenticatedPromptOverride = await fetch(
      `${host.url}/api/v1/hub/prompt-overrides`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: "fictional-direct-student",
          destinationId: "fictional-temporary-destination",
          stage: "arrival",
          reason: "Student cannot answer right now",
        }),
      },
    );
    expect(unauthenticatedPromptOverride.status).toBe(401);
    const issuedPromptOverride = await fetch(
      `${host.url}/api/v1/hub/prompt-overrides`,
      {
        method: "POST",
        headers: {
          Cookie: ticCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          studentId: "fictional-direct-student",
          destinationId: "fictional-temporary-destination",
          stage: "arrival",
          reason: "Student cannot answer right now",
        }),
      },
    );
    expect(issuedPromptOverride.status).toBe(201);
    const overrideReceipt = await issuedPromptOverride.json();
    expect(Date.parse(overrideReceipt.expiresAt)).toBeGreaterThan(Date.now());
    const kioskWithOverride = await fetch(
      `${host.url}/api/v1/kiosk/state`,
      { headers: kioskRequest },
    ).then((response) => response.json());
    expect(kioskWithOverride.promptOverrides).toContainEqual({
      studentId: "fictional-direct-student",
      destinationId: "fictional-temporary-destination",
      stage: "arrival",
    });
    expect(JSON.stringify(kioskWithOverride)).not.toContain(
      "Student cannot answer right now",
    );
    expect(kioskWithOverride.promptOverrides).toEqual([
      {
        studentId: "fictional-direct-student",
        destinationId: "fictional-temporary-destination",
        stage: "arrival",
      },
    ]);
    expect(
      kioskWithOverride.destinations.find(
        (destination: { id: string }) =>
          destination.id === "fictional-temporary-destination",
      ).arrivalPrompts[0].required,
    ).toBe(true);
    const directArrival = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "direct-arrive",
          studentId: "fictional-direct-student",
          destinationId: "fictional-temporary-destination",
          pin: "7890",
          promptVersion: 1,
          promptAnswers: {},
        }),
      },
    );
    expect(directArrival.status).toBe(200);
    expect(await directArrival.json()).toMatchObject({
      accepted: true,
      chime: "soft",
      confirmationMessage:
        "Your Hub arrival is saved. Take a moment to settle in.",
    });
    const afterDirectArrival = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const directVisit = afterDirectArrival.snapshot.hubVisits.find(
      (visit: { studentId: string }) =>
        visit.studentId === "fictional-direct-student",
    );
    expect(directVisit).toMatchObject({
      studentId: "fictional-direct-student",
      source: "direct-kiosk-arrival",
      destinationId: "fictional-temporary-destination",
      arrivedBy: { type: "student-kiosk" },
      temporaryTrips: [],
    });
    expect(directVisit.leftClassAt).toBeUndefined();
    expect(directVisit.promptResponses).toBeUndefined();
    expect(directVisit.promptOverrides).toMatchObject([
      {
        destinationId: "fictional-temporary-destination",
        stage: "arrival",
        promptVersion: 1,
        reason: "Student cannot answer right now",
        usedToSkip: true,
        requestedBy: {
          displayName: "TIC Example",
          role: "tic",
        },
      },
    ]);
    const kioskAfterOverrideUse = await fetch(
      `${host.url}/api/v1/kiosk/state`,
      { headers: kioskRequest },
    ).then((response) => response.json());
    expect(kioskAfterOverrideUse.promptOverrides).not.toContainEqual({
      studentId: "fictional-direct-student",
      destinationId: "fictional-temporary-destination",
      stage: "arrival",
    });
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: kioskRequest,
        }).then((response) => response.json())
      ).students.find(
        (student: { id: string }) =>
          student.id === "fictional-direct-student",
      ),
    ).toMatchObject({
      status: "at-hub",
      destinationLabel: "Bathroom",
    });
    const duplicateDirectArrival = await fetch(
      `${host.url}/api/v1/kiosk/movements`,
      {
        method: "POST",
        headers: {
          ...kioskRequest,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "direct-arrive",
          studentId: "fictional-direct-student",
          destinationId: "fictional-temporary-destination",
          pin: "7890",
        }),
      },
    );
    expect(duplicateDirectArrival.status).toBe(403);

    const reused = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: activation.token }),
    });
    expect(reused.status).toBe(401);

    const replacementTicket = await fetch(`${host.url}/api/v1/kiosk/start`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const replacementSession = await fetch(
      `${host.url}/api/v1/kiosk/activate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: replacementTicket.token }),
      },
    );
    expect(replacementSession.status).toBe(201);
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: kioskRequest,
        })
      ).status,
    ).toBe(401);
    const replacementCookie =
      replacementSession.headers.get("set-cookie")?.split(";")[0] ?? "";

    const expiredTicket = await fetch(`${host.url}/api/v1/kiosk/start`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const expiredDatabase = new Database(path);
    expiredDatabase
      .query(
        "UPDATE hub_kiosk_tickets SET expires_at = ? WHERE token_hash = ?",
      )
      .run(
        new Date(Date.now() - 1000).toISOString(),
        createHash("sha256").update(expiredTicket.token).digest("hex"),
      );
    expiredDatabase.close();
    const expired = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expiredTicket.token }),
    });
    expect(expired.status).toBe(401);

    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/stop`, {
          method: "POST",
          headers: { Cookie: ea.cookie ?? "" },
        })
      ).status,
    ).toBe(403);
    const stopped = await fetch(`${host.url}/api/v1/kiosk/stop`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      stoppedCount: 1,
      revokedActivationCount: 1,
    });
    expect(
      (
        await fetch(`${host.url}/api/v1/kiosk/state`, {
          headers: { Cookie: replacementCookie },
        })
      ).status,
    ).toBe(401);

    const audit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(
      audit.events.some(
        (event: {
          eventType: string;
          details: { source: string; hubVisitId: string };
        }) =>
          event.eventType === "hub_visit_kiosk_arrived" &&
          event.details.source === "student-kiosk" &&
          event.details.hubVisitId === "fictional-kiosk-visit",
      ),
    ).toBe(true);
    for (const eventType of [
      "hub_visit_kiosk_temporary_trip_started",
      "hub_visit_kiosk_temporary_trip_returned",
      "hub_visit_kiosk_left",
      "hub_visit_kiosk_direct_arrived",
    ]) {
      expect(
        audit.events.some(
          (event: { eventType: string; details: { source: string } }) =>
            event.eventType === eventType &&
            event.details.source === "student-kiosk",
        ),
      ).toBe(true);
    }
    expect(
      audit.events.some(
        (event: { eventType: string; actorStaffId: string }) =>
          event.eventType === "hub_kiosk_stopped" &&
          event.actorStaffId === tic.body.staffId,
      ),
    ).toBe(true);
  });

  test("keeps an activated kiosk session across a Host restart", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    const saved = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: {
        Cookie: ticCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: {
          version: 4,
          roster: [],
          classes: [],
          destinations: [],
          hubVisits: [],
        },
      }),
    });
    expect(saved.status).toBe(200);
    const activation = await fetch(`${host.url}/api/v1/kiosk/start`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const activated = await fetch(`${host.url}/api/v1/kiosk/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: activation.token }),
    });
    expect(activated.status).toBe(201);
    const kioskCookie = activated.headers.get("set-cookie")?.split(";")[0] ?? "";

    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);
    const restarted = await startTestHost(path);
    expect(
      (
        await fetch(`${restarted.url}/api/v1/kiosk/state`, {
          headers: { Cookie: kioskCookie },
        })
      ).status,
    ).toBe(200);
    const stopped = await fetch(`${restarted.url}/api/v1/kiosk/stop`, {
      method: "POST",
      headers: { Cookie: ticCookie },
    });
    expect(await stopped.json()).toMatchObject({ stoppedCount: 1 });
    expect(
      (
        await fetch(`${restarted.url}/api/v1/kiosk/state`, {
          headers: { Cookie: kioskCookie },
        })
      ).status,
    ).toBe(401);
  });

  test("keeps favourites personal to each staff profile across Host restarts", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    const inviteEA = async (displayName: string) => {
      const invitation = await fetch(`${host.url}/api/v1/invitations`, {
        method: "POST",
        headers: {
          Cookie: ticCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "ea" }),
      }).then((response) => response.json());
      return enroll(host, invitation.invitation.token, displayName);
    };
    const first = await inviteEA("EA One");
    const second = await inviteEA("EA Two");
    const firstCookie = first.cookie ?? "";
    const secondCookie = second.cookie ?? "";

    expect((await fetch(`${host.url}/api/v1/preferences`)).status).toBe(401);
    expect(
      await fetch(`${host.url}/api/v1/preferences`, {
        headers: { Cookie: firstCookie },
      }).then((response) => response.json()),
    ).toMatchObject({ favouriteStudentIds: [], updatedAt: null });

    const saved = await fetch(`${host.url}/api/v1/preferences`, {
      method: "PUT",
      headers: {
        Cookie: firstCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        favouriteStudentIds: ["fictional-student-1", "fictional-student-2"],
      }),
    });
    expect(saved.status).toBe(200);
    const savedPreferences = await saved.json();
    expect(savedPreferences.favouriteStudentIds).toEqual([
      "fictional-student-1",
      "fictional-student-2",
    ]);
    expect(Date.parse(savedPreferences.updatedAt)).not.toBeNaN();

    expect(
      (
        await fetch(`${host.url}/api/v1/preferences`, {
          headers: { Cookie: firstCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      await fetch(`${host.url}/api/v1/preferences`, {
        headers: { Cookie: secondCookie },
      }).then((response) => response.json()),
    ).toMatchObject({ favouriteStudentIds: [], updatedAt: null });
    expect(
      (
        await fetch(`${host.url}/api/v1/preferences`, {
          method: "PUT",
          headers: {
            Cookie: firstCookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            favouriteStudentIds: ["fictional-student-3"],
            staffId: second.body.staffId,
          }),
        })
      ).status,
    ).toBe(400);

    await host.close();
    const restarted = await startTestHost(path);
    const preferencesAfterRestart = await fetch(
      `${restarted.url}/api/v1/preferences`,
      { headers: { Cookie: firstCookie } },
    ).then((response) => response.json());
    expect(preferencesAfterRestart.favouriteStudentIds).toEqual([
      "fictional-student-1",
      "fictional-student-2",
    ]);
    expect(Date.parse(preferencesAfterRestart.updatedAt)).not.toBeNaN();
  });

  test("routes concern notes to selected staff, preserves inbox messages, and withholds notes from others", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const ticCookie = tic.cookie ?? "";
    async function inviteEa(displayName: string) {
      const invitation = await fetch(`${host.url}/api/v1/invitations`, {
        method: "POST",
        headers: { Cookie: ticCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "ea" }),
      }).then((response) => response.json());
      return enroll(host, invitation.invitation.token, displayName);
    }
    const sender = await inviteEa("EA Sender");
    const recipient = await inviteEa("EA Recipient");
    const otherStaff = await inviteEa("EA Other");
    const senderCookie = sender.cookie ?? "";
    const recipientCookie = recipient.cookie ?? "";
    const otherCookie = otherStaff.cookie ?? "";

    const initialSnapshot = {
      version: 4,
      roster: [
        {
          id: "fictional-student-concern",
          firstName: "Avery",
          lastName: "Example",
        },
      ],
      destinations: [
        {
          id: "wellbeing",
          label: "Wellbeing",
          informHubAvailable: true,
        },
      ],
      hubVisits: [],
      classes: [
        {
          id: "fictional-class-concern",
          name: "Period A",
          members: [
            {
              studentId: "fictional-student-concern",
              lastPrefix: "E",
              status: "current",
            },
          ],
        },
      ],
      activeClass: {
        id: "fictional-class-concern",
        changedAt: "2026-11-12T00:00:00.000Z",
      },
    };
    const seeded = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: ticCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: initialSnapshot,
      }),
    });
    expect(seeded.status).toBe(200);
    const defaultPolicy = await fetch(
      `${host.url}/api/v1/concerns/settings`,
      { headers: { Cookie: senderCookie } },
    ).then((response) => response.json());
    expect(defaultPolicy).toMatchObject({
      availableScopes: ["tic", "all-staff", "selected"],
      defaultScope: "tic",
    });
    const forbiddenPolicyEdit = await fetch(
      `${host.url}/api/v1/concerns/settings`,
      {
        method: "PUT",
        headers: {
          Cookie: senderCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          availableScopes: ["tic", "selected"],
          defaultScope: "tic",
        }),
      },
    );
    expect(forbiddenPolicyEdit.status).toBe(403);
    const savedPolicy = await fetch(
      `${host.url}/api/v1/concerns/settings`,
      {
        method: "PUT",
        headers: { Cookie: ticCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          availableScopes: ["tic", "selected"],
          defaultScope: "selected",
        }),
      },
    );
    expect(savedPolicy.status).toBe(200);
    expect(await savedPolicy.json()).toMatchObject({
      availableScopes: ["tic", "selected"],
      defaultScope: "selected",
    });
    const senderState = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: senderCookie },
    }).then((response) => response.json());
    const visit = {
      id: "fictional-hub-visit-concern",
      studentId: "fictional-student-concern",
      studentName: "Avery Example",
      destinationId: "wellbeing",
      destinationLabel: "Wellbeing",
      classId: "fictional-class-concern",
      className: "Period A",
      source: "classroom-notification",
      leftClassAt: "2026-11-12T01:00:00.000Z",
      hasConcern: true,
      temporaryTrips: [],
    };
    const movementSave = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: senderCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: senderState.revision,
        baseSnapshot: senderState.snapshot,
        snapshot: {
          ...senderState.snapshot,
          hubVisits: [visit],
        },
      }),
    });
    expect(movementSave.status).toBe(200);
    const savedMovement = await movementSave.json();
    expect(savedMovement.snapshot.hubVisits[0]).toMatchObject({
      hasConcern: true,
      notifiedBy: { staffId: sender.body.staffId, role: "ea" },
    });

    const directory = await fetch(`${host.url}/api/v1/mail/recipients`, {
      headers: { Cookie: senderCookie },
    }).then((response) => response.json());
    const listedRecipient = directory.recipients.find(
      (profile: { staffId: string }) =>
        profile.staffId === recipient.body.staffId,
    );
    expect(listedRecipient).toMatchObject({
      staffId: recipient.body.staffId,
      displayName: "EA Recipient",
      role: "ea",
    });

    const note = "Fictional note visible only to authorised staff.";
    const disabledRoute = await fetch(`${host.url}/api/v1/concerns`, {
      method: "POST",
      headers: { Cookie: senderCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        visitId: visit.id,
        note,
        scope: "all-staff",
        recipientIds: [],
      }),
    });
    expect(disabledRoute.status).toBe(400);
    const sent = await fetch(`${host.url}/api/v1/concerns`, {
      method: "POST",
      headers: { Cookie: senderCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        visitId: visit.id,
        note,
        scope: "selected",
        recipientIds: [recipient.body.staffId],
      }),
    });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({
      visitId: visit.id,
      note,
      scope: "selected",
      senderStaffId: sender.body.staffId,
      recipients: [
        {
          staffId: recipient.body.staffId,
          displayName: "EA Recipient",
          role: "ea",
        },
      ],
      isSender: true,
    });

    const recipientMail = await fetch(`${host.url}/api/v1/mail`, {
      headers: { Cookie: recipientCookie },
    }).then((response) => response.json());
    expect(recipientMail).toMatchObject({
      unreadCount: 1,
      messages: [
        {
          note,
          isRecipient: true,
          readAt: null,
          senderDisplayName: "EA Sender",
        },
      ],
    });
    const senderMail = await fetch(`${host.url}/api/v1/mail`, {
      headers: { Cookie: senderCookie },
    }).then((response) => response.json());
    expect(senderMail.messages).toHaveLength(1);
    const otherMail = await fetch(`${host.url}/api/v1/mail`, {
      headers: { Cookie: otherCookie },
    }).then((response) => response.json());
    expect(otherMail).toEqual({ messages: [], unreadCount: 0 });
    expect(JSON.stringify(otherMail)).not.toContain(note);
    const otherState = await fetch(`${host.url}/api/v1/state`, {
      headers: { Cookie: otherCookie },
    }).then((response) => response.json());
    expect(otherState.snapshot.hubVisits[0]).toMatchObject({
      hasConcern: true,
    });
    expect(JSON.stringify(otherState)).not.toContain(note);

    const ticMail = await fetch(`${host.url}/api/v1/mail`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    expect(ticMail.messages).toMatchObject([
      { note, isTicOversight: true, isRecipient: false },
    ]);

    const messageId = recipientMail.messages[0].id;
    const forbiddenRead = await fetch(
      `${host.url}/api/v1/mail/${messageId}/read`,
      { method: "POST", headers: { Cookie: otherCookie } },
    );
    expect(forbiddenRead.status).toBe(404);
    const markedRead = await fetch(
      `${host.url}/api/v1/mail/${messageId}/read`,
      { method: "POST", headers: { Cookie: recipientCookie } },
    );
    expect(markedRead.status).toBe(200);
    expect(
      await fetch(`${host.url}/api/v1/mail`, {
        headers: { Cookie: recipientCookie },
      }).then((response) => response.json()),
    ).toMatchObject({ unreadCount: 0 });

    const retry = await fetch(`${host.url}/api/v1/concerns`, {
      method: "POST",
      headers: { Cookie: senderCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        visitId: visit.id,
        note: "A conflicting retry must not replace the original note.",
        scope: "selected",
        recipientIds: [recipient.body.staffId],
      }),
    });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({
      note,
      scope: "selected",
      recipients: [{ staffId: recipient.body.staffId }],
    });

    const audit = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: ticCookie },
    }).then((response) => response.json());
    const concernEvent = audit.events.find(
      (event: { eventType: string }) => event.eventType === "hub_concern_sent",
    );
    expect(concernEvent.details).toMatchObject({
      hubVisitId: visit.id,
      routingScope: "selected",
      recipientStaffIds: [recipient.body.staffId],
    });
    expect(JSON.stringify(concernEvent)).not.toContain(note);

    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);
    const restarted = await startTestHost(path);
    expect(
      await fetch(`${restarted.url}/api/v1/concerns/settings`, {
        headers: { Cookie: ticCookie },
      }).then((response) => response.json()),
    ).toMatchObject({
      availableScopes: ["tic", "selected"],
      defaultScope: "selected",
    });
    expect(
      await fetch(`${restarted.url}/api/v1/mail`, {
        headers: { Cookie: recipientCookie },
      }).then((response) => response.json()),
    ).toMatchObject({
      unreadCount: 0,
      messages: [{ note, recipients: [{ staffId: recipient.body.staffId }] }],
    });
  });

  test("links an Entra identity to an email-invited staff profile", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const store = new HubStore(path);
    try {
      const ticToken = tic.cookie?.split("=")[1] ?? "";
      const ticActor = store.getSession(ticToken);
      expect(ticActor?.role).toBe("tic");
      expect(() =>
        store.createInvitation(
          "ea",
          ticActor!,
          ticActor!.staffId,
          "tic.example@school.edu.au",
        ),
      ).toThrow(/keep that profile's role/);
      const invitation = store.createInvitation(
        "ea",
        ticActor!,
        null,
        "ea.example@school.edu.au",
      );
      const state = "entra-state-example-1234567890";
      const nonce = "entra-nonce-example-1234567890";
      store.beginEntraLogin(state, nonce, invitation.token);
      expect(store.getEntraAuthNonce(state)).toBe(nonce);
      const firstSignIn = store.completeEntraLogin(state, {
        tenantId: "00000000-0000-0000-0000-000000000001",
        objectId: "00000000-0000-0000-0000-000000000002",
        displayName: "EA Example",
        email: "EA.Example@school.edu.au",
      });
      expect(firstSignIn.actor).toMatchObject({
        displayName: "EA Example",
        role: "ea",
        authMethod: "microsoft-entra-oidc",
      });
      expect(store.getEntraAuthNonce(state)).toBeNull();
      expect(store.getSession(firstSignIn.sessionToken)?.staffId).toBe(
        firstSignIn.actor.staffId,
      );
      expect(() =>
        store.completeEntraLogin(state, {
          tenantId: "00000000-0000-0000-0000-000000000001",
          objectId: "00000000-0000-0000-0000-000000000002",
          displayName: "EA Example",
          email: "ea.example@school.edu.au",
        }),
      ).toThrow();

      const nextState = "entra-state-example-0987654321";
      store.beginEntraLogin(nextState, "new-entra-nonce-example", undefined);
      const returningSignIn = store.completeEntraLogin(nextState, {
        tenantId: "00000000-0000-0000-0000-000000000001",
        objectId: "00000000-0000-0000-0000-000000000002",
        displayName: "EA Example Updated",
        email: "ea.example@school.edu.au",
      });
      expect(returningSignIn.actor.staffId).toBe(firstSignIn.actor.staffId);
    } finally {
      store.close();
    }
  });

  test("keeps the snapshot and enrolled session after a host restart", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const snapshot = {
      version: 4,
      classes: [{ id: "fictional-class-1", name: "Example Class" }],
      hubVisits: [
        {
          id: "fictional-hub-visit-2",
          studentId: "fictional-student-2",
          studentName: "Riley Example",
          destinationLabel: "Check-in",
          source: "direct-kiosk-arrival",
          arrivedAtHubAt: "2026-11-12T02:00:00.000Z",
          temporaryTrips: [],
        },
      ],
      visits: [],
    };
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: tic.cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot }),
    });
    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);
    const restarted = await startTestHost(path);
    expect(
      (
        await fetch(`${restarted.url}/api/v1/session`, {
          headers: { Cookie: tic.cookie ?? "" },
        })
      ).status,
    ).toBe(200);
    expect(
      await fetch(`${restarted.url}/api/v1/state`, {
        headers: { Cookie: tic.cookie ?? "" },
      }).then((r) => r.json()),
    ).toMatchObject({ revision: 1, snapshot });
  });

  test("creates an email-bound Entra invitation for the first TIC", () => {
    const path = temporaryDatabase();
    const store = new HubStore(path);
    const invitation = store.createBootstrapTicInvitation(
      undefined,
      "first.tic@example.edu",
    );
    expect(invitation).toMatchObject({
      role: "tic",
      invitedEmail: "first.tic@example.edu",
    });
    expect(
      store.beginEntraLogin("fictional-state", "fictional-nonce", invitation.token),
    ).toBe("fictional-nonce");
    expect(store.getEntraAuthNonce("fictional-state")).toBe("fictional-nonce");
    store.close();
  });

  test("refuses a second bootstrap invitation after an active invitation or profile exists", () => {
    const path = temporaryDatabase();
    const store = new HubStore(path);
    expect(store.createBootstrapTicInvitation().status).toBe("pending");
    expect(() => store.createBootstrapTicInvitation()).toThrow();
    store.close();
  });

  test("reports healthy SQLite, refuses LAN binding, and checks Host and Origin", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    expect(
      await fetch(`${host.url}/api/v1/health`).then((r) => r.json()),
    ).toMatchObject({
      status: "ready",
      storage: "sqlite",
      revision: 0,
      network: { mode: "loopback_only", schoolLanTest: "not_verified" },
    });
    await expect(
      startHubHost({
        databasePath: temporaryDatabase(),
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow(/LAN binding is disabled/);
    await expect(
      startHubHost({
        databasePath: temporaryDatabase(),
        host: "0.0.0.0",
        port: 0,
        allowLan: true,
      }),
    ).rejects.toThrow(/HTTPS certificate, key, and public host/);
    await expect(
      startHubHost({
        databasePath: temporaryDatabase(),
        host: "127.0.0.1",
        port: 0,
        allowLan: true,
        tls: {
          certificate: "fictional certificate",
          privateKey: "fictional key",
          publicHost: "hub.example.test",
        },
      }),
    ).rejects.toThrow(/non-loopback bind address/);
    expect(
      (
        await fetch(`${host.url}/api/v1/health`, {
          headers: { Host: "outside.example" },
        })
      ).status,
    ).toBe(421);
    expect(
      (
        await fetch(`${host.url}/api/v1/health`, {
          headers: { Origin: "http://outside.example" },
        })
      ).status,
    ).toBe(403);
  });

  test("requires ICT MFA, HTTPS LAN, and an encrypted-backup key before Entra sign-in", async () => {
    const path = temporaryDatabase();
    const entra = {
      tenantId: "fictional-tenant-id",
      clientId: "fictional-client-id",
      redirectUri: "https://hub.example.edu:8787/api/v1/auth/entra/callback",
      certificateThumbprintSha256: "a".repeat(64),
      privateKey: Buffer.from("fictional private key"),
      mfaPolicyConfirmed: false,
    };
    const lanOptions = {
      databasePath: path,
      host: "0.0.0.0",
      allowLan: true,
      tls: {
        certificate: "fictional certificate",
        privateKey: "fictional private key",
        publicHost: "hub.example.edu",
      },
    };
    await expect(
      startHubHost({
        ...lanOptions,
        entra,
        backupEncryptionKey: randomBytes(32),
      }),
    ).rejects.toThrow("Entra sign-in requires ICT-confirmed MFA policy");
    await expect(
      startHubHost({
        ...lanOptions,
        entra: { ...entra, mfaPolicyConfirmed: true },
      }),
    ).rejects.toThrow("Entra sign-in requires ICT-confirmed MFA policy");
  });

  test("creates verified local snapshots, copies them off-host, and exposes accurate limits", async () => {
    const path = temporaryDatabase();
    const offHostDirectory = `${path}.approved-share`;
    const seedStore = new HubStore(path);
    seedStore.save(
      {
        version: 2,
        roster: [
          {
            id: "fictional-student-3",
            firstName: "Riley",
            lastName: "Example",
          },
        ],
        visits: [
          {
            id: "fictional-visit-2",
            arrivedAt: "2026-11-12T01:15:00.000Z",
          },
          {
            id: "fictional-visit-3",
            arrivedAt: "2026-11-12T02:30:00.000Z",
          },
        ],
      },
      0,
      {
        sessionId: "fictional-session-seed",
        staffId: "fictional-staff-tic",
        displayName: "TIC Example",
        role: "tic",
        authMethod: "named-profile-device-enrolment-fallback",
        expiresAt: "2026-11-13T00:00:00.000Z",
      },
    );
    seedStore.close();
    const host = await startTestHost(path, offHostDirectory);
    const tic = await issueBootstrapTic(host, path);
    const health = await fetch(`${host.url}/api/v1/backups/health`, {
      headers: { Cookie: tic.cookie ?? "" },
    }).then((response) => response.json());
    expect(health.local).toMatchObject({
      status: "healthy",
      latestRevision: 1,
    });
    expect(health.offHost).toMatchObject({
      status: "healthy",
      pendingCopies: 0,
      independentStorageVerified: false,
      fallbackOperational: false,
    });
    expect(typeof health.offHost.latestCopyLagMs).toBe("number");
    expect(health.offHost.latestCopyLagMs).toBeGreaterThanOrEqual(0);
    expect(health.restoreTest).toMatchObject({ status: "healthy" });
    const nextSnapshot = {
      version: 2,
      roster: [
        {
          id: "fictional-student-3",
          firstName: "Riley",
          lastName: "Example",
        },
      ],
      visits: [
        {
          id: "fictional-visit-2",
          arrivedAt: "2026-11-12T01:15:00.000Z",
        },
        {
          id: "fictional-visit-3",
          arrivedAt: "2026-11-12T02:30:00.000Z",
        },
        {
          id: "fictional-visit-4",
          arrivedAt: "2026-11-12T03:00:00.000Z",
        },
      ],
    };
    expect(
      (
        await fetch(`${host.url}/api/v1/state`, {
          method: "PUT",
          headers: {
            Cookie: tic.cookie ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ expectedRevision: 1, snapshot: nextSnapshot }),
        })
      ).status,
    ).toBe(200);
    const behind = await fetch(`${host.url}/api/v1/backups/health`, {
      headers: { Cookie: tic.cookie ?? "" },
    }).then((response) => response.json());
    expect(behind.offHost).toMatchObject({
      status: "degraded",
      pendingCopies: 1,
    });
    const { readdirSync } = await import("node:fs");
    const localFiles = readdirSync(`${path}.backups`);
    const copiedFiles = readdirSync(offHostDirectory);
    expect(
      localFiles.some((file) => file.endsWith(".manifest.json")),
    ).toBe(true);
    expect(
      copiedFiles.some((file) => file.endsWith(".manifest.json")),
    ).toBe(true);
    const manifestFile = localFiles.find((file) =>
      file.endsWith(".manifest.json"),
    );
    expect(manifestFile).toBeTruthy();
    const manifest = JSON.parse(
      readFileSync(join(`${path}.backups`, manifestFile!), "utf8"),
    );
    expect(manifest).toMatchObject({
      application: "happy-hallways-hub",
      schemaVersion: 7,
      revision: 1,
      recordCounts: { roster: 1, visits: 2 },
      dataRange: {
        earliest: "2026-11-12T01:15:00.000Z",
        latest: "2026-11-12T02:30:00.000Z",
      },
      integrityCheck: "ok",
      encrypted: true,
    });
    expect(manifest.encryptionKeyId).toMatch(/^[a-f0-9]{24}$/);
    expect(manifest.backupFileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(health.retention).toBe("no automatic deletion");
    const manual = await fetch(`${host.url}/api/v1/backups/run`, {
      method: "POST",
      headers: { Cookie: tic.cookie ?? "" },
    });
    expect(manual.status).toBe(200);
    expect(await manual.json()).toMatchObject({
      local: { status: "healthy" },
      offHost: { status: "healthy", pendingCopies: 0 },
    });
    const events = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: tic.cookie ?? "" },
    }).then((response) => response.json());
    expect(
      events.events.some(
        (event: { eventType: string }) =>
          event.eventType === "backup_run_completed",
      ),
    ).toBe(true);
  });

  test("reports off-host backups as unconfigured when no approved path is supplied", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const health = await fetch(`${host.url}/api/v1/health`).then((response) =>
      response.json(),
    );
    expect(health.backups.offHost).toMatchObject({
      status: "not_configured",
      independentStorageVerified: false,
    });
  });

  test("does not call the local snapshot folder an off-host backup", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path, `${path}.backups`);
    const health = await fetch(`${host.url}/api/v1/health`).then((response) =>
      response.json(),
    );
    expect(health.backups.offHost).toMatchObject({
      status: "degraded",
      independentStorageVerified: false,
    });
  });

  test("uses a configured fallback copy when the preferred destination fails", async () => {
    const path = temporaryDatabase();
    const { writeFileSync, existsSync } = await import("node:fs");
    const preferredParentFile = `${path}.not-a-directory`;
    writeFileSync(preferredParentFile, "fictional test marker");
    const fallbackDirectory = `${path}.approved-fallback`;
    const host = await startTestHost(
      path,
      `${preferredParentFile}/backups`,
      fallbackDirectory,
    );
    const health = await fetch(`${host.url}/api/v1/health`).then((response) =>
      response.json(),
    );
    expect(health.backups.offHost).toMatchObject({
      status: "degraded",
      fallbackOperational: true,
      independentStorageVerified: false,
    });
    expect(health.backups.offHost.destinations).toMatchObject([
      { role: "preferred", status: "degraded", pendingCopies: 1 },
      { role: "fallback", status: "healthy", pendingCopies: 0 },
    ]);
    expect(JSON.stringify(health)).not.toContain(preferredParentFile);
    expect(JSON.stringify(health)).not.toContain(fallbackDirectory);
    expect(
      readdirSync(fallbackDirectory).some((file) => file.endsWith(".sqlite.enc")),
    ).toBe(true);
    expect(existsSync(preferredParentFile)).toBe(true);
    const tic = await issueBootstrapTic(host, path);
    const detailedHealth = await fetch(`${host.url}/api/v1/backups/health`, {
      headers: { Cookie: tic.cookie ?? "" },
    }).then((response) => response.json());
    expect(detailedHealth.offHost.destinations).toMatchObject([
      { role: "preferred", path: `${preferredParentFile}/backups` },
      { role: "fallback", path: fallbackDirectory },
    ]);
  });

  test("keeps each acknowledged revision and restores one between local snapshots", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const headers = {
      Cookie: tic.cookie ?? "",
      "Content-Type": "application/json",
    };
    const firstSnapshot = {
      version: 2,
      visits: [
        {
          id: "fictional-visit-1",
          studentName: "Avery Sample",
          occurredAt: "2026-11-12T01:00:00.000Z",
        },
      ],
    };
    const secondSnapshot = {
      ...firstSnapshot,
      visits: [
        ...firstSnapshot.visits,
        {
          id: "fictional-visit-2",
          studentName: "Jordan Example",
          occurredAt: "2026-11-12T01:05:00.000Z",
        },
      ],
    };
    const firstSave = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 0, snapshot: firstSnapshot }),
    });
    expect(firstSave.status).toBe(200);
    const secondSave = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 1, snapshot: secondSnapshot }),
    });
    expect(secondSave.status).toBe(200);

    const pointsResponse = await fetch(
      `${host.url}/api/v1/backups/restore-points`,
      { headers },
    );
    const points = await pointsResponse.json();
    const point = points.restorePoints.find(
      (entry: { backupId: string }) => entry.backupId === "revision:1",
    );
    expect(point).toMatchObject({
      kind: "state_revision",
      revision: 1,
      checksumValid: true,
      restorable: true,
      staffName: "TIC Example",
      staffRole: "tic",
      recordCounts: { visits: 1 },
    });

    const stageResponse = await fetch(
      `${host.url}/api/v1/backups/restore/stage`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ backupId: point.backupId }),
      },
    );
    const stageBody = await stageResponse.json();
    if (stageResponse.status !== 201) {
      throw new Error(`Restore staging failed: ${JSON.stringify(stageBody)}`);
    }
    const { stage } = stageBody;
    expect(stage.preview).toMatchObject({
      snapshotRevision: 1,
      recordCounts: { visits: 1 },
      integrityCheck: "ok",
      snapshotChecksumValid: true,
    });
    const promotedResponse = await fetch(
      `${host.url}/api/v1/backups/restore/promote`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ stageId: stage.stageId }),
      },
    );
    expect(promotedResponse.status).toBe(200);
    expect(
      await fetch(`${host.url}/api/v1/state`, { headers }).then((response) =>
        response.json(),
      ),
    ).toMatchObject({ revision: 3, snapshot: firstSnapshot });
  });

  test("stages and promotes a TIC restore while preserving a pre-restore point and audit", async () => {
    const path = temporaryDatabase();
    const initialSnapshot = {
      version: 2,
      roster: [
        { id: "fictional-student-4", firstName: "Casey", lastName: "Example" },
      ],
      visits: [
        {
          id: "fictional-visit-4",
          arrivedAt: "2026-11-12T03:15:00.000Z",
        },
      ],
    };
    const seedStore = new HubStore(path);
    seedStore.save(initialSnapshot, 0, {
      sessionId: "fictional-session-seed",
      staffId: "fictional-staff-tic",
      displayName: "TIC Example",
      role: "tic",
      authMethod: "named-profile-device-enrolment-fallback",
      expiresAt: "2026-11-13T00:00:00.000Z",
    });
    seedStore.close();

    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const cookie = tic.cookie ?? "";
    const points = await fetch(`${host.url}/api/v1/backups/restore-points`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    expect(points.restorePoints.length).toBeGreaterThan(0);
    const sourcePoint = points.restorePoints.find(
      (point: { revision: number }) => point.revision === 1,
    );
    expect(sourcePoint).toMatchObject({
      checksumValid: true,
      recordCounts: { roster: 1, visits: 1 },
    });

    const changedSnapshot = {
      version: 2,
      roster: [],
      visits: [
        { id: "fictional-visit-5", arrivedAt: "2026-11-12T04:00:00.000Z" },
      ],
    };
    const changed = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, snapshot: changedSnapshot }),
    });
    expect(changed.status).toBe(200);

    const stagedResponse = await fetch(
      `${host.url}/api/v1/backups/restore/stage`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: sourcePoint.backupId }),
      },
    );
    const stagedBody = await stagedResponse.json();
    if (stagedResponse.status !== 201) {
      throw new Error(`Restore staging failed: ${JSON.stringify(stagedBody)}`);
    }
    const staged = stagedBody.stage;
    expect(staged.encrypted).toBe(true);
    const stagedDirectory = join(`${path}.backups`, "restore-staging");
    const stagedBytes = readFileSync(join(stagedDirectory, staged.stagedFile));
    expect(stagedBytes.subarray(0, 9).toString("ascii")).toBe("HHHUBENC1");
    expect(readdirSync(stagedDirectory).some((file) => file.endsWith(".verify.sqlite"))).toBe(false);
    expect(staged.preview).toMatchObject({
      snapshotRevision: 1,
      recordCounts: { roster: 1, visits: 1 },
      integrityCheck: "ok",
      snapshotChecksumValid: true,
    });
    expect(
      await fetch(`${host.url}/api/v1/state`, {
        headers: { Cookie: cookie },
      }).then((response) => response.json()),
    ).toMatchObject({ revision: 2, snapshot: changedSnapshot });

    const promotedResponse = await fetch(
      `${host.url}/api/v1/backups/restore/promote`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: staged.stageId }),
      },
    );
    const promoted = await promotedResponse.json();
    expect(promotedResponse.status).toBe(200);
    expect(promoted).toMatchObject({
      restored: true,
      backupId: sourcePoint.backupId,
      restoredRevision: 3,
    });
    expect(promoted.preRestoreBackupId).toBeTruthy();
    expect(
      await fetch(`${host.url}/api/v1/state`, {
        headers: { Cookie: cookie },
      }).then((response) => response.json()),
    ).toMatchObject({ revision: 3, snapshot: initialSnapshot });
    const events = await fetch(`${host.url}/api/v1/audit`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    expect(
      events.events.some(
        (event: { eventType: string }) =>
          event.eventType === "backup_restore_promoted",
      ),
    ).toBe(true);
  });

  test("refuses promotion when the live revision changes after restore staging", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const cookie = tic.cookie ?? "";
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: { version: 2, label: "fictional before stage" },
      }),
    });
    const points = await fetch(`${host.url}/api/v1/backups/restore-points`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    const point = points.restorePoints.find(
      (entry: { revision: number }) => entry.revision === 0,
    );
    const stageResponse = await fetch(
      `${host.url}/api/v1/backups/restore/stage`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ backupId: point.backupId }),
      },
    );
    const { stage } = await stageResponse.json();
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        snapshot: { version: 2, label: "fictional after stage" },
      }),
    });
    const promoted = await fetch(`${host.url}/api/v1/backups/restore/promote`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ stageId: stage.stageId }),
    });
    expect(promoted.status).toBe(409);
    expect(
      await fetch(`${host.url}/api/v1/state`, {
        headers: { Cookie: cookie },
      }).then((response) => response.json()),
    ).toMatchObject({
      revision: 2,
      snapshot: { version: 2, label: "fictional after stage" },
    });
  });

  test("migrates a version-three database to revision history without losing attribution", () => {
    const path = temporaryDatabase();
    const original = new HubStore(path);
    const actor = {
      sessionId: "fictional-session-migration",
      staffId: "fictional-staff-migration",
      displayName: "TIC Example",
      role: "tic" as const,
      authMethod: "named-profile-device-enrolment-fallback" as const,
      expiresAt: "2026-11-13T00:00:00.000Z",
    };
    const snapshot = {
      version: 2,
      visits: [
        { id: "fictional-visit-migration", studentName: "Avery Sample" },
      ],
    };
    original.save(snapshot, 0, actor);
    original.close();

    const oldSchema = new Database(path);
    oldSchema.exec(
      "DROP TABLE hub_concern_routing; DROP TABLE hub_concern_recipients; DROP TABLE hub_concerns; DROP TABLE hub_state_revisions; DROP TABLE staff_preferences; UPDATE hub_state SET schema_version = 3; PRAGMA user_version = 3;",
    );
    oldSchema.close();

    const migrated = new HubStore(path);
    expect(migrated.schemaVersion()).toBe(7);
    expect(migrated.read()).toMatchObject({ revision: 1, snapshot });
    expect(migrated.readStaffPreferences(actor)).toMatchObject({
      favouriteStudentIds: [],
      updatedAt: null,
    });
    expect(migrated.readRevisionHistory()).toMatchObject([
      {
        revision: 1,
        staffId: actor.staffId,
        staffName: actor.displayName,
        staffRole: "tic",
        changeType: "saved",
      },
    ]);
    const historical = migrated.readRevision(1);
    expect(historical).toMatchObject({ revision: 1, snapshot });
    migrated.close();
  });

  test("adds staff and revision history tables to an existing version-one database without changing its state", async () => {
    const path = temporaryDatabase();
    const migrationBackupDirectory = `${path}.pre-migration`;
    const backupKey = randomBytes(32);
    const database = new Database(path);
    const snapshotJson = JSON.stringify({
      version: 2,
      visits: [
        { id: "fictional-visit-1", timestamp: "2026-11-12T01:00:00.000Z" },
      ],
    });
    const checksum = createHash("sha256").update(snapshotJson).digest("hex");
    database.exec(
      `CREATE TABLE hub_state (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, saved_at TEXT NOT NULL, snapshot_json TEXT NOT NULL, checksum TEXT NOT NULL); PRAGMA user_version = 1;`,
    );
    database
      .query("INSERT INTO hub_state VALUES (1, 1, 7, ?, ?, ?)")
      .run("2026-11-12T01:00:00.000Z", snapshotJson, checksum);
    database.close();
    const store = new HubStore(path, migrationBackupDirectory, backupKey);
    expect(store.read()).toMatchObject({
      revision: 7,
      savedAt: "2026-11-12T01:00:00.000Z",
      checksum,
      snapshot: JSON.parse(snapshotJson),
    });
    expect(store.readRevisionHistory()).toMatchObject([
      {
        revision: 7,
        savedAt: "2026-11-12T01:00:00.000Z",
        checksum,
        staffId: null,
        changeType: "saved",
      },
    ]);
    expect(store.createBootstrapTicInvitation().role).toBe("tic");
    store.close();
    const migrationFiles = readdirSync(migrationBackupDirectory);
    const migrationManifestName = migrationFiles.find((file) =>
      file.endsWith(".sqlite.enc.manifest.json"),
    );
    expect(migrationManifestName).toBeTruthy();
    const migrationManifest = JSON.parse(
      readFileSync(
        join(migrationBackupDirectory, migrationManifestName!),
        "utf8",
      ),
    );
    expect(migrationManifest).toMatchObject({
      application: "happy-hallways-hub",
      kind: "pre_migration",
      schemaVersion: 1,
      fromSchemaVersion: 1,
      toSchemaVersion: 7,
      sourceRevision: 7,
      recordCounts: { hub_state: 1 },
      sourceSnapshotChecksum: checksum,
      encrypted: true,
      integrityCheck: "ok",
    });
    const migrationDatabasePath = join(path + ".pre-migration", "verified-restore.sqlite");
    decryptBackupFileSync(
      join(migrationBackupDirectory, migrationManifest.fileName),
      migrationDatabasePath,
      backupKey,
      migrationManifest.encryptionKeyId,
    );
    const migrationDatabase = new Database(
      migrationDatabasePath,
      { readonly: true },
    );
    expect(
      migrationDatabase.query("PRAGMA user_version").get()?.user_version,
    ).toBe(1);
    migrationDatabase.close();
    rmSync(migrationDatabasePath, { force: true });

    const offHostPath = `${path}.approved-migration-copy`;
    const currentStore = new HubStore(path, migrationBackupDirectory, backupKey);
    const backupManager = new HubBackupManager(
      currentStore,
      migrationBackupDirectory,
      [
        { role: "preferred", directory: offHostPath },
        { role: "fallback", directory: null },
      ],
      backupKey,
    );
    await backupManager.start();
    expect(
      readdirSync(offHostPath).some(
        (file) =>
          file.startsWith("pre-migration-v1-to-v7-") &&
          file.endsWith(".sqlite.enc"),
      ),
    ).toBe(true);
    backupManager.stop();
    currentStore.close();
  });

  test("detects damaged compressed revision history and disables that restore point", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    const cookie = tic.cookie ?? "";
    const saved = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: {
          version: 2,
          visits: [
            { id: "fictional-visit-integrity", studentName: "Avery Sample" },
          ],
        },
      }),
    });
    expect(saved.status).toBe(200);
    const verified = await fetch(`${host.url}/api/v1/backups/run`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect((await verified.json()).local.status).toBe("healthy");

    const database = new Database(path);
    database
      .query(
        "UPDATE hub_state_revisions SET snapshot_gzip = ? WHERE revision = 1",
      )
      .run(Buffer.from([0, 1, 2, 3]));
    database.close();

    const failedCycle = await fetch(`${host.url}/api/v1/backups/run`, {
      method: "POST",
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    expect(failedCycle.local.status).toBe("degraded");
    expect(failedCycle.local.error).toContain("Compressed revision");
    const pointList = await fetch(`${host.url}/api/v1/backups/restore-points`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    expect(
      pointList.restorePoints.find(
        (point: { backupId: string }) => point.backupId === "revision:1",
      ),
    ).toMatchObject({
      checksumValid: false,
      restorable: false,
      error: "This revision failed its integrity check and cannot be restored.",
    });
  });

  test("does not overwrite a damaged snapshot", async () => {
    const path = temporaryDatabase();
    const host = await startTestHost(path);
    const tic = await issueBootstrapTic(host, path);
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { Cookie: tic.cookie ?? "", "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: { version: 2, roster: [] },
      }),
    });
    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);
    const database = new Database(path);
    database
      .query("UPDATE hub_state SET snapshot_json = '{broken' WHERE id = 1")
      .run();
    database.close();
    const restarted = await startTestHost(path);
    expect(
      (
        await fetch(`${restarted.url}/api/v1/state`, {
          headers: { Cookie: tic.cookie ?? "" },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await fetch(`${restarted.url}/api/v1/state`, {
          method: "PUT",
          headers: {
            Cookie: tic.cookie ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedRevision: 1,
            snapshot: { version: 2, roster: [] },
          }),
        })
      ).status,
    ).toBe(503);
  });
});
