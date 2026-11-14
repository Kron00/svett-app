import { PgClient } from "@effect/sql-pg";
import {
  AccountId,
  Activity,
  type ActivityPage,
  type Block,
  type ActivityView,
  type FollowRequest,
  type FollowState,
  isPublished,
  type OwnProfile,
  type ProfilePage,
  type ProfileSummary,
  type ProfileView,
  privacy,
  type Relation,
  SocialActivityId,
  type Username,
  usernameKey,
  viewActivity,
  visibleAudiences,
} from "@svett/core";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { type SqlError, UniqueViolation } from "effect/sql/SqlError";

import {
  firstVisible,
  InvalidCursor,
  postCursor,
  readPostCursor,
  SCAN,
  type SharedAnchor,
} from "./paging.ts";

export class NotFound extends Data.TaggedError("NotFound")<{}> {}
export class UsernameTaken extends Data.TaggedError("UsernameTaken")<{}> {}
export class UsernameRequired extends Data.TaggedError("UsernameRequired")<{}> {}
export class CannotFollowSelf extends Data.TaggedError("CannotFollowSelf")<{}> {}
export class RequestNotFound extends Data.TaggedError("RequestNotFound")<{}> {}
export class CannotBlockSelf extends Data.TaggedError("CannotBlockSelf")<{}> {}
export class BlockNotFound extends Data.TaggedError("BlockNotFound")<{}> {}

/** The most profiles a search or a page of a list returns, and the most activities a profile shows. */
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
   * approves every request waiting for it, as nobody needs approval any more. It holds the
   * profile's row lock, as `follow` does, so no request made meanwhile is left waiting.
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
  /**
   * A profile and the first page of the activities the privacy rule lets `viewer` see, newest
   * first by when each was shared, never by when it started, as a start may be hidden.
   */
  readonly profile: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<ProfileView, SqlError | NotFound>;
  /**
   * The profile's activities after `cursor`, ordered as `profile` orders them, or its first page
   * without one. The cursor names an activity by its social ID alone, and one the viewer may no
   * longer see is refused.
   */
  readonly activities: (
    viewer: AccountId,
    username: string,
    cursor: string | undefined,
  ) => Effect.Effect<ActivityPage, SqlError | NotFound | InvalidCursor>;
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
  /**
   * One page of the profile's followers, by username. `after` is the `next` of the page
   * before, and the last page's `next` is null.
   */
  readonly followers: (
    viewer: AccountId,
    username: string,
    after?: string,
  ) => Effect.Effect<ProfilePage, SqlError | NotFound>;
  /** One page of the accounts the profile follows, paged like `followers`. */
  readonly following: (
    viewer: AccountId,
    username: string,
    after?: string,
  ) => Effect.Effect<ProfilePage, SqlError | NotFound>;
  /**
   * The activity with this social ID, as the privacy rule lets `viewer` see it. One the
   * viewer may not see answers NotFound, as one that does not exist does.
   */
  readonly activity: (
    viewer: AccountId,
    socialId: SocialActivityId,
  ) => Effect.Effect<ActivityView, SqlError | NotFound>;
  /** The requests waiting for `owner` to approve them, oldest first. */
  readonly requests: (owner: AccountId) => Effect.Effect<ReadonlyArray<FollowRequest>, SqlError>;
  /**
   * Approves the request with this ID when it is still waiting for `owner`. A username is
   * never looked up here, so a stale answer cannot reach whoever holds that username now.
   */
  readonly approve: (
    owner: AccountId,
    request: string,
  ) => Effect.Effect<void, SqlError | RequestNotFound>;
  readonly decline: (
    owner: AccountId,
    request: string,
  ) => Effect.Effect<void, SqlError | RequestNotFound>;
  /**
   * Blocks the account with this username. Any follow or request between the two, either way,
   * ends. From then on neither finds, sees or follows the other, and neither sees the other's
   * likes or comments. Blocking again changes nothing.
   */
  readonly block: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<void, SqlError | NotFound | CannotBlockSelf>;
  /** The accounts `viewer` blocked, newest first. */
  readonly blocks: (viewer: AccountId) => Effect.Effect<ReadonlyArray<Block>, SqlError>;
  /** Ends the block with this ID, when `viewer` made it. A follow it ended stays ended. */
  readonly unblock: (
    viewer: AccountId,
    block: string,
  ) => Effect.Effect<void, SqlError | BlockNotFound>;
  /** Ends the follow of `viewer` by the account with this username, without blocking it. */
  readonly removeFollower: (
    viewer: AccountId,
    username: string,
  ) => Effect.Effect<void, SqlError | NotFound>;
}

