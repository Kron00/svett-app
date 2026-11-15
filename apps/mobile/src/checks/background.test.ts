import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LOCATION_TASK, stopLeftoverLocation } from "./background";

// The location tasks iOS keeps registered across launches, by name.
const { registered } = vi.hoisted(() => ({ registered: new Set<string>() }));
vi.mock("expo-location", () => ({
  hasStartedLocationUpdatesAsync: async (task: string) => registered.has(task),
  stopLocationUpdatesAsync: async (task: string) => {
    registered.delete(task);
  },
}));
vi.mock("expo-task-manager", () => ({ defineTask: () => {} }));
vi.mock("expo-notifications", () => ({
  addNotificationReceivedListener: () => {},
  setNotificationHandler: () => {},
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => {}, currentState: "active" },
}));
vi.mock("./saved", () => ({ markPendingDelivered: async () => {} }));

beforeEach(() => registered.clear());

describe("stopLeftoverLocation", () => {
  it("stops a location check's task an earlier process left running", async () => {
    registered.add(LOCATION_TASK);
    expect(await stopLeftoverLocation()).toBe(true);
    expect(registered.has(LOCATION_TASK)).toBe(false);
  });

  it("does nothing when no task was left", async () => {
    expect(await stopLeftoverLocation()).toBe(false);
  });
});
