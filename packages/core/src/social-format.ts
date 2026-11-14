import { formatWorkoutDuration } from "./history.ts";
import type { ActivityView, FollowState } from "./privacy.ts";
import type { ActivityKind } from "./schema.ts";
import type { ProfileSummary } from "./social-api.ts";

/** What the follow button on someone's profile says, and what pressing it does. */
export const followButton = (
  follow: FollowState,
  isPrivate: boolean,
): {
  readonly label: string;
  readonly action: "follow" | "unfollow";
  readonly hint: string;
} => {
  switch (follow) {
    case "none":
      return isPrivate
        ? {
            label: "Ask to follow",
            action: "follow",
            hint: "This profile is private, so its owner approves each follower",
          }
        : { label: "Follow", action: "follow", hint: "Follows this profile at once" };
    case "requested":
      return { label: "Requested", action: "unfollow", hint: "Takes back your request" };
    case "following":
      return { label: "Following", action: "unfollow", hint: "Stops following this profile" };
  }
};

const KIND: Readonly<Record<ActivityKind, string>> = {
  strength: "Strength",
  run: "Run",
  ride: "Ride",
  walk: "Walk",
  hike: "Hike",
  other: "Activity",
};

/**
 * The line under an activity's title on someone's profile, such as "Run · 30 min · Nov 3".
 * A hidden start time says so instead of a day.
 */
export const activityLine = (view: ActivityView, formatDay: (millis: number) => string) =>
  [
    KIND[view.kind],
    formatWorkoutDuration(view.durationS),
    view.startedAt === null ? "Start time hidden" : formatDay(view.startedAt),
  ].join(" · ");

/** The line under a username in a list, such as "Private · Following". */
export const profileLine = (profile: ProfileSummary): string | undefined => {
  const parts = [
    profile.private ? "Private" : undefined,
    profile.follow === "following"
      ? "Following"
      : profile.follow === "requested"
        ? "Requested"
        : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
};

export const countOf = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
