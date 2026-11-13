import { describe, expect, it } from "vite-plus/test";

import {
  type CheckName,
  type CheckOutcome,
  NOT_RUN,
  type StoredOutcome,
  chatGPTOutcome,
  decodePendingNotification,
  decodeStoredOutcome,
  encodeKeychainMark,
  encodePendingNotification,
  encodeStoredOutcome,
  formatReport,
  healthOutcome,
  keychainOutcome,
  locationOutcome,
  notificationDateMs,
  mergeOutcome,
  mergeOutcomes,
  notificationOutcome,
  parseCount,
  type WorkoutAccess,
} from "./phone-checks.ts";

const T0 = Date.parse("2026-11-13T15:00:00Z");
const s = (n: number) => T0 + n * 1000;

describe("keychainOutcome", () => {
  it("waits for a restart when nothing was stored yet", () => {
    expect(keychainOutcome({ kind: "read", stored: null }, s(0)).status).toBe("waiting");
  });

  it("waits when the stored value came from this same launch", () => {
    const stored = encodeKeychainMark(s(0));
    expect(keychainOutcome({ kind: "read", stored }, s(0)).status).toBe("waiting");
  });

  it("passes when the value from an earlier launch is read back", () => {
    const stored = encodeKeychainMark(s(0));
    expect(keychainOutcome({ kind: "read", stored }, s(90))).toEqual({
      status: "passed",
      detail: "Read back the value saved by the launch at 15:00:00 UTC.",
    });
  });

  it("fails when the Keychain refuses or holds something unreadable", () => {
    expect(keychainOutcome({ kind: "error", message: "-34018" }, s(0))).toEqual({
      status: "failed",
      detail: "The Keychain refused: -34018",
    });
    expect(keychainOutcome({ kind: "read", stored: "{" }, s(0)).status).toBe("failed");
    expect(keychainOutcome({ kind: "read", stored: '{"launchedAt":"x"}' }, s(0)).status).toBe(
      "failed",
    );
  });
});

describe("notificationOutcome", () => {
  const away = [{ from: s(3), to: s(40) }];

  it("passes when the notification arrived while svett was away", () => {
    expect(notificationOutcome({ kind: "arrived", at: s(10) }, away, s(0))).toEqual({
      status: "passed",
      detail: "Arrived at 15:00:10 UTC while svett was in the background.",
    });
  });

  it("counts an away stretch that has not ended yet", () => {
    expect(notificationOutcome({ kind: "arrived", at: s(10) }, [{ from: s(3) }], s(0)).status).toBe(
      "passed",
    );
  });

  it("asks for another run when it arrived while svett was open", () => {
    expect(notificationOutcome({ kind: "arrived", at: s(50) }, away, s(0)).status).toBe("waiting");
  });

  it("passes for an iOS delivery, whose date Expo gives in seconds", () => {
    const iosDate = s(10) / 1000 + 0.123;
    expect(
      notificationOutcome({ kind: "arrived", at: notificationDateMs(iosDate) }, away, s(0)),
    ).toEqual({
      status: "passed",
      detail: "Arrived at 15:00:10 UTC while svett was in the background.",
    });
  });

  it("passes when it arrived before this launch, while svett was closed", () => {
    expect(notificationOutcome({ kind: "arrived", at: s(10) }, [], s(30))).toEqual({
      status: "passed",
      detail: "Arrived at 15:00:10 UTC while svett was closed.",
    });
  });

  it("reads back the pending notification saved before a restart", () => {
    const pending = { id: "abc", dueAt: s(10) };
    expect(decodePendingNotification(encodePendingNotification(pending))).toEqual(pending);
    expect(decodePendingNotification(null)).toBeUndefined();
    expect(decodePendingNotification('{"id":1}')).toBeUndefined();
  });

  it("reads an Android date, which Expo gives in milliseconds, unchanged", () => {
    expect(notificationDateMs(s(10))).toBe(s(10));
  });

  it("fails when notifications are off or it never showed", () => {
    expect(notificationOutcome({ kind: "denied" }, [], s(0)).status).toBe("failed");
    expect(notificationOutcome({ kind: "missing", dueAt: s(10) }, away, s(0)).status).toBe(
      "failed",
    );
  });
});

