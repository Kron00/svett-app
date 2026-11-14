import { DurationSeconds, formatDuration } from "./duration.ts";
import type {
  InboxItem,
  LiftingDetail,
  Post,
  PostRef,
  PostSet,
  RouteDetail,
  RoutePoint,
} from "./feed.ts";
import { describeSet, formatVolumeKg, formatWorkoutDuration } from "./history.ts";
import type { ActivityKind, Audience, HiddenField } from "./schema.ts";
import { setBadge, type SetBadge } from "./set-format.ts";
import { countOf } from "./social-format.ts";

/** Kilometres to two decimals, cut rather than rounded, so 4,996 m does not read as 5.00. */
export const formatPostDistance = (metres: number): string =>
  `${(Math.floor(metres / 10) / 100).toFixed(2)} km`;

/** Minutes and seconds per kilometre, such as "5:12 /km". */
export const formatPostPace = (secondsPerKm: number): string =>
  `${formatDuration(DurationSeconds.make(Math.round(secondsPerKm)))} /km`;

/** A post's duration, or "Hidden" when the owner hides pace or the start time. */
export const formatPostDuration = (seconds: number | null): string =>
  seconds === null ? "Hidden" : formatWorkoutDuration(seconds);

/** The numbers under a lifting post, such as "4 exercises · 16 sets · 12,450 kg". */
export const liftingLine = (detail: LiftingDetail): string =>
  [
    countOf(detail.exercises.length, "exercise", "exercises"),
    countOf(
      detail.exercises.reduce((total, exercise) => total + exercise.sets.length, 0),
      "set",
      "sets",
    ),
    detail.volumeKg === null ? "Weight hidden" : formatVolumeKg(detail.volumeKg),
  ].join(" · ");

/** The numbers under a route post, such as "5.02 km · 5:12 /km". */
export const routeLine = (detail: RouteDetail): string =>
  [
    detail.distanceM === null ? "No distance" : formatPostDistance(detail.distanceM),
    detail.paceSPerKm === null ? undefined : formatPostPace(detail.paceSPerKm),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/** A post's likes and comments, such as "3 likes · 1 comment". */
export const postCounts = (post: Pick<Post, "likes" | "comments">): string =>
  `${countOf(post.likes, "like", "likes")} · ${countOf(post.comments, "comment", "comments")}`;

/** What the like button says and does for a post. */
export const likeButton = (post: Pick<Post, "liked" | "likes">) =>
  post.liked
    ? ({ label: "Liked", symbol: "heart.fill", hint: "Takes back your like" } as const)
    : ({ label: "Like", symbol: "heart", hint: "Likes this post" } as const);

export const AUDIENCE_LABEL: Readonly<Record<Audience, string>> = {
  everyone: "Everyone",
  followers: "Followers",
  only_you: "Only you",
};

const NOUN: Readonly<Record<ActivityKind, string>> = {
  strength: "workout",
  run: "run",
  ride: "ride",
  walk: "walk",
  hike: "hike",
  other: "activity",
};

const postName = (post: PostRef) => {
  const whose = post.mine ? "your" : `${post.username}'s`;
  const title = post.title.trim();
  return title === "" ? `${whose} ${NOUN[post.kind]}` : `${whose} ${NOUN[post.kind]} ${title}`;
};

/** An inbox item as one sentence, such as "anna liked your run Morning run". */
export const inboxLine = (item: InboxItem): string => {
  switch (item.kind) {
    case "like":
      return `${item.username} liked ${postName(item.post)}`;
    case "comment":
      return `${item.username} commented on ${postName(item.post)}`;
    case "follow":
      return `${item.username} follows you`;
    case "follow_request":
      return `${item.username} asked to follow you`;
  }
};

const ROUTE_PADDING = 12;

/**
 * A route's lines as SVG polyline points in a box `width` by `height`, north up, centred,
 * keeping the route's shape: away from the equator a degree of longitude is shorter than one
 * of latitude.
 */
export const projectRoute = (
  lines: ReadonlyArray<ReadonlyArray<RoutePoint>>,
  width: number,
  height: number,
): ReadonlyArray<string> => {
  const points = lines.flat();
  if (points.length === 0 || width <= 0 || height <= 0) return [];
  const latitudes = points.map((point) => point.latitude);
  const middle = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const squeeze = Math.cos((middle * Math.PI) / 180);
  const xs = points.map((point) => point.longitude * squeeze);
  const [left, right] = [Math.min(...xs), Math.max(...xs)];
  const [bottom, top] = [Math.min(...latitudes), Math.max(...latitudes)];
  const span = Math.max(right - left, top - bottom, 1e-9);
  const scale = Math.min(width - 2 * ROUTE_PADDING, height - 2 * ROUTE_PADDING) / span;
  const offsetX = (width - (right - left) * scale) / 2;
  const offsetY = (height - (top - bottom) * scale) / 2;
  const at = (point: RoutePoint) =>
    `${(offsetX + (point.longitude * squeeze - left) * scale).toFixed(1)},${(offsetY + (top - point.latitude) * scale).toFixed(1)}`;
  return lines.map((line) => line.map(at).join(" "));
};

/** Each split of a route as a row says it, such as "Split 2, 1.00 km" at "5:30 /km". */
export const splitLines = (splits: RouteDetail["splits"]) =>
  splits.map((split, index) => ({
    endM: split.endM,
    number: index + 1,
    title: `Split ${index + 1}, ${formatPostDistance(split.distanceM)}`,
    pace:
      split.durationS === null || split.distanceM <= 0
        ? "Hidden"
        : formatPostPace((split.durationS / split.distanceM) * 1000),
  }));

/** Each set of an exercise in a post with its badge, such as "W" or "2", and what it recorded. */
export const postSetLines = (
  sets: ReadonlyArray<PostSet>,
): ReadonlyArray<{
  readonly position: number;
  readonly setType: PostSet["setType"];
  readonly badge: SetBadge;
  readonly text: string;
}> => {
  let normal = 0;
  return sets.map((set) => {
    if (set.setType === "normal") normal++;
    return {
      position: set.position,
      setType: set.setType,
      badge: setBadge(set.setType, normal),
      text: describeSet(set) || "Nothing recorded",
    };
  });
};

const HIDDEN_FIELD_LABEL: Readonly<Record<HiddenField, string>> = {
  weight: "weight",
  heart_rate: "heart rate",
  start_time: "start time",
  calories: "calories",
  pace: "pace",
};

/** What the owner hid from you, such as "anna hides weight and start time.", or undefined. */
export const hiddenNote = (
  username: string,
  hidden: ReadonlyArray<HiddenField>,
): string | undefined => {
  const names = hidden.map((field) => HIDDEN_FIELD_LABEL[field]);
  if (names.length === 0) return undefined;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${username} hides ${list}.`;
};
