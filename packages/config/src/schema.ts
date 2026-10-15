import { z } from "zod";
import { parseDuration } from "@qtiauth/common";

const DURATION_STRING_RE = /^(\d+(?:\.\d+)?(ms|s|m|h|d|w|y)\s*)+$/;

export const duration = (def: string) =>
  z
    .union([z.string().regex(DURATION_STRING_RE, "Expected a duration like 30s, 15m, 7d"), z.number().int().nonnegative()])
    .transform((v) => parseDuration(v))
    .prefault(def);

function withDefaults<S extends z.ZodType>(defaults: Record<string, unknown>, schema: S) {
  return z.preprocess((v) => ({ ...defaults, ...((v as Record<string, unknown> | undefined) ?? {}) }), schema).prefault({});
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #rrggbb colour");
const hostname = z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i, "Expected a hostname");
const basePath = z
  .string()
  .regex(/^\/[A-Za-z0-9/_-]*$/, "base_path must start with /")
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") : p));

export const MODULES = ["identity", "oidc", "games", "safety", "admin", "support"] as const;
export const SERVICES = ["gateway", "identity", "notifier", "scheduler", "web", "oidc", "safety", "support", "games", "backup"] as const;
export const SURFACE_NAMES = ["account", "support", "api"] as const;

const surface = (defaults: { base_path: string }) =>
  z
    .object({
      hosts: z.array(hostname).default([]),
      ports: z.array(z.number().int().min(1).max(65535)).default([]),
      base_path: basePath.default(defaults.base_path),
      scheme: z.enum(["https", "http"]).default("https"),
      public_origin: z.url().optional(),
      modules: z.array(z.enum(MODULES)).optional(),
    })
    .prefault({});

const sender = z.object({ name: z.string(), address: z.email() });

const socialProvider = z
  .object({
    enabled: z.boolean().default(false),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .prefault({});

const genericOidc = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  issuer: z.url(),
  client_id: z.string(),
  client_secret: z.string(),
  scopes: z.array(z.string()).default(["openid", "email", "profile"]),
  icon: z.string().optional(),
  enabled: z.boolean().default(true),
});

const toggle = (enabled: boolean) => z.object({ enabled: z.boolean().default(enabled) }).prefault({});

const ratePolicy = z.object({
  per: z.union([z.enum(["ip", "account", "email", "user", "client", "session", "game", "app"]), z.array(z.enum(["ip", "account", "email", "user", "client", "session", "game", "app"]))]),
  limit: z.number().int().positive(),
  window: duration("1m"),
  fail: z.enum(["open", "closed"]).optional(),
  captcha_after: z.number().int().positive().optional(),
});

const DEFAULT_RATE_LIMITS = {
  global: { per: "ip", limit: 300, window: "1m", fail: "open" },
  auth_password: { per: ["ip", "account"], limit: 10, window: "15m", captcha_after: 5 },
  auth_signup: { per: "ip", limit: 10, window: "1h", captcha_after: 3 },
  auth_general: { per: "ip", limit: 30, window: "15m" },
  auth_verify: { per: "ip", limit: 30, window: "15m" },
  magic_link_email: { per: "email", limit: 3, window: "1h" },
  magic_link_ip: { per: "ip", limit: 10, window: "1h", captcha_after: 5 },
  magic_link_ip_day: { per: "ip", limit: 20, window: "1d" },
  password_reset: { per: ["ip", "email"], limit: 5, window: "1h" },
  totp_verify: { per: ["ip", "user"], limit: 10, window: "15m" },
  account_write: { per: "user", limit: 60, window: "1m", fail: "open" },
  ticket_create: { per: "user", limit: 5, window: "1h" },
  guest_ticket: { per: "ip", limit: 3, window: "1h", captcha_after: 1 },
  guest_code: { per: ["ip", "email"], limit: 5, window: "1h" },
  key_redeem: { per: ["ip", "user"], limit: 10, window: "1h", captcha_after: 3 },
  kb_feedback: { per: "ip", limit: 30, window: "1h", fail: "open" },
  report_create: { per: "user", limit: 20, window: "1h" },
  oauth_token: { per: ["ip", "client"], limit: 120, window: "1m" },
  oauth_device: { per: "ip", limit: 30, window: "15m" },
  game_write: { per: ["user", "game"], limit: 600, window: "1m", fail: "open" },
  game_service: { per: "client", limit: 3000, window: "1m", fail: "open" },
  steam_authenticate: { per: ["ip", "app"], limit: 60, window: "1m" },
  license_verify: { per: "ip", limit: 300, window: "1m", fail: "open" },
  admin: { per: "user", limit: 300, window: "1m", fail: "open" },
  developer: { per: "user", limit: 60, window: "1m" },
  intake: { per: "client", limit: 600, window: "1m" },
  public_read: { per: "ip", limit: 120, window: "1m", fail: "open" },
} as const;

