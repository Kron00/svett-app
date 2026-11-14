import { Schema } from "effect";

import { DurationSeconds } from "./duration.ts";
import { workingVolumeKg } from "./history.ts";
import { muscleSplit } from "./muscle-split.ts";
import {
  ActivityView,
  SocialActivityId,
  type Visibility,
  type Withheld,
  withheldBy,
} from "./privacy.ts";
import {
  type Activity,
  type ActivityExercise,
  ActivityKind,
  type ActivitySample,
  type ActivitySet,
  type ActivityTrack,
  Audience,
  Muscle,
  SetType,
} from "./schema.ts";

/** Posts in one page of the feed. */
export const FEED_PAGE = 20;
/** Inbox items in one page. */
export const INBOX_PAGE = 30;
/** The longest comment, in characters as a person counts them. */
export const COMMENT_MAX_LENGTH = 500;
/** The most comments a post shows, oldest first. */
export const COMMENT_PAGE = 200;
/** The most positions a shared route carries, so a feed page stays small. */
export const ROUTE_POINTS_MAX = 400;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const PostSet = Schema.Struct({
  /** Its place in the exercise, from 0. */
  position: Schema.Int,
  setType: SetType,
  /** Null when the set has none, and when the owner hides weight. */
  weightKg: Schema.NullOr(Schema.Finite),
  reps: Schema.NullOr(Schema.Int),
  /** Null when the set has none, and when the owner hides pace. */
  durationS: Schema.NullOr(DurationSeconds),
  distanceM: Schema.NullOr(Schema.Finite),
  rpe: Schema.NullOr(Schema.Finite),
});
export type PostSet = typeof PostSet.Type;

export const PostExercise = Schema.Struct({
  /** Its place in the session, from 0. */
  position: Schema.Int,
  name: Schema.String,
  sets: Schema.Array(PostSet),
});
export type PostExercise = typeof PostExercise.Type;

/** A lifting session's sets and how they fall across muscles, as P1's detail shows them. */
export const LiftingDetail = Schema.Struct({
  type: Schema.Literal("lifting"),
  exercises: Schema.Array(PostExercise),
  split: Schema.Array(Schema.Struct({ muscle: Muscle, sets: Schema.Finite, percent: Schema.Int })),
  /** Null when the owner hides weight. */
  volumeKg: Schema.NullOr(Schema.Finite),
});
export type LiftingDetail = typeof LiftingDetail.Type;

export const RoutePoint = Schema.Struct({ latitude: Schema.Finite, longitude: Schema.Finite });
export type RoutePoint = typeof RoutePoint.Type;

/** A run, ride, walk or hike as others see it: the route without its hidden ends, and no times. */
export const RouteDetail = Schema.Struct({
  type: Schema.Literal("route"),
  distanceM: Schema.NullOr(Schema.Finite),
  elevationGainM: Schema.NullOr(Schema.Finite),
  /** Seconds per kilometre. Null without a distance, and when the owner hides pace. */
  paceSPerKm: Schema.NullOr(Schema.Finite),
  /** Each split's time is null when the owner hides pace. */
  splits: Schema.Array(
    Schema.Struct({
      distanceM: Schema.Finite,
      /** The distance from the start to the end of this split. */
      endM: Schema.Finite,
      durationS: Schema.NullOr(DurationSeconds),
    }),
  ),
  /** The visible stretch, as lines of positions. */
  route: Schema.Array(Schema.Array(RoutePoint)),
  /** Null without readings, and when the owner hides heart rate. */
  averageHeartRateBpm: Schema.NullOr(Schema.Int),
});
export type RouteDetail = typeof RouteDetail.Type;

export const PostDetail = Schema.Union([LiftingDetail, RouteDetail]);
export type PostDetail = typeof PostDetail.Type;

/** One activity in the feed, with what the privacy rule lets the signed-in account see of it. */
export const Post = Schema.Struct({
  username: Schema.String,
  /** The post is the signed-in account's own. */
  mine: Schema.Boolean,
  /** Who can see it, only on your own posts. */
  audience: Schema.NullOr(Audience),
  activity: ActivityView,
  /** Null for an activity with no sets and no route. */
  detail: Schema.NullOr(PostDetail),
  likes: Count,
  liked: Schema.Boolean,
  comments: Count,
});
export type Post = typeof Post.Type;

