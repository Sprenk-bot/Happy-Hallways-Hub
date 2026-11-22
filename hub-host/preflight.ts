import {
  createPrivateKey,
  X509Certificate,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { parseBackupEncryptionKey } from "./backup-crypto";
import { isGuid } from "./entra";

export type ReadinessCheck = {
  area: string;
  status: "ready" | "warning" | "blocked" | "not_verified";
  message: string;
};

export type HostReadiness = {
  checks: ReadinessCheck[];
  localDevelopmentReady: boolean;
  realStudentDataReady: false;
};

export type AclRuleSummary = {
  sid: string;
  type: "Allow" | "Deny";
  rights: string;
};

const entraVariableNames = [
  "HUB_ENTRA_TENANT_ID",
  "HUB_ENTRA_CLIENT_ID",
  "HUB_ENTRA_REDIRECT_URI",
  "HUB_ENTRA_CERTIFICATE_SHA256",
  "HUB_ENTRA_PRIVATE_KEY_PATH",
] as const;

export function inspectHubHostConfiguration(
  environment: Record<string, string | undefined>,
): HostReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (area: string, status: ReadinessCheck["status"], message: string) =>
    checks.push({ area, status, message });

  add(
    "Host operating system",
    platform() === "win32" ? "ready" : "warning",
    platform() === "win32"
      ? "Windows detected. ICT still needs to select the school device and service account."
      : "The selected production target is a school Windows device; this computer is not running Windows.",
  );

  const port = Number(environment.HUB_PORT ?? "8787");
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  add(
    "Host service",
    portValid ? "ready" : "blocked",
    portValid
      ? "Port setting is valid. The scheduled Host service and account permissions still need a school-device check."
      : "Set HUB_PORT to a whole number from 1 to 65535.",
  );

  const databasePath = resolve(
    environment.HUB_DATABASE_PATH ?? ".hub-data/hub.sqlite",
  );
  const databaseFolder = directoryAccess(dirname(databasePath));
  add(
    "Local database folder",
    databaseFolder.status === "blocked" ? "blocked" : databaseFolder.status,
    `The folder for the Host database ${databaseFolder.message}. No database is opened or changed by this check.`,
  );
  addAclCheck("Local database folder", dirname(databasePath), add);

  const staticDirectory = resolve(environment.HUB_STATIC_DIRECTORY ?? "build");
  const staticReady =
    existsSync(resolve(staticDirectory, "index.html")) &&
    existsSync(resolve(staticDirectory, "_app"));
  add(
    "Happy Hallways app files",
    staticReady ? "ready" : "warning",
    staticReady
      ? "The built app files are present for the Host to serve locally."
      : "Built app files are missing. Run the approved build before using the Host app; without them it starts as API-only.",
  );

  const localBackupDirectory = resolve(
    environment.HUB_LOCAL_BACKUP_DIRECTORY ?? ".hub-data/backups/local",
  );
  const offHostDirectory = environment.HUB_OFFHOST_BACKUP_DIRECTORY
    ? resolve(environment.HUB_OFFHOST_BACKUP_DIRECTORY)
    : null;
  const fallbackDirectory = environment.HUB_FALLBACK_BACKUP_DIRECTORY
    ? resolve(environment.HUB_FALLBACK_BACKUP_DIRECTORY)
    : null;
  const backupKeyPath = environment.HUB_BACKUP_ENCRYPTION_KEY_PATH;
  const backupKey = backupKeyPath
    ? readKey(backupKeyPath)
    : { value: null, error: "No protected backup key is configured." };
  add(
    "Backup encryption",
    backupKey.value ? "ready" : "warning",
    backupKey.value
      ? "A valid 32-byte key file is readable. Confirm its Windows permissions and independent recovery copy with ICT."
      : `${backupKey.error} Backups will be plaintext, so use fictional data only.`,
  );
  if (backupKeyPath) addAclCheck("Backup key file", resolve(backupKeyPath), add);
  const localBackupAccess = directoryAccess(localBackupDirectory);
  add(
    "Local backup folder",
    localBackupAccess.status === "blocked" ? "blocked" : localBackupAccess.status,
    `The local snapshot folder ${localBackupAccess.message}. Check access using the Host service account before relying on automatic backups.`,
  );
  addAclCheck("Local snapshot folder", localBackupDirectory, add);

  const primaryIsLocal =
    offHostDirectory !== null && samePath(offHostDirectory, localBackupDirectory);
  const primaryAccess = offHostDirectory ? directoryAccess(offHostDirectory) : null;
  add(
    "Backup destination",
    primaryIsLocal ? "blocked" : offHostDirectory ? primaryAccess!.status : "warning",
    primaryIsLocal
      ? "The primary destination resolves to the local snapshot folder. Choose a separate school-controlled location."
      : offHostDirectory
        ? `Primary folder ${primaryAccess!.message}. ICT must confirm it is school-controlled and approved.`
        : "No primary school-controlled off-host destination is configured.",
  );
  if (offHostDirectory) {
    addAclCheck("Primary off-host folder", offHostDirectory, add);
  }
  const fallbackIsLocal =
    fallbackDirectory !== null && samePath(fallbackDirectory, localBackupDirectory);
  const fallbackMatchesPrimary =
    fallbackDirectory !== null &&
    offHostDirectory !== null &&
    samePath(fallbackDirectory, offHostDirectory);
  const fallbackAccess = fallbackDirectory ? directoryAccess(fallbackDirectory) : null;
  add(
    "Backup fallback",
    fallbackIsLocal || fallbackMatchesPrimary
      ? "blocked"
      : fallbackDirectory
        ? fallbackAccess!.status
        : "warning",
    fallbackIsLocal || fallbackMatchesPrimary
      ? "The fallback must be a separate folder from the local and primary destinations."
      : fallbackDirectory
        ? `Fallback folder ${fallbackAccess!.message}. ICT must confirm it is an approved alternative.`
        : "No alternate off-host folder is configured. If the primary location fails, the Host can only queue the copy.",
  );
  if (fallbackDirectory) {
    addAclCheck("Fallback off-host folder", fallbackDirectory, add);
  }

  const allowLan = environment.HUB_ALLOW_LAN === "true";
  const host = environment.HUB_HOST ?? "127.0.0.1";
  const publicHost = environment.HUB_PUBLIC_HOST;
  const certificatePath = environment.HUB_TLS_CERTIFICATE;
  const privateKeyPath = environment.HUB_TLS_PRIVATE_KEY;
  let tlsValid = false;
  let tlsMessage = "LAN access is off. The Host will accept connections from this computer only.";
  if (allowLan) {
    if (!publicHost || !certificatePath || !privateKeyPath) {
      tlsMessage = "LAN is requested, but its public Host name, certificate, and private-key paths must all be configured.";
    } else if (host === "127.0.0.1" || host === "::1") {
      tlsMessage = "LAN is requested, but HUB_HOST still points to this computer only. ICT must provide the approved bind address.";
    } else {
      const result = checkTlsFiles(certificatePath, privateKeyPath, publicHost);
      tlsValid = result.valid;
      tlsMessage = result.message;
    }
  }
  add(
    "LAN and HTTPS",
    !allowLan ? "warning" : tlsValid ? "ready" : "blocked",
    tlsMessage,
  );
  if (privateKeyPath) addAclCheck("HTTPS private-key file", resolve(privateKeyPath), add);

  const configuredEntra = entraVariableNames.filter((name) =>
    Boolean(environment[name]),
  );
  const mfaConfirmed = environment.HUB_ENTRA_MFA_POLICY_CONFIRMED === "true";
  let entraReady = false;
  if (configuredEntra.length === 0 && !mfaConfirmed) {
    add(
      "Microsoft Entra and MFA",
      "warning",
      "Entra is not configured. ICT must register the app and confirm its MFA policy before staff sign-in can be tested.",
    );
  } else if (configuredEntra.length !== entraVariableNames.length || !mfaConfirmed) {
    const missing = entraVariableNames.filter((name) => !environment[name]);
    add(
      "Microsoft Entra and MFA",
      "blocked",
      `Entra settings are incomplete or MFA confirmation is missing${missing.length ? ` (${missing.join(", ")})` : ""}.`,
    );
  } else {
    const redirectUri = environment.HUB_ENTRA_REDIRECT_URI!;
    const expectedRedirect = `https://${publicHost}:${port}/api/v1/auth/entra/callback`;
    const privateKey = readPrivateKey(environment.HUB_ENTRA_PRIVATE_KEY_PATH!);
    addAclCheck("Entra private-key file", resolve(environment.HUB_ENTRA_PRIVATE_KEY_PATH!), add);
    entraReady =
      isGuid(environment.HUB_ENTRA_TENANT_ID!) &&
      isGuid(environment.HUB_ENTRA_CLIENT_ID!) &&
      redirectUri === expectedRedirect &&
      Boolean(publicHost && tlsValid && backupKey.value && privateKey);
    add(
      "Microsoft Entra and MFA",
      entraReady ? "not_verified" : "blocked",
      entraReady
        ? "Configuration is complete and MFA is attested by ICT. Actual sign-in against the school tenant remains untested."
        : "Check the tenant/client IDs, exact HTTPS callback address, Entra private-key file, LAN certificate, backup key, and ICT MFA confirmation.",
    );
  }

  const fallbackEnabled =
    environment.HUB_NAMED_PROFILE_FALLBACK_ENABLED === "true";
  add(
    "Named-profile fallback",
    fallbackEnabled ? "warning" : "ready",
    fallbackEnabled
      ? "Enabled for fictional development only. It does not verify staff identity or provide MFA."
      : "Disabled. It can be explicitly enabled for fictional development if Entra setup is not available.",
  );

  add(
    "School network test",
    "not_verified",
    "A local check cannot verify school Wi-Fi segmentation, firewall rules, client isolation, or staff-device reachability.",
  );
  add(
    "Real student data",
    "blocked",
    "Not ready until ICT-approved sign-in, encrypted backups, an approved off-host destination, Windows permissions, and an on-school restore/network test are complete.",
  );

  return {
    checks,
    localDevelopmentReady:
      portValid &&
      (!allowLan || tlsValid) &&
      databaseFolder.status !== "blocked" &&
      localBackupAccess.status !== "blocked" &&
      (fallbackEnabled || entraReady),
    realStudentDataReady: false,
  };
}

