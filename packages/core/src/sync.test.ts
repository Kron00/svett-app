import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { tokenSubject } from "./sync-api.ts";
import {
  changeIdOf,
  checkSyncRow,
  isTooFarAhead,
  MAX_CLOCK_AHEAD_MS,
  mergeRow,
  type RowVersion,
} from "./sync.ts";
import { nextRowTime } from "./table.ts";

const v = (updatedAt: number, changeId: string): RowVersion => ({ updatedAt, changeId });

/** Every order of `items`. */
const orders = <A>(items: ReadonlyArray<A>): Array<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        orders(items.filter((_, other) => other !== index)).map((rest) => [item].concat(rest)),
      );

/** The copy a store keeps after the versions arrive one by one in this order. */
const arrive = (versions: ReadonlyArray<RowVersion>) =>
  versions.reduce<RowVersion | undefined>(
    (stored, incoming) => (mergeRow(stored, incoming) === "take" ? incoming : stored),
    undefined,
  );

describe("mergeRow", () => {
  it.each([
    { case: "nothing stored", stored: undefined, incoming: v(5, "b"), result: "take" },
    { case: "a later time", stored: v(5, "b"), incoming: v(6, "a"), result: "take" },
    { case: "an earlier time", stored: v(5, "a"), incoming: v(4, "z"), result: "keep" },
    {
      case: "an equal time and a higher change ID",
      stored: v(5, "a"),
      incoming: v(5, "b"),
      result: "take",
    },
    {
      case: "an equal time and a lower change ID",
      stored: v(5, "b"),
      incoming: v(5, "a"),
      result: "keep",
    },
    { case: "the same change sent again", stored: v(5, "a"), incoming: v(5, "a"), result: "keep" },
  ] as const)("$result for $case", ({ stored, incoming, result }) => {
    expect(mergeRow(stored, incoming)).toBe(result);
  });

  const races = {
    "an insert, an edit and a delete": [v(1, "insert"), v(2, "edit"), v(3, "delete")],
    "a delete before a later edit from another phone": [v(3, "delete"), v(4, "edit")],
    "two changes with equal times": [v(7, "0f"), v(7, "f0")],
    "equal times with an older change among them": [v(7, "aa"), v(6, "zz"), v(7, "ab")],
    "a lost confirmation, a newer edit, then the retry": [
      v(1, "first"),
      v(2, "newer"),
      v(1, "first"),
    ],
  };

  it.each(Object.entries(races))(
    "keeps the newest copy of %s, in every order of arrival",
    (_, versions) => {
      const newest = [...versions].sort((a, b) =>
        a.updatedAt === b.updatedAt
          ? a.changeId < b.changeId
            ? -1
            : 1
          : a.updatedAt - b.updatedAt,
      )[versions.length - 1];
      for (const order of orders(versions)) expect(arrive(order)).toEqual(newest);
    },
  );
});

describe("change IDs", () => {
  it("are the same for the same row on every phone, and differ when the row does", () => {
    const row = { id: "a", updatedAt: 1, deletedAt: null, name: "Push", position: 0 };
    expect(changeIdOf("folder", row)).toBe(changeIdOf("folder", { ...row }));
    expect(changeIdOf("folder", row)).not.toBe(changeIdOf("folder", { ...row, name: "Pull" }));
    expect(changeIdOf("folder", row)).not.toBe(changeIdOf("routine", row));
  });
});

describe("row times", () => {
  it("follow the phone's clock until sync has applied a newer change", () => {
    expect(nextRowTime(1000, 0)).toBe(1000);
    expect(nextRowTime(1000, 999)).toBe(1000);
    expect(nextRowTime(1000, 1000)).toBe(1001);
    expect(nextRowTime(1000, 5000)).toBe(5001);
  });

  it("may run up to five minutes ahead of the server", () => {
    expect(isTooFarAhead(10_000 + MAX_CLOCK_AHEAD_MS, 10_000)).toBe(false);
    expect(isTooFarAhead(10_001 + MAX_CLOCK_AHEAD_MS, 10_000)).toBe(true);
  });
});

describe("checkSyncRow", () => {
  const folder = { id: "0190a0b2-0000-7000-8000-000000000001", updatedAt: 3, deletedAt: null };

  it("checks a row against its table's schema and gives its version", async () => {
    const row = { ...folder, name: "Push", position: 0 };
    const checked = await Effect.runPromise(checkSyncRow("folder", row));
    expect(checked).toEqual({
      table: "folder",
      id: folder.id,
      updatedAt: 3,
      deletedAt: null,
      encoded: row,
      changeId: changeIdOf("folder", row),
    });
  });

  it("refuses a row its table's schema refuses", async () => {
    const exit = await Effect.runPromiseExit(checkSyncRow("folder", { ...folder, position: -1 }));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

const token = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

describe("tokenSubject", () => {
  it("reads the account a session token names", () => {
    expect(tokenSubject(token({ sub: "user_alice", sid: "sess_ü" }))).toBe("user_alice");
  });

  it("names no account for a token without one or one that is not a token", () => {
    expect(tokenSubject(token({ sid: "sess_1" }))).toBeUndefined();
    expect(tokenSubject("not a token")).toBeUndefined();
  });
});