const decodeActivity = Schema.decodeUnknownOption(Activity);
const decodeAccountId = Schema.decodeUnknownOption(AccountId);

// A username prefix may hold an underscore, which LIKE reads as any one character.
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

type SummaryRow = { readonly username: string; readonly private: boolean; readonly follow: string };

type OwnedRelation = Relation & { readonly owner: AccountId };

const visibilityOf = (relation: Relation, activity: Activity) =>
  privacy({ ...relation, audience: activity.audience, hiddenFields: activity.hiddenFields });

const summary = (row: SummaryRow): ProfileSummary => ({
  username: row.username,
  private: row.private,
  follow: row.follow as FollowState,
});

/**
 * True when `viewer` and the account in `column` block each other, either way round. The
 * caller names a column it trusts, never one a request supplies.
 */
export const blockedWith = (sql: PgClient.PgClient, viewer: string, column: string) =>
  sql`exists (
    select 1 from block b
    where (b.blocker_id = ${viewer} and b.blocked_id = ${sql.literal(column)})
      or (b.blocked_id = ${viewer} and b.blocker_id = ${sql.literal(column)})
  )`;

export class SocialRows extends Context.Service<SocialRows, SocialRowsShape>()(
  "svett/server/SocialRows",
) {
  static readonly layer: Layer.Layer<SocialRows, never, PgClient.PgClient> = Layer.effect(
    SocialRows,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      // `lock` holds the profile's row until the transaction ends, so its private choice
      // cannot change between reading it and acting on it. With a `viewer`, an account in a
      // block with them is not found, as one that does not exist is not.
      const findAccount = (
        username: string,
        options: { readonly lock?: boolean; readonly viewer?: AccountId } = {},
      ) =>
        sql<Account>`
          select account_id as id, username, private from profile
          where username_key = ${usernameKey(username)}
          ${options.viewer === undefined ? sql`` : sql`and not ${blockedWith(sql, options.viewer, "profile.account_id")}`}
          ${options.lock === true ? sql`for update` : sql``}
        `.pipe(
          Effect.flatMap(([account]) =>
            account === undefined ? Effect.fail(new NotFound()) : Effect.succeed(account),
          ),
        );

      const followState = (follower: AccountId, followee: AccountId) =>
        sql<{ readonly state: FollowState }>`
          select state from follow where follower_id = ${follower} and followee_id = ${followee}
        `.pipe(Effect.map(([row]) => row?.state ?? "none"));

      const isBlocked = (viewer: AccountId, other: AccountId) =>
        sql<{ readonly blocked: boolean }>`
          select exists (
            select 1 from block
            where (blocker_id = ${viewer} and blocked_id = ${other})
              or (blocker_id = ${other} and blocked_id = ${viewer})
          ) as blocked
        `.pipe(Effect.map(([row]) => row?.blocked === true));

      const relationTo = (viewer: AccountId, owner: AccountId) =>
        Effect.map(
          Effect.all([followState(viewer, owner), isBlocked(viewer, owner)]),
          ([follow, blocked]): OwnedRelation => ({ viewer, owner, follow, blocked }),
        );

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
      // A page ends at a username key, and the next starts after it.
      const listOf = (
        viewer: AccountId,
        where: "followers" | "following",
        owner: AccountId,
        after: string | undefined,
      ) =>
        sql<SummaryRow & { readonly key: string }>`
          select p.username, p.private, coalesce(mine.state, 'none') as follow,
            p.username_key as key
          from follow f
          join profile p on p.account_id = ${where === "followers" ? sql`f.follower_id` : sql`f.followee_id`}
          left join follow mine on mine.follower_id = ${viewer} and mine.followee_id = p.account_id
          where ${where === "followers" ? sql`f.followee_id` : sql`f.follower_id`} = ${owner}
            and f.state = 'following'
            and not ${blockedWith(sql, viewer, "p.account_id")}
            ${after === undefined ? sql`` : sql`and p.username_key collate "C" > ${after}`}
          order by p.username_key collate "C"
          limit ${PAGE + 1}
        `.pipe(
          Effect.map((rows): ProfilePage => {
            const page = rows.slice(0, PAGE);
            return {
              profiles: page.map(summary),
              next: rows.length > PAGE ? (page.at(-1)?.key ?? null) : null,
            };
          }),
        );

      /**
       * The owner's activities that `relation` reaches by audience, each from the time it was
       * shared. A workout in progress is not shared yet.
       */
      const sharedScope = (relation: OwnedRelation, audiences: ReadonlyArray<string>) => sql`
        from activity_social s
        join account_row r on r.account_id = s.account_id and r.table_name = 'activity'
          and r.row_id = s.activity_id
        where s.account_id = ${relation.owner} and s.shared_ms is not null
          and r.deleted_at is null and coalesce(r.data->>'status', '') <> 'in_progress'
          and r.data->>'audience' in ${sql.in(audiences)}
      `;

      /**
       * Where the page after `cursor` starts. The activity it names must still be one the
       * viewer may see, and one that is not is refused just as one that never was.
       */
      const activitiesAfter = (relation: OwnedRelation, cursor: string) =>
        Effect.gen(function* () {
          const id = yield* readPostCursor(cursor);
          const audiences = visibleAudiences(relation);
          if (audiences.length === 0) return yield* new InvalidCursor();
          const [anchor] = yield* sql<SharedAnchor>`
            select s.shared_ms as "sharedMs", s.social_id as "socialId"
            ${sharedScope(relation, audiences)} and s.social_id = ${id}
          `;
          if (anchor === undefined) return yield* new InvalidCursor();
          return anchor;
        });

      // Newest first by when each activity was shared, never by when it started, as its start
      // may be hidden. The social ID breaks a tie, as the feed does.
      const activityPage = (relation: OwnedRelation, start: SharedAnchor | undefined) =>
        Effect.gen(function* () {
          const audiences = visibleAudiences(relation);
          if (audiences.length === 0) return { activities: [], next: null } satisfies ActivityPage;
          const scope = sharedScope(relation, audiences);
          type Row = SharedAnchor & { readonly data: unknown };
          const shown = yield* firstVisible(
            (after: Row | undefined) => {
              const before = after ?? start;
              return sql<Row>`
                select s.shared_ms as "sharedMs", s.social_id as "socialId", r.data
                ${scope}
                ${
                  before === undefined
                    ? sql``
                    : sql`and (s.shared_ms, s.social_id)
                        < (${before.sharedMs}::bigint, ${before.socialId})`
                }
                order by s.shared_ms desc, s.social_id desc
                limit ${SCAN}
              `;
            },
            (row) => {
              const activity = isPublished(row.data)
                ? Option.getOrUndefined(decodeActivity(row.data))
                : undefined;
              return activity === undefined
                ? undefined
                : viewActivity(
                    activity,
                    SocialActivityId.make(row.socialId),
                    visibilityOf(relation, activity),
                  );
            },
            PAGE + 1,
          );
          const last = shown[PAGE - 1];
          return {
            activities: shown.slice(0, PAGE).map(({ item }) => item),
            next: shown.length > PAGE && last !== undefined ? postCursor(last.row.socialId) : null,
          } satisfies ActivityPage;
        });

      return SocialRows.of({
        ownProfile,
        saveProfile: (account, profile) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`insert into account (id) values (${account}) on conflict do nothing`;
                // The upsert takes the profile's row lock before the requests are approved,
                // so a `follow` that read the old choice has committed its request by then.
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
              and not ${blockedWith(sql, viewer, "p.account_id")}
            order by p.username_key collate "C"
            limit ${PAGE}
          `.pipe(Effect.map((rows) => rows.map(summary))),
        profile: (viewer, username) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username, { viewer });
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
              ...(yield* activityPage(seen, undefined)),
            };
          }),
        activities: (viewer, username, cursor) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username, { viewer });
            const seen = yield* relationTo(viewer, owner.id);
            const start = cursor === undefined ? undefined : yield* activitiesAfter(seen, cursor);
            return yield* activityPage(seen, start);
          }),
        follow: (viewer, username) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const owner = yield* findAccount(username, { lock: true, viewer });
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
          ),
        unfollow: (viewer, username) =>
          Effect.gen(function* () {
            const owner = yield* findAccount(username, { viewer });
            yield* sql`delete from follow where follower_id = ${viewer} and followee_id = ${owner.id}`;
            return "none" as const;
          }),
        followers: (viewer, username, after) =>
          Effect.flatMap(findAccount(username, { viewer }), (owner) =>
            listOf(viewer, "followers", owner.id, after),
          ),
        following: (viewer, username, after) =>
          Effect.flatMap(findAccount(username, { viewer }), (owner) =>
            listOf(viewer, "following", owner.id, after),
          ),
        activity: (viewer, socialId) =>
          Effect.gen(function* () {
            const [found] = yield* sql<{ readonly account_id: string; readonly data: unknown }>`
              select s.account_id, r.data from activity_social s
              join account_row r on r.account_id = s.account_id and r.table_name = 'activity'
                and r.row_id = s.activity_id
              where s.social_id = ${socialId} and r.deleted_at is null
            `;
            const owner = Option.getOrUndefined(decodeAccountId(found?.account_id));
            const activity = isPublished(found?.data)
              ? Option.getOrUndefined(decodeActivity(found?.data))
              : undefined;
            if (owner === undefined || activity === undefined) return yield* new NotFound();
            const relation = yield* relationTo(viewer, owner);
            const view = viewActivity(activity, socialId, visibilityOf(relation, activity));
            if (view === undefined) return yield* new NotFound();
            return view;
          }),
        requests: (owner) =>
          sql<SummaryRow & { readonly id: string }>`
            select f.id, p.username, p.private, coalesce(mine.state, 'none') as follow
            from follow f
            join profile p on p.account_id = f.follower_id
            left join follow mine on mine.follower_id = ${owner} and mine.followee_id = p.account_id
            where f.followee_id = ${owner} and f.state = 'requested'
              and not ${blockedWith(sql, owner, "f.follower_id")}
            order by f.created_at, f.id
            limit ${PAGE}
          `.pipe(Effect.map((rows) => rows.map((row) => ({ id: row.id, ...summary(row) })))),
        approve: (owner, request) =>
          Effect.gen(function* () {
            const approved = yield* sql`
              update follow set state = 'following'
              where id = ${request} and followee_id = ${owner} and state = 'requested'
              returning 1
            `;
            if (approved.length === 0) return yield* new RequestNotFound();
          }),
        decline: (owner, request) =>
          Effect.gen(function* () {
            const declined = yield* sql`
              delete from follow
              where id = ${request} and followee_id = ${owner} and state = 'requested'
              returning 1
            `;
            if (declined.length === 0) return yield* new RequestNotFound();
          }),
        block: (viewer, username) =>
          sql.withTransaction(
            Effect.gen(function* () {
              // Blocking finds the account even when it blocked the viewer first, so each
              // side can keep the other out whoever blocked first.
              const other = yield* findAccount(username);
              if (other.id === viewer) return yield* new CannotBlockSelf();
              yield* sql`
                insert into block (blocker_id, blocked_id) values (${viewer}, ${other.id})
                on conflict do nothing
              `;
              yield* sql`
                delete from follow
                where (follower_id = ${viewer} and followee_id = ${other.id})
                  or (follower_id = ${other.id} and followee_id = ${viewer})
              `;
            }),
          ),
        blocks: (viewer) =>
          sql<{ readonly id: string; readonly username: string }>`
            select b.id, p.username from block b
            join profile p on p.account_id = b.blocked_id
            where b.blocker_id = ${viewer}
            order by b.created_at desc, b.id
            limit ${PAGE}
          `.pipe(Effect.map((rows) => rows.map((row) => ({ id: row.id, username: row.username })))),
        unblock: (viewer, block) =>
          Effect.gen(function* () {
            const removed = yield* sql`
              delete from block where id = ${block} and blocker_id = ${viewer} returning 1
            `;
            if (removed.length === 0) return yield* new BlockNotFound();
          }),
        removeFollower: (viewer, username) =>
          Effect.gen(function* () {
            const follower = yield* findAccount(username, { viewer });
            yield* sql`
              delete from follow
              where follower_id = ${follower.id} and followee_id = ${viewer}
                and state = 'following'
            `;
          }),
      });
    }),
  );
}
