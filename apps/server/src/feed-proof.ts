/**
 * Proves on a running svett server that two accounts find each other by username and follow
 * each other, that a lifting session and a run each show their own detail in the other's feed,
 * and that a hidden field appears in no feed, post or inbox answer.
 *
 * Against the live server, with a Clerk development instance's secret key:
 *
 *   CLERK_SECRET_KEY=sk_test_... node apps/server/src/feed-proof.ts
 *
 * SVETT_SERVER, SVETT_PROOF_EMAILS and SVETT_PROOF_USERNAMES work as in social-proof.ts, with
 * the lifter first and the runner second. It leaves both accounts as it found them, unless
 * SVETT_PROOF_KEEP=1 asks it to keep both posts, their like and comments, and the follows,
 * for scripts/sim/feed.sh to show. It prints both posts' svett:// links either way.
 */
import { libraryExerciseId } from "@svett/core";

import { clerkTokens, type ProofAccount } from "./social-proof.ts";

export interface FeedProofOptions {
  /** Such as https://svett-app.jservers.net, with no trailing slash. */
  readonly server: string;
  /** A fresh session token. The owner account lifts and the follower runs. */
  readonly token: (account: ProofAccount) => Promise<string>;
  readonly usernames: { readonly owner: string; readonly follower: string };
  readonly log: (line: string) => void;
  readonly keep?: boolean;
  readonly now?: () => number;
}

class ProofFailed extends Error {}

const other = (as: ProofAccount): ProofAccount => (as === "owner" ? "follower" : "owner");

const expect = (holds: boolean, message: string) => {
  if (!holds) throw new ProofFailed(message);
};

// Fixed IDs, so a kept run of the proof shows the same posts each time.
export const PROOF_LIFTING_ID = "0196f000-5e4f-7000-8000-00000000f001";
export const PROOF_RUN_ID = "0196f000-5e4f-7000-8000-00000000f002";
export const PROOF_LIFTING_TITLE = "Feed proof, legs and bench";
export const PROOF_RUN_TITLE = "Feed proof, river loop";
const id = (n: number) => `0196f000-5e4f-7000-8000-${String(n).padStart(12, "0")}`;

/** A hidden calorie count no other number in an answer could contain. */
export const PROOF_HIDDEN_KCAL = 987.25;
/** The run's heart rate, hidden from everyone but its owner. */
export const PROOF_HIDDEN_BPM = 171;
const HIDE_M = 200;
const RUN_POINTS = 41;
const RUN_STEP_DEGREES = 0.001;
const RUN_START = { latitude: 59.95, longitude: 10.75 };

type Row = { readonly table: string; readonly row: Record<string, unknown> };

const rowOf =
  (updatedAt: number) =>
  (table: string, fields: Record<string, unknown>): Row => ({
    table,
    row: Object.assign({ updatedAt, deletedAt: null }, fields),
  });

const activityFields = {
  notes: "",
  audience: "followers",
  source: "svett",
  sourceId: null,
  fingerprint: null,
  importBatchId: null,
};

const LIFTS = [
  {
    n: 11,
    name: "Barbell_Squat",
    sets: [
      [60, 8, "warm_up"],
      [100, 5],
      [100, 5],
      [100, 5],
    ],
  },
  {
    n: 12,
    name: "Barbell_Bench_Press_-_Medium_Grip",
    sets: [
      [80, 8],
      [80, 7],
    ],
  },
] as const;

/** A lifting session: squats and bench press, with its calories hidden, for followers. */
export const liftingRows = (startedAt: number, updatedAt: number): ReadonlyArray<Row> => {
  const row = rowOf(updatedAt);
  const rows = [
    row("activity", {
      ...activityFields,
      id: PROOF_LIFTING_ID,
      kind: "strength",
      startedAt,
      durationS: 3300,
      title: PROOF_LIFTING_TITLE,
      energyKcal: PROOF_HIDDEN_KCAL,
      hiddenFields: JSON.stringify(["calories"]),
    }),
  ];
  for (const [position, lift] of LIFTS.entries()) {
    rows.push(
      row("activity_exercise", {
        id: id(lift.n),
        activityId: PROOF_LIFTING_ID,
        exerciseId: libraryExerciseId(lift.name),
        position,
        supersetGroup: null,
        notes: "",
      }),
    );
    for (const [index, [weightKg, reps, setType]] of lift.sets.entries()) {
      rows.push(
        row("activity_set", {
          id: id(lift.n * 10 + index),
          activityExerciseId: id(lift.n),
          position: index,
          setType: setType ?? "normal",
          weightKg,
          reps,
          durationS: null,
          distanceM: null,
          rpe: null,
        }),
      );
    }
  }
  return rows;
};

