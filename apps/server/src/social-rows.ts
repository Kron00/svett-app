import { PgClient } from "@effect/sql-pg";
import {
  AccountId,
  Activity,
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

export class NotFound extends Data.TaggedError("NotFound")<{}> {}
export class UsernameTaken extends Data.TaggedError("UsernameTaken")<{}> {}
export class UsernameRequired extends Data.TaggedError("UsernameRequired")<{}> {}
export class CannotFollowSelf extends Data.TaggedError("CannotFollowSelf")<{}> {}
export class RequestNotFound extends Data.TaggedError("RequestNotFound")<{}> {}

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
}

const decodeActivity = Schema.decodeUnknownOption(Activity);
const decodeAccountId = Schema.decodeUnknownOption(AccountId);

// A username prefix may hold an underscore, which LIKE reads as any one character.
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;

type SummaryRow = { readonly username: string; readonly private: boolean; readonly follow: string };

type OwnedRelation = Relation & { readonly owner: AccountId };

const visibilityOf = (relation: Relation, activity: Activity) =>
  privacy({ ...relation, audience: activity.audience, hiddenFields: activity.hiddenFields });

/**
 * Mints the social ID of each of `owner`'s activities that has none yet, and gives back every
 * one, keyed by the activity's own ID.
 */
const socialIdsOf = (sql: PgClient.PgClient, owner: string, activityIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [first, ...rest] = activityIds.map((id) => ({ account_id: owner, activity_id: id }));
    if (first === undefined) return new Map<string, SocialActivityId>();
    yield* sql`
      insert into activity_social ${sql.insert([first, ...rest])}
      on conflict do nothing
    `;
    const rows = yield* sql<{ readonly activity_id: string; readonly social_id: string }>`
      select activity_id, social_id from activity_social
      where account_id = ${owner} and activity_id in ${sql.in(activityIds)}
    `;
    return new Map(rows.map((row) => [row.activity_id, SocialActivityId.make(row.social_id)]));
  });

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

      // `lock` holds the profile's row until the transaction ends, so its private choice
      // cannot change between reading it and acting on it.
      const findAccount = (username: string, lock = false) =>
        sql<Account>`
          select account_id as id, username, private from profile
          where username_key = ${usernameKey(username)}
          ${lock ? sql`for update` : sql``}
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
        Effect.map(followState(viewer, owner), (follow): OwnedRelation => ({
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

      const socialIds = (owner: AccountId, activityIds: ReadonlyArray<string>) =>
        socialIdsOf(sql, owner, activityIds);

      const activities = (relation: OwnedRelation) =>
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
          const shown = rows.flatMap(({ data }) => {
            const activity = isPublished(data)
              ? Option.getOrUndefined(decodeActivity(data))
              : undefined;
            if (activity === undefined) return [];
            const visibility = visibilityOf(relation, activity);
            return visibility.visible ? [{ activity, visibility }] : [];
          });
          const ids = yield* socialIds(
            relation.owner,
            shown.map(({ activity }) => activity.id),
          );
          return shown.flatMap(({ activity, visibility }): ReadonlyArray<ActivityView> => {
            const socialId = ids.get(activity.id);
            const view = socialId && viewActivity(activity, socialId, visibility);
            return view ? [view] : [];
          });
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
          sql.withTransaction(
            Effect.gen(function* () {
              const owner = yield* findAccount(username, true);
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
            const owner = yield* findAccount(username);
            yield* sql`delete from follow where follower_id = ${viewer} and followee_id = ${owner.id}`;
            return "none" as const;
          }),
        followers: (viewer, username, after) =>
          Effect.flatMap(findAccount(username), (owner) =>
            listOf(viewer, "followers", owner.id, after),
          ),
        following: (viewer, username, after) =>
          Effect.flatMap(findAccount(username), (owner) =>
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
      });
    }),
  );
}
