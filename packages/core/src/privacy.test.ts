import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import {
  type FollowState,
  privacy,
  SocialActivityId,
  viewActivity,
  visibleAudiences,
} from "./privacy.ts";
import { type Activity, ActivityId, type Audience, EpochMillis, HiddenField } from "./schema.ts";

const OWNER = "user_owner";
const OTHER = "user_other";

type Who = "owner" | "other";

/**
 * Every combination of who looks, the viewer's follow state, a block and the audience,
 * with what the viewer sees. "fields" means the activity without its hidden fields.
 * The owner's follow of themself cannot happen, yet the rule must still hold for it.
 */
const MATRIX: ReadonlyArray<
  readonly [Who, FollowState, boolean, Audience, "all" | "fields" | "nothing"]
> = [
  ["owner", "none", false, "everyone", "all"],
  ["owner", "none", false, "followers", "all"],
  ["owner", "none", false, "only_you", "all"],
  ["owner", "none", true, "everyone", "all"],
  ["owner", "none", true, "followers", "all"],
  ["owner", "none", true, "only_you", "all"],
  ["owner", "requested", false, "everyone", "all"],
  ["owner", "requested", false, "followers", "all"],
  ["owner", "requested", false, "only_you", "all"],
  ["owner", "requested", true, "everyone", "all"],
  ["owner", "requested", true, "followers", "all"],
  ["owner", "requested", true, "only_you", "all"],
  ["owner", "following", false, "everyone", "all"],
  ["owner", "following", false, "followers", "all"],
  ["owner", "following", false, "only_you", "all"],
  ["owner", "following", true, "everyone", "all"],
  ["owner", "following", true, "followers", "all"],
  ["owner", "following", true, "only_you", "all"],
  ["other", "none", false, "everyone", "fields"],
  ["other", "none", false, "followers", "nothing"],
  ["other", "none", false, "only_you", "nothing"],
  ["other", "none", true, "everyone", "nothing"],
  ["other", "none", true, "followers", "nothing"],
  ["other", "none", true, "only_you", "nothing"],
  ["other", "requested", false, "everyone", "fields"],
  ["other", "requested", false, "followers", "nothing"],
  ["other", "requested", false, "only_you", "nothing"],
  ["other", "requested", true, "everyone", "nothing"],
  ["other", "requested", true, "followers", "nothing"],
  ["other", "requested", true, "only_you", "nothing"],
  ["other", "following", false, "everyone", "fields"],
  ["other", "following", false, "followers", "fields"],
  ["other", "following", false, "only_you", "nothing"],
  ["other", "following", true, "everyone", "nothing"],
  ["other", "following", true, "followers", "nothing"],
  ["other", "following", true, "only_you", "nothing"],
];

const FIELDS = HiddenField.literals;

/** Every set of hidden fields, from none to all five. */
const FIELD_SETS: ReadonlyArray<ReadonlyArray<HiddenField>> = Array.from(
  { length: 2 ** FIELDS.length },
  (_, bits) => FIELDS.filter((__, index) => (bits & (2 ** index)) !== 0),
);

const activity = (hiddenFields: ReadonlyArray<HiddenField>, audience: Audience): Activity => ({
  id: ActivityId.make("0190a0b2-0000-7000-8000-000000000001"),
  updatedAt: EpochMillis.make(2),
  deletedAt: null,
  kind: "run",
  startedAt: EpochMillis.make(1_790_000_000_000),
  durationS: DurationSeconds.make(1800),
  title: "Morning run",
  notes: "Easy",
  energyKcal: 420,
  audience,
  hiddenFields,
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
});

