import { Schema } from "effect";

export type CheckName = "keychain" | "notification" | "location" | "health" | "chatgpt";

export type CheckOutcome =
  | { readonly status: "not run" }
  | {
      readonly status: "waiting" | "passed" | "failed" | "inconclusive";
      readonly detail: string;
    };

export const NOT_RUN: CheckOutcome = { status: "not run" };

const waiting = (detail: string): CheckOutcome => ({ status: "waiting", detail });
const passed = (detail: string): CheckOutcome => ({ status: "passed", detail });
const failed = (detail: string): CheckOutcome => ({ status: "failed", detail });
const inconclusive = (detail: string): CheckOutcome => ({ status: "inconclusive", detail });

export interface CheckInfo {
  readonly name: CheckName;
  readonly title: string;
  readonly steps: string;
}

export const PHONE_CHECKS: ReadonlyArray<CheckInfo> = [
  {
    name: "keychain",
    title: "Keychain after restart",
    steps:
      "Opening this screen saves a value in the Keychain. Close svett in the app switcher, open it again, and come back here.",
  },
  {
    name: "notification",
    title: "Notification in the background",
    steps:
      "Tap Run, then lock the phone or go to the home screen. A notification shows after 10 seconds. Come back after it shows.",
  },
  {
    name: "location",
    title: "GPS with the screen locked",
    steps:
      "Tap Run and allow location. Lock the phone for at least a minute, then unlock it and come back.",
  },
  {
    name: "health",
    title: "Apple Health permission",
    steps: "Tap Run and answer the Apple Health sheet.",
  },
  {
    name: "chatgpt",
    title: "ChatGPT sign-in",
    steps:
      "Tap Run and sign in with ChatGPT. If the sheet does not come back, try Safari and paste the address Safari could not open.",
  },
];

/** A stretch of time when svett was not on screen. `to` is missing while it lasts. */
export interface AwayWindow {
  readonly from: number;
  readonly to?: number;
}

const clock = (time: number): string => `${new Date(time).toISOString().slice(11, 19)} UTC`;
const seconds = (ms: number): number => Math.round(ms / 1000);

const finishedAwayWindows = (away: ReadonlyArray<AwayWindow>, after: number) =>
  away.flatMap((w) => (w.to !== undefined && w.from >= after ? [{ from: w.from, to: w.to }] : []));

const wasAway = (away: ReadonlyArray<AwayWindow>, time: number): boolean =>
  away.some((w) => w.from <= time && (w.to === undefined || time <= w.to));

// The Keychain check stores the launch that wrote it, so the next launch can tell
// its own value from one that survived a restart.
const KeychainMark = Schema.Struct({ launchedAt: Schema.Number });
const decodeKeychainMark = Schema.decodeUnknownSync(KeychainMark);

export const encodeKeychainMark = (launchedAt: number): string => JSON.stringify({ launchedAt });

export type KeychainRead =
  | { readonly kind: "read"; readonly stored: string | null }
  | { readonly kind: "error"; readonly message: string };

export function keychainOutcome(read: KeychainRead, launchedAt: number): CheckOutcome {
  if (read.kind === "error") return failed(`The Keychain refused: ${read.message}`);
  if (read.stored === null) {
    return waiting("Saved a value. Close svett in the app switcher and open it again.");
  }
  let mark: typeof KeychainMark.Type;
  try {
    mark = decodeKeychainMark(JSON.parse(read.stored));
  } catch {
    return failed("The Keychain held a value svett cannot read.");
  }
  if (mark.launchedAt === launchedAt) {
    return waiting("The value was saved during this launch. Close svett and open it again.");
  }
  return passed(`Read back the value saved by the launch at ${clock(mark.launchedAt)}.`);
}

export type NotificationObservation =
  | { readonly kind: "denied" }
  | { readonly kind: "scheduled"; readonly dueAt: number }
  | { readonly kind: "arrived"; readonly at: number }
  | { readonly kind: "missing"; readonly dueAt: number };

