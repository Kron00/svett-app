import { AccountId, ANONYMOUS } from "@svett/core";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type OpenDatabase, switchOwner } from "./current";
import { useOnFocus } from "./loaded";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} },
}));
vi.mock("../account/config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("./database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: unknown) => ({ target, close: async () => {} }),
}));
// The screen stays in front the whole time, and comes into view once.
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  const navigation = { isFocused: () => true };
  return {
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
    useNavigation: () => navigation,
  };
});

const ACCOUNT = AccountId.make("user_svett_loaded");

/** Each read, with whose database it reads and a way to finish it with the rows it found. */
let reads: Array<{ readonly owner: string; readonly finish: (rows: string) => Promise<void> }> = [];

const load = (database: OpenDatabase) =>
  new Promise<string>((resolve) => {
    reads.push({
      owner: database.owner.kind,
      finish: (rows) => act(async () => resolve(rows)),
    });
  });

function Rows() {
  const loaded = useOnFocus(load);
  return createElement("rows", { shows: loaded.state === "ready" ? loaded.value : loaded.state });
}

let tree: ReactTestRenderer | undefined;

const shown = () => tree?.root.findByType("rows" as never).props.shows as string;

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  switchOwner(ANONYMOUS);
  reads = [];
  await act(async () => {
    tree = create(createElement(Rows));
  });
});

afterEach(async () => {
  await act(async () => tree?.unmount());
});

describe("a screen's data when someone signs in or out", () => {
  it("never shows the previous owner's slow read that finishes after the new owner's", async () => {
    await act(async () => switchOwner({ kind: "account", accountId: ACCOUNT }));
    expect(reads.map((read) => read.owner)).toEqual(["anonymous", "account"]);

    await reads[1]!.finish("the account's routines");
    expect(shown()).toBe("the account's routines");
    await reads[0]!.finish("the phone's routines");
    expect(shown()).toBe("the account's routines");
  });

  it("stops showing the previous owner's rows as soon as another database opens", async () => {
    await reads[0]!.finish("the phone's routines");
    expect(shown()).toBe("the phone's routines");

    await act(async () => switchOwner({ kind: "account", accountId: ACCOUNT }));
    expect(shown()).toBe("loading");
    await reads[1]!.finish("the account's routines");
    expect(shown()).toBe("the account's routines");
  });
});
