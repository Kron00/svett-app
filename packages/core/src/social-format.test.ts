import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import type { ActivityView } from "./privacy.ts";
import { ActivityId, EpochMillis } from "./schema.ts";
import { activityLine, countOf, followButton, profileLine } from "./social-format.ts";

describe("followButton", () => {
  it.each([
    ["none", false, "Follow", "follow"],
    ["none", true, "Ask to follow", "follow"],
    ["requested", true, "Requested", "unfollow"],
    ["following", true, "Following", "unfollow"],
    ["following", false, "Following", "unfollow"],
  ] as const)("says what a %s follow of a private:%s profile does", (follow, isPrivate, label, action) => {
    expect(followButton(follow, isPrivate)).toMatchObject({ label, action });
  });
});

describe("activityLine", () => {
  const view: ActivityView = {
    id: ActivityId.make("0190a0b2-0000-7000-8000-000000000001"),
    kind: "run",
    startedAt: EpochMillis.make(1_790_000_000_000),
    durationS: DurationSeconds.make(1830),
    title: "Morning run",
    notes: "",
    energyKcal: null,
    hiddenFields: [],
  };
  const day = (millis: number) => `day ${millis}`;

  it("names the kind, the length and the day", () => {
    expect(activityLine(view, day)).toBe("Run · 31 min · day 1790000000000");
  });

  it("says the start time is hidden instead of a day", () => {
    expect(activityLine({ ...view, kind: "strength", startedAt: null }, day)).toBe(
      "Strength · 31 min · Start time hidden",
    );
  });
});

describe("profileLine", () => {
  it.each([
    [{ private: false, follow: "none" }, undefined],
    [{ private: true, follow: "none" }, "Private"],
    [{ private: true, follow: "requested" }, "Private · Requested"],
    [{ private: false, follow: "following" }, "Following"],
  ] as const)("describes %j as %j", (profile, line) => {
    expect(profileLine({ username: "anna", ...profile })).toBe(line);
  });
});

describe("countOf", () => {
  it("counts one and many", () => {
    expect([countOf(1, "follower", "followers"), countOf(0, "follower", "followers")]).toEqual([
      "1 follower",
      "0 followers",
    ]);
  });
});