/** Newest first by when each activity started. `next` asks for the page after this one. */
export const FeedPage = Schema.Struct({
  posts: Schema.Array(Post),
  next: Schema.NullOr(Schema.String),
});
export type FeedPage = typeof FeedPage.Type;

export const PostComment = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  /** What a person wrote. Show it as plain text only. */
  body: Schema.String,
  /** Epoch milliseconds. */
  at: Count,
  /** The signed-in account may delete it: it wrote the comment or owns the post. */
  canDelete: Schema.Boolean,
});
export type PostComment = typeof PostComment.Type;

/** A post with its comments, oldest first. */
export const PostThread = Schema.Struct({
  post: Post,
  comments: Schema.Array(PostComment),
});
export type PostThread = typeof PostThread.Type;

export const Likes = Schema.Struct({ likes: Count, liked: Schema.Boolean });
export type Likes = typeof Likes.Type;

/** The post an inbox item is about, as much as its line needs. */
export const PostRef = Schema.Struct({
  username: Schema.String,
  /** The post's social ID, as ActivityView names it. */
  id: SocialActivityId,
  kind: ActivityKind,
  title: Schema.String,
  mine: Schema.Boolean,
});
export type PostRef = typeof PostRef.Type;

const itemFields = {
  id: Schema.String,
  /** Who liked, commented or followed. */
  username: Schema.String,
  /** Epoch milliseconds. */
  at: Count,
  unread: Schema.Boolean,
};

export const InboxItem = Schema.Union([
  Schema.Struct({ ...itemFields, kind: Schema.Literal("like"), post: PostRef }),
  Schema.Struct({
    ...itemFields,
    kind: Schema.Literal("comment"),
    post: PostRef,
    body: Schema.String,
  }),
  Schema.Struct({ ...itemFields, kind: Schema.Literal("follow") }),
  Schema.Struct({ ...itemFields, kind: Schema.Literal("follow_request") }),
]);
export type InboxItem = typeof InboxItem.Type;

/** Newest first. `unread` counts unread items up to INBOX_PAGE. */
export const InboxPage = Schema.Struct({
  items: Schema.Array(InboxItem),
  next: Schema.NullOr(Schema.String),
  unread: Count,
});
export type InboxPage = typeof InboxPage.Type;

/**
 * Whether a stored activity row may reach a feed. A workout in progress is a draft on the
 * phone, so even a copy that reached the server stays out.
 */
export const isPublished = (row: unknown): boolean =>
  !(typeof row === "object" && row !== null && "status" in row && row.status === "in_progress");

// Control characters, and direction marks, isolates and overrides, which can make a comment
// read differently from what it holds.
const isHiddenCharacter = (code: number) =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
  code === 0x7f ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** A comment as svett keeps it: line breaks as \n, no control or direction characters, trimmed. */
export const cleanComment = (text: string): string =>
  [...text.replace(/\r\n?/g, "\n")]
    .filter((character) => !isHiddenCharacter(character.codePointAt(0) ?? 0))
    .join("")
    .trim();

/** Why svett refuses a cleaned comment, or undefined when it may be posted. */
export const commentProblem = (cleaned: string): string | undefined => {
  if (cleaned.length === 0) return "Write something first.";
  const length = [...cleaned].length;
  if (length > COMMENT_MAX_LENGTH) {
    return `A comment holds up to ${COMMENT_MAX_LENGTH} characters. This one has ${length}.`;
  }
  return undefined;
};

/** One exercise in an activity, with the name and main muscles of the exercise it logs. */
export interface PostRowsExercise {
  readonly exercise: ActivityExercise;
  readonly name: string | undefined;
  readonly primaryMuscles: ReadonlyArray<Muscle>;
  readonly sets: ReadonlyArray<ActivitySet>;
}

/** The rows under one activity that a post shows. */
export interface PostRows {
  readonly exercises: ReadonlyArray<PostRowsExercise>;
  readonly track:
    | { readonly track: ActivityTrack; readonly samples: ReadonlyArray<ActivitySample> }
    | undefined;
}

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

