import { sql, type ColumnType, type Generated, type Selectable } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

type NTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string | T, string | T>;

export type TicketStatus = "open" | "waiting_on_user" | "on_hold" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type AuthorType = "user" | "guest" | "staff" | "system";

export interface SupportDB {
  tickets: {
    id: string;
    number: Generated<number>;
    user_id: string | null;
    guest_email: string | null;
    guest_token_hash: string | null;
    guest_token_expires_at: NTs;
    category: string;
    subject: string;
    status: TicketStatus;
    priority: TicketPriority;
    assignee_id: string | null;
    appeal_id: string | null;
    action_id: string | null;
    locale: string | null;
    rating: number | null;
    rating_comment: string | null;
    first_response_at: NTs;
    last_user_activity_at: Generated<Date>;
    last_staff_reply_at: NTs;
    reminder_sent_at: NTs;
    closed_at: NTs;
    closed_by: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  messages: {
    id: string;
    ticket_id: string;
    author_type: AuthorType;
    author_id: string | null;
    body: string;
    internal: Generated<boolean>;
    created_at: Generated<Date>;
  };
  attachments: {
    id: string;
    ticket_id: string;
    message_id: string | null;
    storage_key: string;
    filename: string;
    declared_type: string;
    sniffed_type: string | null;
    size: number;
    status: "pending" | "ready" | "rejected";
    uploaded_by_type: AuthorType;
    uploaded_by: string | null;
    created_at: Generated<Date>;
  };
  macros: {
    id: string;
    title: string;
    body: string;
    created_by: string;
    updated_at: Generated<Date>;
  };
  kb_categories: {
    id: string;
    slug: string;
    name: string;
    description: string;
    icon: string | null;
    sort_order: number;
    created_at: Generated<Date>;
  };
  kb_articles: {
    id: string;
    slug: string;
    category_id: string | null;
    title: string;
    body: string;
    tags: Json<string[]>;
    status: "draft" | "published";
    published_at: NTs;
    author_id: string;
    updated_by: string;
    helpful_yes: Generated<number>;
    helpful_no: Generated<number>;
    views: Generated<number>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    deleted_at: NTs;
  };
  kb_revisions: {
    id: string;
    article_id: string;
    title: string;
    body: string;
    tags: Json<string[]>;
    author_id: string;
    note: string | null;
    created_at: Generated<Date>;
  };
  kb_feedback: {
    article_id: string;
    voter_key: string;
    helpful: boolean;
    created_at: Generated<Date>;
  };
  kb_images: {
    id: string;
    storage_key: string;
    content_type: string;
    size: number;
    uploaded_by: string;
    created_at: Generated<Date>;
  };
}

export type Ticket = Selectable<SupportDB["tickets"]>;
export type Message = Selectable<SupportDB["messages"]>;
export type Article = Selectable<SupportDB["kb_articles"]>;
export type Attachment = Selectable<SupportDB["attachments"]>;

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db) {
      await createOutboxTables(db);
      await sql`create sequence ticket_number_seq start 1000`.execute(db);
      await sql`
        create table tickets (
          id uuid primary key,
          number bigint not null unique default nextval('ticket_number_seq'),
          user_id uuid,
          guest_email text,
          guest_token_hash text,
          guest_token_expires_at timestamptz,
          category text not null,
          subject text not null,
          status text not null check (status in ('open','waiting_on_user','on_hold','closed')),
          priority text not null check (priority in ('low','normal','high','urgent')),
          assignee_id uuid,
          appeal_id uuid,
          action_id uuid,
          locale text,
          rating smallint check (rating between 1 and 5),
          rating_comment text,
          first_response_at timestamptz,
          last_user_activity_at timestamptz not null default now(),
          last_staff_reply_at timestamptz,
          reminder_sent_at timestamptz,
          closed_at timestamptz,
          closed_by text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          search tsvector generated always as (to_tsvector('simple', coalesce(subject, ''))) stored
        )`.execute(db);
      await sql`alter sequence ticket_number_seq owned by tickets.number`.execute(db);
      await sql`create index tickets_user on tickets (user_id, created_at desc)`.execute(db);
      await sql`create index tickets_queue on tickets (status, priority, updated_at)`.execute(db);
      await sql`create index tickets_assignee on tickets (assignee_id) where status <> 'closed'`.execute(db);
      await sql`create index tickets_closed on tickets (closed_at) where closed_at is not null`.execute(db);
      await sql`create index tickets_search on tickets using gin (search)`.execute(db);
      await sql`create unique index tickets_one_open_appeal on tickets (action_id) where action_id is not null and status <> 'closed'`.execute(db);
      await sql`
        create table messages (
          id uuid primary key,
          ticket_id uuid not null references tickets(id) on delete cascade,
          author_type text not null check (author_type in ('user','guest','staff','system')),
          author_id uuid,
          body text not null,
          internal boolean not null default false,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index messages_ticket on messages (ticket_id, created_at)`.execute(db);
      await sql`
        create table attachments (
          id uuid primary key,
          ticket_id uuid not null references tickets(id) on delete cascade,
          message_id uuid references messages(id) on delete set null,
          storage_key text not null,
          filename text not null,
          declared_type text not null,
          sniffed_type text,
          size bigint not null,
          status text not null check (status in ('pending','ready','rejected')),
          uploaded_by_type text not null,
          uploaded_by uuid,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index attachments_ticket on attachments (ticket_id)`.execute(db);
      await sql`
        create table macros (
          id uuid primary key,
          title text not null,
          body text not null,
          created_by uuid not null,
          updated_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table kb_categories (
          id uuid primary key,
          slug text not null unique,
          name text not null,
          description text not null default '',
          icon text,
          sort_order int not null default 0,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table kb_articles (
          id uuid primary key,
          slug text not null unique,
          category_id uuid references kb_categories(id) on delete set null,
          title text not null,
          body text not null,
          tags jsonb not null default '[]',
          status text not null check (status in ('draft','published')),
          published_at timestamptz,
          author_id uuid not null,
          updated_by uuid not null,
          helpful_yes int not null default 0,
          helpful_no int not null default 0,
          views bigint not null default 0,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          deleted_at timestamptz,
          search tsvector generated always as (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(jsonb_path_query_array(tags, '$[*]')::text, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(body, '')), 'C')
          ) stored
        )`.execute(db);
      await sql`create index kb_articles_search on kb_articles using gin (search)`.execute(db);
      await sql`create index kb_articles_category on kb_articles (category_id, status)`.execute(db);
      await sql`
        create table kb_revisions (
          id uuid primary key,
          article_id uuid not null references kb_articles(id) on delete cascade,
          title text not null,
          body text not null,
          tags jsonb not null default '[]',
          author_id uuid not null,
          note text,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index kb_revisions_article on kb_revisions (article_id, created_at desc)`.execute(db);
      await sql`
        create table kb_feedback (
          article_id uuid not null references kb_articles(id) on delete cascade,
          voter_key text not null,
          helpful boolean not null,
          created_at timestamptz not null default now(),
          primary key (article_id, voter_key)
        )`.execute(db);
      await sql`
        create table kb_images (
          id uuid primary key,
          storage_key text not null,
          content_type text not null,
          size bigint not null,
          uploaded_by uuid not null,
          created_at timestamptz not null default now()
        )`.execute(db);
    },
  },
];
