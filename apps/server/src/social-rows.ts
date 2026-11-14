import { PgClient } from "@effect/sql-pg";
import {
  Activity,
  type AccountId,
  type ActivityView,
  type FollowState,
  type OwnProfile,
  type ProfileSummary,
  type ProfileView,
  privacy,
  type Relation,
  type Username,
  usernameKey,
  viewActivity,
  visibleAudiences,
} from "@svett/core";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { type SqlError, UniqueViolation } from "effect/sql/SqlError";

export class NotFound extends Data.TaggedError("NotFound")<{}> {}
export class UsernameTaken extends Data.TaggedError("UsernameTaken")<{}> {}
export class UsernameRequired extends Data.TaggedError("UsernameRequired")<{}> {}
export class CannotFollowSelf extends Data.TaggedError("CannotFollowSelf")<{}> {}

/** The most profiles a search or a list returns, and the most activities a profile shows. */
export const PAGE = 50;

interface Account {
  readonly id: AccountId;
  readonly username: string;
  readonly private: boolean;
}

export interface SocialRowsShape {
  readonly ownProfile: (account: AccountId) => Effect.Effect<OwnProfile, SqlError>;
  /**
   * Gives `account` the username and the private choice. Making a private profile public
   * approves every request waiting for it, as nobody needs approval any more.
   */
  readonly saveProfile: (
    account: AccountId,
    profile: { readonly username: Username; readonly private: boolean },
  ) => Effect.Effect<OwnProfile, SqlError | UsernameTaken>;
  /** Profiles whose username starts with `prefix`, a lower-case username prefix. */
  readonly search: (
    viewer: AccountId,
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<ProfileSummary>, SqlError>;
  /** A profile and the activities the privacy rule lets `viewer` see. */
  readonly profile: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<ProfileView, SqlError | NotFound>;
  /** Follows at once when the profile is public, and asks for approval when it is private. */
  readonly follow: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<FollowState, SqlError | NotFound | UsernameRequired | CannotFollowSelf>;
  /** Ends a follow or takes back a request. */
  readonly unfollow: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<FollowState, SqlError | NotFound>;
  readonly followers: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<ReadonlyArray<ProfileSummary>, SqlError | NotFound>;
  readonly following: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<ReadonlyArray<ProfileSummary>, SqlError | NotFound>;
  /** The accounts waiting for `owner` to approve their follow, oldest first. */
  readonly requests: (owner: AccountId) => Effect.Effect<ReadonlyArray<ProfileSummary>, SqlError>;
  readonly approve: (
    owner: AccountId,
    username: string,
  ) => Effect.Effect<void, SqlError | NotFound>;
  readonly decline: (
    owner: AccountId,
    username: string,
  ) => Effect.Effect<void, SqlError | NotFound>;
}

const decodeActivity = Schema.decodeUnknownOption(Activity);

// A username prefix may hold an underscore, which LIKE reads as any one character.
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

type SummaryRow = { readonly username: string; readonly private: boolean; readonly follow: string };

const summary = (row: SummaryRow): ProfileSummary => ({
  username: row.username,
  private: row.private,
  follow: row.follow as FollowState,
});

export class SocialRows extends Context.Service<SocialRows, SocialRowsShape>()(
  "svett/server/SocialRows",
) {
  static readonly layer: Layer.Layer<SocialRows, never, PgClient.PgClient> = Layer.effect(
    SocialRows,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      const findAccount = (username: string) =>
        sql<Account>`
          select account_id as id, username, private from profile
          where username_key = ${usernameKey(username)}
        `.pipe(
          Effect.flatMap(([account]) =>
            account === undefined ? Effect.fail(new NotFound()) : Effect.succeed(account),
          ),
        );

      const followState = (follower: AccountId, followee: AccountId) =>
        sql<{ readonly state: FollowState }>`
          select state from follow where follower_id = ${follower} and followee_id = ${followee}
        `.pipe(Effect.map(([row]) => row?.state ?? "none"));

      const relationTo = (viewer: AccountId, owner: AccountId) =>
        Effect.map(followState(viewer, owner), (follow): Relation => ({
          viewer,
          owner,
          follow,
          blocked: false,
        }));

      const counts = (account: AccountId) =>
        sql<{ readonly followers: number; readonly following: number; readonly requests: number }>`
          select
            (select count(*)::int from follow
              where followee_id = ${account} and state = 'following') as followers,
            (select count(*)::int from follow
              where follower_id = ${account} and state = 'following') as following,
            (select count(*)::int from follow
              where followee_id = ${account} and state = 'requested') as requests
        `.pipe(Effect.map(([row]) => row ?? { followers: 0, following: 0, requests: 0 }));

      const ownProfile = (account: AccountId) =>
        Effect.gen(function* () {
          const [profile] = yield* sql<{ readonly username: string; readonly private: boolean }>`
            select username, private from profile where account_id = ${account}
          `;
          return {
            username: profile?.username ?? null,
            private: profile?.private ?? true,
            ...(yield* counts(account)),
          };
        });

      // The viewer's follow state of each listed account comes with it, so a list can show
      // a Follow button. Accounts without a username yet cannot follow, so all have one.
      const listOf = (viewer: AccountId, where: "followers" | "following", owner: AccountId) =>
        sql<SummaryRow>`
          select p.username, p.private, coalesce(mine.state, 'none') as follow
          from follow f
          join profile p on p.account_id = ${where === "followers" ? sql`f.follower_id` : sql`f.followee_id`}
          left join follow mine on mine.follower_id = ${viewer} and mine.followee_id = p.account_id
          where ${where === "followers" ? sql`f.followee_id` : sql`f.follower_id`} = ${owner}
            and f.state = 'following'
          order by p.username_key collate "C"
          limit ${PAGE}
        `.pipe(Effect.map((rows) => rows.map(summary)));

      const activities = (relation: Relation) =>
        Effect.gen(function* () {
          const audiences = visibleAudiences(relation);
          if (audiences.length === 0) return [];
          const rows = yield* sql<{ readonly data: unknown }>`
            select data from account_row
            where account_id = ${relation.owner} and table_name = 'activity'
              and deleted_at is null and data->>'audience' in ${sql.in(audiences)}
            order by (data->>'startedAt')::bigint desc, row_id desc
            limit ${PAGE}
          `;
          const views: Array<ActivityView> = [];
          for (const { data } of rows) {
            const activity = Option.getOrUndefined(decodeActivity(data));
            if (activity === undefined) continue;
            const view = viewActivity(
              activity,
              privacy({
                ...relation,
                audience: activity.audience,
                hiddenFields: activity.hiddenFields,
              }),
            );
            if (view !== undefined) views.push(view);
          }
          return views;
        });

      return SocialRows.of({
        ownProfile,
        saveProfile: (account, profile) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`insert into account (id) values (${account}) on conflict do nothing`;
                yield* sql`
                  insert into profile (account_id, username, username_key, private)
                  values (${account}, ${profile.username}, ${usernameKey(profile.username)},
                    ${profile.private})
                  on conflict (account_id) do update set
                    username = excluded.username,
                    username_key = excluded.username_key,
                    private = excluded.private,
                    updated_at = now()
                `;
                if (!profile.private) {
                  yield* sql`
                    update follow set state = 'following'
                    where followee_id = ${account} and state = 'requested'
                  `;
                }
                return yield* ownProfile(account);
              }),
            )
            .pipe(
              Effect.catchIf(
                (error) => error.reason instanceof UniqueViolation,
                () => Effect.fail(new UsernameTaken()),
              ),
            ),
        search: (viewer, prefix) =>
          sql<SummaryRow>`
            select p.username, p.private, coalesce(f.state, 'none') as follow
            from profile p
            left join follow f on f.follower_id = ${viewer} and f.followee_id = p.account_id
            where p.username_key like ${likePrefix(prefix)}
            order by p.username_key collate "C"
            limit ${PAGE}
          `.pipe(Effect.map((rows) => rows.map(summary))),
        profile: (viewer, username) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username);
            const seen = yield* relationTo(viewer, owner.id);
            return {
              username: owner.username,
              private: owner.private,
              self: viewer === owner.id,
              ...(yield* Effect.map(counts(owner.id), ({ followers, following }) => ({
                followers,
                following,
              }))),
              follow: seen.follow,
              followsYou: (yield* followState(owner.id, viewer)) === "following",
              activities: yield* activities(seen),
            };
          }),
        follow: (viewer, username) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username);
            if (owner.id === viewer) return yield* new CannotFollowSelf();
            const [own] = yield* sql`select 1 from profile where account_id = ${viewer}`;
            if (own === undefined) return yield* new UsernameRequired();
            const state: FollowState = owner.private ? "requested" : "following";
            yield* sql`
              insert into follow (follower_id, followee_id, state)
              values (${viewer}, ${owner.id}, ${state})
              on conflict do nothing
            `;
            return yield* followState(viewer, owner.id);
          }),
        unfollow: (viewer, username) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username);
            yield* sql`delete from follow where follower_id = ${viewer} and followee_id = ${owner.id}`;
            return "none" as const;
          }),
        followers: (viewer, username) =>
          Effect.flatMap(findAccount(username), (owner) => listOf(viewer, "followers", owner.id)),
        following: (viewer, username) =>
          Effect.flatMap(findAccount(username), (owner) => listOf(viewer, "following", owner.id)),
        requests: (owner) =>
          sql<SummaryRow>`
            select p.username, p.private, coalesce(mine.state, 'none') as follow
            from follow f
            join profile p on p.account_id = f.follower_id
            left join follow mine on mine.follower_id = ${owner} and mine.followee_id = p.account_id
            where f.followee_id = ${owner} and f.state = 'requested'
            order by f.created_at, p.username_key collate "C"
            limit ${PAGE}
          `.pipe(Effect.map((rows) => rows.map(summary))),
        approve: (owner, username) =>
          Effect.gen(function* () {
            const follower = yield* findAccount(username);
            const approved = yield* sql`
              update follow set state = 'following'
              where follower_id = ${follower.id} and followee_id = ${owner} and state = 'requested'
              returning 1
            `;
            if (approved.length === 0) return yield* new NotFound();
          }),
        decline: (owner, username) =>
          Effect.gen(function* () {
            const follower = yield* findAccount(username);
            const declined = yield* sql`
              delete from follow
              where follower_id = ${follower.id} and followee_id = ${owner} and state = 'requested'
              returning 1
            `;
            if (declined.length === 0) return yield* new NotFound();
          }),
      });
    }),
  );
}
