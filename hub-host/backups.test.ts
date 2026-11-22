import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBackupManager } from "./backups";
import { HubStore } from "./store";

const directories: string[] = [];
const stores: HubStore[] = [];
const managers: HubBackupManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hh-backups-test-"));
  directories.push(directory);
  return directory;
}

describe("Hub backup encryption health", () => {
  test("writes encrypted snapshots and reports encryption status", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    const backupDirectory = join(directory, "backups");
    const store = new HubStore(databasePath);
    stores.push(store);
    const manager = new HubBackupManager(
      store,
      backupDirectory,
      [
        { role: "preferred", directory: null },
        { role: "fallback", directory: null },
      ],
      randomBytes(32),
    );
    managers.push(manager);
    await manager.start();

    const backups = readdirSync(backupDirectory);
    expect(backups.some((file) => file.endsWith(".sqlite.enc"))).toBe(true);
    expect(manager.health().encryption.status).toBe("enabled");
    expect(manager.restorePoints().every((point) => point.checksumValid)).toBe(true);

  });

  test("marks encrypted backups unavailable with missing or mismatched keys", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "hub.sqlite");
    const backupDirectory = join(directory, "backups");
    const firstStore = new HubStore(databasePath);
    stores.push(firstStore);
    const firstManager = new HubBackupManager(
      firstStore,
      backupDirectory,
      [
        { role: "preferred", directory: null },
        { role: "fallback", directory: null },
      ],
      randomBytes(32),
    );
    managers.push(firstManager);
    await firstManager.start();
    const initialKeyId = firstManager.health().encryption.keyId;
    firstManager.stop();
    managers.splice(managers.indexOf(firstManager), 1);
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const secondStore = new HubStore(databasePath);
    stores.push(secondStore);
    const secondManager = new HubBackupManager(
      secondStore,
      backupDirectory,
      [
        { role: "preferred", directory: null },
        { role: "fallback", directory: null },
      ],
    );
    managers.push(secondManager);
    expect(secondManager.health().encryption).toMatchObject({
      status: "key_unavailable",
      unavailableEncryptedBackups: 1,
    });
    expect(secondManager.restorePoints().every((point) => !point.restorable)).toBe(true);
    secondStore.close();
    stores.splice(stores.indexOf(secondStore), 1);

    const thirdStore = new HubStore(databasePath);
    stores.push(thirdStore);
    const thirdManager = new HubBackupManager(
      thirdStore,
      backupDirectory,
      [
        { role: "preferred", directory: null },
        { role: "fallback", directory: null },
      ],
      randomBytes(32),
    );
    managers.push(thirdManager);
    expect(thirdManager.health().encryption).toMatchObject({
      status: "key_mismatch",
      unavailableEncryptedBackups: 1,
    });
    expect(thirdManager.health().encryption.keyId).not.toBe(initialKeyId);
    expect(thirdManager.restorePoints().every((point) => !point.restorable)).toBe(true);
    thirdStore.close();
    stores.splice(stores.indexOf(thirdStore), 1);
  });
});