// Expo's `Notification.date` is seconds on iOS (UNNotification.date.timeIntervalSince1970) and
// milliseconds on Android. Below 1e11 it can only be seconds: as milliseconds it would be 1973.
export const notificationDateMs = (date: number): number => (date < 1e11 ? date * 1000 : date);

export function notificationOutcome(
  observation: NotificationObservation,
  away: ReadonlyArray<AwayWindow>,
): CheckOutcome {
  switch (observation.kind) {
    case "denied":
      return failed("Notifications are off for svett. Turn them on in Settings and run it again.");
    case "scheduled":
      return waiting(
        `Due at ${clock(observation.dueAt)}. Lock the phone or go to the home screen now.`,
      );
    case "arrived":
      return wasAway(away, observation.at)
        ? passed(`Arrived at ${clock(observation.at)} while svett was in the background.`)
        : waiting(
            `Arrived at ${clock(observation.at)} while svett was open. Run it again and leave svett before it is due.`,
          );
    case "missing":
      return failed(
        `Due at ${clock(observation.dueAt)} and not delivered. If you swiped it away, run it again.`,
      );
  }
}

/** Locking for less than this does not show that recording survives the lock. */
export const LOCKED_LONG_ENOUGH_MS = 60_000;
/** A point this long after the lock shows recording went on, not just one last fix. */
const STILL_RECORDING_AFTER_MS = 30_000;

export type LocationObservation =
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "recording";
      readonly startedAt: number;
      readonly access: "always" | "while using";
      /** When each location was measured. */
      readonly points: ReadonlyArray<number>;
    };

export function locationOutcome(
  observation: LocationObservation,
  away: ReadonlyArray<AwayWindow>,
): CheckOutcome {
  if (observation.kind === "denied") {
    return failed("Location is off for svett. Allow it in Settings and run it again.");
  }
  if (observation.kind === "error")
    return failed(`Recording did not start: ${observation.message}`);
  const access = `Location access: ${observation.access}.`;
  // The first lock long enough decides, so locking again after recording stopped changes nothing.
  const locks = finishedAwayWindows(away, observation.startedAt);
  const judged = locks.find((lock) => lock.to - lock.from >= LOCKED_LONG_ENOUGH_MS);
  if (judged === undefined) {
    const last = locks.at(-1);
    return last === undefined
      ? waiting(
          `Recording, ${observation.points.length} points so far. Lock the phone for a minute, then come back. ${access}`,
        )
      : waiting(
          `Locked for only ${seconds(last.to - last.from)} s. Lock it again for at least a minute. ${access}`,
        );
  }
  const lockedFor = judged.to - judged.from;
  const whileLocked = observation.points.filter((t) => judged.from <= t && t <= judged.to);
  const latest = whileLocked.at(-1);
  const summary = `${whileLocked.length} points arrived while locked for ${seconds(lockedFor)} s.`;
  if (latest === undefined || latest - judged.from < STILL_RECORDING_AFTER_MS) {
    return failed(`${summary} None came after the first 30 s. ${access}`);
  }
  return passed(
    `${summary} The last was ${seconds(judged.to - latest)} s before unlocking. ${access}`,
  );
}

/** What the app learned from asking Apple Health to read workouts. */
export type WorkoutAccess =
  | { readonly kind: "unavailable" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "query failed"; readonly reason: string }
  /** iOS also reads none when reading was not allowed. */
  | { readonly kind: "read"; readonly workouts: number };

export interface HealthObservation {
  /** Whether the running app's signature carries the HealthKit entitlement, when it can be read. */
  readonly entitlement: boolean | null;
  readonly access: WorkoutAccess;
}

const VERIFY_HEALTH =
  "Add one workout in the Health app, or open Health > Sharing > Apps > svett to see the read permission, then run the check again.";

