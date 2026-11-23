import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  backupEncryptionKeyId,
  parseBackupEncryptionKey,
} from "./backup-crypto";
import { startHubHost } from "./server";

const host = process.env.HUB_HOST ?? "127.0.0.1";
const allowLan = process.env.HUB_ALLOW_LAN === "true";
const trustedProxyOrigin = process.env.HUB_TRUSTED_PROXY_ORIGIN?.trim() || undefined;
const certificatePath = process.env.HUB_TLS_CERTIFICATE;
const privateKeyPath = process.env.HUB_TLS_PRIVATE_KEY;
const publicHost = process.env.HUB_PUBLIC_HOST;
const portText = process.env.HUB_PORT ?? "8787";
const port = Number(portText);
const databasePath = resolve(
  process.env.HUB_DATABASE_PATH ?? ".hub-data/hub.sqlite",
);
const staticDirectory = resolve(process.env.HUB_STATIC_DIRECTORY ?? "build");
if (
  (certificatePath || privateKeyPath || publicHost) &&
  !(certificatePath && privateKeyPath && publicHost)
) {
  throw new Error(
    "HTTPS setup requires HUB_TLS_CERTIFICATE, HUB_TLS_PRIVATE_KEY, and HUB_PUBLIC_HOST together.",
  );
}
const tls =
  certificatePath && privateKeyPath && publicHost
    ? {
        certificate: readFileSync(resolve(certificatePath)),
        privateKey: readFileSync(resolve(privateKeyPath)),
        publicHost,
      }
    : undefined;
const localBackupDirectory = resolve(
  process.env.HUB_LOCAL_BACKUP_DIRECTORY ?? ".hub-data/backups/local",
);
const offHostBackupDirectory = process.env.HUB_OFFHOST_BACKUP_DIRECTORY
  ? resolve(process.env.HUB_OFFHOST_BACKUP_DIRECTORY)
  : null;
const fallbackBackupDirectory = process.env.HUB_FALLBACK_BACKUP_DIRECTORY
  ? resolve(process.env.HUB_FALLBACK_BACKUP_DIRECTORY)
  : null;
const backupEncryptionKeyPath = process.env.HUB_BACKUP_ENCRYPTION_KEY_PATH;
const backupEncryptionKey = backupEncryptionKeyPath
  ? parseBackupEncryptionKey(readFileSync(resolve(backupEncryptionKeyPath)))
  : undefined;
const allowNamedProfileFallback =
  process.env.HUB_NAMED_PROFILE_FALLBACK_ENABLED === "true";
const namedProfileFallbackApprovedForRealData =
  process.env.HUB_NAMED_PROFILE_FALLBACK_APPROVED_FOR_REAL_DATA === "true";
const entraTenantId = process.env.HUB_ENTRA_TENANT_ID;
const entraClientId = process.env.HUB_ENTRA_CLIENT_ID;
const entraRedirectUri = process.env.HUB_ENTRA_REDIRECT_URI;
const entraThumbprint = process.env.HUB_ENTRA_CERTIFICATE_SHA256;
const entraPrivateKeyPath = process.env.HUB_ENTRA_PRIVATE_KEY_PATH;
const entraMfaConfirmed = process.env.HUB_ENTRA_MFA_POLICY_CONFIRMED === "true";
const entraValues = [
  entraTenantId,
  entraClientId,
  entraRedirectUri,
  entraThumbprint,
  entraPrivateKeyPath,
];
if (entraValues.some(Boolean) && !entraValues.every(Boolean)) {
  throw new Error(
    "Entra setup requires tenant ID, client ID, redirect URI, certificate SHA-256 thumbprint, and private-key path together.",
  );
}
if (entraMfaConfirmed && !entraValues.every(Boolean)) {
  throw new Error(
    "HUB_ENTRA_MFA_POLICY_CONFIRMED requires a complete Entra configuration.",
  );
}
const entra =
  entraValues.every(Boolean) && entraMfaConfirmed
    ? {
        tenantId: entraTenantId!,
        clientId: entraClientId!,
        redirectUri: entraRedirectUri!,
        certificateThumbprintSha256: entraThumbprint!,
        privateKey: readFileSync(resolve(entraPrivateKeyPath!)),
        mfaPolicyConfirmed: true,
      }
    : undefined;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("HUB_PORT must be an integer from 1 to 65535.");
}

const service = await startHubHost({
  host,
  port,
  allowLan,
  tls,
  databasePath,
  localBackupDirectory,
  offHostBackupDirectory,
  fallbackBackupDirectory,
  backupEncryptionKey,
  allowNamedProfileFallback,
  namedProfileFallbackApprovedForRealData,
  trustedProxyOrigin,
  entra,
  staticDirectory: existsSync(staticDirectory) ? staticDirectory : null,
});
console.log(`Happy Hallways Hub Host prototype listening at ${service.url}`);
if (trustedProxyOrigin) console.log(`Configured trusted proxy origin: ${trustedProxyOrigin} (Cloudflare Access policy must be enabled separately).`);
console.log(`SQLite state file: ${databasePath}`);
console.log(
  `Local application: ${existsSync(staticDirectory) ? staticDirectory : "not built; run bun run build to enable"}.`,
);
console.log(`Local snapshot directory: ${localBackupDirectory}`);
console.log(
  `Off-host snapshot directory: ${offHostBackupDirectory ?? "not configured"}`,
);
console.log(
  `Fallback snapshot directory: ${fallbackBackupDirectory ?? "not configured"}`,
);
console.log(
  `Local backup encryption: ${backupEncryptionKey ? `enabled (key ${backupEncryptionKeyId(backupEncryptionKey)})` : "not configured; use fictional data only"}.`,
);
console.log(
  `Named-profile fallback: ${allowNamedProfileFallback ? namedProfileFallbackApprovedForRealData ? "enabled; ICT-approved for real data as a compensating control, but it does not verify identity or provide MFA" : "enabled for fictional development data only; it does not verify identity or provide MFA" : "disabled pending explicit Host configuration"}. LAN listener: ${allowLan ? "HTTPS configuration enabled; ICT network validation still required" : "disabled"}.`,
);
console.log(
  `Microsoft Entra sign-in: ${entra ? "configured; ICT MFA policy attestation supplied" : "disabled pending complete ICT configuration"}.`,
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await service.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