/** The run's positions, due north in steps of about 111 m. */
export const runPositions = () =>
  Array.from({ length: RUN_POINTS }, (_, index) => ({
    latitude: Math.round((RUN_START.latitude + index * RUN_STEP_DEGREES) * 1e6) / 1e6,
    longitude: RUN_START.longitude,
  }));

/**
 * A run with a route, splits and heart rate, its start time and heart rate hidden, for
 * followers. `activity` changes the activity row's fields.
 */
export const runRows = (
  startedAt: number,
  updatedAt: number,
  activity: Record<string, unknown> = {},
): ReadonlyArray<Row> => {
  const row = rowOf(updatedAt);
  const trackId = id(21);
  const sample = (n: number, recordedAt: number, fields: Record<string, unknown>) =>
    row("activity_sample", { id: id(n), activityTrackId: trackId, recordedAt, ...fields });
  return [
    row("activity", {
      ...activityFields,
      id: PROOF_RUN_ID,
      kind: "run",
      startedAt,
      durationS: 1500,
      title: PROOF_RUN_TITLE,
      energyKcal: 380,
      hiddenFields: JSON.stringify(["start_time", "heart_rate"]),
      ...activity,
    }),
    row("activity_track", {
      id: trackId,
      activityId: PROOF_RUN_ID,
      distanceM: 4440,
      elevationGainM: 18,
      hideStartM: HIDE_M,
      hideEndM: HIDE_M,
    }),
    ...runPositions().map((point, index) =>
      sample(1000 + index, startedAt + index * 36_000, {
        kind: "location",
        latitude: point.latitude,
        longitude: point.longitude,
        altitudeM: 10,
      }),
    ),
    ...[0, 1, 2].map((index) =>
      sample(2000 + index, startedAt + index * 500_000, {
        kind: "heart_rate",
        bpm: PROOF_HIDDEN_BPM,
      }),
    ),
    ...[330, 335, 340, 345].map((durationS, index) =>
      sample(3000 + index, startedAt + (index + 1) * 340_000, {
        kind: "split",
        distanceM: 1000,
        durationS,
      }),
    ),
  ];
};

const metresBetween = (
  a: { readonly latitude: number; readonly longitude: number },
  b: { readonly latitude: number; readonly longitude: number },
) => {
  const rad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * rad * Math.cos(((a.latitude + b.latitude) / 2) * rad);
  const y = (b.latitude - a.latitude) * rad;
  return Math.sqrt(x * x + y * y) * 6_371_008.8;
};

type Json = Record<string, unknown>;
type FeedPost = {
  readonly username: string;
  readonly activity: { readonly id: string; readonly startedAt: number | null } & Json;
  readonly detail: Json | null;
};

