import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgetChecks,
  loadPendingNotification,
  markPendingDelivered,
  savePendingNotification,
} from "./saved";

// A Keychain where every call takes a moment, so a delivery's read and its save can have
// another write land between them.
const { keychain, later } = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  later: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => {
    const value = keychain.get(key) ?? null;
    await later(5);
    return value;
  },
  setItemAsync: async (key: string, value: string) => {
    await later(5);
    keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    await later(5);
    keychain.delete(key);
  },
}));
vi.mock("../../modules/svett-native", () => ({ default: { launchedAt: 0 } }));

beforeEach(() => keychain.clear());

describe("the pending notification", () => {
  it("keeps a newer run's notification when the older one is delivered meanwhile", async () => {
    await savePendingNotification({ id: "first", dueAt: 1_000 });

    await Promise.all([
      markPendingDelivered("first", 1_200),
      savePendingNotification({ id: "second", dueAt: 2_000 }),
    ]);

    expect(await loadPendingNotification()).toEqual({ id: "second", dueAt: 2_000 });
  });

  it("records a delivery of the notification that is still pending", async () => {
    await savePendingNotification({ id: "first", dueAt: 1_000 });

    await markPendingDelivered("first", 1_200);

    expect(await loadPendingNotification()).toEqual({
      id: "first",
      dueAt: 1_000,
      deliveredInSvett: 1_200,
    });
  });

  it("ignores a delivery of a notification that was replaced", async () => {
    await savePendingNotification({ id: "first", dueAt: 1_000 });

    await Promise.all([
      savePendingNotification({ id: "second", dueAt: 2_000 }),
      markPendingDelivered("first", 1_200),
    ]);

    expect(await loadPendingNotification()).toEqual({ id: "second", dueAt: 2_000 });
  });

  it("stays forgotten when the checks reset while a delivery is being saved", async () => {
    await savePendingNotification({ id: "first", dueAt: 1_000 });

    await Promise.all([markPendingDelivered("first", 1_200), forgetChecks()]);

    expect(await loadPendingNotification()).toBeUndefined();
  });
});
