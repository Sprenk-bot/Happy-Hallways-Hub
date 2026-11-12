import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHubHost, type RunningHubHost } from "./server";

const temporaryDirectories: string[] = [];
const runningHosts: RunningHubHost[] = [];

afterEach(async () => {
  for (const host of runningHosts.splice(0)) await host.close();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function startTestHost(databasePath: string) {
  const host = await startHubHost({ databasePath, host: "127.0.0.1", port: 0 });
  runningHosts.push(host);
  return host;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "happy-hallways-hub-host-"));
  temporaryDirectories.push(directory);
  return join(directory, "hub.sqlite");
}

describe("local Hub Host state service", () => {
  test("stores a versioned snapshot and rejects a stale writer", async () => {
    const host = await startTestHost(temporaryDatabase());
    const initial = await fetch(`${host.url}/api/v1/state`).then((response) =>
      response.json(),
    );
    expect(initial).toMatchObject({ revision: 0, snapshot: null });

    const snapshot = {
      version: 2,
      roster: [
        { id: "fictional-student-1", firstName: "Avery", lastName: "Example" },
      ],
      passes: [],
    };
    const savedResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot }),
    });
    const saved = await savedResponse.json();
    expect(savedResponse.status).toBe(200);
    expect(saved).toMatchObject({ revision: 1, snapshot });
    expect(saved.checksum).toMatch(/^[a-f0-9]{64}$/);

    const staleResponse = await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: { version: 2, roster: [], passes: [] },
      }),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: "revision_conflict",
      currentRevision: 1,
    });
    expect(
      await fetch(`${host.url}/api/v1/state`).then((response) =>
        response.json(),
      ),
    ).toMatchObject({ revision: 1, snapshot });
  });

  test("accepts only one of two concurrent writes based on the same revision", async () => {
    const host = await startTestHost(temporaryDatabase());
    const write = (label: string) =>
      fetch(`${host.url}/api/v1/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          snapshot: { version: 2, writer: label },
        }),
      });

    const results = await Promise.all([
      write("fictional-staff-a"),
      write("fictional-staff-b"),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await fetch(`${host.url}/api/v1/state`).then((response) =>
        response.json(),
      ),
    ).toMatchObject({ revision: 1 });
  });

  test("keeps an acknowledged snapshot after the host process restarts", async () => {
    const databasePath = temporaryDatabase();
    const firstHost = await startTestHost(databasePath);
    const snapshot = {
      version: 2,
      classes: [{ id: "fictional-class-1", name: "Example Class" }],
      passes: [],
    };
    const response = await fetch(`${firstHost.url}/api/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot }),
    });
    expect(response.status).toBe(200);
    await firstHost.close();
    runningHosts.splice(runningHosts.indexOf(firstHost), 1);

    const restartedHost = await startTestHost(databasePath);
    expect(
      await fetch(`${restartedHost.url}/api/v1/state`).then((result) =>
        result.json(),
      ),
    ).toMatchObject({ revision: 1, snapshot });
  });

  test("reports healthy local storage and refuses non-loopback binding", async () => {
    const host = await startTestHost(temporaryDatabase());
    expect(
      await fetch(`${host.url}/api/v1/health`).then((response) =>
        response.json(),
      ),
    ).toMatchObject({
      status: "ready",
      storage: "sqlite",
      revision: 0,
      lastSavedAt: null,
    });
    await expect(
      startHubHost({
        databasePath: temporaryDatabase(),
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow(/only binds to 127\.0\.0\.1/);
  });

  test("rejects unexpected host headers and browser origins", async () => {
    const host = await startTestHost(temporaryDatabase());
    const wrongHost = await fetch(`${host.url}/api/v1/health`, {
      headers: { Host: "outside.example" },
    });
    const wrongOrigin = await fetch(`${host.url}/api/v1/health`, {
      headers: { Origin: "http://outside.example" },
    });
    expect(wrongHost.status).toBe(421);
    expect(wrongOrigin.status).toBe(403);
  });

  test("does not replace existing state when its stored checksum is damaged", async () => {
    const databasePath = temporaryDatabase();
    const host = await startTestHost(databasePath);
    const firstSnapshot = {
      version: 2,
      roster: [{ id: "fictional-student-2", firstName: "Morgan" }],
    };
    await fetch(`${host.url}/api/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, snapshot: firstSnapshot }),
    });

    await host.close();
    runningHosts.splice(runningHosts.indexOf(host), 1);

    const { Database } = await import("bun:sqlite");
    const database = new Database(databasePath);
    database
      .query("UPDATE hub_state SET snapshot_json = '{broken' WHERE id = 1")
      .run();
    database.close();

    const restartedHost = await startTestHost(databasePath);
    expect((await fetch(`${restartedHost.url}/api/v1/state`)).status).toBe(503);
    expect((await fetch(`${restartedHost.url}/api/v1/health`)).status).toBe(
      503,
    );
    const overwrite = await fetch(`${restartedHost.url}/api/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        snapshot: { version: 2, roster: [] },
      }),
    });
    expect(overwrite.status).toBe(503);
  });
});
