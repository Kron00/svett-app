import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { syncStatusMessage, tokenSubject } from "./sync-api.ts";
import {
  changeIdOf,
  checkSyncRow,
  isTooFarAhead,
  MAX_CLOCK_AHEAD_MS,
  mergeChange,
  mergePushed,
  mergeRow,
  restoredAfter,
  type RowCopy,
  type RowVersion,
  type ServerCopy,
  staysOnPhone,
} from "./sync.ts";

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

const live = (updatedAt: number, changeId: string): RowCopy => ({
  updatedAt,
  changeId,
  deletedAt: null,
});
const deleted = (at: number, changeId: string): RowCopy => ({
  updatedAt: at,
  changeId,
  deletedAt: at,
});

describe("mergeChange", () => {
  it.each([
    {
      case: "an edit made after the workout was deleted",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      deletedAbove: 3,
      result: "keep",
    },
    {
      case: "an edit made as the workout was deleted",
      stored: deleted(3, "a"),
      incoming: live(3, "z"),
      deletedAbove: 3,
      result: "keep",
    },
    {
      case: "the delete arriving after a later edit",
      stored: live(4, "b"),
      incoming: deleted(3, "a"),
      deletedAbove: 3,
      result: "take",
    },
    {
      case: "an edit made before the workout was deleted",
      stored: deleted(3, "a"),
      incoming: live(2, "b"),
      deletedAbove: 3,
      result: "keep",
    },
    {
      case: "an edit after a set's own delete, with the workout live",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      deletedAbove: null,
      result: "take",
    },
    {
      case: "an edit after a set's own delete, before its workout's delete",
      stored: deleted(3, "a"),
      incoming: live(5, "b"),
      deletedAbove: 6,
      result: "take",
    },
  ] as const)("gives $result for $case", ({ stored, incoming, deletedAbove, result }) => {
    expect(mergeChange(stored, incoming, deletedAbove)).toBe(result);
  });

  it("keeps the deleted copy in either order of arrival", () => {
    const [edit, remove] = [live(4, "b"), deleted(3, "a")];
    const keptFirst = mergeChange(remove, edit, 3) === "take" ? edit : remove;
    const keptSecond = mergeChange(edit, remove, 3) === "take" ? remove : edit;
    expect(keptFirst).toEqual(remove);
    expect(keptSecond).toEqual(remove);
  });
});

/** The copy and Undos a server keeps of a workout after the changes arrive in this order. */
const serverArrive = (
  first: RowCopy,
  changes: ReadonlyArray<{ readonly copy: RowCopy; readonly restores: ReadonlyArray<number> }>,
) =>
  changes.reduce<ServerCopy>(
    (stored, { copy, restores }) =>
      mergePushed("activity", stored, copy, restores, []) === "take"
        ? { ...copy, restored: restoredAfter(stored, copy, restores) }
        : stored,
    { ...first, restored: [] },
  );