function readKey(path: string) {
  try {
    return { value: parseBackupEncryptionKey(readFileSync(resolve(path))), error: null };
  } catch {
    return { value: null, error: "The configured backup key file is missing or invalid." };
  }
}

function readPrivateKey(path: string) {
  try {
    const key = readFileSync(resolve(path));
    createPrivateKey(key);
    return key;
  } catch {
    return null;
  }
}

function checkTlsFiles(certificatePath: string, privateKeyPath: string, host: string) {
  try {
    const certificate = new X509Certificate(readFileSync(resolve(certificatePath)));
    const privateKey = createPrivateKey(readFileSync(resolve(privateKeyPath)));
    const now = Date.now();
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
      return { valid: false, message: "The HTTPS certificate is not currently valid." };
    }
    if (!certificate.checkHost(host, { subject: "never" })) {
      return { valid: false, message: "The HTTPS certificate does not contain the approved Host name in its subject alternative names." };
    }
    if (!certificate.checkPrivateKey(privateKey)) {
      return { valid: false, message: "The HTTPS certificate and private-key files do not match." };
    }
    return {
      valid: true,
      message: "The HTTPS certificate is in date, matches the Host name, and pairs with its private key. School-network access remains untested.",
    };
  } catch {
    return { valid: false, message: "The HTTPS certificate or private-key file is missing or unreadable." };
  }
}

