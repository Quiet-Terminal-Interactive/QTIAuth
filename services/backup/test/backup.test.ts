import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger, decryptStream, encryptStream } from "@qtiauth/common";
import { parseConfig } from "@qtiauth/config";
import { backupKey, backupStore, listBackups, newBackupId, pruneBackups, readManifest } from "../src/lib.ts";

const dir = mkdtempSync(join(tmpdir(), "qtiauth-backup-"));
const cfg = parseConfig({ surfaces: { account: { ports: [1] }, support: { ports: [2] }, api: { ports: [3] } }, backups: { retention: "1d", destination: { type: "volume", path: dir } } }, { BACKUP_ENCRYPTION_KEY: "d".repeat(64) });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("backup library", () => {
  it("makes sortable ids", () => {
    const a = newBackupId(new Date("2026-01-01T00:00:00Z"));
    expect(a).toMatch(/^20260101T000000Z-[a-z0-9]{4}$/);
    expect(a < newBackupId(new Date("2026-01-02T00:00:00Z"))).toBe(true);
  });

  it("encrypts with a key derived from BACKUP_ENCRYPTION_KEY", () => {
    const blob = encryptStream(backupKey(cfg), Buffer.from("pg dump bytes"));
    expect(blob.includes(Buffer.from("pg dump"))).toBe(false);
    expect(decryptStream(backupKey(cfg), blob).toString()).toBe("pg dump bytes");
    expect(() => backupKey(parseConfig({ surfaces: cfg.surfaces }, {}))).toThrow(/BACKUP_ENCRYPTION_KEY/);
  });

  it("stores, lists and prunes backups past retention", async () => {
    const store = backupStore(cfg);
    const old = newBackupId(new Date(Date.now() - 3 * 86_400_000));
    const fresh = newBackupId();
    for (const [id, at] of [[old, new Date(Date.now() - 3 * 86_400_000)], [fresh, new Date()]] as const) {
      await store.put(`${id}/manifest.json`, Buffer.from(JSON.stringify({ id, created_at: at.toISOString(), qtiauth_version: "1", schemas: [], storage_manifest: null, format: 1 })));
    }
    expect((await listBackups(cfg)).map((b) => b.id)).toEqual([old, fresh]);
    expect(await pruneBackups(cfg, createLogger("test", "silent"))).toEqual([old]);
    expect((await readManifest(cfg, fresh)).id).toBe(fresh);
    await expect(readManifest(cfg, "../../etc")).rejects.toThrow(/Invalid backup id/);
  });
});