const scopeDef = z.object({
  description: z.string(),
  consent_text: z.string(),
  claims: z.array(z.string()).default([]),
  game_client_only: z.boolean().default(false),
  service_only: z.boolean().default(false),
  hidden: z.boolean().default(false),
});

const DEFAULT_SCOPES = {
  openid: { description: "Sign you in", consent_text: "Sign you in with your account", claims: ["sub"] },
  profile: { description: "Your username", consent_text: "See your username", claims: ["preferred_username", "username_updated_at"] },
  email: { description: "Your email address", consent_text: "See your email address", claims: ["email", "email_verified"] },
  offline_access: { description: "Stay signed in", consent_text: "Stay connected when you're not using it", claims: [] },
  age: { description: "Your age band", consent_text: "See your age band (never your date of birth)", claims: ["age_band", "age_assurance_strength"] },
  parental_controls: { description: "Parental controls", consent_text: "See parental controls set by your parent or guardian", claims: ["parental_controls"] },
  restrictions: { description: "Account restrictions", consent_text: "See moderation restrictions on your account", claims: ["restrictions"] },
  games: { description: "Your games", consent_text: "See which games and content you own", claims: [] },
  achievements: { description: "Your achievements", consent_text: "See your achievements", claims: [] },
  game_stats: { description: "Your game stats", consent_text: "See your game stats and leaderboard entries", claims: [] },
  "achievements.write": { description: "Unlock achievements", consent_text: "Unlock achievements and record progress in this game", claims: [], game_client_only: true },
  "game_stats.write": { description: "Record stats", consent_text: "Record stats, playtime and save data for this game", claims: [], game_client_only: true },
  "games.entitlements.write": { description: "Grant entitlements", consent_text: "Grant and revoke entitlements", claims: [], service_only: true, hidden: true },
  "games.server": { description: "Game server", consent_text: "Act as this game's server", claims: [], service_only: true, hidden: true },
  "safety.intake": { description: "Submit reports", consent_text: "Submit safety reports", claims: [], service_only: false, hidden: false },
};

const firstPartyClient = z.object({
  client_id: z.string().regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string(),
  type: z.enum(["confidential", "public"]).default("public"),
  client_secret: z.string().optional(),
  redirect_uris: z.array(z.string()).default([]),
  post_logout_redirect_uris: z.array(z.string()).default([]),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"])).default(["authorization_code", "refresh_token"]),
  scopes: z.array(z.string()).default(["openid", "profile", "email", "offline_access"]),
  backchannel_logout_uri: z.url().optional(),
  backchannel_logout_session_required: z.boolean().default(false),
  require_par: z.boolean().default(false),
});

const DEFAULT_ROLES = {
  admin: { description: "Full administrative access", permissions: ["*"] },
  moderator: {
    description: "Reviews reports and applies moderation actions",
    permissions: ["users.read", "safety.reports.read", "safety.actions.apply", "safety.appeals.resolve", "safety.flags.read"],
  },
  support_agent: { description: "Handles support tickets", permissions: ["users.read", "support.tickets.staff", "support.macros.manage"] },
  kb_editor: { description: "Edits the knowledge base", permissions: ["support.kb.edit"] },
  game_manager: {
    description: "Manages the game catalog and entitlements",
    permissions: ["games.catalog.edit", "games.entitlements.grant", "games.keys.manage", "games.achievements.moderate", "games.leaderboards.moderate", "games.licensing.manage"],
  },
};

const reportType = z.object({
  label: z.string(),
  osa_category: z.string(),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  sla: duration("24h"),
  csea: z.boolean().default(false),
  subtypes: z.record(z.string(), z.object({ label: z.string(), priority: z.enum(["low", "normal", "high", "critical"]).optional() })).default({}),
});