const recording = (points: number[]) =>
  ({ kind: "recording", startedAt: s(0), access: "always", points }) as const;
const everySecond = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => s(from + i));

describe("locationOutcome", () => {
  it("passes when points kept arriving through a lock of a minute or more", () => {
    const outcome = locationOutcome(recording(everySecond(0, 70)), [{ from: s(5), to: s(75) }]);
    expect(outcome).toEqual({
      status: "passed",
      detail:
        "66 points arrived while locked for 70 s. The last was 5 s before unlocking. Location access: always.",
    });
  });

  it("fails when points stopped soon after the lock", () => {
    const outcome = locationOutcome(recording(everySecond(0, 20)), [{ from: s(5), to: s(75) }]);
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("16 points arrived");
  });

  it("fails when no point arrived while locked", () => {
    expect(locationOutcome(recording([s(1)]), [{ from: s(5), to: s(75) }]).status).toBe("failed");
  });

  it("waits while the phone has not been locked long enough", () => {
    expect(locationOutcome(recording(everySecond(0, 30)), []).status).toBe("waiting");
    expect(locationOutcome(recording(everySecond(0, 30)), [{ from: s(5), to: s(30) }])).toEqual({
      status: "waiting",
      detail: "Locked for only 25 s. Lock it again for at least a minute. Location access: always.",
    });
  });

  it("judges the first lock of a minute or more since recording started", () => {
    const away = [
      { from: s(-100), to: s(-10) },
      { from: s(5), to: s(10) },
      { from: s(20), to: s(85) },
    ];
    expect(locationOutcome(recording(everySecond(0, 90)), away).status).toBe("passed");
  });

  it("keeps its outcome when the phone is locked again after recording stopped", () => {
    const first = [{ from: s(5), to: s(75) }];
    const outcome = locationOutcome(recording(everySecond(0, 75)), first);
    const later = [...first, { from: s(100), to: s(300) }];
    expect(locationOutcome(recording(everySecond(0, 75)), later)).toEqual(outcome);
  });

  it("ignores a lock that is still going on", () => {
    expect(locationOutcome(recording(everySecond(0, 90)), [{ from: s(5) }]).status).toBe("waiting");
  });

  it("fails when location is denied or recording cannot start", () => {
    expect(locationOutcome({ kind: "denied" }, []).status).toBe("failed");
    expect(locationOutcome({ kind: "error", message: "no" }, []).status).toBe("failed");
  });
});

const read = (workouts: number) => ({ kind: "read", workouts }) as const;
const signed = (access: WorkoutAccess) => healthOutcome({ entitlement: true, access });

describe("healthOutcome", () => {
  it("passes only with the entitlement, a granted request and a readable workout", () => {
    expect(signed(read(3))).toEqual({
      status: "passed",
      detail:
        "Asked to read workouts. Workouts readable: 3. The HealthKit entitlement is in the app.",
    });
  });

  it("is inconclusive with no readable workouts and says how to verify", () => {
    expect(signed(read(0))).toEqual({
      status: "inconclusive",
      detail:
        "Asked to read workouts. Workouts readable: 0. iOS also reads none when reading is not allowed. Add one workout in the Health app, or open Health > Sharing > Apps > svett to see the read permission, then run the check again.",
    });
  });

  it("is inconclusive when the entitlements cannot be read", () => {
    expect(healthOutcome({ entitlement: null, access: read(3) })).toEqual({
      status: "inconclusive",
      detail:
        "Asked to read workouts. Workouts readable: 3. The app's entitlements could not be read. So the HealthKit entitlement is not confirmed.",
    });
  });

  it("fails with the reason when the workout query fails", () => {
    expect(signed({ kind: "query failed", reason: "Protected data is unavailable." })).toEqual({
      status: "failed",
      detail:
        "Asked to read workouts, but reading them failed: Protected data is unavailable. The HealthKit entitlement is in the app.",
    });
    expect(
      healthOutcome({ entitlement: null, access: { kind: "query failed", reason: "No." } }).status,
    ).toBe("failed");
  });

  it("fails without the entitlement, when Health refuses, or without Health", () => {
    expect(healthOutcome({ entitlement: false, access: read(3) })).toEqual({
      status: "failed",
      detail: "The HealthKit entitlement is missing from the app.",
    });
    expect(signed({ kind: "refused", reason: "Missing entitlement" })).toEqual({
      status: "failed",
      detail: "Apple Health refused: Missing entitlement The HealthKit entitlement is in the app.",
    });
    expect(signed({ kind: "unavailable" }).status).toBe("failed");
  });
});

