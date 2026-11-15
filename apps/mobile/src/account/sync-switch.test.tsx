import {
  AccountId,
  type ActivityDraft,
  ActivityRepository,
  databaseLayer,
  DurationSeconds,
  EpochMillis,
  Ids,
  libraryExerciseId,
  MADE_HERE,
  type AssistantProposal,
  ProposalRepository,
} from "@svett/core";
import { manualClock, openNodeDatabase } from "@svett/core/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { currentDatabase, signedOut } from "../data/current";
import { AccountProvider } from "./AccountProvider";
import { syncNow } from "./sync";

const app = vi.hoisted(() => ({
  databases: new Map<string, unknown>(),
  storage: new Map<string, string>(),
  auth: { isLoaded: true, userId: null as string | null },
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  Settings: { get: (key: string) => (key === "svettServer" ? "http://svett.test" : undefined) },
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => app.storage.get(key) ?? null,
    setItemSync: (key: string, value: string) => app.storage.set(key, value),
    removeItemSync: (key: string) => app.storage.delete(key),
  },
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { readonly children: unknown }) => children,
  useAuth: () => ({
    ...app.auth,
    getToken: async () => (app.auth.userId === null ? null : sessionToken(app.auth.userId)),
  }),
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("./config", () => ({ CLERK_PUBLISHABLE_KEY: "pk_test_svett" }));
vi.mock("./move", () => ({ resumeMove: async () => {}, finishLeavingAccount: async () => {} }));
// Each owner's file is an in-memory SQLite database that outlives its handles, as a file would.
vi.mock("../data/database", () => ({
  launchFixture: () => undefined,
  openDatabaseHandle: (target: { kind: string; owner?: { kind: string; accountId?: string } }) => ({
    target,
    runtime: app.databases.get(target.owner?.accountId ?? target.owner?.kind ?? target.kind),
    close: async () => {},
  }),
}));

const sessionToken = (userId: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub: userId })).toString("base64url")}.signature`;

const T0 = Date.UTC(2026, 10, 1, 9);
const ALICE = "user_alice";
const BOB = "user_bob";

type Runtime = ManagedRuntime.ManagedRuntime<ActivityRepository | ProposalRepository, unknown>;

const openDatabase = (seed: number): Runtime => {
  const { driver } = openNodeDatabase();
  return ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(seed)), manualClock(T0).layer),
  );
};

const workout = (title: string): ActivityDraft => ({
  kind: "strength",
  startedAt: EpochMillis.make(T0 - 86_400_000),
  durationS: DurationSeconds.make(3_000),
  title,
  notes: "",
  energyKcal: null,
  audience: "only_you",
  hiddenFields: [],
  origin: MADE_HERE,
  exercises: [
    {
      exerciseId: libraryExerciseId("Barbell_Squat"),
      supersetGroup: null,
      notes: "",
      sets: [
        { setType: "normal", weightKg: 100, reps: 5, durationS: null, distanceM: null, rpe: null },
      ],
    },
  ],
  track: null,
});

const logWorkout = (runtime: Runtime, title: string) =>
  runtime.runPromise(
    Effect.flatMap(Effect.service(ActivityRepository), (activities) =>
      activities.create(workout(title)),
    ),
  );

interface Request {
  readonly account: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const proposalFor = (id: string, title: string): AssistantProposal => ({
  id,
  from: "ChatGPT",
  createdAt: T0,
  plan: {
    kind: "routine",
    routine: {
      title,
      notes: "",
      exercises: [
        {
          exerciseId: libraryExerciseId("Barbell_Squat"),
          restS: null,
          notes: "",
          sets: [
            {
              setType: "normal",
              weightKg: 100,
              repsMin: 5,
              repsMax: 5,
              durationS: null,
              distanceM: null,
            },
          ],
        },
      ],
    },
  },
});

/**
 * A stand-in for the svett server that keeps each account's rows and proposals apart by the
 * session's account, as the real one does, and records every request a phone makes. `hold`
 * keeps one account's next row pull waiting until it is released.
 */
const standInServer = () => {
  const requests: Array<Request> = [];
  const rows = new Map<string, Array<{ table: string; row: unknown }>>();
  const proposals = new Map<string, Array<AssistantProposal>>();
  let held: { account: string; answer: Promise<void> } | undefined;
  const hold = (account: string) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    held = { account, answer: promise };
    return resolve;
  };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
    const account = (
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
        sub?: string;
      }
    ).sub;
    const body = typeof init?.body === "string" ? init.body : "";
    const path = new URL(String(url)).pathname;
    requests.push({ account, method: init?.method ?? "GET", path, body });
    const queue = proposals.get(account ?? "") ?? [];
    if (path === "/v1/assistant-proposals") return Response.json({ proposals: queue });
    if (path === "/v1/assistant-proposals/received") {
      const taken = (JSON.parse(body) as { ids: Array<string> }).ids;
      const left = queue.filter(({ id }) => !taken.includes(id));
      proposals.set(account ?? "", left);
      return Response.json({ received: queue.length - left.length });
    }
    const own = rows.get(account ?? "") ?? [];
    rows.set(account ?? "", own);
    if (init?.method === "PUT") {
      const pushed = (JSON.parse(body) as { rows: Array<{ table: string; row: unknown }> }).rows;
      own.push(...pushed);
      return Response.json({ stored: pushed.length, ahead: [], serverMillis: T0 });
    }
    if (held !== undefined && held.account === account) {
      const { answer } = held;
      held = undefined;
      await answer;
    }
    const after = Number(new URL(String(url)).searchParams.get("after") ?? 0);
    const page = own
      .slice(after)
      .map(({ table, row }, index) => ({ seq: after + index + 1, table, row }));
    return Response.json({ rows: page, next: after + page.length, more: false });
  };
  return { requests, rows, proposals, hold, fetch };
};

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function until(done: () => boolean, what: string, tries = 0): Promise<void> {
  if (done()) return;
  if (tries > 200) throw new Error(`${what} never happened`);
  await settle();
  return until(done, what, tries + 1);
}

let alice: Runtime;
let bob: Runtime;
let server: ReturnType<typeof standInServer>;
let tree: ReactTestRenderer | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  alice = openDatabase(1);
  bob = openDatabase(2);
  app.databases.set("anonymous", openDatabase(3));
  app.databases.set(ALICE, alice);
  app.databases.set(BOB, bob);
  app.storage.clear();
  server = standInServer();
  vi.stubGlobal("fetch", server.fetch);
});

afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  vi.unstubAllGlobals();
  await Promise.all([alice.dispose(), bob.dispose()]);
});

const signIn = async (userId: string | null) => {
  app.auth = { isLoaded: true, userId };
  await act(async () => {
    if (tree === undefined) tree = create(<AccountProvider>{null}</AccountProvider>);
    else tree.update(<AccountProvider>{null}</AccountProvider>);
  });
};

const requestsOf = (account: string) =>
  server.requests.filter((request) => request.account === account);

describe("signing out and in as someone else", () => {
  it("syncs only the signed-in account's own database", async () => {
    await logWorkout(alice, "Alice's squats");
    await signIn(ALICE);
    await until(
      () => requestsOf(ALICE).some(({ method }) => method === "GET"),
      "Alice's first sync",
    );
    expect(JSON.stringify(server.rows.get(ALICE))).toContain("Alice's squats");

    // Sign out on the Account screen, then sign in as Bob.
    await signIn(null);
    await act(async () => signedOut());
    expect(currentDatabase().owner).toEqual({ kind: "anonymous" });
    await signIn(BOB);
    expect(currentDatabase().owner).toEqual({ kind: "account", accountId: BOB });
    await until(() => requestsOf(BOB).some(({ method }) => method === "GET"), "Bob's first sync");

    // Bob's database is empty, so his sync sends nothing and pulls nothing of Alice's.
    expect(requestsOf(BOB).filter(({ method }) => method === "PUT")).toEqual([]);
    const bobsRows = await bob.runPromise(
      Effect.flatMap(Effect.service(ActivityRepository), (activities) => activities.counts),
    );
    expect(bobsRows).toEqual({ activities: 0, sets: 0 });

    // A sync for Alice that starts while Bob's database is open sends nothing at all.
    const before = server.requests.length;
    await act(() => syncNow(AccountId.make(ALICE), async () => sessionToken(ALICE)));
    expect(server.requests.length).toBe(before);

    // What Bob logs reaches only Bob's account.
    await logWorkout(bob, "Bob's deadlifts");
    await act(() => syncNow(AccountId.make(BOB), async () => sessionToken(BOB)));
    const bobsPushes = requestsOf(BOB).filter(({ method }) => method === "PUT");
    expect(bobsPushes.length).toBeGreaterThan(0);
    for (const { body } of bobsPushes) expect(body).not.toContain("Alice's squats");
    expect(JSON.stringify(server.rows.get(BOB))).toContain("Bob's deadlifts");
    expect(JSON.stringify(server.rows.get(ALICE))).not.toContain("Bob's deadlifts");
  });

  it("keeps the next account's proposals on the server when an earlier sync answers late", async () => {
    server.proposals.set(BOB, [proposalFor("proposal-bob", "Bob's squat plan")]);
    const release = server.hold(ALICE);
    await signIn(ALICE);
    await until(
      () => requestsOf(ALICE).some(({ path }) => path === "/v1/rows"),
      "Alice's row pull",
    );

    // Alice's pull is still out when the phone signs out and Bob signs in.
    await signIn(null);
    await act(async () => signedOut());
    await signIn(BOB);
    expect(currentDatabase().owner).toEqual({ kind: "account", accountId: BOB });

    // Alice's answer arrives. Her sync is joined, so waiting on a sync waits for hers to end.
    release();
    await act(() => syncNow(AccountId.make(BOB), async () => sessionToken(BOB)));

    const proposalRequests = server.requests.filter(({ path }) =>
      path.startsWith("/v1/assistant-proposals"),
    );
    expect(proposalRequests).toEqual([]);
    expect(server.proposals.get(BOB)?.map(({ id }) => id)).toEqual(["proposal-bob"]);
    const alicesProposals = await alice.runPromise(
      Effect.flatMap(Effect.service(ProposalRepository), (repository) => repository.list),
    );
    expect(alicesProposals).toEqual([]);

    // Bob's own sync takes them into Bob's database and clears his queue.
    await act(() => syncNow(AccountId.make(BOB), async () => sessionToken(BOB)));
    const bobsProposals = await bob.runPromise(
      Effect.flatMap(Effect.service(ProposalRepository), (repository) => repository.list),
    );
    expect(bobsProposals.map(({ title }) => title)).toEqual(["Bob's squat plan"]);
    expect(server.proposals.get(BOB)).toEqual([]);
  });
});
