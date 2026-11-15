import { describe, expect, it } from "vite-plus/test";

import { firstRunAtLaunch } from "./first-run.ts";

describe("firstRunAtLaunch", () => {
  it("shows the first run on a fresh install", () => {
    expect(firstRunAtLaunch(undefined, undefined)).toEqual({ show: true, remember: false });
    expect(firstRunAtLaunch(null, "something else")).toEqual({ show: true, remember: false });
  });

  it("never shows it again once it was seen", () => {
    expect(firstRunAtLaunch(1, undefined)).toEqual({ show: false, remember: false });
    expect(firstRunAtLaunch(true, undefined)).toEqual({ show: false, remember: false });
    expect(firstRunAtLaunch("1", undefined)).toEqual({ show: false, remember: false });
  });

  it("skips it for a proof script and remembers that only once", () => {
    expect(firstRunAtLaunch(undefined, "skip")).toEqual({ show: false, remember: true });
    expect(firstRunAtLaunch(1, "skip")).toEqual({ show: false, remember: false });
  });

  it("shows it again when a launch asks to, without forgetting it was seen", () => {
    expect(firstRunAtLaunch(1, "show")).toEqual({ show: true, remember: false });
  });
});