function directoryAccess(path: string) {
  try {
    if (!existsSync(path)) {
      return {
        status: "warning" as const,
        message: "does not exist yet; confirm the path and the service-account permission to create it",
      };
    }
    if (!statSync(path).isDirectory()) {
      return {
        status: "blocked" as const,
        message: "is not a folder",
      };
    }
    accessSync(path, constants.W_OK);
    return {
      status: "not_verified" as const,
      message: "is writable by the account running this check",
    };
  } catch {
    return {
      status: "blocked" as const,
      message: "is not writable by the account running this check",
    };
  }
}

export function summarizeAclRules(rules: AclRuleSummary[]) {
  const broadSids = new Set([
    "S-1-1-0", // Everyone
    "S-1-5-7", // Anonymous Logon
    "S-1-5-11", // Authenticated Users
    "S-1-5-2", // Network
    "S-1-5-32-545", // Built-in Users
  ]);
  const broadAllow = rules.some((rule) => {
    const broadPrincipal =
      broadSids.has(rule.sid) || /^S-1-5-21-(?:\d+-){3}513$/.test(rule.sid);
    const grantsAccess =
      /read|write|modify|fullcontrol|genericall|genericread/i.test(rule.rights);
    return rule.type === "Allow" && broadPrincipal && grantsAccess;
  });
  return broadAllow
    ? {
        status: "warning" as const,
        message:
          "A broad local-users or network group appears to have access. ICT should restrict this ACL before real data is used.",
      }
    : {
        status: "not_verified" as const,
        message:
          "No broad local-users ACE was detected. ICT still needs to verify the Host service account, inherited permissions, and any network-share ACL.",
      };
}

