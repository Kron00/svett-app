import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { Username, usernameKey, usernamePrefix, usernameProblem } from "./username.ts";

describe("usernameProblem", () => {
  it.each(["abc", "Lifter_99", "anna.k", "a".repeat(30), "9to5", "xy_"])("accepts %s", (name) => {
    expect(usernameProblem(name)).toBeUndefined();
  });

  it.each([
    ["ab", "A username has at least 3 characters."],
    ["a".repeat(31), "A username has at most 30 characters."],
    ["anna k", "Use only letters, digits, periods and underscores."],
    ["anna-k", "Use only letters, digits, periods and underscores."],
    ["émile", "Use only letters, digits, periods and underscores."],
    ["@anna", "Use only letters, digits, periods and underscores."],
    ["_anna", "Start with a letter or a digit."],
    [".anna", "Start with a letter or a digit."],
    ["anna.", "A username cannot end with a period."],
    ["an..na", "A username cannot have two periods in a row."],
    ["svett", "That username is reserved."],
    ["Admin", "That username is reserved."],
    ["s.v_e.t_t", "That username is reserved."],
  ])("refuses %s", (name, problem) => {
    expect(usernameProblem(name)).toBe(problem);
  });

  it("is the rule the Username schema checks", () => {
    expect(Schema.decodeUnknownOption(Username)("Lifter_99")._tag).toBe("Some");
    expect(Schema.decodeUnknownOption(Username)("svett")._tag).toBe("None");
  });
});

describe("usernameKey", () => {
  it("makes names that differ only in case the same", () => {
    expect(usernameKey("Lifter_99")).toBe(usernameKey("LIFTER_99"));
  });
});

describe("usernamePrefix", () => {
  it.each([
    ["Lif", "lif"],
    ["  @Anna.K ", "anna.k"],
    ["_", "_"],
  ])("searches %j as %j", (text, prefix) => {
    expect(usernamePrefix(text)).toBe(prefix);
  });

  it.each(["", "  ", "@", "anna k", "a%", "a".repeat(31)])(
    "searches nothing for %j, which no username starts with",
    (text) => {
      expect(usernamePrefix(text)).toBeUndefined();
    },
  );
});
