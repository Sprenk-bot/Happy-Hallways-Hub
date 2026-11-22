import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
  backupEncryptionKeyId,
  decryptBackupFileSync,
  encryptBackupFileSync,
  encryptedBackupHeader,
} from "./backup-crypto";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "hh-backup-crypto-"));
  directories.push(directory);
  return directory;
}

describe("Hub backup encryption", () => {
  test("encrypts and decrypts a file with authenticated metadata", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "fictional.sqlite");
    const encrypted = join(directory, "fictional.sqlite.enc");
    const restored = join(directory, "restored.sqlite");
    const key = randomBytes(32);
    const contents = Buffer.from("fictional Hub snapshot fixture\n");
    writeFileSync(source, contents);

    const metadata = encryptBackupFileSync(source, encrypted, key);
    expect(encryptedBackupHeader(encrypted).keyId).toBe(backupEncryptionKeyId(key));
    expect(readFileSync(encrypted).includes(contents)).toBe(false);
    expect(decryptBackupFileSync(encrypted, restored, key, metadata.keyId)).toEqual({
      keyId: metadata.keyId,
      plaintextSha256: metadata.plaintextSha256,
      plaintextBytes: contents.byteLength,
    });
    expect(readFileSync(restored)).toEqual(contents);
  });

  test("rejects an incorrect key and removes partial plaintext output", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "fictional.sqlite");
    const encrypted = join(directory, "fictional.sqlite.enc");
    const restored = join(directory, "restored.sqlite");
    writeFileSync(source, "fictional data");
    encryptBackupFileSync(source, encrypted, randomBytes(32));

    expect(() => decryptBackupFileSync(encrypted, restored, randomBytes(32))).toThrow();
    expect(existsSync(restored)).toBe(false);
  });

  test("rejects a modified ciphertext and removes partial plaintext output", () => {
    const directory = temporaryDirectory();
    const source = join(directory, "fictional.sqlite");
    const encrypted = join(directory, "fictional.sqlite.enc");
    const restored = join(directory, "restored.sqlite");
    const key = randomBytes(32);
    writeFileSync(source, "fictional data");
    encryptBackupFileSync(source, encrypted, key);
    const bytes = readFileSync(encrypted);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(encrypted, bytes);

    expect(() => decryptBackupFileSync(encrypted, restored, key)).toThrow();
    expect(existsSync(restored)).toBe(false);
  });
});
