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
  // Usernames are unique whatever their case, so the lower-case form carries the index that
  // keeps them apart and serves searches by prefix. A follow is requested until the account
  // followed approves it, or following at once when that profile is public. Each follow has
  // its own ID, so an answer to a request reaches that request alone, even after its
  // username passes to another account.
  "3_social": Effect.gen(function* () {
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
  // Another account names an activity by a random ID minted here the first time anyone is
  // shown it. An activity's own ID can come from its start time, as an imported workout's
  // does, so it never leaves the server for anyone but its owner.
  "4_activity_social": Effect.gen(function* () {
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
  // up to which it has read it. The indexes serve a post's sets and route.
  "5_feed": Effect.gen(function* () {
    const sql = yield* SqlClient;
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
    yield* sql`
      create index account_row_activity_child
      on account_row (account_id, table_name, (data->>'activityId'))
    `;
    yield* sql`
      create index account_row_exercise_child
      on account_row (account_id, table_name, (data->>'activityExerciseId'))
    `;
    yield* sql`
      create index account_row_track_child
      on account_row (account_id, table_name, (data->>'activityTrackId'))
    `;
  }),
};
