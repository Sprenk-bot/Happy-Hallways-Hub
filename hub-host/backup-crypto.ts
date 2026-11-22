import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";

const magic = Buffer.from("HHHUBENC1", "ascii");
const algorithm = "aes-256-gcm";
const chunkSize = 64 * 1024;

type BackupHeader = {
  formatVersion: 1;
  algorithm: typeof algorithm;
  keyId: string;
  iv: string;
  authTag: string;
  plaintextSha256: string;
  plaintextBytes: number;
};

type HeaderBase = Pick<BackupHeader, "formatVersion" | "algorithm" | "keyId" | "iv">;

export function parseBackupEncryptionKey(contents: Buffer): Buffer {
  const text = contents.toString("utf8").trim();
  let key: Buffer;
  if (/^[a-f0-9]{64}$/i.test(text)) key = Buffer.from(text, "hex");
  else if (/^[A-Za-z0-9+/]{43}=$/.test(text)) key = Buffer.from(text, "base64");
  else if (contents.byteLength === 32) key = Buffer.from(contents);
  else {
    throw new Error(
      "Backup key must be 32 raw bytes, 64 hexadecimal characters, or a 44-character base64 value.",
    );
  }
  if (key.byteLength !== 32) {
    throw new Error("Backup key must contain exactly 32 bytes.");
  }
  return key;
}

export function backupEncryptionKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export function encryptBackupFileSync(
  plaintextPath: string,
  encryptedPath: string,
  key: Buffer,
) {
  if (key.byteLength !== 32) throw new TypeError("Backup key must be 32 bytes.");
  if (existsSync(encryptedPath)) {
    throw new TypeError("Encrypted backup target must be a new file.");
  }

  const keyId = backupEncryptionKeyId(key);
  const iv = randomBytes(12);
  const base: HeaderBase = {
    formatVersion: 1,
    algorithm,
    keyId,
    iv: iv.toString("base64"),
  };
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(base), "utf8"));
  const hash = createHash("sha256");
  const encryptedTemporaryPath = `${encryptedPath}.${randomUUID()}.cipher.partial`;
  let sourceFd: number | null = null;
  let cipherFd: number | null = null;
  let outputFd: number | null = null;
  let plaintextBytes = 0;

  try {
    sourceFd = openSync(plaintextPath, "r");
    cipherFd = openSync(encryptedTemporaryPath, "wx");
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      plaintextBytes += bytesRead;
      writeAll(cipherFd, cipher.update(chunk));
    }
    writeAll(cipherFd, cipher.final());
    closeSync(cipherFd);
    cipherFd = null;
    closeSync(sourceFd);
    sourceFd = null;

    const header: BackupHeader = {
      ...base,
      authTag: cipher.getAuthTag().toString("base64"),
      plaintextSha256: hash.digest("hex"),
      plaintextBytes,
    };
    const encodedHeader = Buffer.from(JSON.stringify(header), "utf8");
    if (encodedHeader.byteLength > 16 * 1024) {
      throw new Error("Encrypted backup header is too large.");
    }
    outputFd = openSync(encryptedPath, "wx");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encodedHeader.byteLength, 0);
    writeAll(outputFd, magic);
    writeAll(outputFd, length);
    writeAll(outputFd, encodedHeader);

    cipherFd = openSync(encryptedTemporaryPath, "r");
    const outputBuffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const bytesRead = readSync(cipherFd, outputBuffer, 0, outputBuffer.byteLength, null);
      if (bytesRead === 0) break;
      writeAll(outputFd, outputBuffer.subarray(0, bytesRead));
    }
    closeSync(cipherFd);
    cipherFd = null;
    closeSync(outputFd);
    outputFd = null;
    return { keyId, plaintextSha256: header.plaintextSha256, plaintextBytes };
  } catch (error) {
    if (existsSync(encryptedPath)) rmSync(encryptedPath, { force: true });
    throw error;
  } finally {
    if (sourceFd !== null) closeSync(sourceFd);
    if (cipherFd !== null) closeSync(cipherFd);
    if (outputFd !== null) closeSync(outputFd);
    rmSync(encryptedTemporaryPath, { force: true });
  }
}

