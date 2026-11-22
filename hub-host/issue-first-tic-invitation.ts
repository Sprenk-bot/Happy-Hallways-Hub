import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parseBackupEncryptionKey } from "./backup-crypto";
import { HubStore } from "./store";

const databasePath = resolve(
  process.env.HUB_DATABASE_PATH ?? ".hub-data/hub.sqlite",
);
const backupDirectory = resolve(
  process.env.HUB_LOCAL_BACKUP_DIRECTORY ?? ".hub-data/backups/local",
);
const backupEncryptionKeyPath = process.env.HUB_BACKUP_ENCRYPTION_KEY_PATH;
const backupEncryptionKey = backupEncryptionKeyPath
  ? parseBackupEncryptionKey(readFileSync(resolve(backupEncryptionKeyPath)))
  : undefined;
const store = new HubStore(databasePath, backupDirectory, backupEncryptionKey);
const entraEmail = process.env.HUB_BOOTSTRAP_TIC_EMAIL?.trim();

try {
  const invitation = store.createBootstrapTicInvitation(undefined, entraEmail);
  console.log(
    entraEmail
      ? `One-time first TIC Microsoft Entra invitation for ${entraEmail} (shown once):`
      : "One-time first TIC named-profile fallback token (shown once):",
  );
  console.log(invitation.token);
  console.log(`Expires at: ${invitation.expiresAt}`);
  if (entraEmail) {
    console.log("The invitation can only be used by this email through the configured Entra sign-in flow.");
  } else {
    console.log(
      "Development fallback only. This named profile and device enrolment do not verify staff identity or provide MFA. Enable HUB_NAMED_PROFILE_FALLBACK_ENABLED=true to use it. Do not use with real student data.",
    );
  }
} finally {
  store.close();
}