describe("chatGPTOutcome", () => {
  it("passes with the granted scope and says whether plan usage was granted", () => {
    expect(
      chatGPTOutcome({
        kind: "signed in",
        scope: "openid email chatgpt.tokens.use.direct",
        earlier: false,
      }),
    ).toEqual({
      status: "passed",
      detail:
        "Signed in. Granted scope: openid email chatgpt.tokens.use.direct. Plan usage (chatgpt.tokens.use.direct): granted.",
    });
    const without = chatGPTOutcome({ kind: "signed in", scope: "openid email", earlier: true });
    expect(without.detail).toBe(
      "Signed in on an earlier launch. Granted scope: openid email. Plan usage (chatgpt.tokens.use.direct): not granted.",
    );
  });

  it("does not take a longer scope name for plan usage", () => {
    const outcome = chatGPTOutcome({
      kind: "signed in",
      scope: "chatgpt.tokens.use.direct.preview",
      earlier: false,
    });
    expect(outcome.detail).toContain("not granted");
  });

  it("fails with the sign-in problem", () => {
    expect(chatGPTOutcome({ kind: "failed", problem: "Try again." })).toEqual({
      status: "failed",
      detail: "Try again.",
    });
  });
});

describe("parseCount", () => {
  it.each([
    ["3", 3],
    [" 10 ", 10],
    ["0", 0],
    ["", undefined],
    ["-1", undefined],
    ["2.5", undefined],
    ["three", undefined],
  ])("reads %j as %s", (text, expected) => {
    expect(parseCount(text)).toBe(expected);
  });
});

describe("formatReport", () => {
  const outcomes: Record<CheckName, CheckOutcome> = {
    keychain: { status: "passed", detail: "Read back the value." },
    notification: NOT_RUN,
    location: { status: "waiting", detail: "Recording." },
    health: { status: "inconclusive", detail: "Workouts readable: 0." },
    chatgpt: NOT_RUN,
  };

  it("prints the app, the phone, the AltStore counts and every check in order", () => {
    expect(
      formatReport({
        createdAt: s(0),
        appVersion: "0.1.42",
        appBuild: "42",
        iosVersion: "27.1",
        altStoreAppIds: 4,
        altStoreActiveApps: undefined,
        entitlements: ["com.apple.developer.healthkit", "get-task-allow"],
        outcomes,
      }),
    ).toBe(
      [
        "svett phone checks",
        "Created: 2026-11-13T15:00:00.000Z",
        "App: 0.1.42 (42)",
        "iOS: 27.1",
        "AltStore App IDs: 4",
        "AltStore active apps: not entered",
        "Entitlements: com.apple.developer.healthkit, get-task-allow",
        "",
        "Keychain after restart: PASSED. Read back the value.",
        "Notification in the background: NOT RUN",
        "GPS with the screen locked: WAITING. Recording.",
        "Apple Health permission: INCONCLUSIVE. Workouts readable: 0.",
        "ChatGPT sign-in: NOT RUN",
        "",
      ].join("\n"),
    );
  });

  it("says when the entitlements are empty or unreadable", () => {
    const base = {
      createdAt: s(0),
      appVersion: "0.1.0",
      appBuild: "0",
      iosVersion: "27.0",
      altStoreAppIds: undefined,
      altStoreActiveApps: undefined,
      outcomes,
    };
    expect(formatReport({ ...base, entitlements: [] })).toContain("Entitlements: none\n");
    expect(formatReport({ ...base, entitlements: null })).toContain(
      "Entitlements: could not be read\n",
    );
  });
});

