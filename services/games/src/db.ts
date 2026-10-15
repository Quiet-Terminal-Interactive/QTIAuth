import { sql, type ColumnType, type Generated, type Selectable } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

type NTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string | T, string | T>;
type GJson<T> = ColumnType<T, string | T | undefined, string | T>;

export type GameStatus = "draft" | "hidden" | "early_access" | "released" | "archived";
export type ProductKind = "base" | "dlc" | "edition" | "beta_access" | "soundtrack" | "other";
export type EntitlementSource = "admin_grant" | "key_redemption" | "steam" | "api";
export type Authority = "player" | "game";
export type StatType = "int" | "float" | "duration";
export type Aggregation = "sum" | "max" | "min" | "latest";

export interface GameSettings {
  lease_duration_ms?: number | null;
  device_binding?: boolean;
  max_devices?: number | null;
  cloud_slots?: number | null;
  cloud_slot_bytes?: number | null;
  require_game_authority?: boolean | null;
  redirect_uris?: string[];
}

export interface GamesDB {
  games: {
    id: string;
    slug: string;
    name: string;
    description: string;
    status: GameStatus;
    icon_url: string | null;
    art: GJson<Record<string, string>>;
    settings: GJson<GameSettings>;
    client_id: string | null;
    server_client_id: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    deleted_at: NTs;
  };
  products: {
    id: string;
    game_id: string;
    sku: string;
    name: string;
    kind: ProductKind;
    description: string;
    retired_at: NTs;
    created_at: Generated<Date>;
  };
  entitlements: {
    id: string;
    user_id: string;
    product_id: string;
    game_id: string;
    source: EntitlementSource;
    source_ref: string | null;
    granted_by: string | null;
    granted_at: Generated<Date>;
    expires_at: NTs;
    revoked_at: NTs;
    revoked_by: string | null;
    revoke_reason: string | null;
  };
  key_batches: {
    id: string;
    game_id: string;
    product_id: string;
    label: string;
    count: number;
    format: string;
    expires_at: NTs;
    created_by: string;
    created_at: Generated<Date>;
    exported_at: NTs;
    revoked_at: NTs;
  };
  keys: {
    id: string;
    batch_id: string;
    code_hash: string;
    code_enc: string;
    redeemed_by: string | null;
    redeemed_at: NTs;
    entitlement_id: string | null;
    revoked_at: NTs;
  };
  achievements: {
    id: string;
    game_id: string;
    key: string;
    name: string;
    description: string;
    icon_url: string | null;
    locked_icon_url: string | null;
    points: number;
    hidden: boolean;
    progress_target: number | null;
    sort_order: number;
    rarity_percent: number | null;
    rarity_computed_at: NTs;
    created_at: Generated<Date>;
    deleted_at: NTs;
  };
  achievement_unlocks: {
    user_id: string;
    achievement_id: string;
    game_id: string;
    progress: number;
    unlocked_at: NTs;
    trust: Authority;
    revoked_at: NTs;
    revoked_by: string | null;
    revoke_reason: string | null;
    updated_at: Generated<Date>;
  };
  stats: {
    id: string;
    game_id: string;
    key: string;
    name: string;
    type: StatType;
    aggregation: Aggregation;
    max_delta: number | null;
    authority: Authority;
    default_value: number;
    created_at: Generated<Date>;
    deleted_at: NTs;
  };
  user_stats: {
    user_id: string;
    stat_id: string;
    game_id: string;
    value: number;
    trust: Authority;
    updated_at: Generated<Date>;
  };
  custom_data: {
    user_id: string;
    game_id: string;
    data: Json<Record<string, unknown>>;
    updated_at: Generated<Date>;
  };
  leaderboards: {
    id: string;
    game_id: string;
    key: string;
    name: string;
    stat_id: string;
    sort: "desc" | "asc";
    reset_period: string;
    current_period: string;
    period_started_at: Generated<Date>;
    created_at: Generated<Date>;
    deleted_at: NTs;
  };
  leaderboard_entries: {
    leaderboard_id: string;
    period: string;
    user_id: string;
    score: number;
    visible: boolean;
    trust: Authority;
    updated_at: Generated<Date>;
    removed_at: NTs;
    removed_by: string | null;
    removed_reason: string | null;
  };
  player_prefs: {
    user_id: string;
    leaderboard_visible: boolean | null;
    age_band: string | null;
    guardian_leaderboards: boolean | null;
    updated_at: Generated<Date>;
  };
  playtime_sessions: {
    id: string;
    user_id: string;
    game_id: string;
    client_id: string | null;
    started_at: Generated<Date>;
    last_heartbeat_at: Generated<Date>;
    ended_at: NTs;
    seconds: Generated<number>;
  };
  playtime_daily: {
    user_id: string;
    game_id: string;
    day: string;
    seconds: number;
  };
  cloud_slots: {
    user_id: string;
    game_id: string;
    slot: string;
    current_version: number;
    size: number;
    sha256: string | null;
    updated_at: Generated<Date>;
  };
  cloud_versions: {
    id: string;
    user_id: string;
    game_id: string;
    slot: string;
    version: number;
    base_version: number;
    storage_key: string;
    size: number;
    sha256: string | null;
    status: "pending" | "committed";
    created_at: Generated<Date>;
  };
  leases: {
    jti: string;
    user_id: string;
    game_id: string;
    device_hash: string | null;
    products: Json<string[]>;
    issued_at: Generated<Date>;
    expires_at: Date;
    revoked_at: NTs;
    revoke_reason: string | null;
  };
  devices: {
    user_id: string;
    game_id: string;
    device_hash: string;
    name: string | null;
    first_seen_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    removed_at: NTs;
  };
  steam_status: {
    steam_id: string;
    user_id: string | null;
    vac_banned: boolean;
    publisher_banned: boolean;
    checked_at: Generated<Date>;
  };
  removal_requests: {
    id: string;
    game_id: string;
    action_id: string;
    user_id: string | null;
    content: GJson<Record<string, unknown>>;
    created_at: Generated<Date>;
    acknowledged_at: NTs;
  };
}