/** Runs the proof, and throws with what went wrong when any step does not hold. */
export const feedProof = async (options: FeedProofOptions) => {
  const now = options.now ?? Date.now;
  const call = async (as: ProofAccount, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${options.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await options.token(as)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text || "null") as unknown };
  };
  const ok = async (as: ProofAccount, method: string, path: string, body?: unknown) => {
    const answer = await call(as, method, path, body);
    expect(
      answer.status === 200,
      `${method} ${path} as the ${as} answered ${answer.status}: ${answer.text}`,
    );
    return answer;
  };

  const { owner: lifter, follower: runner } = options.usernames;
  const nameOf = (as: ProofAccount) => (as === "owner" ? lifter : runner);

  await ok("owner", "PUT", "/v1/profile", { username: lifter, private: true });
  await ok("follower", "PUT", "/v1/profile", { username: runner, private: true });
  // An earlier run that stopped half way may have left follows in place.
  await ok("owner", "DELETE", `/v1/profiles/${runner}/follow`);
  await ok("follower", "DELETE", `/v1/profiles/${lifter}/follow`);
  options.log(`${lifter} and ${runner} have private profiles and follow nobody`);

  const hour = now() - 3_600_000;
  const lifting = liftingRows(hour, now());
  const run = runRows(hour + 600_000, now());
  const runStart = String(hour + 600_000);
  let done = false;

  /** `as` finds the other account by the start of its username, and the other approves the follow. */
  const meet = async (as: ProofAccount) => {
    const prefix = nameOf(other(as)).slice(0, 4);
    const found = (await ok(as, "GET", `/v1/profiles?prefix=${prefix}`)).body as {
      readonly profiles: ReadonlyArray<{ readonly username: string }>;
    };
    expect(
      found.profiles.some(({ username }) => username === nameOf(other(as))),
      `Searching ${prefix} as ${nameOf(as)} did not find ${nameOf(other(as))}`,
    );
    const asked = (await ok(as, "PUT", `/v1/profiles/${nameOf(other(as))}/follow`)).body as {
      readonly follow: string;
    };
    expect(asked.follow === "requested", `Following a private profile gave ${asked.follow}`);
    const inbox = (await ok(other(as), "GET", "/v1/inbox")).body as {
      readonly items: ReadonlyArray<{ readonly kind: string; readonly username: string }>;
    };
    expect(
      inbox.items.some((item) => item.kind === "follow_request" && item.username === nameOf(as)),
      `${nameOf(other(as))}'s inbox has no follow request from ${nameOf(as)}`,
    );
    const waiting = (await ok(other(as), "GET", "/v1/follow-requests")).body as {
      readonly requests: ReadonlyArray<{ readonly id: string; readonly username: string }>;
    };
    const request = waiting.requests.find(({ username }) => username === nameOf(as));
    expect(request !== undefined, `${nameOf(other(as))}'s requests do not list ${nameOf(as)}`);
    await ok(other(as), "PUT", `/v1/follow-requests/${encodeURIComponent(request?.id ?? "")}`);
    options.log(
      `${nameOf(as)} found ${nameOf(other(as))} by username, and the follow was approved`,
    );
  };

  try {
    await meet("owner");
    await meet("follower");

    await ok("owner", "PUT", "/v1/rows", { rows: lifting });
    await ok("follower", "PUT", "/v1/rows", { rows: run });
    options.log(`${lifter} wrote a lifting session and ${runner} a run, both for followers`);

    const feedOf = async (as: ProofAccount) => {
      const answer = await ok(as, "GET", "/v1/feed");
      return {
        text: answer.text,
        posts: (answer.body as { readonly posts: ReadonlyArray<FeedPost> }).posts,
      };
    };

    const runnerFeed = await feedOf("follower");
    const liftPost = runnerFeed.posts.find((post) => post.activity.title === PROOF_LIFTING_TITLE);
    expect(liftPost !== undefined, `${runner}'s feed has no lifting post from ${lifter}`);
    const lift = liftPost?.detail as {
      readonly type: string;
      readonly exercises: ReadonlyArray<{
        readonly name: string;
        readonly sets: ReadonlyArray<Json>;
      }>;
      readonly split: ReadonlyArray<{ readonly muscle: string }>;
    };
    expect(lift?.type === "lifting", `The lifting post's detail is ${JSON.stringify(lift)}`);
    expect(
      lift.exercises.map(({ name }) => name).join(", ") ===
        "Barbell Squat, Barbell Bench Press - Medium Grip" &&
        lift.exercises.map(({ sets }) => sets.length).join(",") === "4,2",
      `The lifting post's exercises are ${JSON.stringify(lift.exercises)}`,
    );
    expect(
      lift.split.map(({ muscle }) => muscle).join(",") === "quadriceps,chest",
      `The lifting post's muscle split is ${JSON.stringify(lift.split)}`,
    );
    expect(liftPost?.activity.energyKcal === null, "The lifting post carries its hidden calories");
    options.log(
      `${runner}'s feed shows ${lifter}'s lifting session with its sets and muscle split`,
    );

    const lifterFeed = await feedOf("owner");
    const runPost = lifterFeed.posts.find((post) => post.activity.title === PROOF_RUN_TITLE);
    expect(runPost !== undefined, `${lifter}'s feed has no run from ${runner}`);
    const route = runPost?.detail as {
      readonly type: string;
      readonly distanceM: number;
      readonly paceSPerKm: number | null;
      readonly splits: ReadonlyArray<{ readonly durationS: number | null }>;
      readonly route: ReadonlyArray<ReadonlyArray<{ latitude: number; longitude: number }>>;
      readonly averageHeartRateBpm: number | null;
    };
    expect(route?.type === "route", `The run's detail is ${JSON.stringify(route)}`);
    expect(route.distanceM === 4440, `The run's distance is ${route.distanceM}`);
    expect(
      route.paceSPerKm !== null && Math.round(route.paceSPerKm) === 338,
      `The run's pace is ${route.paceSPerKm}`,
    );
    expect(
      route.splits.map(({ durationS }) => durationS).join(",") === "330,335,340,345",
      `The run's splits are ${JSON.stringify(route.splits)}`,
    );
    const positions = route.route.flat();
    const [first, last] = [runPositions()[0]!, runPositions().at(-1)!];
    expect(positions.length > 0, "The run's route is empty");
    expect(
      positions.every(
        (point) => metresBetween(point, first) > HIDE_M && metresBetween(point, last) > HIDE_M,
      ),
      "The run's route shows a position inside its hidden start or end",
    );
    expect(route.averageHeartRateBpm === null, "The run carries its hidden heart rate");
    expect(runPost?.activity.startedAt === null, "The run carries its hidden start time");
    options.log(
      `${lifter}'s feed shows ${runner}'s run with distance, pace, splits and a route without its ends`,
    );

    const liftAt = `/v1/posts/${liftPost?.activity.id}`;
    const runAt = `/v1/posts/${runPost?.activity.id}`;
    await ok("follower", "PUT", `${liftAt}/like`);
    await ok("follower", "PUT", `${liftAt}/like`);
    await ok("owner", "POST", `${runAt}/comments`, {
      body: "Strong pace!",
    });
    await ok("follower", "POST", `${runAt}/comments`, {
      body: "Thanks, see you Sunday",
    });
    const liked = (await ok("owner", "GET", liftAt)).body as {
      readonly post: { readonly likes: number };
    };
    expect(liked.post.likes === 1, `Two likes from one account counted ${liked.post.likes}`);
    const lifterInbox = await ok("owner", "GET", "/v1/inbox");
    const items = (lifterInbox.body as { readonly items: ReadonlyArray<Json> }).items;
    expect(
      items.some((item) => item.kind === "like" && item.username === runner),
      `${lifter}'s inbox has no like from ${runner}`,
    );
    expect(
      items.some((item) => item.kind === "comment" && item.username === runner),
      `${lifter}'s inbox has no notification of ${runner}'s reply`,
    );
    options.log(`${lifter}'s inbox lists ${runner}'s like and the reply on ${runner}'s run`);

    const runThread = await ok("owner", "GET", runAt);
    const liftThread = await ok("follower", "GET", liftAt);
    const runnerInbox = await ok("follower", "GET", "/v1/inbox");
    for (const [where, text] of [
      [`${lifter}'s feed`, lifterFeed.text],
      [`the run as ${lifter} sees it`, runThread.text],
      [`${lifter}'s inbox`, lifterInbox.text],
    ] as const) {
      expect(!text.includes(runStart), `The run's hidden start time is in ${where}`);
      // A UUIDv7 holds the time it was made, so the run's own ID would give its start away.
      expect(!text.includes(PROOF_RUN_ID), `The run's own ID is in ${where}`);
      expect(!text.includes(`"bpm"`), `A heart rate reading is in ${where}`);
    }
    for (const [where, text] of [
      [`${runner}'s feed`, runnerFeed.text],
      [`the lifting session as ${runner} sees it`, liftThread.text],
      [`${runner}'s inbox`, runnerInbox.text],
    ] as const) {
      expect(!text.includes(String(PROOF_HIDDEN_KCAL)), `The hidden calories are in ${where}`);
    }
    options.log(
      "No hidden start time, calories or heart rate is in any feed, post or inbox answer",
    );
    options.log(`Lifting post: svett://post/${liftPost?.activity.id}`);
    options.log(`Run: svett://post/${runPost?.activity.id}`);
    done = true;
  } finally {
    if (!(options.keep && done)) {
      const later = now() + 1;
      const deleted = (rows: ReadonlyArray<Row>) =>
        rows.map(({ table, row }) => ({
          table,
          row: Object.assign({}, row, { updatedAt: later, deletedAt: later }),
        }));
      await ok("owner", "PUT", "/v1/rows", { rows: deleted(lifting) });
      await ok("follower", "PUT", "/v1/rows", { rows: deleted(run) });
      await ok("owner", "DELETE", `/v1/profiles/${runner}/follow`);
      await ok("follower", "DELETE", `/v1/profiles/${lifter}/follow`);
      options.log("Deleted the proof's posts and ended both follows");
    }
  }
};

const pair = (value: string | undefined, fallback: string) => {
  const [owner, follower] = (value ?? fallback).split(" ").filter(Boolean);
  if (owner === undefined || follower === undefined) {
    throw new ProofFailed(`Expected two values separated by a space, got: ${value}`);
  }
  return { owner, follower };
};

if (import.meta.main) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (secretKey === undefined || !secretKey.startsWith("sk_test_")) {
    console.error("Set CLERK_SECRET_KEY to a Clerk development instance's secret key.");
    process.exit(64);
  }
  const emails = pair(
    process.env.SVETT_PROOF_EMAILS,
    "svett-feed-a+clerk_test@example.com svett-feed-b+clerk_test@example.com",
  );
  feedProof({
    server: process.env.SVETT_SERVER ?? "https://svett-app.jservers.net",
    token: clerkTokens(secretKey, emails),
    usernames: pair(process.env.SVETT_PROOF_USERNAMES, "feed_proof_a feed_proof_b"),
    keep: process.env.SVETT_PROOF_KEEP === "1",
    log: (line) => console.log(line),
  }).then(
    () => console.log("The feed proof passed"),
    (error: unknown) => {
      console.error(`The feed proof failed. ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
