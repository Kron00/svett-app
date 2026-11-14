import { getStateFromPath } from "@react-navigation/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { linking } from "./linking";

// The launch arguments iOS turned into user defaults, and the link that launched svett.
const launch = vi.hoisted(() => ({
  defaults: new Map<string, unknown>(),
  url: null as string | null,
}));
vi.mock("react-native", () => ({
  Linking: { getInitialURL: async () => launch.url },
  Settings: { get: (key: string) => launch.defaults.get(key) },
}));

beforeEach(() => {
  launch.defaults.clear();
  launch.url = null;
});

describe("linking.getInitialURL", () => {
  it("opens the link given as -svettLink at once, so the first screen is the Train tab", () => {
    launch.defaults.set("svettLink", "svett://train");
    const url = linking.getInitialURL!();
    expect(url).toBe("svett://train");
    expect(getStateFromPath("train", linking.config)).toEqual({
      routes: [{ name: "Tabs", state: { routes: [{ name: "Train", path: "train" }] } }],
    });
  });

  it("opens the link that launched svett without -svettLink", async () => {
    launch.url = "svett://progress";
    expect(await linking.getInitialURL!()).toBe("svett://progress");
  });

  it("ignores a -svettLink that is not a svett link", async () => {
    launch.defaults.set("svettLink", "https://example.com/train");
    expect(await linking.getInitialURL!()).toBeNull();
    launch.defaults.set("svettLink", 1);
    expect(await linking.getInitialURL!()).toBeNull();
  });
});