export function decryptBackupFileSync(
  encryptedPath: string,
  plaintextPath: string,
  key: Buffer,
  expectedKeyId?: string,
) {
  if (key.byteLength !== 32) throw new TypeError("Backup key must be 32 bytes.");
  if (existsSync(plaintextPath)) {
    throw new TypeError("Decrypted backup target must be a new file.");
  }

  let inputFd: number | null = null;
  let outputFd: number | null = null;
  try {
    inputFd = openSync(encryptedPath, "r");
    const prefix = readExact(inputFd, magic.byteLength + 4);
    if (!prefix.subarray(0, magic.byteLength).equals(magic)) {
      throw new Error("Encrypted backup has an unknown file format.");
    }
    const headerLength = prefix.readUInt32BE(magic.byteLength);
    if (headerLength < 1 || headerLength > 16 * 1024) {
      throw new Error("Encrypted backup header length is invalid.");
    }
    const header = JSON.parse(readExact(inputFd, headerLength).toString("utf8")) as BackupHeader;
    const actualKeyId = backupEncryptionKeyId(key);
    if (
      header.formatVersion !== 1 ||
      header.algorithm !== algorithm ||
      header.keyId !== actualKeyId ||
      (expectedKeyId && header.keyId !== expectedKeyId) ||
      !/^[a-f0-9]{64}$/.test(header.plaintextSha256) ||
      !Number.isSafeInteger(header.plaintextBytes) ||
      header.plaintextBytes < 0
    ) {
      throw new Error("Encrypted backup metadata or key does not match.");
    }
    const iv = Buffer.from(header.iv, "base64");
    const authTag = Buffer.from(header.authTag, "base64");
    if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
      throw new Error("Encrypted backup authentication metadata is invalid.");
    }
    const base: HeaderBase = {
      formatVersion: 1,
      algorithm,
      keyId: header.keyId,
      iv: header.iv,
    };
    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(base), "utf8"));
    decipher.setAuthTag(authTag);
    const hash = createHash("sha256");
    let plaintextBytes = 0;
    outputFd = openSync(plaintextPath, "wx");
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const bytesRead = readSync(inputFd, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = decipher.update(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      plaintextBytes += chunk.byteLength;
      writeAll(outputFd, chunk);
    }
    const final = decipher.final();
    hash.update(final);
    plaintextBytes += final.byteLength;
    writeAll(outputFd, final);
    const plaintextSha256 = hash.digest("hex");
    if (
      plaintextSha256 !== header.plaintextSha256 ||
      plaintextBytes !== header.plaintextBytes
    ) {
      throw new Error("Decrypted backup failed its plaintext checksum.");
    }
    closeSync(outputFd);
    outputFd = null;
    closeSync(inputFd);
    inputFd = null;
    return {
      keyId: header.keyId,
      plaintextSha256,
      plaintextBytes,
    };
  } catch (error) {
    if (existsSync(plaintextPath)) rmSync(plaintextPath, { force: true });
    throw error;
  } finally {
    if (inputFd !== null) closeSync(inputFd);
    if (outputFd !== null) closeSync(outputFd);
  }
}

export function encryptedBackupHeader(encryptedPath: string) {
  const fileSize = statSync(encryptedPath).size;
  const fd = openSync(encryptedPath, "r");
  try {
    const prefix = readExact(fd, magic.byteLength + 4);
    if (!prefix.subarray(0, magic.byteLength).equals(magic)) {
      throw new Error("Encrypted backup has an unknown file format.");
    }
    const headerLength = prefix.readUInt32BE(magic.byteLength);
    if (
      headerLength < 1 ||
      headerLength > 16 * 1024 ||
      magic.byteLength + 4 + headerLength > fileSize
    ) {
      throw new Error("Encrypted backup header length is invalid.");
    }
    return JSON.parse(readExact(fd, headerLength).toString("utf8")) as BackupHeader;
  } finally {
    closeSync(fd);
  }
}

function readExact(fd: number, length: number) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(fd, buffer, offset, length - offset, null);
    if (bytesRead === 0) throw new Error("Encrypted backup is truncated.");
    offset += bytesRead;
  }
  return buffer;
}

function writeAll(fd: number, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    offset += writeSync(fd, buffer, offset, buffer.byteLength - offset);
  }
}
