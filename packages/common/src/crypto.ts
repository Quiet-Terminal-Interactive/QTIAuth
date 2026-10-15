import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256b64url(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function sha1Hex(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function hmacSha256(key: string | Buffer, input: string | Buffer): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = typeof a === "string" ? Buffer.from(a) : a;
  const bb = typeof b === "string" ? Buffer.from(b) : b;
  const len = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

export function numericCode(digits = 6): string {
  let out = "";
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function humanCode(length: number, groupSize = 0, alphabet = CODE_ALPHABET): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    if (groupSize > 0 && i > 0 && i % groupSize === 0) out += "-";
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

export function decodeKey(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length === 32) return buf;
  return Buffer.from(hkdfSync("sha256", Buffer.from(trimmed), Buffer.alloc(0), "qtiauth-key", 32));
}

export function deriveSubkey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `qtiauth:${purpose}`, 32));
}

export interface EncryptedBlob {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export function encrypt(key: Buffer, plaintext: string | Buffer, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext), cipher.final()]);
  const blob: EncryptedBlob = { v: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url") };
  return Buffer.from(JSON.stringify(blob)).toString("base64url");
}

export function decrypt(key: Buffer, encoded: string, aad = ""): Buffer {
  const blob = JSON.parse(Buffer.from(encoded, "base64url").toString()) as EncryptedBlob;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, "base64url")), decipher.final()]);
}

export function encryptStream(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from("QTIE1"), iv, cipher.getAuthTag(), ct]);
}

export function decryptStream(key: Buffer, data: Buffer): Buffer {
  if (data.subarray(0, 5).toString() !== "QTIE1") throw new Error("Not a QTIAuth encrypted blob");
  const iv = data.subarray(5, 17);
  const tag = data.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(33)), decipher.final()]);
}
