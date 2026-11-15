import { describe, expect, it, vi } from "vite-plus/test";

describe("the coach's first words timing", () => {
  it("runs from the first words arriving to the next frame after they show, once per answer", async () => {
    vi.resetModules();
    const frames: Array<() => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timing = await import("./timing");

    timing.firstWordsArrived();
    now = 1_004;
    // Later pieces of the same answer do not move the start.
    timing.firstWordsArrived();
    now = 1_010;
    timing.firstWordsShown();
    now = 1_026;
    expect(timing.firstWordsTiming()).toBeNull();
    frames.shift()?.();
    expect(timing.firstWordsTiming()).toBe(26);

    // Showing more of the answer without new first words records nothing.
    timing.firstWordsShown();
    expect(frames).toEqual([]);
    expect(timing.firstWordsTiming()).toBe(26);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
