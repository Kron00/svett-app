import { describe, expect, it } from "vite-plus/test";

import {
  RATE_LIMITS,
  rateLimitedMessage,
  retryAfterSeconds,
  type Take,
  takeToken,
} from "./rate-limit.ts";

const LIMIT = { capacity: 3, perSecond: 1 / 10 };

/** Takes a token at each time in turn, from an unseen bucket. */
const takes = (times: ReadonlyArray<number>) => {
  const answers: Array<Take> = [];
  let bucket: Take["bucket"] | undefined;
  for (const at of times) {
    const answer = takeToken(bucket, LIMIT, at);
    answers.push(answer);
    bucket = answer.bucket;
  }
  return answers;
};

describe("takeToken", () => {
  it("lets a full burst through, then refuses the next with the wait for one token", () => {
    const answers = takes([0, 0, 0, 0]);
    expect(answers.map((answer) => answer.allowed)).toEqual([true, true, true, false]);
    expect(answers[3]).toMatchObject({ allowed: false, retryAfterSeconds: 10 });
  });

  it("fills again over time, never past capacity", () => {
    const answers = takes([0, 0, 0, 5_000, 10_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000]);
    expect(answers.map((answer) => answer.allowed)).toEqual([
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(answers[3]).toMatchObject({ retryAfterSeconds: 5 });
  });

  it("refills nothing when the clock goes back", () => {
    const answers = takes([10_000, 10_000, 10_000, 0]);
    expect(answers[3]).toMatchObject({ allowed: false, retryAfterSeconds: 10 });
    expect(answers[3]?.bucket.atMillis).toBe(10_000);
  });

  it("gives every group a burst of at least one", () => {
    for (const limit of Object.values(RATE_LIMITS)) {
      expect(takeToken(undefined, limit, 0).allowed).toBe(true);
      expect(limit.perSecond).toBeGreaterThan(0);
    }
  });
});

describe("rate limit messages", () => {
  it("says how long to wait in seconds or minutes", () => {
    expect(rateLimitedMessage(1)).toBe("That was a lot at once. Try again in 1 second.");
    expect(rateLimitedMessage(30)).toBe("That was a lot at once. Try again in 30 seconds.");
    expect(rateLimitedMessage(61)).toBe("That was a lot at once. Try again in 2 minutes.");
    expect(rateLimitedMessage(undefined)).toBe(
      "That was a lot at once. Wait a moment and try again.",
    );
  });

  it("reads a Retry-After header in whole seconds only", () => {
    expect(retryAfterSeconds("12")).toBe(12);
    expect(retryAfterSeconds(" 3 ")).toBe(3);
    expect(retryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });
});
