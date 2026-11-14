import { Schema } from "effect";

import { DurationSeconds } from "./duration.ts";
import { Uuid } from "./ids.ts";
import { type Activity, ActivityKind, type Audience, EpochMillis, HiddenField } from "./schema.ts";

/** Where one account's follow of another stands. */
export const FollowState = Schema.Literals(["none", "requested", "following"]);
export type FollowState = typeof FollowState.Type;

/** Who is looking at whose data, and how the two are connected. */
export interface Relation {
  readonly viewer: string;
  readonly owner: string;
  /** Where the viewer's follow of the owner stands. */
  readonly follow: FollowState;
  /** Either account blocks the other. Blocks come with safety, so the server sends false. */
  readonly blocked: boolean;
}

export interface PrivacyInput extends Relation {
  readonly audience: Audience;
  readonly hiddenFields: ReadonlyArray<HiddenField>;
}

/** What a viewer may see of one activity: nothing, or the activity without `hidden`. */
export type Visibility =
  | { readonly visible: false }
  | { readonly visible: true; readonly hidden: ReadonlyArray<HiddenField> };

const NOTHING: Visibility = { visible: false };
const EVERYTHING: Visibility = { visible: true, hidden: [] };

/**
 * The privacy rule. The server runs every read of another account's activities through it.
 * The owner sees everything. A block hides everything. Otherwise `everyone` reaches every
 * account, `followers` only accounts whose follow was accepted, and `only_you` nobody else.
 * Anyone but the owner sees the activity without its hidden fields.
 */
export const privacy = (input: PrivacyInput): Visibility => {
  if (input.viewer === input.owner) return EVERYTHING;
  if (input.blocked) return NOTHING;
  switch (input.audience) {
    case "only_you":
      return NOTHING;
    case "followers":
      if (input.follow !== "following") return NOTHING;
      break;
    case "everyone":
      break;
  }
  return {
    visible: true,
    hidden: HiddenField.literals.filter((field) => input.hiddenFields.includes(field)),
  };
};

/** The audiences of the owner's activities that `relation` lets the viewer see at all. */
export const visibleAudiences = (relation: Relation): ReadonlyArray<Audience> =>
  (["everyone", "followers", "only_you"] as const).filter(
    (audience) => privacy({ ...relation, audience, hiddenFields: [] }).visible,
  );

/**
 * How another account names an activity. The server mints it at random the first time it
 * shows the activity, and keeps it, so it stays the same across reads and likes and
 * comments can point at it. An activity's own ID can be derived from its start time, as
 * an imported workout's is, so it never leaves the server for anyone else.
 */
export const SocialActivityId = Uuid.pipe(Schema.brand("SocialActivityId"));
export type SocialActivityId = typeof SocialActivityId.Type;

/**
 * An activity as another account receives it. A hidden field's value is not in it at all,
 * and `hiddenFields` names what the owner hid, so the app can say so. Weight, heart rate and
 * pace live in an activity's sets and samples, which this view does not carry.
 */
export const ActivityView = Schema.Struct({
  id: SocialActivityId,
  kind: ActivityKind,
  startedAt: Schema.NullOr(EpochMillis),
  durationS: DurationSeconds,
  title: Schema.String,
  notes: Schema.String,
  energyKcal: Schema.NullOr(Schema.Finite),
  hiddenFields: Schema.Array(HiddenField),
});
export type ActivityView = typeof ActivityView.Type;

/**
 * What `visibility` lets a viewer see of `activity`, named by its `socialId`, or undefined
 * when it is not theirs to see.
 */
export const viewActivity = (
  activity: Activity,
  socialId: SocialActivityId,
  visibility: Visibility,
): ActivityView | undefined => {
  if (!visibility.visible) return undefined;
  const hidden = new Set(visibility.hidden);
  return {
    id: socialId,
    kind: activity.kind,
    startedAt: hidden.has("start_time") ? null : activity.startedAt,
    durationS: activity.durationS,
    title: activity.title,
    notes: activity.notes,
    energyKcal: hidden.has("calories") ? null : activity.energyKcal,
    hiddenFields: visibility.hidden,
  };
};