export function healthOutcome({ entitlement, access }: HealthObservation): CheckOutcome {
  if (access.kind === "unavailable") return failed("Apple Health is not available on this device.");
  const signed =
    entitlement === null
      ? "The app's entitlements could not be read."
      : entitlement
        ? "The HealthKit entitlement is in the app."
        : "The HealthKit entitlement is missing from the app.";
  if (access.kind === "refused") return failed(`Apple Health refused: ${access.reason} ${signed}`);
  if (entitlement === false) return failed(signed);
  if (access.kind === "query failed") {
    return failed(`Asked to read workouts, but reading them failed: ${access.reason} ${signed}`);
  }
  const read = `Asked to read workouts. Workouts readable: ${access.workouts}.`;
  if (entitlement === null) {
    return inconclusive(`${read} ${signed} So the HealthKit entitlement is not confirmed.`);
  }
  if (access.workouts === 0) {
    return inconclusive(
      `${read} iOS also reads none when reading is not allowed. ${VERIFY_HEALTH}`,
    );
  }
  return passed(`${read} ${signed}`);
}

export const PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";

export type ChatGPTObservation =
  | { readonly kind: "signing in" }
  | { readonly kind: "signed in"; readonly scope: string; readonly earlier: boolean }
  | { readonly kind: "failed"; readonly problem: string };

export function chatGPTOutcome(observation: ChatGPTObservation): CheckOutcome {
  switch (observation.kind) {
    case "signing in":
      return waiting("Signing in.");
    case "failed":
      return failed(observation.problem);
    case "signed in": {
      const planUsage = observation.scope.split(" ").includes(PLAN_USAGE_SCOPE);
      const when = observation.earlier ? "Signed in on an earlier launch." : "Signed in.";
      return passed(
        `${when} Granted scope: ${observation.scope || "none"}. Plan usage (${PLAN_USAGE_SCOPE}): ${planUsage ? "granted" : "not granted"}.`,
      );
    }
  }
}

/** Reads a count typed by the user, or undefined when it is not a whole number. */
export function parseCount(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : undefined;
}

export interface PhoneReport {
  readonly createdAt: number;
  readonly appVersion: string;
  readonly appBuild: string;
  readonly iosVersion: string;
  readonly altStoreAppIds: number | undefined;
  readonly altStoreActiveApps: number | undefined;
  /** The entitlements in the running app's signature, or null when they cannot be read. */
  readonly entitlements: ReadonlyArray<string> | null;
  readonly outcomes: Readonly<Record<CheckName, CheckOutcome>>;
}

const STATUS_LABEL: Record<CheckOutcome["status"], string> = {
  "not run": "NOT RUN",
  waiting: "WAITING",
  passed: "PASSED",
  failed: "FAILED",
  inconclusive: "INCONCLUSIVE",
};

export const statusLabel = (outcome: CheckOutcome): string => STATUS_LABEL[outcome.status];

const count = (value: number | undefined) => (value === undefined ? "not entered" : value);

export function formatReport(report: PhoneReport): string {
  const entitlements =
    report.entitlements === null
      ? "could not be read"
      : report.entitlements.length === 0
        ? "none"
        : report.entitlements.join(", ");
  const checks = PHONE_CHECKS.map(({ name, title }) => {
    const outcome = report.outcomes[name];
    const label = `${title}: ${statusLabel(outcome)}`;
    return outcome.status === "not run" ? label : `${label}. ${outcome.detail}`;
  });
  return [
    "svett phone checks",
    `Created: ${new Date(report.createdAt).toISOString()}`,
    `App: ${report.appVersion} (${report.appBuild})`,
    `iOS: ${report.iosVersion}`,
    `AltStore App IDs: ${count(report.altStoreAppIds)}`,
    `AltStore active apps: ${count(report.altStoreActiveApps)}`,
    `Entitlements: ${entitlements}`,
    "",
    ...checks,
    "",
  ].join("\n");
}
