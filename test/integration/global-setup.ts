import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgUrl: string;
    natsUrl: string;
    valkeyUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

function findBinary(name: string): string {
  const dirs = [process.env.QTIAUTH_TEST_BIN_DIR, ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean) as string[];
  for (const d of dirs) {
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  throw new Error(`${name} not found. Install it or set QTIAUTH_TEST_BIN_DIR.`);
}

async function waitFor(fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for infrastructure");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createServer();
    sock.once("error", () => resolve(true));
    sock.listen(port, "127.0.0.1", () => sock.close(() => resolve(false)));
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = mkdtempSync(join(tmpdir(), "qtiauth-it-"));
  const pgPort = await freePort();
  const natsPort = await freePort();
  const valkeyPort = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(root, "pg"), user: "postgres", password: "postgres", port: pgPort, persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("qtiauth");
  const procs: ChildProcess[] = [];
  procs.push(spawn(findBinary("nats-server"), ["-js", "-p", String(natsPort), "-sd", join(root, "nats"), "-a", "127.0.0.1"], { stdio: "ignore" }));
  procs.push(spawn(findBinary("valkey-server"), ["--port", String(valkeyPort), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" }));
  await waitFor(() => portOpen(natsPort));
  await waitFor(() => portOpen(valkeyPort));
  project.provide("pgUrl", `postgres://postgres:postgres@127.0.0.1:${pgPort}/qtiauth`);
  project.provide("natsUrl", `nats://127.0.0.1:${natsPort}`);
  project.provide("valkeyUrl", `redis://127.0.0.1:${valkeyPort}`);
  return async () => {
    for (const p of procs) p.kill("SIGTERM");
    await pg.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };
}
