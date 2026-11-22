import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectHubHostConfiguration,
  summarizeAclRules,
} from "./preflight";

describe("Hub Host preflight", () => {
  test("reports missing ICT configuration without exposing values or ready data claims", () => {
    const result = inspectHubHostConfiguration({});
    expect(result.realStudentDataReady).toBe(false);
    expect(result.checks).toContainEqual({
      area: "School network test",
      status: "not_verified",
      message:
        "A local check cannot verify school Wi-Fi segmentation, firewall rules, client isolation, or staff-device reachability.",
    });
    expect(result.checks.find((check) => check.area === "Microsoft Entra and MFA")?.status).toBe("warning");
    expect(result.checks.find((check) => check.area === "Backup encryption")?.message).toContain("fictional data only");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  test("reports incomplete Entra setup and leaves fallback disabled by default", () => {
    const result = inspectHubHostConfiguration({
      HUB_ENTRA_TENANT_ID: "fictional-tenant-id",
    });
    expect(result.checks.find((check) => check.area === "Microsoft Entra and MFA")).toMatchObject({
      status: "blocked",
    });
    expect(result.checks.find((check) => check.area === "Named-profile fallback")).toMatchObject({
      status: "ready",
      message: "Disabled. It can be explicitly enabled for fictional development if Entra setup is not available.",
    });
    expect(result.localDevelopmentReady).toBe(false);
    expect(result.realStudentDataReady).toBe(false);
  });

  test("labels explicitly enabled named-profile access as development-only", () => {
    const result = inspectHubHostConfiguration({
      HUB_NAMED_PROFILE_FALLBACK_ENABLED: "true",
    });
    expect(result.checks.find((check) => check.area === "Named-profile fallback")).toMatchObject({
      status: "warning",
      message: "Enabled for fictional development only. It does not verify staff identity or provide MFA.",
    });
    expect(result.localDevelopmentReady).toBe(true);
    expect(result.realStudentDataReady).toBe(false);
  });

  test("rejects backup paths that do not provide a separate off-host copy", () => {
    const result = inspectHubHostConfiguration({
      HUB_LOCAL_BACKUP_DIRECTORY: "C:\\Hub\\Backups",
      HUB_OFFHOST_BACKUP_DIRECTORY: "c:\\hub\\backups",
      HUB_FALLBACK_BACKUP_DIRECTORY: "C:\\Hub\\Backups",
    });
    expect(result.checks.find((check) => check.area === "Backup destination")).toMatchObject({
      status: "blocked",
    });
    expect(result.checks.find((check) => check.area === "Backup fallback")).toMatchObject({
      status: "blocked",
    });
  });

  test("does not mark requested LAN access ready without Host TLS files", () => {
    const result = inspectHubHostConfiguration({
      HUB_ALLOW_LAN: "true",
      HUB_HOST: "0.0.0.0",
      HUB_PUBLIC_HOST: "hub.example.edu",
    });
    expect(result.checks.find((check) => check.area === "LAN and HTTPS")).toMatchObject({
      status: "blocked",
    });
    expect(result.checks.find((check) => check.area === "School network test")?.status).toBe("not_verified");
    expect(result.realStudentDataReady).toBe(false);
  });

  test("warns on broad Windows ACLs without exposing principal names", () => {
    const broadRule = summarizeAclRules([
      {
        sid: "S-1-5-32-545",
        type: "Allow",
        rights: "ReadAndExecute, Synchronize",
      },
    ]);
    expect(broadRule.status).toBe("warning");
    expect(broadRule.message).not.toContain("S-1-5-32-545");

    const restrictedRules = summarizeAclRules([
      {
        sid: "S-1-5-21-111111111-222222222-333333333-1105",
        type: "Allow",
        rights: "Modify, Synchronize",
      },
    ]);
    expect(restrictedRules.status).toBe("not_verified");
  });

  test("checks a fictional backup-key file ACL without printing its path or contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "hh-preflight-acl-"));
    const keyPath = join(directory, "fictional.key");
    const keyContents = Buffer.alloc(32, 66).toString("base64");
    try {
      writeFileSync(keyPath, keyContents, { flag: "wx" });
      const result = inspectHubHostConfiguration({
        HUB_BACKUP_ENCRYPTION_KEY_PATH: keyPath,
      });
      const acl = result.checks.find((check) => check.area === "Backup key file ACL");
      expect(acl).toBeDefined();
      expect(["warning", "not_verified"]).toContain(acl!.status);
      expect(JSON.stringify(result)).not.toContain(keyPath);
      expect(JSON.stringify(result)).not.toContain(keyContents);
    } finally {
      if (existsSync(keyPath) && readFileSync(keyPath, "utf8") === keyContents) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