function addAclCheck(
  area: string,
  path: string,
  add: (area: string, status: ReadinessCheck["status"], message: string) => void,
) {
  if (platform() !== "win32") {
    add(
      `${area} ACL`,
      "not_verified",
      "Windows file permissions are not available on this operating system.",
    );
    return;
  }
  if (!existsSync(path)) {
    add(
      `${area} ACL`,
      "warning",
      "The path does not exist yet, so its Windows permissions cannot be checked.",
    );
    return;
  }
  try {
    const pathBase64 = Buffer.from(path, "utf8").toString("base64");
    const script = `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}')); $acl = Get-Acl -LiteralPath $p -ErrorAction Stop; $rows = @($acl.Access | ForEach-Object { $sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value }; [pscustomobject]@{ sid = $sid; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString() } }); ConvertTo-Json -InputObject $rows -Compress`;
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const output = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = output ? JSON.parse(output) as AclRuleSummary | AclRuleSummary[] : [];
    const rules = Array.isArray(parsed) ? parsed : [parsed];
    const summary = summarizeAclRules(rules);
    add(`${area} ACL`, summary.status, summary.message);
  } catch {
    add(
      `${area} ACL`,
      "not_verified",
      "Windows could not read this ACL. Have ICT verify permissions for the Host service account and approved administrators.",
    );
  }
}

function samePath(first: string, second: string) {
  const a = resolve(first);
  const b = resolve(second);
  return platform() === "win32"
    ? a.toLocaleLowerCase("en-AU") === b.toLocaleLowerCase("en-AU")
    : a === b;
}

function printReadiness(readiness: HostReadiness) {
  console.log("Happy Hallways Hub Host setup check");
  for (const check of readiness.checks) {
    const label = check.status.toUpperCase().replaceAll("_", " ");
    console.log(`${label} · ${check.area}: ${check.message}`);
  }
  console.log(
    `Local fictional testing: ${readiness.localDevelopmentReady ? "ready for local-only use" : "needs setup"}.`,
  );
  console.log("Real student data: NOT READY. This check does not test the school network or Entra sign-in.");
}

if (import.meta.main) {
  printReadiness(inspectHubHostConfiguration(process.env));
}
