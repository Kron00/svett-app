import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { Ids } from "./ids.ts";
import { makeRecorder } from "./recorder.ts";
import { type Fix, isPaused, movingMs, parseJournal } from "./recording.ts";
import { ActivityRepository } from "./repositories/activities.ts";
import { openTestDatabase, T0 } from "./test-database.ts";

const DEGREE_M = (Math.PI * 6_371_008.8) / 180;

const reading = (at: number, metres: number): Fix => ({
  at,
  latitude: metres / DEGREE_M,
  longitude: 0,
  altitudeM: null,
  altitudeAccuracyM: null,
  accuracyM: 2,
});

/** A phone whose journal lives in memory and whose calls can fail or wait when told. */
const fakePhone = (initialJournal = "") => {
  const phone = {
    journal: initialJournal,
    calls: [] as string[],
    startFails: false,
    stopFails: false,
    appendFails: false,
    removeFails: false,
    /** While set, journal writes wait for it. */
    appendGate: undefined as Promise<void> | undefined,
  };
  const ports = {
    journal: {
      read: () => phone.journal,
      append: async (text: string) => {
        phone.calls.push("append started");
        await phone.appendGate;
        if (phone.appendFails) throw new Error("The disk is full");
        phone.journal += text;
        phone.calls.push("append done");
      },
      remove: async () => {
        phone.calls.push("remove");
        if (phone.removeFails) throw new Error("svett was closed");
        phone.journal = "";
      },
    },
    location: {
      start: async () => {
        phone.calls.push("location start");
        if (phone.startFails) throw new Error("Location updates are not allowed");
      },
      stop: async () => {
        phone.calls.push("location stop");
        if (phone.stopFails) throw new Error("Location updates did not stop");
      },
    },
    localHour: () => 8,
    onChange: () => undefined,
  };
  return { phone, ports };
};

type Services = ActivityRepository | Ids;

const setup = (initialJournal = "") => {
  const database = openTestDatabase();
  const { phone, ports } = fakePhone(initialJournal);
  const recorder = makeRecorder(ports);
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) => database.runtime.runPromise(effect);
  const exit = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    database.runtime.runPromiseExit(effect);
  const advance = (seconds: number) => run(database.clock.advance(seconds * 1000));
  return { database, phone, ports, recorder, run, exit, advance };
};

describe("the recorder", () => {
  it("times start, pause, resume and finish by the Effect clock", async () => {
    const { recorder, run, advance, phone } = setup();
    await run(recorder.start("run"));
    await advance(60);
    await run(recorder.pause);
    await advance(30);
    await run(recorder.resume);
    await advance(45);
    expect(movingMs(recorder.get()!, T0 + 135_000)).toBe(105_000);
    const journal = parseJournal(phone.journal);
    const id = await run(recorder.finish);
    expect(journal.map((event) => ("at" in event ? event.at - T0 : event.type))).toEqual([
      0, 60_000, 90_000,
    ]);
    const saved = await run(Effect.flatMap(Effect.service(ActivityRepository), (a) => a.get(id)));
    expect(Option.getOrThrow(saved).activity).toMatchObject({
      startedAt: T0,
      durationS: 105,
      title: "Morning run",
    });
  });

  it("starts nothing and writes no journal when GPS will not start", async () => {
    const { recorder, exit, phone } = setup();
    phone.startFails = true;
    const result = await exit(recorder.start("walk"));
    expect(result).toMatchObject({ _tag: "Failure" });
    expect(String(Exit.isFailure(result) && result.cause)).toContain(
      "Location updates are not allowed",
    );
    expect(recorder.get()).toBeUndefined();
    expect(phone.journal).toBe("");
  });

  it("stays paused and says why when GPS will not resume", async () => {
    const { recorder, run, exit, phone, advance } = setup();
    await run(recorder.start("run"));
    await run(recorder.pause);
    await advance(10);
    phone.startFails = true;
    phone.calls.length = 0;
    const result = await exit(recorder.resume);
    expect(result).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "RecorderError", step: "location" } }] },
    });
    expect(isPaused(recorder.get()!)).toBe(true);
    expect(parseJournal(phone.journal).map((event) => event.type)).toEqual(["start", "pause"]);
    // Updates that may have half started are stopped, since nothing would read them.
    expect(phone.calls).toEqual(["location start", "location stop"]);
    phone.startFails = false;
    await run(recorder.resume);
    expect(isPaused(recorder.get()!)).toBe(false);
  });

  it("pauses, and says why, when GPS will not stop", async () => {
    const { recorder, run, exit, phone } = setup();
    await run(recorder.start("run"));
    phone.stopFails = true;
    expect(await exit(recorder.pause)).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "RecorderError", step: "location" } }] },
    });
    expect(isPaused(recorder.get()!)).toBe(true);
  });

  it("keeps the recording as it was when the journal cannot be written", async () => {
    const { recorder, run, exit, phone, advance } = setup();
    await run(recorder.start("run"));
    await advance(1);
    phone.appendFails = true;
    const result = await exit(recorder.addFixes([reading(T0 + 1000, 0)]));
    expect(result).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { _tag: "RecorderError", step: "journal" } }] },
    });
    expect(recorder.get()!.segments[0]!.fixes).toHaveLength(0);
  });

  it("finishes writing readings before a change that follows, and before removing the journal", async () => {
    const { recorder, run, phone } = setup();
    await run(recorder.start("run"));
    const gate = Promise.withResolvers<void>();
    phone.appendGate = gate.promise;
    phone.calls.length = 0;
    const fixes = run(recorder.addFixes([reading(T0, 0)]));
    const discard = run(recorder.discard);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(phone.calls).toEqual(["append started"]);
    gate.resolve();
    await Promise.all([fixes, discard]);
    expect(phone.calls).toEqual(["append started", "append done", "location stop", "remove"]);
    expect(phone.journal).toBe("");
    expect(recorder.get()).toBeUndefined();
  });

  it("saves once when finished again after svett closed between the save and the journal's removal", async () => {
    const { recorder, run, exit, phone, database, ports } = setup();
    await run(recorder.start("ride"));
    await run(recorder.addFixes([reading(T0, 0), reading(T0 + 1000, 10), reading(T0 + 2000, 20)]));
    phone.removeFails = true;
    expect(await exit(recorder.finish)).toMatchObject({ _tag: "Failure" });
    phone.removeFails = false;

    // svett opens again and replays the journal that was left behind.
    const reopened = makeRecorder({ ...ports });
    expect(reopened.get()?.activityId).toBe(recorder.get()?.activityId);
    const id = await run(reopened.finish);
    expect(id).toBe(recorder.get()?.activityId);
    const counts = await database.runtime.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.counts),
    );
    expect(counts.activities).toBe(1);
    expect(phone.journal).toBe("");
  });

  it("pauses a running recording when GPS will not start again after svett reopens", async () => {
    const first = setup();
    await first.run(first.recorder.start("run"));
    const { phone, ports } = fakePhone(first.phone.journal);
    phone.startFails = true;
    const reopened = makeRecorder(ports);
    const result = await first.exit(reopened.restore);
    expect(result).toMatchObject({ _tag: "Failure" });
    expect(isPaused(reopened.get()!)).toBe(true);
    expect(parseJournal(phone.journal).at(-1)?.type).toBe("pause");
  });

  it("drops readings that arrive with no recording", async () => {
    const { recorder, run, phone } = setup();
    await run(recorder.addFixes([reading(T0, 0)]));
    expect(phone.journal).toBe("");
    expect(recorder.get()).toBeUndefined();
  });
});