function saved(outcome: StoredOutcome["outcome"], launchedAt: number): StoredOutcome {
  const stored = decodeStoredOutcome(encodeStoredOutcome({ outcome, launchedAt }));
  if (stored === undefined) throw new Error("the saved outcome did not read back");
  return stored;
}

describe("saved outcomes across a restart", () => {
  const launchA = s(0);
  const launchB = s(120);
  const nothingLive: Record<CheckName, CheckOutcome> = {
    keychain: NOT_RUN,
    notification: NOT_RUN,
    location: NOT_RUN,
    health: NOT_RUN,
    chatgpt: NOT_RUN,
  };
  const report = (outcomes: Record<CheckName, CheckOutcome>) =>
    formatReport({
      createdAt: launchB,
      appVersion: "0.1.42",
      appBuild: "42",
      iosVersion: "27.2",
      altStoreAppIds: undefined,
      altStoreActiveApps: undefined,
      entitlements: [],
      outcomes,
    });

  it("reports the Keychain and a background notification as PASSED after svett restarts", () => {
    const stored = {
      keychain: saved(keychainOutcome({ kind: "read", stored: null }, launchA), launchA),
      notification: saved(
        notificationOutcome({ kind: "arrived", at: s(20) }, [{ from: s(5), to: s(60) }], launchA),
        launchA,
      ),
    };
    const live = {
      ...nothingLive,
      keychain: keychainOutcome({ kind: "read", stored: encodeKeychainMark(launchA) }, launchB),
    };
    const text = report(mergeOutcomes(live, stored, launchB));
    expect(text).toContain(
      "Keychain after restart: PASSED. Read back the value saved by the launch at 15:00:00 UTC.\n",
    );
    expect(text).toContain(
      "Notification in the background: PASSED. Arrived at 15:00:20 UTC while svett was in the background.\n",
    );
    expect(text).toContain("Apple Health permission: NOT RUN\n");
  });

  it("keeps a reload of the same launch waiting for a real restart", () => {
    const live = {
      ...nothingLive,
      keychain: keychainOutcome({ kind: "read", stored: encodeKeychainMark(launchA) }, launchA),
    };
    expect(report(mergeOutcomes(live, {}, launchA))).toContain("Keychain after restart: WAITING.");
  });

  it("shows this launch's outcome over a saved one", () => {
    const stored = saved({ status: "passed", detail: "Arrived." }, launchA);
    const live = { status: "waiting", detail: "Due soon." } as const;
    expect(mergeOutcome(live, stored, launchB)).toEqual(live);
  });

  it("keeps a saved waiting outcome within its own launch", () => {
    const outcome = { status: "waiting", detail: "Recording." } as const;
    expect(mergeOutcome(NOT_RUN, saved(outcome, launchA), launchA)).toEqual(outcome);
  });

  it("asks to run again a check that was still waiting when svett closed", () => {
    const stored = saved({ status: "waiting", detail: "Recording." }, launchA);
    expect(mergeOutcome(NOT_RUN, stored, launchB)).toEqual({
      status: "waiting",
      detail: "svett closed before this check finished. Run it again.",
    });
  });

  it("treats a missing or unreadable saved outcome as not run", () => {
    expect(decodeStoredOutcome(null)).toBeUndefined();
    expect(decodeStoredOutcome("{")).toBeUndefined();
    expect(
      decodeStoredOutcome(JSON.stringify({ outcome: { status: "not run" }, launchedAt: launchA })),
    ).toBeUndefined();
    expect(mergeOutcome(NOT_RUN, undefined, launchB)).toEqual(NOT_RUN);
  });
});