const DEFAULT_TAXONOMY = {
  csea: {
    label: "Child sexual exploitation and abuse",
    osa_category: "priority_illegal_csea",
    priority: "critical",
    sla: "1h",
    csea: true,
    subtypes: { csam: { label: "Child sexual abuse material" }, grooming: { label: "Grooming or sexual communication with a child" } },
  },
  terrorism: { label: "Terrorism", osa_category: "priority_illegal_terrorism", priority: "critical", sla: "1h", subtypes: { terrorist_content: { label: "Terrorist content or support for a proscribed organisation" } } },
  violence: {
    label: "Threats and violence",
    osa_category: "priority_illegal_threats",
    priority: "high",
    sla: "24h",
    subtypes: { threats: { label: "Threats to kill or harm" }, violent_content: { label: "Graphic violence", priority: "normal" } },
  },
  hate: { label: "Hate", osa_category: "priority_illegal_hate", priority: "high", sla: "24h", subtypes: { hate_speech: { label: "Hate speech or stirring up hatred" } } },
  harassment: {
    label: "Harassment",
    osa_category: "priority_illegal_harassment",
    priority: "normal",
    sla: "24h",
    subtypes: { harassment: { label: "Harassment, stalking or abuse" }, doxxing: { label: "Sharing private information", priority: "high" } },
  },
  self_harm: {
    label: "Suicide and self-harm",
    osa_category: "primary_priority_content_children",
    priority: "high",
    sla: "24h",
    subtypes: { suicide_self_harm: { label: "Encouraging suicide or self-harm" }, eating_disorder: { label: "Promoting eating disorders" } },
  },
  sexual_content: {
    label: "Sexual content",
    osa_category: "priority_illegal_sexual",
    priority: "high",
    sla: "24h",
    subtypes: { pornography: { label: "Pornographic content" }, intimate_image_abuse: { label: "Intimate image abuse" } },
  },
  fraud: { label: "Fraud and scams", osa_category: "priority_illegal_fraud", priority: "normal", sla: "24h", subtypes: { scam: { label: "Scam or fraud" }, impersonation: { label: "Impersonation" } } },
  other_illegal: { label: "Other illegal content", osa_category: "priority_illegal_other", priority: "normal", sla: "24h", subtypes: { drugs_weapons: { label: "Drugs, weapons or other illegal sales" } } },
};

const actionType = z.object({
  label: z.string(),
  effect: z.enum(["warn", "restrict", "force_username_reset", "lock", "ban", "remove_content", "proscribed_org_removal"]),
  restrictions: z.array(z.string()).default([]),
  default_duration: duration("0s").optional(),
  requires_duration: z.boolean().default(false),
  reason_code: z.string().optional(),
});

const DEFAULT_ACTIONS = {
  warn: { label: "Warning", effect: "warn" },
  restrict_chat: { label: "Restrict chat", effect: "restrict", restrictions: ["chat"] },
  restrict_ugc: { label: "Restrict user-generated content", effect: "restrict", restrictions: ["ugc"] },
  restrict_username: { label: "Restrict username changes", effect: "restrict", restrictions: ["username_change"] },
  force_username_reset: { label: "Force username reset", effect: "force_username_reset" },
  lock: { label: "Temporary lock", effect: "lock", requires_duration: true, default_duration: "7d" },
  ban: { label: "Ban", effect: "ban" },
  remove_content: { label: "Remove content", effect: "remove_content" },
  proscribed_org_removal: { label: "Proscribed organisation removal", effect: "proscribed_org_removal", reason_code: "ICU_H1" },
};

const DEFAULT_RULES = {
  "conduct.illegal": { title: "Illegal content", text: "You must not share or promote illegal content." },
  "conduct.csea": { title: "Child safety", text: "Content or behaviour that sexually exploits or endangers children is prohibited and reported to the authorities." },
  "conduct.terrorism": { title: "Terrorism", text: "You must not share terrorist content or support proscribed organisations." },
  "conduct.hate": { title: "Hate", text: "You must not attack people based on protected characteristics." },
  "conduct.harassment": { title: "Harassment", text: "You must not harass, threaten or abuse others." },
  "conduct.self_harm": { title: "Self-harm", text: "You must not encourage suicide, self-harm or eating disorders." },
  "conduct.sexual": { title: "Sexual content", text: "You must not share sexual content or intimate images without consent." },
  "conduct.fraud": { title: "Fraud", text: "You must not scam, defraud or impersonate others." },
  "conduct.cheating": { title: "Cheating", text: "You must not cheat or exploit games." },
  "conduct.username": { title: "Usernames", text: "Usernames must not be offensive, misleading or impersonate others." },
};

