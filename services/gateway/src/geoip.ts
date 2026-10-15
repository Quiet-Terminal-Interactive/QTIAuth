import { existsSync } from "node:fs";
import maxmind, { type Reader, type CountryResponse } from "maxmind";
import type { Config } from "@qtiauth/config";
import type { Logger } from "@qtiauth/common";

export class GeoIp {
  private reader: Reader<CountryResponse> | null = null;
  private readonly cfg: Config["geoip"];
  private readonly log: Logger;
  status: "ok" | "missing" | "disabled" | "header" = "disabled";

  constructor(cfg: Config, log: Logger) {
    this.cfg = cfg.geoip;
    this.log = log;
  }

  async init(): Promise<void> {
    if (this.cfg.source === "none") {
      this.status = "disabled";
      return;
    }
    if (this.cfg.source === "header") {
      this.status = this.cfg.header ? "header" : "disabled";
      return;
    }
    await this.load();
    const timer = setInterval(() => void this.load(), 3_600_000);
    timer.unref();
  }

  private async load(): Promise<void> {
    if (!existsSync(this.cfg.database_path)) {
      this.status = "missing";
      return;
    }
    try {
      this.reader = await maxmind.open<CountryResponse>(this.cfg.database_path, { cache: { max: 10_000 } });
      this.status = "ok";
    } catch (err) {
      this.log.warn({ err }, "could not open GeoIP database");
      this.status = "missing";
    }
  }

  country(ip: string, headers: Headers): string | null {
    if (this.cfg.source === "header") {
      const v = this.cfg.header ? headers.get(this.cfg.header) : null;
      return v && /^[A-Z]{2}$/i.test(v.trim()) ? v.trim().toUpperCase() : null;
    }
    if (!this.reader) return null;
    try {
      const r = this.reader.get(ip);
      return r?.country?.iso_code ?? r?.registered_country?.iso_code ?? null;
    } catch {
      return null;
    }
  }
}