describe("mergePushed", () => {
  it.each([
    {
      case: "an edit to a deleted workout from a phone that never saw the delete",
      table: "activity",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [],
      deletedAbove: [],
      result: "refuse",
    },
    {
      case: "an Undo of the workout's current deletion",
      table: "activity",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [3],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "an Undo of an older deletion",
      table: "activity",
      stored: deleted(5, "a"),
      incoming: live(6, "b"),
      restores: [3],
      deletedAbove: [],
      result: "refuse",
    },
    {
      case: "an Undo that reversed this deletion and an earlier one",
      table: "activity",
      stored: deleted(5, "a"),
      incoming: live(6, "b"),
      restores: [3, 5],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "an Undo of this phone's own deletions after another phone's",
      table: "activity",
      stored: deleted(4, "a"),
      incoming: live(6, "b"),
      restores: [3, 5],
      deletedAbove: [],
      result: "refuse",
    },
    {
      case: "a set added under a deleted workout",
      table: "activity_set",
      stored: undefined,
      incoming: live(4, "b"),
      restores: [],
      deletedAbove: [3],
      result: "refuse",
    },
    {
      case: "a set added under a deleted workout before its delete",
      table: "activity_set",
      stored: undefined,
      incoming: live(2, "b"),
      restores: [],
      deletedAbove: [3],
      result: "take",
    },
    {
      case: "a set the Undo brings back before the workout",
      table: "activity_set",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [3],
      deletedAbove: [3, 3],
      result: "take",
    },
    {
      case: "a set the Undo brings back under an exercise deleted before",
      table: "activity_set",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [3],
      deletedAbove: [2, 3],
      result: "refuse",
    },
    {
      case: "an edit older than the delete",
      table: "activity_set",
      stored: deleted(3, "a"),
      incoming: live(2, "b"),
      restores: [],
      deletedAbove: [3],
      result: "keep",
    },
    {
      case: "a delete of a live set",
      table: "activity_set",
      stored: live(2, "a"),
      incoming: deleted(3, "b"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "a delete of a workout another phone edited after it",
      table: "activity",
      stored: live(4, "b"),
      incoming: deleted(3, "a"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "a delete of a set another phone edited after it",
      table: "activity_set",
      stored: live(4, "b"),
      incoming: deleted(3, "a"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "a delete of a set another phone deleted after it",
      table: "activity_set",
      stored: deleted(4, "b"),
      incoming: deleted(3, "a"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "a delete of a set after the workout's delete",
      table: "activity_set",
      stored: deleted(3, "a"),
      incoming: deleted(4, "b"),
      restores: [],
      deletedAbove: [3],
      result: "refuse",
    },
    {
      case: "a later delete of a deleted workout",
      table: "activity",
      stored: deleted(3, "a"),
      incoming: deleted(4, "b"),
      restores: [],
      deletedAbove: [],
      result: "refuse",
    },
    {
      case: "an edit to a live workout",
      table: "activity",
      stored: live(2, "a"),
      incoming: live(3, "b"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "an edit to a deleted routine, which only workouts guard",
      table: "routine",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [],
      deletedAbove: [],
      result: "take",
    },
    {
      case: "an edit to a routine set after its routine was deleted",
      table: "routine_set",
      stored: deleted(3, "a"),
      incoming: live(4, "b"),
      restores: [],
      deletedAbove: [3],
      result: "refuse",
    },
  ] as const)(
    "gives $result for $case",
    ({ table, stored, incoming, restores, deletedAbove, result }) => {
      expect(
        mergePushed(
          table,
          stored === undefined ? undefined : { ...stored, restored: [] },
          incoming,
          restores,
          deletedAbove.map((deletedAt) => ({ deletedAt, restoredAt: null })),
        ),
      ).toBe(result);
    },
  );

  it.each([
    {
      case: "a delete the server took an Undo of",
      stored: live(5, "c"),
      restored: [{ deletedAt: 3, restoredAt: 4 }],
      incoming: deleted(3, "a"),
      restores: [],
      above: [],
      result: "keep",
    },
    {
      case: "an edit made while its workout was deleted, arriving after the Undo",
      stored: live(2, "o"),
      restored: [],
      incoming: live(4, "b"),
      restores: [],
      above: [{ deletedAt: 3, restoredAt: 5 }],
      result: "refuse",
    },
    {
      case: "an edit made after an Undo",
      stored: live(5, "c"),
      restored: [{ deletedAt: 3, restoredAt: 5 }],
      incoming: live(6, "b"),
      restores: [],
      above: [],
      result: "take",
    },
    {
      case: "a set added while its workout was deleted, arriving after the Undo",
      stored: undefined,
      restored: [],
      incoming: live(4, "b"),
      restores: [],
      above: [{ deletedAt: 3, restoredAt: 5 }],
      result: "refuse",
    },
    {
      case: "a set added after its workout's Undo",
      stored: undefined,
      restored: [],
      incoming: live(6, "b"),
      restores: [],
      above: [{ deletedAt: 3, restoredAt: 5 }],
      result: "take",
    },
  ] as const)(
    "gives $result for $case",
    ({ stored, restored, incoming, restores, above, result }) => {
      expect(
        mergePushed(
          "activity_set",
          stored === undefined ? undefined : { ...stored, restored },
          incoming,
          restores,
          above,
        ),
      ).toBe(result);
    },
  );

  const remove = { copy: deleted(3, "a"), restores: [] };
  const edit = { copy: live(4, "b"), restores: [] };
  const removeAgain = { copy: deleted(5, "c"), restores: [] };
  const undo = { copy: live(6, "u"), restores: [3] };

  it.each(
    orders([
      ["delete", remove],
      ["later edit", edit],
      ["later delete", removeAgain],
    ] as const).map((order) => ({
      names: order.map(([name]) => name).join(", "),
      changes: order.map(([, change]) => change),
    })),
  )(
    "keeps a workout deleted at its first delete when the changes arrive as $names",
    ({ changes }) => {
      expect(serverArrive(live(1, "o"), changes)).toEqual({ ...deleted(3, "a"), restored: [] });
    },
  );

  it.each(
    orders([
      ["delete", remove],
      ["later edit", edit],
      ["Undo", undo],
    ] as const)
      .filter(
        (order) =>
          order.findIndex(([name]) => name === "delete") <
          order.findIndex(([name]) => name === "Undo"),
      )
      .map((order) => ({
        names: order.map(([name]) => name).join(", "),
        changes: order.map(([, change]) => change),
      })),
  )("keeps the Undo of a workout when the changes arrive as $names", ({ changes }) => {
    expect(serverArrive(live(1, "o"), changes)).toEqual({
      ...live(6, "u"),
      restored: [{ deletedAt: 3, restoredAt: 6 }],
    });
  });
});

const journal = (fields: object) => ({
  itemTable: "activity",
  rowIds: JSON.stringify({ activity: ["x"] }),
  replaced: null,
  ...fields,
});

describe("staysOnPhone", () => {
  const coachRow = { id: "m", content: "private" };

  it.each([
    ["a coach message", "coach_message", coachRow, true],
    ["a coach proposal", "proposal", {}, true],
    ["a workout's journal", "import_change", journal({}), false],
    [
      "a journal of a coach message",
      "import_change",
      journal({ itemTable: "coach_message", rowIds: JSON.stringify({ coach_message: ["m"] }) }),
      true,
    ],
    [
      "a journal that kept a replaced coach message",
      "import_change",
      journal({ replaced: JSON.stringify({ coach_message: [coachRow] }) }),
      true,
    ],
    [
      "a journal that kept an older journal of a coach message",
      "import_change",
      journal({
        itemTable: "import_batch",
        replaced: JSON.stringify({
          import_change: [
            journal({ rowIds: { activity: [] }, replaced: { coach_message: [coachRow] } }),
          ],
        }),
      }),
      true,
    ],
    [
      "a journal that kept an older workout journal",
      "import_change",
      journal({ replaced: JSON.stringify({ import_change: [journal({ rowIds: {} })] }) }),
      false,
    ],
    ["a journal it cannot read", "import_change", journal({ rowIds: "{" }), true],
    ["a workout", "activity", { id: "a" }, false],
  ] as const)("is %s for %s", (_, table, row, result) => {
    expect(staysOnPhone(table, row)).toBe(result);
  });
});

describe("row times", () => {
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

  it("refuses an import journal that kept a coach message", async () => {
    const exit = await Effect.runPromiseExit(
      checkSyncRow("import_change", {
        id: "0190a0b2-0000-7000-8000-000000000002",
        updatedAt: 3,
        deletedAt: null,
        importBatchId: "0190a0b2-0000-7000-8000-000000000003",
        change: "replaced",
        itemTable: "coach_message",
        itemId: "0190a0b2-0000-7000-8000-000000000004",
        title: "How was leg day?",
        itemAt: 3,
        rowIds: JSON.stringify({ coach_message: ["0190a0b2-0000-7000-8000-000000000004"] }),
        replaced: JSON.stringify({ coach_message: [{ content: "How was leg day?" }] }),
        written: "f".repeat(64),
      }),
    );
    expect(JSON.stringify(exit)).toContain("stays on the phone");
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

describe("syncStatusMessage", () => {
  it.each([
    [{ kind: "synced", queued: 0, held: 0 }, "Up to date"],
    [{ kind: "synced", queued: 1, held: 0 }, "1 change waits to upload."],
    [
      { kind: "synced", queued: 3, held: 3 },
      "This phone's clock is ahead of the svett server. 3 changes wait on this phone until the clock is right.",
    ],
    [
      { kind: "failed", problem: "offline", queued: 2 },
      "Cannot reach svett. 2 changes wait on this phone, and sync tries again soon.",
    ],
    [
      { kind: "failed", problem: "signed_out", queued: 2 },
      "Sign in again to sync. Everything stays on this phone meanwhile.",
    ],
    [
      { kind: "failed", problem: "update_required", queued: 2 },
      "Update svett to sync. Everything stays on this phone meanwhile.",
    ],
  ] as const)("describes %o", (status, message) => {
    expect(syncStatusMessage(status)).toBe(message);
  });
});
