import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * The server's schema changes, keyed `<id>_<name>`. Append new ones with the next id.
 * Never edit one that has shipped.
 */
export const MIGRATIONS: Record<string, Effect.Effect<void, unknown, SqlClient>> = {
  // Rows are keyed by account and ID together, so two accounts that hold the same ID,
  // such as the same imported Hevy workout, each keep their own row.
  "1_accounts": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table account (
        id text primary key,
        created_at timestamptz not null default now()
      )
    `;
    yield* sql`
      create table account_row (
        account_id text not null,
        table_name text not null,
        row_id text not null,
        updated_at bigint not null,
        deleted_at bigint,
        data jsonb not null,
        primary key (account_id, table_name, row_id)
      )
    `;
  }),
  // Each applied change gets the account's next number, so a phone pulls from where it left
  // off. A row's change ID breaks a tie between two changes with the same time.
  "2_sync": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`alter table account add column next_seq bigint not null default 0`;
    yield* sql`alter table account_row add column seq bigint`;
    yield* sql`alter table account_row add column change_id text not null default ''`;
    yield* sql`
      update account_row set seq = numbered.seq
      from (
        select account_id, table_name, row_id,
          row_number() over (partition by account_id order by updated_at, table_name, row_id) as seq
        from account_row
      ) as numbered
      where account_row.account_id = numbered.account_id
        and account_row.table_name = numbered.table_name
        and account_row.row_id = numbered.row_id
    `;
    yield* sql`
      update account set next_seq = coalesce(
        (select max(seq) from account_row where account_id = account.id), 0)
    `;
    yield* sql`alter table account_row alter column seq set not null`;
    yield* sql`create unique index account_row_seq on account_row (account_id, seq)`;
  }),
  // The Undos the server took of each row, so a delete that arrives after a change to the row
  // decides as it would have had it arrived first. A delete of a workout row finds the rows
  // under it by their parent's key.
  "3_sync_restored": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`alter table account_row add column restored jsonb not null default '[]'`;
    for (const parent of ["activityId", "activityExerciseId", "activityTrackId"]) {
      yield* sql.unsafe(
        `create index account_row_${parent} on account_row
          (account_id, table_name, (data ->> '${parent}'))`,
      );
    }
  }),
  // Usernames are unique whatever their case, so the lower-case form carries the index that
  // keeps them apart and serves searches by prefix. A follow is requested until the account
  // followed approves it, or following at once when that profile is public. Each follow has
  // its own ID, so an answer to a request reaches that request alone, even after its
  // username passes to another account.
  "4_social": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table profile (
        account_id text primary key,
        username text not null,
        username_key text not null,
        private boolean not null,
        updated_at timestamptz not null default now()
      )
    `;
    yield* sql`create unique index profile_username_key on profile (username_key text_pattern_ops)`;
    yield* sql`
      create table follow (
        id text not null default gen_random_uuid()::text,
        follower_id text not null,
        followee_id text not null,
        state text not null,
        created_at timestamptz not null default now(),
        primary key (follower_id, followee_id)
      )
    `;
    yield* sql`create unique index follow_id on follow (id)`;
    yield* sql`create index follow_followee on follow (followee_id, state)`;
  }),
  // Another account names an activity by a random ID, minted when the activity first reaches
  // the server. An activity's own ID can come from its start time, as an imported workout's
  // does, so it never leaves the server for anyone but its owner.
  "5_activity_social": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table activity_social (
        account_id text not null,
        activity_id text not null,
        social_id text not null default gen_random_uuid()::text,
        primary key (account_id, activity_id)
      )
    `;
    yield* sql`create unique index activity_social_id on activity_social (social_id)`;
  }),
  // Likes and comments key an activity by its owner and its own ID, which others never see.
  // The inbox is read from likes, comments and follows, and each account keeps only the time
  // up to which it has read it. The feed orders posts by when each was first shared with
  // anyone, set once and never from a start time, which may be hidden. An activity for only
  // its owner has no such time until its audience changes. Shared activities already here share
  // the migration's time, so the random social ID orders them. Others see a profile's
  // activities in the same order. 3_sync_restored's indexes serve a post's sets and route.
  "6_feed": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`alter table activity_social add column shared_ms bigint`;
    yield* sql`
      insert into activity_social (account_id, activity_id, shared_ms)
      select account_id, row_id,
        case when data->>'audience' <> 'only_you'
          then (extract(epoch from now()) * 1000)::bigint end
      from account_row
      where table_name = 'activity' and deleted_at is null
        and coalesce(data->>'status', '') <> 'in_progress'
      on conflict (account_id, activity_id) do update set shared_ms = excluded.shared_ms
    `;
    yield* sql`create index activity_social_shared on activity_social (shared_ms, social_id)`;
    yield* sql`
      create index activity_social_owner_shared on activity_social (account_id, shared_ms, social_id)
    `;
    yield* sql`
      create table activity_like (
        owner_id text not null,
        activity_id text not null,
        liker_id text not null,
        created_ms bigint not null,
        primary key (owner_id, activity_id, liker_id)
      )
    `;
    yield* sql`create index activity_like_owner on activity_like (owner_id, created_ms)`;
    yield* sql`
      create table activity_comment (
        id text primary key,
        owner_id text not null,
        activity_id text not null,
        author_id text not null,
        body text not null,
        created_ms bigint not null
      )
    `;
    yield* sql`
      create index activity_comment_post on activity_comment (owner_id, activity_id, created_ms)
    `;
    yield* sql`create index activity_comment_author on activity_comment (author_id)`;
    yield* sql`
      create table inbox_read (
        account_id text primary key,
        read_until bigint not null
      )
    `;
  }),
  // A block works both ways, so each pair is read in both directions. A rate limit is a token
  // bucket per account and route group, kept here so it survives a restart and holds across
  // servers. A deleted account's ID stays, so no later request or upload recreates it, with
  // whether its rows are gone yet and whether Clerk ended its sessions, so a start finishes a
  // deletion that failed part way. A deletion's receipt is kept as a hash alone, so a phone
  // whose session ended with the deletion can still ask whether it happened, and nobody else can.
  "7_safety": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table block (
        id text not null default gen_random_uuid()::text,
        blocker_id text not null,
        blocked_id text not null,
        created_at timestamptz not null default now(),
        primary key (blocker_id, blocked_id)
      )
    `;
    yield* sql`create unique index block_id on block (id)`;
    yield* sql`create index block_blocked on block (blocked_id)`;
    yield* sql`
      create table rate_limit (
        account_id text not null,
        route_group text not null,
        tokens double precision not null,
        at_ms bigint not null,
        primary key (account_id, route_group)
      )
    `;
    yield* sql`
      create table deleted_account (
        id text primary key,
        deleted_at timestamptz not null default now(),
        rows_deleted boolean not null default false,
        sessions_ended boolean not null default false
      )
    `;
    yield* sql`
      create table deletion_receipt (
        receipt_hash text primary key,
        deleted_at timestamptz not null default now()
      )
    `;
    yield* sql`create index activity_like_liker on activity_like (liker_id)`;
    // The ID of the deletion ledger in BACKUP_DIR, recorded when the ledger is made, so a start
    // or a restore can tell a lost or wrongly mounted ledger from a server that never had one.
    yield* sql`create table deletion_ledger (id text primary key)`;
  }),
  // Apps the person connects, such as ChatGPT, sign in with the server's own OAuth. A client
  // names no account. A client that never connected an account is removed after a day. A code, a
  // connection and its tokens do name one, and only hashes of the codes and
  // tokens are kept. A connection holds one access token and one refresh token at a time, so
  // deleting the row cuts the app off at once. The access log records each tool call, and the
  // proposals an app made wait here until the phone takes them.
  "8_assistant": Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      create table oauth_client (
        id text primary key,
        name text not null,
        redirect_uris jsonb not null,
        created_ms bigint not null,
        connected_ms bigint
      )
    `;
    yield* sql`
      create table oauth_code (
        code_hash text primary key,
        client_id text not null,
        account_id text not null,
        redirect_uri text not null,
        code_challenge text not null,
        scopes text not null,
        expires_ms bigint not null
      )
    `;
    yield* sql`create index oauth_code_account on oauth_code (account_id)`;
    yield* sql`
      create table assistant_connection (
        id text primary key,
        account_id text not null,
        client_id text not null,
        name text not null,
        host text not null,
        scopes text not null,
        created_ms bigint not null,
        last_read_ms bigint,
        access_hash text not null unique,
        access_expires_ms bigint not null,
        refresh_hash text not null unique,
        refresh_expires_ms bigint not null
      )
    `;
    yield* sql`create index assistant_connection_account on assistant_connection (account_id)`;
    yield* sql`
      create table assistant_access (
        id text primary key,
        account_id text not null,
        connection_id text not null,
        tool text not null,
        at_ms bigint not null
      )
    `;
    yield* sql`create index assistant_access_account on assistant_access (account_id, at_ms)`;
    yield* sql`
      create table assistant_proposal (
        id text primary key,
        account_id text not null,
        connection_id text not null,
        source_name text not null,
        plan jsonb not null,
        created_ms bigint not null
      )
    `;
    yield* sql`create index assistant_proposal_account on assistant_proposal (account_id, created_ms)`;
  }),
};
