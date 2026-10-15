import { createChallenge, verifySolution } from "altcha-lib";
import { inc, sha256 } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";
import type { Valkey } from "@qtiauth/service-kit";

export interface CaptchaInfo {
  provider: string;
  site_key: string | null;
}

const VERIFY_URLS: Record<string, string> = {
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  hcaptcha: "https://api.hcaptcha.com/siteverify",
  friendly_captcha: "https://api.friendlycaptcha.com/api/v1/siteverify",
};

export class Captcha {
  private readonly cfg: Config["captcha"];
  private readonly v: Valkey;
  private readonly hmacKey: string;

  constructor(cfg: Config, v: Valkey) {
    this.cfg = cfg.captcha;
    this.v = v;
    this.hmacKey = cfg.captcha.altcha_hmac_key ?? sha256(`altcha:${cfg.secrets.app_encryption_key ?? "qtiauth-dev"}`);
  }

  get enabled(): boolean {
    return this.cfg.provider !== "none";
  }

  info(): CaptchaInfo {
    return { provider: this.cfg.provider, site_key: this.cfg.site_key ?? null };
  }

  async challenge(): Promise<unknown> {
    if (this.cfg.provider !== "altcha") return { provider: this.cfg.provider, site_key: this.cfg.site_key ?? null };
    const expires = new Date(Date.now() + this.cfg.solution_ttl);
    return createChallenge({ hmacKey: this.hmacKey, maxNumber: this.cfg.altcha_max_number, expires });
  }

  async verify(solution: string | undefined | null, ip: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (!solution) return false;
    let ok = false;
    try {
      if (this.cfg.provider === "altcha") {
        ok = await verifySolution(solution, this.hmacKey, true);
        if (ok) {
          const replayKey = `captcha:used:${sha256(solution)}`;
          const first = await this.v.set(replayKey, "1", "PX", this.cfg.solution_ttl, "NX").catch(() => "OK");
          if (first !== "OK") ok = false;
        }
      } else {
        const url = VERIFY_URLS[this.cfg.provider]!;
        const body =
          this.cfg.provider === "friendly_captcha"
            ? JSON.stringify({ solution, secret: this.cfg.secret_key, sitekey: this.cfg.site_key })
            : new URLSearchParams({ secret: this.cfg.secret_key ?? "", response: solution, remoteip: ip }).toString();
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": this.cfg.provider === "friendly_captcha" ? "application/json" : "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        const j = (await r.json()) as { success?: boolean };
        ok = j.success === true;
      }
    } catch {
      ok = false;
    }
    inc("qtiauth_captcha_total", { provider: this.cfg.provider, result: ok ? "solved" : "failed" }, 1, "CAPTCHA verifications");
    return ok;
  }
}
