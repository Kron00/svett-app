import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  Activity,
  ActivityExercise,
  ActivitySample,
  ActivitySet,
  ActivityTrack,
  cleanComment,
  COMMENT_PAGE,
  commentProblem,
  Exercise,
  exerciseLibrary,
  FEED_PAGE,
  type FeedPage,
  type FollowState,
  INBOX_PAGE,
  type InboxItem,
  type InboxPage,
  isPublished,
  type Likes,
  type Muscle,
  type Post,
  type PostComment,
  type PostRows,
  type PostThread,
  privacy,
  type Relation,
  SocialActivityId,
  viewActivity,
  viewPostDetail,
  visibleAudiences,
} from "@svett/core";
import { Clock, Context, Data, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import {
  decodeCursor,
  encodeCursor,
  firstVisible,
  InvalidCursor,
  postCursor,
  readPostCursor,
  SCAN,
  type SharedAnchor,
} from "./paging.ts";
import { blockedWith, UsernameRequired } from "./social-rows.ts";

/** The post is not there, or the privacy rule does not let the account see it. */
export class PostNotFound extends Data.TaggedError("PostNotFound")<{}> {}
export class InvalidComment extends Data.TaggedError("InvalidComment")<{
  readonly message: string;
}> {}

type PostError = SqlError | PostNotFound;

export interface FeedRowsShape {
  /** The account's own posts and those of the accounts it follows, newest first. */
  readonly feed: (
    viewer: AccountId,
    cursor: string | undefined,
  ) => Effect.Effect<FeedPage, SqlError | UsernameRequired | InvalidCursor>;
  readonly post: (viewer: AccountId, id: SocialActivityId) => Effect.Effect<PostThread, PostError>;
  /** Likes the post. Liking it again changes nothing. */
  readonly like: (
    viewer: AccountId,
    id: SocialActivityId,
  ) => Effect.Effect<Likes, PostError | UsernameRequired>;
  /** Takes back a like. Without one it changes nothing. */
  readonly unlike: (viewer: AccountId, id: SocialActivityId) => Effect.Effect<Likes, PostError>;
  readonly comment: (
    viewer: AccountId,
    id: SocialActivityId,
    body: string,
  ) => Effect.Effect<PostComment, PostError | UsernameRequired | InvalidComment>;
  /** Deletes a comment the account wrote, or one on its own post. Anything else changes nothing. */
  readonly deleteComment: (
    viewer: AccountId,
    id: SocialActivityId,
    commentId: string,
  ) => Effect.Effect<void, PostError>;
  /** Likes, comments, follows and follow requests for the account, newest first. */
  readonly inbox: (
    viewer: AccountId,
    cursor: string | undefined,
  ) => Effect.Effect<InboxPage, SqlError | InvalidCursor>;
  /** Marks every inbox item up to `until` read. An earlier time changes nothing. */
  readonly markRead: (viewer: AccountId, until: number) => Effect.Effect<void, SqlError>;
}

const decodeActivity = Schema.decodeUnknownOption(Activity);
const decodeExercise = Schema.decodeUnknownOption(ActivityExercise);
const decodeSet = Schema.decodeUnknownOption(ActivitySet);
const decodeTrack = Schema.decodeUnknownOption(ActivityTrack);
const decodeSample = Schema.decodeUnknownOption(ActivitySample);
const decodeExerciseInfo = Schema.decodeUnknownOption(Exercise);

const decodeAll = <A>(
  decode: (data: unknown) => Option.Option<A>,
  rows: ReadonlyArray<{ readonly data: unknown }>,
): Array<A> => rows.flatMap(({ data }) => Option.toArray(decode(data)));

const InboxCursor = Schema.Struct({ at: Schema.Int, key: Schema.String });
const readInboxCursor = decodeCursor(InboxCursor);

/** Where `viewer` stands to an account they follow, or to themself. */
const relation = (
  viewer: AccountId,
  owner: string,
  follow: FollowState,
  blocked = false,
): Relation => ({ viewer, owner, follow, blocked });

/** Where an inbox row sits in the inbox's order. */
const position = (row: InboxRow) => ({ at: Number(row.at), key: row.key });

type FeedRow = SharedAnchor & {
  readonly ownerId: string;
  readonly username: string;
  readonly data: unknown;
};

type InboxRow = {
  readonly kind: InboxItem["kind"];
  readonly key: string;
  readonly username: string;
  readonly at: string;
  readonly ownerId: string | null;
  readonly ownerUsername: string | null;
  readonly socialId: string | null;
  readonly follow: FollowState | null;
  readonly activity: unknown;
  readonly body: string | null;
};

/** The inbox item a row makes, or undefined when its post is not the viewer's to see. */
const inboxItem = (viewer: AccountId, readUntil: number, row: InboxRow) => {
  const item = {
    id: row.key,
    username: row.username,
    at: Number(row.at),
    unread: Number(row.at) > readUntil,
  };
  if (row.kind === "follow") return { ...item, kind: "follow" } satisfies InboxItem;
  if (row.kind === "follow_request") {
    return { ...item, kind: "follow_request" } satisfies InboxItem;
  }
  if (
    row.ownerId === null ||
    row.ownerUsername === null ||
    row.socialId === null ||
    !isPublished(row.activity)
  ) {
    return undefined;
  }
  const activity = Option.getOrUndefined(decodeActivity(row.activity));
  if (activity === undefined) return undefined;
  const seen = relation(
    viewer,
    row.ownerId,
    row.ownerId === viewer ? "none" : (row.follow ?? "none"),
  );
  const view = viewActivity(
    activity,
    SocialActivityId.make(row.socialId),
    privacy({ ...seen, audience: activity.audience, hiddenFields: activity.hiddenFields }),
  );
  if (view === undefined) return undefined;
  const post = {
    username: row.ownerUsername,
    id: view.id,
    kind: view.kind,
    title: view.title,
    mine: row.ownerId === viewer,
  };
  return row.kind === "comment"
    ? ({ ...item, kind: "comment", post, body: row.body ?? "" } satisfies InboxItem)
    : ({ ...item, kind: "like", post } satisfies InboxItem);
};

export class FeedRows extends Context.Service<FeedRows, FeedRowsShape>()("svett/server/FeedRows") {
  static readonly layer: Layer.Layer<FeedRows, never, PgClient.PgClient> = Layer.effect(
    FeedRows,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const library = new Map(
        exerciseLibrary().map((exercise) => [exercise.id as string, exercise]),
      );

      const usernameOf = (account: AccountId) =>
        Effect.map(
          sql<{ readonly username: string }>`
            select username from profile where account_id = ${account}
          `,
          ([row]) => row?.username,
        );

      const followOf = (viewer: AccountId, owner: string) =>
        sql<{ readonly state: FollowState }>`
          select state from follow where follower_id = ${viewer} and followee_id = ${owner}
        `.pipe(Effect.map(([row]) => row?.state ?? "none"));

      const blockedOf = (viewer: AccountId, owner: string) =>
        sql<{ readonly blocked: boolean }>`
          select exists (
            select 1 from block
            where (blocker_id = ${viewer} and blocked_id = ${owner})
              or (blocker_id = ${owner} and blocked_id = ${viewer})
          ) as blocked
        `.pipe(Effect.map(([row]) => row?.blocked === true));

      /** The sets or the route under one activity, each row checked against its schema. */
      const postRows = (owner: string, activityId: string) =>
        Effect.gen(function* () {
          const children = yield* sql<{ readonly tableName: string; readonly data: unknown }>`
            select table_name as "tableName", data from account_row
            where account_id = ${owner} and deleted_at is null
              and table_name in ('activity_exercise', 'activity_track')
              and data->>'activityId' = ${activityId}
          `;
          const exercises = decodeAll(
            decodeExercise,
            children.filter((row) => row.tableName === "activity_exercise"),
          );
          const [track] = decodeAll(
            decodeTrack,
            children.filter((row) => row.tableName === "activity_track"),
          );
          const sets =
            exercises.length === 0
              ? []
              : decodeAll(
                  decodeSet,
                  yield* sql<{ readonly data: unknown }>`
                    select data from account_row
                    where account_id = ${owner} and deleted_at is null
                      and table_name = 'activity_set'
                      and data->>'activityExerciseId' in ${sql.in(exercises.map(({ id }) => id))}
                  `,
                );
          const custom = new Map(
            (exercises.length === 0
              ? []
              : decodeAll(
                  decodeExerciseInfo,
                  yield* sql<{ readonly data: unknown }>`
                    select data from account_row
                    where account_id = ${owner} and table_name = 'exercise'
                      and row_id in ${sql.in(exercises.map(({ exerciseId }) => exerciseId))}
                  `,
                )
            ).map((exercise) => [exercise.id as string, exercise]),
          );
          const samples =
            track === undefined
              ? []
              : decodeAll(
                  decodeSample,
                  yield* sql<{ readonly data: unknown }>`
                    select data from account_row
                    where account_id = ${owner} and deleted_at is null
                      and table_name = 'activity_sample' and data->>'activityTrackId' = ${track.id}
                  `,
                );
          const info = (id: string): { name?: string; primaryMuscles: ReadonlyArray<Muscle> } =>
            custom.get(id) ?? library.get(id) ?? { primaryMuscles: [] };
          const rows: PostRows = {
            exercises: exercises.map((exercise) => ({
              exercise,
              name: info(exercise.exerciseId).name,
              primaryMuscles: info(exercise.exerciseId).primaryMuscles,
              sets: sets.filter((set) => set.activityExerciseId === exercise.id),
            })),
            track: track === undefined ? undefined : { track, samples },
          };
          return rows;
        });

      const likesOf = (viewer: string, owner: string, activityId: string) =>
        sql<{ readonly likes: number; readonly liked: boolean; readonly comments: number }>`
          select
            (select count(*)::int from activity_like
              where owner_id = ${owner} and activity_id = ${activityId}) as likes,
            exists (select 1 from activity_like
              where owner_id = ${owner} and activity_id = ${activityId}
                and liker_id = ${viewer}) as liked,
            (select count(*)::int from activity_comment
              where owner_id = ${owner} and activity_id = ${activityId}) as comments
        `.pipe(Effect.map(([row]) => row ?? { likes: 0, liked: false, comments: 0 }));

      /**
       * The post as `seen` lets its viewer see it, or undefined. The privacy rule decides,
       * for the activity and for its sets and route alike.
       */
      const postFor = (
        seen: Relation,
        username: string,
        activity: Activity,
        socialId: SocialActivityId,
      ) =>
        Effect.gen(function* () {
          const visibility = privacy({
            ...seen,
            audience: activity.audience,
            hiddenFields: activity.hiddenFields,
          });
          const view = viewActivity(activity, socialId, visibility);
          if (view === undefined) return undefined;
          const detail = viewPostDetail(
            activity,
            yield* postRows(seen.owner, activity.id),
            visibility,
          );
          if (detail === undefined) return undefined;
          const mine = seen.viewer === seen.owner;
          const post: Post = {
            username,
            mine,
            audience: mine ? activity.audience : null,
            activity: view,
            detail,
            ...(yield* likesOf(seen.viewer, seen.owner, activity.id)),
          };
          return post;
        });

      /**
       * The post with social ID `id`, as `viewer` may see it, with its owner's account and the
       * activity's own ID, which only the server knows.
       */
      const visiblePost = (viewer: AccountId, id: SocialActivityId) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{
            readonly owner: string;
            readonly username: string;
            readonly activityId: string;
            readonly data: unknown;
          }>`
            select s.account_id as owner, p.username, s.activity_id as "activityId", r.data
            from activity_social s
            join profile p on p.account_id = s.account_id
            join account_row r on r.account_id = s.account_id and r.table_name = 'activity'
              and r.row_id = s.activity_id
            where s.social_id = ${id} and r.deleted_at is null
          `;
          const activity =
            row !== undefined && isPublished(row.data)
              ? Option.getOrUndefined(decodeActivity(row.data))
              : undefined;
          if (row === undefined || activity === undefined) return yield* new PostNotFound();
          const follow = row.owner === viewer ? "none" : yield* followOf(viewer, row.owner);
          const blocked = row.owner !== viewer && (yield* blockedOf(viewer, row.owner));
          const post = yield* postFor(
            relation(viewer, row.owner, follow, blocked),
            row.username,
            activity,
            id,
          );
          if (post === undefined) return yield* new PostNotFound();
          return { owner: row.owner, activityId: row.activityId, post };
        });

      const needUsername = (viewer: AccountId) =>
        Effect.flatMap(usernameOf(viewer), (username) =>
          username === undefined ? Effect.fail(new UsernameRequired()) : Effect.succeed(username),
        );

      /**
       * The posts `viewer`'s feed holds: their own and those of the accounts they follow, as
       * far as the privacy rule's audiences reach, each from the time it reached the feed.
       */
      const feedScope = (viewer: AccountId) => sql`
        from activity_social s
        join account_row r on r.account_id = s.account_id and r.table_name = 'activity'
          and r.row_id = s.activity_id
        join profile p on p.account_id = s.account_id
        left join follow f on f.follower_id = ${viewer} and f.followee_id = s.account_id
          and f.state = 'following'
        where s.shared_ms is not null and r.deleted_at is null
          and coalesce(r.data->>'status', '') <> 'in_progress'
          and ((s.account_id = ${viewer}
              and r.data->>'audience' in ${sql.in(visibleAudiences(relation(viewer, viewer, "none")))})
            or (f.follower_id is not null
              and r.data->>'audience' in ${sql.in(visibleAudiences(relation(viewer, "", "following")))}
              and not ${blockedWith(sql, viewer, "s.account_id")}))
      `;

      /**
       * Where the page after `cursor` starts. The post it names must still be in the viewer's
       * feed, and one that is not is refused just as one that never was.
       */
      const feedAfter = (viewer: AccountId, cursor: string | undefined) =>
        Effect.gen(function* () {
          if (cursor === undefined) return undefined;
          const id = yield* readPostCursor(cursor);
          const [anchor] = yield* sql<SharedAnchor>`
            select s.shared_ms as "sharedMs", s.social_id as "socialId"
            ${feedScope(viewer)} and s.social_id = ${id}
          `;
          if (anchor === undefined) return yield* new InvalidCursor();
          return anchor;
        });

      const inboxRows = (
        viewer: AccountId,
        options: {
          readonly before?: { readonly at: number; readonly key: string };
          readonly after?: number;
          readonly limit: number;
        },
      ) =>
        sql<InboxRow>`
          with item as (
            select 'like' as kind, md5('like/' || l.owner_id || '/' || l.activity_id || '/' || l.liker_id) as key,
              l.liker_id as actor, l.owner_id, l.activity_id, null::text as body, l.created_ms as at
            from activity_like l
            where l.owner_id = ${viewer} and l.liker_id <> ${viewer}
            union all
            select 'comment', md5('comment/' || c.id), c.author_id, c.owner_id, c.activity_id,
              c.body, c.created_ms
            from activity_comment c
            where c.author_id <> ${viewer}
              and (c.owner_id = ${viewer} or exists (
                select 1 from activity_comment mine
                where mine.owner_id = c.owner_id and mine.activity_id = c.activity_id
                  and mine.author_id = ${viewer} and mine.created_ms < c.created_ms))
            union all
            select case f.state when 'following' then 'follow' else 'follow_request' end,
              md5('follow/' || f.follower_id), f.follower_id, null, null, null,
              (extract(epoch from f.created_at) * 1000)::bigint
            from follow f
            where f.followee_id = ${viewer}
          )
          select i.kind, i.key, actor.username, i.at, i.owner_id as "ownerId",
            owner.username as "ownerUsername", social.social_id as "socialId",
            coalesce(seen.state, 'none') as follow, post.data as activity, i.body
          from item i
          join profile actor on actor.account_id = i.actor
          left join profile owner on owner.account_id = i.owner_id
          left join follow seen on seen.follower_id = ${viewer} and seen.followee_id = i.owner_id
          left join account_row post on post.account_id = i.owner_id
            and post.table_name = 'activity' and post.row_id = i.activity_id
            and post.deleted_at is null
          left join activity_social social on social.account_id = i.owner_id
            and social.activity_id = i.activity_id
          where (i.activity_id is null or (post.data is not null and owner.username is not null))
            and not ${blockedWith(sql, viewer, "i.actor")}
            and (i.owner_id is null or not ${blockedWith(sql, viewer, "i.owner_id")})
            ${options.before === undefined ? sql`` : sql`and (i.at, i.key) < (${options.before.at}, ${options.before.key})`}
            ${options.after === undefined ? sql`` : sql`and i.at > ${options.after}`}
          order by i.at desc, i.key desc
          limit ${options.limit}
        `;

      return FeedRows.of({
        feed: (viewer, cursor) =>
          Effect.gen(function* () {
            yield* needUsername(viewer);
            const start = yield* feedAfter(viewer, cursor);
            // Newest first by when each post reached the feed, never by when it started, as
            // its start time may be hidden. The social ID breaks a tie.
            const shown = yield* firstVisible(
              (after: FeedRow | undefined) => {
                const before = after ?? start;
                return sql<FeedRow>`
                  select s.account_id as "ownerId", p.username, s.social_id as "socialId",
                    s.shared_ms as "sharedMs", r.data
                  ${feedScope(viewer)}
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
                if (activity === undefined) return undefined;
                const seen = relation(
                  viewer,
                  row.ownerId,
                  row.ownerId === viewer ? "none" : "following",
                );
                const visible = privacy({
                  ...seen,
                  audience: activity.audience,
                  hiddenFields: activity.hiddenFields,
                }).visible;
                return visible ? { seen, activity } : undefined;
              },
              FEED_PAGE + 1,
            );
            const posts = yield* Effect.forEach(shown.slice(0, FEED_PAGE), ({ row, item }) =>
              postFor(item.seen, row.username, item.activity, SocialActivityId.make(row.socialId)),
            );
            const last = shown[FEED_PAGE - 1];
            return {
              posts: posts.filter((post) => post !== undefined),
              next:
                shown.length > FEED_PAGE && last !== undefined
                  ? postCursor(last.row.socialId)
                  : null,
            };
          }),
        post: (viewer, id) =>
          Effect.gen(function* () {
            const found = yield* visiblePost(viewer, id);
            const { owner, activityId } = found;
            const comments = yield* sql<{
              readonly id: string;
              readonly username: string;
              readonly body: string;
              readonly at: string;
              readonly authorId: string;
            }>`
              select c.id, p.username, c.body, c.created_ms as at, c.author_id as "authorId"
              from activity_comment c join profile p on p.account_id = c.author_id
              where c.owner_id = ${owner} and c.activity_id = ${activityId}
                and not ${blockedWith(sql, viewer, "c.author_id")}
              order by c.created_ms, c.id
              limit ${COMMENT_PAGE}
            `;
            return {
              post: found.post,
              comments: comments.map((comment) => ({
                id: comment.id,
                username: comment.username,
                body: comment.body,
                at: Number(comment.at),
                canDelete: comment.authorId === viewer || owner === viewer,
              })),
            };
          }),
        like: (viewer, id) =>
          Effect.gen(function* () {
            const { owner, activityId } = yield* visiblePost(viewer, id);
            yield* needUsername(viewer);
            yield* sql`
              insert into activity_like (owner_id, activity_id, liker_id, created_ms)
              values (${owner}, ${activityId}, ${viewer}, ${yield* Clock.currentTimeMillis})
              on conflict do nothing
            `;
            const { likes, liked } = yield* likesOf(viewer, owner, activityId);
            return { likes, liked };
          }),
        unlike: (viewer, id) =>
          Effect.gen(function* () {
            const { owner, activityId } = yield* visiblePost(viewer, id);
            yield* sql`
              delete from activity_like
              where owner_id = ${owner} and activity_id = ${activityId} and liker_id = ${viewer}
            `;
            const { likes, liked } = yield* likesOf(viewer, owner, activityId);
            return { likes, liked };
          }),
        comment: (viewer, id, text) =>
          Effect.gen(function* () {
            const { owner, activityId } = yield* visiblePost(viewer, id);
            const author = yield* needUsername(viewer);
            const body = cleanComment(text);
            const problem = commentProblem(body);
            if (problem !== undefined) return yield* new InvalidComment({ message: problem });
            const comment = { id: randomUUID(), at: yield* Clock.currentTimeMillis };
            yield* sql`
              insert into activity_comment (id, owner_id, activity_id, author_id, body, created_ms)
              values (${comment.id}, ${owner}, ${activityId}, ${viewer}, ${body}, ${comment.at})
            `;
            return { ...comment, username: author, body, canDelete: true };
          }),
        deleteComment: (viewer, id, commentId) =>
          Effect.gen(function* () {
            const { owner, activityId } = yield* visiblePost(viewer, id);
            yield* sql`
              delete from activity_comment
              where id = ${commentId} and owner_id = ${owner} and activity_id = ${activityId}
                and (author_id = ${viewer} or owner_id = ${viewer})
            `;
          }),
        inbox: (viewer, cursor) =>
          Effect.gen(function* () {
            const start = cursor === undefined ? undefined : yield* readInboxCursor(cursor);
            const [read] = yield* sql<{ readonly readUntil: string }>`
              select read_until as "readUntil" from inbox_read where account_id = ${viewer}
            `;
            const readUntil = Number(read?.readUntil ?? 0);
            const itemOf = (row: InboxRow) => inboxItem(viewer, readUntil, row);
            // Items about a post the viewer may no longer see are skipped before paging and
            // counting, so they neither shorten a page nor place a cursor.
            const page = yield* firstVisible(
              (after: InboxRow | undefined) => {
                const before = after === undefined ? start : position(after);
                return inboxRows(viewer, {
                  ...(before === undefined ? {} : { before }),
                  limit: SCAN,
                });
              },
              itemOf,
              INBOX_PAGE + 1,
            );
            const unread = yield* firstVisible(
              (after: InboxRow | undefined) =>
                inboxRows(viewer, {
                  ...(after === undefined ? {} : { before: position(after) }),
                  after: readUntil,
                  limit: SCAN,
                }),
              itemOf,
              INBOX_PAGE,
            );
            const last = page[INBOX_PAGE - 1];
            return {
              items: page.slice(0, INBOX_PAGE).map(({ item }) => item),
              next:
                page.length > INBOX_PAGE && last !== undefined
                  ? encodeCursor(position(last.row))
                  : null,
              unread: unread.length,
            };
          }),
        markRead: (viewer, until) =>
          Effect.gen(function* () {
            const capped = Math.min(Math.floor(until), yield* Clock.currentTimeMillis);
            yield* sql`
              insert into inbox_read (account_id, read_until) values (${viewer}, ${capped})
              on conflict (account_id) do update
                set read_until = greatest(inbox_read.read_until, excluded.read_until)
            `;
          }),
      });
    }),
  );
}