const metresBetween = (a: RoutePoint, b: RoutePoint): number => {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * The route others may see: every position from the first one outside `hideStartM` of the
 * start to the last one outside `hideEndM` of the end. Whole readings are dropped, so the
 * visible line never reaches into either circle.
 */
export const visibleRoute = (
  points: ReadonlyArray<RoutePoint>,
  hideStartM: number,
  hideEndM: number,
): ReadonlyArray<RoutePoint> => {
  if (points.length < 2) return [];
  const start = points[0]!;
  const end = points.at(-1)!;
  const first = points.findIndex((point) => metresBetween(start, point) > hideStartM);
  const last = points.findLastIndex((point) => metresBetween(end, point) > hideEndM);
  if (first === -1 || last === -1 || first >= last) return [];
  return points.slice(first, last + 1);
};

/** At most `max` positions, evenly picked, always keeping the first and the last. */
export const thinRoute = (
  points: ReadonlyArray<RoutePoint>,
  max = ROUTE_POINTS_MAX,
): ReadonlyArray<RoutePoint> => {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]!);
};

const liftingDetail = (rows: PostRows, withheld: ReadonlySet<Withheld>): LiftingDetail => {
  const ordered = [...rows.exercises].sort((a, b) => a.exercise.position - b.exercise.position);
  const exercises = ordered.map((entry, position) => ({
    position,
    name: entry.name ?? "Deleted exercise",
    sets: [...entry.sets]
      .sort((a, b) => a.position - b.position)
      .map((set, setPosition) => ({
        position: setPosition,
        setType: set.setType,
        weightKg: withheld.has("weight") ? null : set.weightKg,
        reps: set.reps,
        durationS: withheld.has("duration") ? null : set.durationS,
        distanceM: set.distanceM,
        rpe: set.rpe,
      })),
  }));
  return {
    type: "lifting",
    exercises,
    split: muscleSplit(ordered).map(({ muscle, sets, percent }) => ({ muscle, sets, percent })),
    volumeKg: withheld.has("volume")
      ? null
      : workingVolumeKg(ordered.flatMap((entry) => entry.sets)),
  };
};

const splitsOf = (samples: ReadonlyArray<ActivitySample>, hideDuration: boolean) => {
  let endM = 0;
  return samples.flatMap((sample) => {
    if (sample.kind !== "split") return [];
    endM += sample.distanceM;
    return [
      { distanceM: sample.distanceM, endM, durationS: hideDuration ? null : sample.durationS },
    ];
  });
};

const routeDetail = (
  activity: Activity,
  track: ActivityTrack,
  samples: ReadonlyArray<ActivitySample>,
  withheld: ReadonlySet<Withheld>,
): RouteDetail => {
  const byTime = [...samples].sort((a, b) => a.recordedAt - b.recordedAt);
  const positions = byTime.flatMap((sample) =>
    sample.kind === "location" ? [{ latitude: sample.latitude, longitude: sample.longitude }] : [],
  );
  const beats = byTime.flatMap((sample) => (sample.kind === "heart_rate" ? [sample.bpm] : []));
  const visible = thinRoute(visibleRoute(positions, track.hideStartM, track.hideEndM));
  const pace =
    track.distanceM === null || track.distanceM < 10 || activity.durationS <= 0
      ? null
      : activity.durationS / (track.distanceM / 1000);
  return {
    type: "route",
    distanceM: track.distanceM,
    elevationGainM: track.elevationGainM,
    paceSPerKm: withheld.has("pace") ? null : pace,
    splits: splitsOf(byTime, withheld.has("duration")),
    route: visible.length === 0 ? [] : [visible],
    averageHeartRateBpm:
      withheld.has("heart_rate") || beats.length === 0
        ? null
        : Math.round(beats.reduce((total, bpm) => total + bpm, 0) / beats.length),
  };
};

/**
 * What `visibility` lets a viewer see of an activity's sets or route, or undefined when the
 * activity is not theirs to see. Only privacy() makes a Visibility, so this is the one way to
 * a post's detail. The owner's own view still leaves out the route's ends and every reading's
 * time, as a post looks the same to everyone who sees it, apart from hidden fields.
 */
export const viewPostDetail = (
  activity: Activity,
  rows: PostRows,
  visibility: Visibility,
): PostDetail | null | undefined => {
  if (!visibility.visible) return undefined;
  const withheld = withheldBy(visibility.hidden);
  if (rows.track !== undefined) {
    return routeDetail(activity, rows.track.track, rows.track.samples, withheld);
  }
  if (rows.exercises.length > 0) return liftingDetail(rows, withheld);
  return null;
};