export type Game = Selectable<GamesDB["games"]>;
export type Product = Selectable<GamesDB["products"]>;
export type Entitlement = Selectable<GamesDB["entitlements"]>;
export type Achievement = Selectable<GamesDB["achievements"]>;
export type Stat = Selectable<GamesDB["stats"]>;
export type Leaderboard = Selectable<GamesDB["leaderboards"]>;

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db) {
      await createOutboxTables(db);
      await sql`
        create table games (
          id uuid primary key,
          slug text not null unique,
          name text not null,
          description text not null default '',
          status text not null check (status in ('draft','hidden','early_access','released','archived')),
          icon_url text,
          art jsonb not null default '{}',
          settings jsonb not null default '{}',
          client_id text,
          server_client_id text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          deleted_at timestamptz
        )`.execute(db);
      await sql`
        create table products (
          id uuid primary key,
          game_id uuid not null references games(id),
          sku text not null unique,
          name text not null,
          kind text not null check (kind in ('base','dlc','edition','beta_access','soundtrack','other')),
          description text not null default '',
          retired_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create unique index products_one_base on products (game_id) where kind = 'base'`.execute(db);
      await sql`
        create table entitlements (
          id uuid primary key,
          user_id uuid not null,
          product_id uuid not null references products(id),
          game_id uuid not null,
          source text not null check (source in ('admin_grant','key_redemption','steam','api')),
          source_ref text,
          granted_by text,
          granted_at timestamptz not null default now(),
          expires_at timestamptz,
          revoked_at timestamptz,
          revoked_by text,
          revoke_reason text
        )`.execute(db);
      await sql`create unique index entitlements_active on entitlements (user_id, product_id, source) where revoked_at is null`.execute(db);
      await sql`create index entitlements_user on entitlements (user_id, game_id)`.execute(db);
      await sql`
        create table key_batches (
          id uuid primary key,
          game_id uuid not null,
          product_id uuid not null references products(id),
          label text not null,
          count int not null,
          format text not null,
          expires_at timestamptz,
          created_by uuid not null,
          created_at timestamptz not null default now(),
          exported_at timestamptz,
          revoked_at timestamptz
        )`.execute(db);
      await sql`
        create table keys (
          id uuid primary key,
          batch_id uuid not null references key_batches(id) on delete cascade,
          code_hash text not null unique,
          code_enc text not null,
          redeemed_by uuid,
          redeemed_at timestamptz,
          entitlement_id uuid,
          revoked_at timestamptz
        )`.execute(db);
      await sql`create index keys_batch on keys (batch_id)`.execute(db);
      await sql`
        create table achievements (
          id uuid primary key,
          game_id uuid not null references games(id),
          key text not null,
          name text not null,
          description text not null default '',
          icon_url text,
          locked_icon_url text,
          points int not null default 0,
          hidden boolean not null default false,
          progress_target int,
          sort_order int not null default 0,
          rarity_percent double precision,
          rarity_computed_at timestamptz,
          created_at timestamptz not null default now(),
          deleted_at timestamptz
        )`.execute(db);
      await sql`create unique index achievements_key on achievements (game_id, key) where deleted_at is null`.execute(db);
      await sql`
        create table achievement_unlocks (
          user_id uuid not null,
          achievement_id uuid not null references achievements(id) on delete cascade,
          game_id uuid not null,
          progress int not null default 0,
          unlocked_at timestamptz,
          trust text not null,
          revoked_at timestamptz,
          revoked_by uuid,
          revoke_reason text,
          updated_at timestamptz not null default now(),
          primary key (user_id, achievement_id)
        )`.execute(db);
      await sql`create index achievement_unlocks_game on achievement_unlocks (game_id, achievement_id) where unlocked_at is not null and revoked_at is null`.execute(db);
      await sql`
        create table stats (
          id uuid primary key,
          game_id uuid not null references games(id),
          key text not null,
          name text not null,
          type text not null check (type in ('int','float','duration')),
          aggregation text not null check (aggregation in ('sum','max','min','latest')),
          max_delta double precision,
          authority text not null check (authority in ('player','game')),
          default_value double precision not null default 0,
          created_at timestamptz not null default now(),
          deleted_at timestamptz
        )`.execute(db);
      await sql`create unique index stats_key on stats (game_id, key) where deleted_at is null`.execute(db);
      await sql`
        create table user_stats (
          user_id uuid not null,
          stat_id uuid not null references stats(id) on delete cascade,
          game_id uuid not null,
          value double precision not null,
          trust text not null,
          updated_at timestamptz not null default now(),
          primary key (user_id, stat_id)
        )`.execute(db);
      await sql`
        create table custom_data (
          user_id uuid not null,
          game_id uuid not null,
          data jsonb not null,
          updated_at timestamptz not null default now(),
          primary key (user_id, game_id)
        )`.execute(db);
      await sql`
        create table leaderboards (
          id uuid primary key,
          game_id uuid not null references games(id),
          key text not null,
          name text not null,
          stat_id uuid not null references stats(id),
          sort text not null check (sort in ('desc','asc')),
          reset_period text not null,
          current_period text not null,
          period_started_at timestamptz not null default now(),
          created_at timestamptz not null default now(),
          deleted_at timestamptz
        )`.execute(db);
      await sql`create unique index leaderboards_key on leaderboards (game_id, key) where deleted_at is null`.execute(db);
      await sql`
        create table leaderboard_entries (
          leaderboard_id uuid not null references leaderboards(id) on delete cascade,
          period text not null,
          user_id uuid not null,
          score double precision not null,
          visible boolean not null,
          trust text not null,
          updated_at timestamptz not null default now(),
          removed_at timestamptz,
          removed_by uuid,
          removed_reason text,
          primary key (leaderboard_id, period, user_id)
        )`.execute(db);
      await sql`create index leaderboard_entries_rank on leaderboard_entries (leaderboard_id, period, score) where removed_at is null`.execute(db);
      await sql`create index leaderboard_entries_user on leaderboard_entries (user_id)`.execute(db);
      await sql`
        create table player_prefs (
          user_id uuid primary key,
          leaderboard_visible boolean,
          age_band text,
          guardian_leaderboards boolean,
          updated_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table playtime_sessions (
          id uuid primary key,
          user_id uuid not null,
          game_id uuid not null,
          client_id text,
          started_at timestamptz not null default now(),
          last_heartbeat_at timestamptz not null default now(),
          ended_at timestamptz,
          seconds int not null default 0
        )`.execute(db);
      await sql`create index playtime_sessions_open on playtime_sessions (last_heartbeat_at) where ended_at is null`.execute(db);
      await sql`create index playtime_sessions_user on playtime_sessions (user_id, game_id)`.execute(db);
      await sql`
        create table playtime_daily (
          user_id uuid not null,
          game_id uuid not null,
          day date not null,
          seconds int not null,
          primary key (user_id, game_id, day)
        )`.execute(db);
      await sql`
        create table cloud_slots (
          user_id uuid not null,
          game_id uuid not null,
          slot text not null,
          current_version int not null,
          size bigint not null,
          sha256 text,
          updated_at timestamptz not null default now(),
          primary key (user_id, game_id, slot)
        )`.execute(db);
      await sql`
        create table cloud_versions (
          id uuid primary key,
          user_id uuid not null,
          game_id uuid not null,
          slot text not null,
          version int not null,
          base_version int not null,
          storage_key text not null,
          size bigint not null,
          sha256 text,
          status text not null check (status in ('pending','committed')),
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create unique index cloud_versions_committed on cloud_versions (user_id, game_id, slot, version) where status = 'committed'`.execute(db);
      await sql`
        create table leases (
          jti text primary key,
          user_id uuid not null,
          game_id uuid not null,
          device_hash text,
          products jsonb not null,
          issued_at timestamptz not null default now(),
          expires_at timestamptz not null,
          revoked_at timestamptz,
          revoke_reason text
        )`.execute(db);
      await sql`create index leases_user on leases (user_id, game_id)`.execute(db);
      await sql`create index leases_revoked on leases (revoked_at) where revoked_at is not null`.execute(db);
      await sql`
        create table devices (
          user_id uuid not null,
          game_id uuid not null,
          device_hash text not null,
          name text,
          first_seen_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now(),
          removed_at timestamptz,
          primary key (user_id, game_id, device_hash)
        )`.execute(db);
      await sql`
        create table steam_status (
          steam_id text primary key,
          user_id uuid,
          vac_banned boolean not null,
          publisher_banned boolean not null,
          checked_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table removal_requests (
          id uuid primary key,
          game_id uuid not null,
          action_id uuid not null unique,
          user_id uuid,
          content jsonb not null default '{}',
          created_at timestamptz not null default now(),
          acknowledged_at timestamptz
        )`.execute(db);
    },
  },
];