describe("privacy", () => {
  it("covers every combination of viewer, follow state, block and audience once", () => {
    const keys = MATRIX.map(([who, follow, blocked, audience]) =>
      [who, follow, blocked, audience].join(" "),
    );
    expect(new Set(keys).size).toBe(2 * 3 * 2 * 3);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it.each(MATRIX)(
    "%s viewer, follow %s, blocked %s, audience %s sees %s, whatever fields are hidden",
    (who, follow, blocked, audience, sees) => {
      for (const hiddenFields of FIELD_SETS) {
        const visibility = privacy({
          viewer: who === "owner" ? OWNER : OTHER,
          owner: OWNER,
          follow,
          blocked,
          audience,
          hiddenFields,
        });
        switch (sees) {
          case "nothing":
            expect(visibility).toEqual({ visible: false });
            break;
          case "all":
            expect(visibility).toEqual({ visible: true, hidden: [] });
            break;
          case "fields":
            expect(visibility).toEqual({ visible: true, hidden: hiddenFields });
            break;
        }
      }
    },
  );

  it("names each hidden field once, in one order, however the owner listed them", () => {
    expect(
      privacy({
        viewer: OTHER,
        owner: OWNER,
        follow: "none",
        blocked: false,
        audience: "everyone",
        hiddenFields: ["pace", "weight", "pace", "start_time"],
      }),
    ).toEqual({ visible: true, hidden: ["weight", "start_time", "pace"] });
  });
});

describe("visibleAudiences", () => {
  it.each([
    { follow: "none", blocked: false, audiences: ["everyone"] },
    { follow: "requested", blocked: false, audiences: ["everyone"] },
    { follow: "following", blocked: false, audiences: ["everyone", "followers"] },
    { follow: "following", blocked: true, audiences: [] },
  ] as const)("a $follow viewer, blocked $blocked, may see $audiences", (relation) => {
    expect(visibleAudiences({ viewer: OTHER, owner: OWNER, ...relation })).toEqual(
      relation.audiences,
    );
  });

  it("lets the owner see every audience", () => {
    expect(
      visibleAudiences({ viewer: OWNER, owner: OWNER, follow: "none", blocked: false }),
    ).toEqual(["everyone", "followers", "only_you"]);
  });
});

const SOCIAL_ID = SocialActivityId.make("6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13");

describe("viewActivity", () => {
  it("gives nothing when the activity is not the viewer's to see", () => {
    expect(viewActivity(activity([], "only_you"), SOCIAL_ID, { visible: false })).toBeUndefined();
  });

  it("names the activity by its social ID, never by its own", () => {
    const own = activity([], "everyone");
    const view = viewActivity(own, SOCIAL_ID, { visible: true, hidden: [] });
    expect(view?.id).toBe(SOCIAL_ID);
    expect(JSON.stringify(view)).not.toContain(own.id);
  });

  it("leaves the start time and calories out when they are hidden", () => {
    const hidden = activity(["start_time", "calories"], "everyone");
    const view = viewActivity(hidden, SOCIAL_ID, {
      visible: true,
      hidden: ["start_time", "calories"],
    });
    expect(view).toEqual({
      id: SOCIAL_ID,
      kind: "run",
      startedAt: null,
      durationS: 1800,
      title: "Morning run",
      notes: "Easy",
      energyKcal: null,
      hiddenFields: ["start_time", "calories"],
    });
    const sent = JSON.stringify(view);
    expect(sent).not.toContain(String(hidden.startedAt));
    expect(sent).not.toContain("420");
  });

  it("shows the owner everything, hidden fields included", () => {
    const own = activity(["start_time", "calories"], "only_you");
    expect(viewActivity(own, SOCIAL_ID, { visible: true, hidden: [] })).toMatchObject({
      startedAt: own.startedAt,
      energyKcal: 420,
      hiddenFields: [],
    });
  });

  it("leaves out the owner's audience and where the activity came from", () => {
    const view = viewActivity(activity([], "followers"), SOCIAL_ID, {
      visible: true,
      hidden: [],
    });
    expect(Object.keys(view ?? {}).sort()).toEqual([
      "durationS",
      "energyKcal",
      "hiddenFields",
      "id",
      "kind",
      "notes",
      "startedAt",
      "title",
    ]);
  });
});
