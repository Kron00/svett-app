import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { contentFingerprint, Ids, importedId, uuidV5, uuidV7 } from "./ids.ts";
import { manualClock } from "./manual-clock.ts";

describe("uuidV7", () => {
  it("matches the RFC 9562 example", () => {
    const random = Uint8Array.from([0x0c, 0xc3, 0x18, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]);
    expect(uuidV7(0x017f22e279b0, random)).toBe("017f22e2-79b0-7cc3-98c4-dc0c0c07398f");
  });

  it("sorts by creation time", () => {
    const random = new Uint8Array(10).fill(0xff);
    const earlier = uuidV7(Date.UTC(2026, 0, 1), random);
    const later = uuidV7(Date.UTC(2026, 0, 1) + 1, new Uint8Array(10));
    expect(earlier < later).toBe(true);
  });
});

describe("uuidV5", () => {
  it("matches the RFC 9562 example", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });
});

describe("importedId", () => {
  it("gives the same workout the same ID on every device", () => {
    expect(importedId("hevy", "2025-03-01T08:15:00Z")).toBe(
      importedId("hevy", "2025-03-01T08:15:00Z"),
    );
    expect(importedId("hevy", "2025-03-01T08:15:00Z")).toMatch(/^[0-9a-f-]{14}5/);
  });

  it("separates sources and identities", () => {
    const ids = new Set([
      importedId("hevy", "2025-03-01T08:15:00Z"),
      importedId("apple_health", "2025-03-01T08:15:00Z"),
      importedId("hevy", "2025-03-01T08:15:00Z#2"),
      importedId("hevy:2025", "03-01T08:15:00Z"),
    ]);
    expect(ids.size).toBe(4);
  });
});

const take = (layer: Layer.Layer<Ids>) =>
  Effect.runSync(
    Effect.gen(function* () {
      const ids = yield* Ids;
      return [yield* ids.random, yield* ids.random];
    }).pipe(Effect.provide(Layer.merge(layer, manualClock(Date.UTC(2026, 0, 1)).layer))),
  );

describe("Ids", () => {
  it("makes version 7 IDs that start with the current time", () => {
    let calls = 0;
    const [first, second] = take(Ids.layer((bytes) => bytes.fill(++calls)));
    expect(first).toBe("019b76da-a800-7101-8101-010101010101");
    expect(second).toBe("019b76da-a800-7202-8202-020202020202");
  });

  it("repeats the same IDs for the same seed and differs for another", () => {
    expect(take(Ids.layerSeeded(42))).toEqual(take(Ids.layerSeeded(42)));
    expect(take(Ids.layerSeeded(42))).not.toEqual(take(Ids.layerSeeded(43)));
  });
});

describe("contentFingerprint", () => {
  it("ignores key order and changes with content", () => {
    const a = contentFingerprint({ title: "Push", sets: [{ reps: 5, kg: 100 }] });
    expect(contentFingerprint({ sets: [{ kg: 100, reps: 5 }], title: "Push" })).toBe(a);
    expect(contentFingerprint({ title: "Push", sets: [{ reps: 6, kg: 100 }] })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