const supportCategory = z.object({
  label: z.string(),
  guest_allowed: z.boolean().default(false),
  appeal: z.boolean().default(false),
  default_priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

const DEFAULT_CATEGORIES = {
  account: { label: "Account and sign-in", guest_allowed: true },
  privacy: { label: "Privacy and data", guest_allowed: true },
  games: { label: "Games and purchases" },
  technical: { label: "Technical problem" },
  appeal: { label: "Appeal a moderation decision", appeal: true, guest_allowed: false, default_priority: "high" },
  other: { label: "Something else", guest_allowed: true },
};

const DEFAULT_SCHEDULE = {
  "retention.sweep": "0 3 * * *",
  "parental.expire_pending": "0 * * * *",
  "parental.reminders": "0 10 * * *",
  "parental.activity_summary": "0 9 * * 1",
  "accounts.purge_deleted": "30 3 * * *",
  "age.recompute_bands": "5 0 * * *",
  "deletion_ledger.prune": "0 4 * * *",
  "keys.rotate": "15 1 * * *",
  "webhooks.retry": "* * * * *",
  "support.auto_close": "0 * * * *",
  "achievements.recompute_rarity": "0 2 * * *",
  "leaderboards.reset_periodic": "1 0 * * *",
  "steam.ownership_sync": "0 5 * * *",
  "backup.run": "30 2 * * *",
  "safety.sla_check": "*/5 * * * *",
  "safety.expire_actions": "*/5 * * * *",
  "identity.expire_locks": "*/5 * * * *",
  "legal.activate_versions": "*/5 * * * *",
  "oidc.backchannel_retry": "* * * * *",
  "deletion_ledger.flush": "*/5 * * * *",
};

const storage = z
  .object({
    provider: z.enum(["s3", "none"]).default("none"),
    endpoint: z.string().optional(),
    public_endpoint: z.string().optional(),
    region: z.string().default("us-east-1"),
    bucket: z.string().default("qtiauth"),
    access_key_id: z.string().optional(),
    secret_access_key: z.string().optional(),
    force_path_style: z.boolean().default(true),
    presign_ttl: duration("15m"),
  })
  .prefault({});

const colors = z
  .object({
    scheme: z.enum(["dark", "light"]).default("dark"),
    background: hex.default("#222034"),
    surface: hex.default("#2C2A44"),
    surface_raised: hex.default("#363352"),
    border: hex.default("#45416A"),
    text: hex.default("#F2F0FA"),
    text_muted: hex.default("#A9A5C6"),
    primary: hex.default("#5BB1EF"),
    primary_text: hex.default("#222034"),
    accent: hex.default("#BC6DE0"),
    success: hex.default("#80D35D"),
    warning: hex.default("#F7DA47"),
    danger: hex.default("#DD5F5F"),
    highlight: hex.default("#FF954F"),
    info: hex.default("#5BB1EF"),
    palette: z
      .object({
        red: hex.default("#DD5F5F"),
        orange: hex.default("#FF954F"),
        green: hex.default("#80D35D"),
        yellow: hex.default("#F7DA47"),
        purple: hex.default("#BC6DE0"),
        blue: hex.default("#5BB1EF"),
      })
      .prefault({}),
  })
  .prefault({});

export const configSchema = z
  .object({
    branding: z
      .object({
        product_name: z.string().default("Example Account"),
        company_name: z.string().default("Example Ltd"),
        support_email: z.email().default("support@example.com"),
        logo: z.string().default("./branding/logo.svg"),
        favicon: z.string().default("./branding/favicon.ico"),
        colors,
        font_family: z.string().default("system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"),
        heading_font_family: z.string().optional(),
        border_radius: z.string().default("10px"),
        custom_css: z.string().optional(),
        default_locale: z.string().default("en-GB"),
        locales: z.array(z.string()).default(["en-GB"]),
        website_url: z.url().optional(),
        footer_links: z.array(z.object({ label: z.string(), href: z.string() })).default([]),
      })
      .prefault({}),

    surfaces: z
      .object({
        account: surface({ base_path: "/" }),
        support: surface({ base_path: "/support" }),
        api: surface({ base_path: "/api" }),
      })
      .prefault({}),

    cookies: z
      .object({
        domain: z.string().nullable().default(null),
        name: z.string().regex(/^[A-Za-z0-9_-]+$/).default("qtiauth_session"),
        secure: z.boolean().default(true),
        session_ttl: duration("7d"),
        idle_timeout: duration("30d"),
      })
      .prefault({}),

    cors: z.object({ allowed_origins: z.array(z.string()).default([]) }).prefault({}),

    network: z
      .object({
        trusted_proxies: z.array(z.string()).default([]),
        client_port_header: z.string().toLowerCase().nullable().default("x-client-port"),
        listen: z.array(z.number().int().min(1).max(65535)).default([]),
        metrics_token: z.string().optional(),
      })
      .prefault({}),

    infrastructure: z
      .object({
        nats_url: z.string().default("nats://nats:4222"),
        nats_user: z.string().optional(),
        nats_password: z.string().optional(),
        valkey_url: z.string().default("redis://valkey:6379"),
        internal_port: z.number().int().default(3000),
        gateway_url: z.string().default("http://gateway:8080"),
        web_url: z.string().default("http://web:3000"),
        rpc_timeout: duration("5s"),
      })
      .prefault({}),

    geoip: z
      .object({
        source: z.enum(["dbip_lite", "maxmind", "header", "none"]).default("dbip_lite"),
        header: z.string().nullable().default(null),
        database_path: z.string().default("/var/lib/geoip/country.mmdb"),
        maxmind_license_key: z.string().optional(),
      })
      .prefault({}),

    migrations: z.object({ auto_apply: z.boolean().default(true) }).prefault({}),

    features: z
      .object({
        auth: z
          .object({
            password: toggle(true),
            magic_link: toggle(true),
            passkeys: toggle(true),
            totp: toggle(true),
            social: z
              .object({
                google: socialProvider,
                github: socialProvider,
                discord: socialProvider,
                steam: z.object({ enabled: z.boolean().default(false), api_key: z.string().optional() }).prefault({}),
                generic_oidc: z.array(genericOidc).default([]),
              })
              .prefault({}),
          })
          .prefault({}),
        session_security: toggle(true),
        oidc: z
          .object({
            developer_portal: z.object({ enabled: z.boolean().default(true), max_clients_per_user: z.number().int().positive().default(10) }).prefault({}),
            backchannel_logout: toggle(true),
            device_flow: toggle(true),
            par: toggle(true),
          })
          .prefault({}),
        games: z
          .object({
            licensing: z.object({ enabled: z.boolean().default(true), max_devices: z.number().int().positive().default(3) }).prefault({}),
            steam: z
              .object({
                enabled: z.boolean().default(false),
                publisher_key: z.string().optional(),
                web_api_host: z.string().default("partner.steam-api.com"),
                unlink_cooldown: duration("7d"),
                apps: z
                  .array(
                    z.object({
                      app_id: z.number().int().positive(),
                      game_slug: z.string(),
                      ticket_identity: z.string().default("qtiauth"),
                      family_sharing: z.enum(["allow", "deny", "allow_no_entitlement"]).default("allow"),
                      sync_ownership: z.boolean().default(true),
                      allow_token_issue: z.boolean().default(true),
                    }),
                  )
                  .default([]),
              })
              .prefault({}),
            leaderboards: z.object({ enabled: z.boolean().default(true), require_game_authority: z.boolean().default(true) }).prefault({}),
            playtime: toggle(true),
            cloud_saves: toggle(false),
            keys: toggle(true),
            achievements: toggle(true),
            stats: toggle(true),
          })
          .prefault({}),
        support: z
          .object({
            tickets: toggle(true),
            kb: toggle(true),
            guest_tickets: toggle(true),
            attachments: toggle(false),
            kb_images: toggle(false),
          })
          .prefault({}),
        data_export: toggle(true),
      })
      .prefault({}),

    storage,

    captcha: z
      .object({
        provider: z.enum(["altcha", "turnstile", "hcaptcha", "friendly_captcha", "none"]).default("altcha"),
        altcha_hmac_key: z.string().optional(),
        altcha_max_number: z.number().int().positive().default(100_000),
        site_key: z.string().optional(),
        secret_key: z.string().optional(),
        solution_ttl: duration("10m"),
      })
      .prefault({}),

    email: z
      .object({
        provider: z.enum(["smtp", "brevo", "postmark", "ses", "resend", "mailgun", "console"]).default("console"),
        from: z
          .object({
            auth: sender.default({ name: "Example Auth", address: "auth@example.com" }),
            security: sender.default({ name: "Example Security", address: "security@example.com" }),
            support: sender.default({ name: "Example Support", address: "support@example.com" }),
          })
          .prefault({}),
        reply_to: z.email().optional(),
        smtp: z
          .object({
            host: z.string().default("localhost"),
            port: z.number().int().default(587),
            secure: z.boolean().default(false),
            user: z.string().optional(),
            password: z.string().optional(),
          })
          .prefault({}),
        api_key: z.string().optional(),
        mailgun_domain: z.string().optional(),
        mailgun_region: z.enum(["us", "eu"]).default("us"),
        ses_region: z.string().optional(),
        ses_access_key_id: z.string().optional(),
        ses_secret_access_key: z.string().optional(),
        webhook_secret: z.string().optional(),
        max_attempts: z.number().int().positive().default(8),
        attachment_max_bytes: z.number().int().positive().default(8_000_000),
      })
      .prefault({}),

    accounts: z
      .object({
        max_per_email: z.number().int().positive().default(2),
        deletion_grace: duration("30d"),
        email_change_revert_ttl: duration("7d"),
        verification_ttl: duration("24h"),
        signup_continue_ttl: duration("1h"),
        export_link_ttl: duration("7d"),
        min_signup_age: z.number().int().min(0).default(0),
        email_normalization: z
          .record(
            z.string(),
            z.object({
              strip_dots: z.boolean().default(false),
              strip_plus: z.boolean().default(false),
              canonical_domain: z.string().optional(),
            }),
          )
          .default({
            "gmail.com": { strip_dots: true, strip_plus: true },
            "googlemail.com": { strip_dots: true, strip_plus: true, canonical_domain: "gmail.com" },
          }),
      })
      .prefault({}),

    sessions: z.object({ max_per_user: z.number().int().positive().default(10), activity_update_interval: duration("5m") }).prefault({}),

    password: z
      .object({
        min_length: z.number().int().min(1).default(10),
        max_length: z.number().int().min(1).max(256).default(256),
        composition: z
          .object({
            require_lower: z.boolean().default(false),
            require_upper: z.boolean().default(false),
            require_digit: z.boolean().default(false),
            require_symbol: z.boolean().default(false),
          })
          .prefault({}),
        breach_check: z.boolean().default(true),
        breach_api_url: z.url().default("https://api.pwnedpasswords.com/range/"),
        reset_ttl: duration("15m"),
        argon2: z
          .object({
            memory_kib: z.number().int().positive().default(19456),
            iterations: z.number().int().positive().default(2),
            parallelism: z.number().int().positive().default(1),
          })
          .prefault({}),
        failure_delay_after: z.number().int().nonnegative().default(3),
        failure_delay_max: duration("5s"),
      })
      .prefault({}),

    magic_link: z.object({ ttl: duration("15m") }).prefault({}),

    security: z
      .object({
        step_up_window: duration("10m"),
        require_2fa_for_permissions: z.array(z.string()).default(["*"]),
        totp_issuer: z.string().optional(),
        recovery_code_count: z.number().int().positive().default(10),
        security_alert_min_interval: duration("10m"),
        webauthn_rp_id: z.string().optional(),
        webauthn_rp_name: z.string().optional(),
      })
      .prefault({}),

    age: z
      .object({
        boundaries: z
          .object({
            teen: z.number().int().default(13),
            older_teen: z.number().int().default(16),
            adult: z.number().int().default(18),
          })
          .prefault({}),
        assurance: z
          .object({
            default_provider: z.string().default("self_declared"),
            required_for: z.array(z.enum(["claim_adult_band", "signup", "guardian_approval", "dob_change"])).default([]),
            providers: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
          })
          .prefault({}),
      })
      .prefault({}),

    parental: z
      .object({
        consent_age: z.number().int().min(0).max(18).default(13),
        pending_ttl: duration("14d"),
        max_guardians: z.number().int().positive().default(2),
        graduation_grace: duration("30d"),
        max_guardian_email_changes: z.number().int().nonnegative().default(3),
        reminder_interval: duration("3d"),
        access_link_ttl: duration("1h"),
        guardian_session_ttl: duration("1d"),
        default_controls: z
          .object({
            approve_third_party_apps: z.boolean().default(true),
            online_play: z.boolean().default(true),
            in_game_chat: z.boolean().default(false),
            user_generated_content: z.boolean().default(false),
            purchases: z.boolean().default(false),
            daily_playtime_minutes: z.number().int().nonnegative().nullable().default(null),
            leaderboards: z.boolean().default(false),
            public_profile: z.boolean().default(false),
            username_changes_require_approval: z.boolean().default(true),
          })
          .prefault({}),
      })
      .prefault({}),

    session_security: z
      .object({
        on_country_change: z.enum(["challenge", "block", "notify", "ignore"]).default("challenge"),
        new_device_email: z.boolean().default(true),
        tls_fingerprint: z.object({ header: z.string().nullable().default(null) }).prefault({}),
        client_signal_headers: z.array(z.string()).default(["x-qtiauth-tz", "x-qtiauth-screen"]),
        weights: z
          .object({
            ip: z.number().default(10),
            subnet: z.number().default(20),
            country: z.number().default(50),
            user_agent: z.number().default(25),
            tls_fingerprint: z.number().default(5),
            client_signals: z.number().default(3),
          })
          .prefault({}),
        thresholds: z
          .object({
            partial: z.number().default(20),
            challenge: z.number().default(50),
            blocked: z.number().default(100),
          })
          .prefault({}),
      })
      .prefault({}),

    legal: z
      .object({
        public_history: z.boolean().default(true),
        directory: z.string().default("./legal"),
        required_at_signup: z.array(z.string()).default(["terms", "privacy"]),
      })
      .prefault({}),

    usernames: z
      .object({
        min_length: z.number().int().positive().default(8),
        max_length: z.number().int().positive().default(18),
        charset: z.string().default("[A-Za-z0-9_]"),
        change_cooldown: duration("30d"),
        yearly_limit: z.number().int().nonnegative().default(3),
        reserved: z.array(z.string()).default([]),
        reserved_prefixes: z.array(z.string()).default([]),
        release_hold: duration("90d"),
      })
      .prefault({}),

    text_filter: z
      .object({
        lists_directory: z.string().default("./lists/username"),
        raw_input_retention: duration("30d"),
      })
      .prefault({}),

    oidc: z
      .object({
        issuer: z.url().optional(),
        resource: z.string().optional(),
        id_token_alg: z.enum(["RS256", "ES256"]).default("ES256"),
        access_token_ttl: duration("15m"),
        id_token_ttl: duration("1h"),
        refresh_token_ttl: duration("30d"),
        offline_refresh_token_ttl: duration("180d"),
        auth_code_ttl: duration("60s"),
        device_code_ttl: duration("10m"),
        device_poll_interval: duration("5s"),
        par_ttl: duration("60s"),
        client_credentials_ttl: duration("1h"),
        authorization_request_ttl: duration("15m"),
        scopes: withDefaults(DEFAULT_SCOPES, z.record(z.string(), scopeDef)),
        first_party_clients: z.array(firstPartyClient).default([]),
        backchannel_logout_max_attempts: z.number().int().positive().default(10),
      })
      .prefault({}),

    keys: z.object({ rotate_every: duration("90d"), overlap: duration("30d") }).prefault({}),

    roles: withDefaults(DEFAULT_ROLES, z.record(z.string(), z.object({ description: z.string().default(""), permissions: z.array(z.string()) }))),

    notifications: z
      .object({
        staff_alerts: z.array(z.string()).default(["support.new_ticket", "safety.high_priority_report"]),
      })
      .prefault({}),

    safety: z
      .object({
        taxonomy: z.record(z.string(), reportType).prefault(DEFAULT_TAXONOMY as unknown as Record<string, z.input<typeof reportType>>),
        actions: z.record(z.string(), actionType).prefault(DEFAULT_ACTIONS as unknown as Record<string, z.input<typeof actionType>>),
        rules: z.record(z.string(), z.object({ title: z.string(), text: z.string() })).default(DEFAULT_RULES),
        bans: z.object({ require_second_approval: z.boolean().default(false) }).prefault({}),
        accountable_person: z.object({ name: z.string().default("Not configured"), role: z.string().default("Not configured") }).prefault({}),
        csea_alert_emails: z.array(z.email()).default([]),
        csea_evidence_retention: duration("1y"),
        csea_reference_retention: duration("5y"),
        nca_deadlines: z
          .object({ unassessed: duration("1h"), priority_1: duration("1h"), priority_2: duration("24h"), priority_3: duration("72h") })
          .prefault({}),
        evidence_encryption: z.boolean().default(true),
        flag_auto_report_threshold: z.number().min(0).max(1).default(0.8),
      })
      .prefault({}),

    support: z
      .object({
        categories: z.record(z.string(), supportCategory).prefault(DEFAULT_CATEGORIES as unknown as Record<string, z.input<typeof supportCategory>>),
        auto_close_after: duration("7d"),
        guest_code_ttl: duration("15m"),
        guest_access_ttl: duration("30d"),
        attachments: z
          .object({
            max_bytes: z.number().int().positive().default(10_000_000),
            max_per_message: z.number().int().positive().default(5),
            allowed_types: z.array(z.string()).default(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]),
          })
          .prefault({}),
        kb_image_max_bytes: z.number().int().positive().default(5_000_000),
        macros: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })).default([]),
      })
      .prefault({}),

    games: z
      .object({
        lease_duration: duration("20d"),
        cloud_saves: z
          .object({
            default_slots: z.number().int().positive().default(5),
            default_slot_bytes: z.number().int().positive().default(10_000_000),
            versions_kept: z.number().int().positive().default(5),
          })
          .prefault({}),
        keys: z
          .object({
            format: z.string().default("XXXXX-XXXXX-XXXXX"),
            max_batch: z.number().int().positive().default(100_000),
            failures_before_captcha: z.number().int().positive().default(3),
          })
          .prefault({}),
        playtime_heartbeat_max_gap: duration("5m"),
      })
      .prefault({}),

    webhooks: z
      .object({
        disable_after_failures: z.number().int().positive().default(50),
        allow_private_targets: z.boolean().default(false),
        max_retry_window: duration("24h"),
        secret_overlap: duration("24h"),
        timeout: duration("10s"),
        endpoints: z
          .array(
            z.object({
              id: z.string(),
              url: z.url(),
              description: z.string().default(""),
              events: z.array(z.string()),
              format: z.enum(["standard", "discord", "slack"]).default("standard"),
              secret: z.string().optional(),
            }),
          )
          .default([]),
      })
      .prefault({}),

    rate_limits: withDefaults(DEFAULT_RATE_LIMITS, z.record(z.string(), ratePolicy)),

    retention: z
      .object({
        sessions: duration("30d"),
        security_events: duration("93d"),
        tokens_after_expiry: duration("24h"),
        filter_raw_input: duration("30d"),
        delivery_logs: duration("30d"),
        audit_log: duration("2y"),
        closed_tickets: duration("2y"),
        resolved_reports: duration("1y"),
        processed_events: duration("14d"),
        outbox_sent: duration("7d"),
      })
      .prefault({}),

    backups: z
      .object({
        retention: duration("35d"),
        destination: z
          .object({
            type: z.enum(["s3", "volume"]).default("volume"),
            path: z.string().default("/backups"),
            bucket: z.string().optional(),
            prefix: z.string().default("backups/"),
            endpoint: z.string().optional(),
            region: z.string().default("us-east-1"),
            access_key_id: z.string().optional(),
            secret_access_key: z.string().optional(),
            force_path_style: z.boolean().default(true),
          })
          .prefault({}),
        encryption_key: z.string().optional(),
        pg_dump_path: z.string().default("pg_dump"),
        pg_restore_path: z.string().default("pg_restore"),
      })
      .prefault({}),

    deletion_ledger: z.object({ extra_retention: duration("30d") }).prefault({}),

    schedule: withDefaults(DEFAULT_SCHEDULE, z.record(z.string(), z.string())),

    observability: z
      .object({
        log_level: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
        otlp_endpoint: z.string().nullable().default(null),
        otlp_metrics: z.boolean().default(false),
        trace_sample_ratio: z.number().min(0).max(1).default(1),
      })
      .prefault({}),

    secrets: z
      .object({
        app_encryption_key: z.string().optional(),
        key_encryption_key: z.string().optional(),
        backup_encryption_key: z.string().optional(),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const name of ["google", "github", "discord"] as const) {
      const p = cfg.features.auth.social[name];
      if (p.enabled && (!p.client_id || !p.client_secret)) issue(["features", "auth", "social", name], `${name} is enabled but client_id or client_secret is missing`);
    }
    const ids = new Set<string>();
    cfg.features.auth.social.generic_oidc.forEach((p, i) => {
      if (ids.has(p.id)) issue(["features", "auth", "social", "generic_oidc", i, "id"], `Duplicate provider id ${p.id}`);
      ids.add(p.id);
      if (p.enabled && (!p.client_id || !p.client_secret)) issue(["features", "auth", "social", "generic_oidc", i], "client_id and client_secret are required");
    });
    const steam = cfg.features.games.steam;
    if (steam.enabled && !steam.publisher_key) issue(["features", "games", "steam", "publisher_key"], "Steam is enabled but publisher_key is missing");
    const needsStorage: [boolean, string[]][] = [
      [cfg.features.support.attachments.enabled, ["features", "support", "attachments"]],
      [cfg.features.support.kb_images.enabled, ["features", "support", "kb_images"]],
      [cfg.features.games.cloud_saves.enabled, ["features", "games", "cloud_saves"]],
    ];
    for (const [on, path] of needsStorage) {
      if (on && cfg.storage.provider === "none") issue(path, "This feature needs object storage; configure storage.provider");
    }
    if (cfg.storage.provider === "s3" && (!cfg.storage.access_key_id || !cfg.storage.secret_access_key)) issue(["storage"], "S3 storage needs access_key_id and secret_access_key");
    if (cfg.password.min_length > cfg.password.max_length) issue(["password", "min_length"], "min_length must not exceed max_length");
    if (cfg.usernames.min_length > cfg.usernames.max_length) issue(["usernames", "min_length"], "min_length must not exceed max_length");
    try {
      new RegExp(`^${cfg.usernames.charset}+$`);
    } catch {
      issue(["usernames", "charset"], "Not a valid character class");
    }
    const b = cfg.age.boundaries;
    if (!(b.teen < b.older_teen && b.older_teen < b.adult)) issue(["age", "boundaries"], "Boundaries must increase: teen < older_teen < adult");
    for (const [name, s] of Object.entries(cfg.surfaces)) {
      if (!s.hosts.length && !s.ports.length && !s.public_origin) issue(["surfaces", name], "A surface needs at least one host or port");
    }
    if (cfg.captcha.provider !== "none" && cfg.captcha.provider !== "altcha" && (!cfg.captcha.site_key || !cfg.captcha.secret_key)) issue(["captcha"], `${cfg.captcha.provider} needs site_key and secret_key`);
    const providerNeeds: Record<string, (keyof typeof cfg.email)[]> = {
      brevo: ["api_key"],
      postmark: ["api_key"],
      resend: ["api_key"],
      mailgun: ["api_key", "mailgun_domain"],
      ses: ["ses_region", "ses_access_key_id", "ses_secret_access_key"],
    };
    for (const key of providerNeeds[cfg.email.provider] ?? []) {
      if (!cfg.email[key]) issue(["email", key], `email.provider ${cfg.email.provider} needs ${key}`);
    }
    for (const [i, c] of cfg.oidc.first_party_clients.entries()) {
      if (c.type === "confidential" && !c.client_secret) issue(["oidc", "first_party_clients", i, "client_secret"], "Confidential clients need a client_secret");
    }
    for (const [name, role] of Object.entries(cfg.roles)) {
      for (const p of role.permissions) {
        if (p !== "*" && !/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/.test(p)) issue(["roles", name, "permissions"], `Invalid permission "${p}"`);
      }
    }
    for (const [name, rl] of Object.entries(cfg.rate_limits)) {
      if (rl.window <= 0) issue(["rate_limits", name, "window"], "window must be positive");
    }
    for (const app of steam.apps) {
      if (!app.ticket_identity) issue(["features", "games", "steam", "apps"], "ticket_identity is required");
    }
  });

export type Config = z.output<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type SurfaceName = (typeof SURFACE_NAMES)[number];
export type ModuleName = (typeof MODULES)[number];
export type ServiceName = (typeof SERVICES)[number];
export type RatePolicy = z.output<typeof ratePolicy>;
