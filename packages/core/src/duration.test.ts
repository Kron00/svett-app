import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds, formatDuration } from "./duration.ts";

const decode = Schema.decodeUnknownSync(DurationSeconds);

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [7, "0:07"],
    [65, "1:05"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3725, "1:02:05"],
    [36_000, "10:00:00"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatDuration(decode(seconds))).toBe(expected);
  });

  it("drops a partial second instead of rounding up", () => {
    expect(formatDuration(decode(59.9))).toBe("0:59");
  });
});

describe("DurationSeconds", () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "60"])("rejects %s", (input) => {
    expect(() => decode(input)).toThrow();
  });
});
