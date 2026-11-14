/**
 * Proves on a running svett server that a followers-only activity is absent for a stranger
 * and present for a follower, with two accounts.
 *
 * Against the live server, with a Clerk development instance's secret key:
 *
 *   CLERK_SECRET_KEY=sk_test_... node apps/server/src/social-proof.ts
 *
 * SVETT_SERVER names another server, https://svett-app.jservers.net by default.
 * SVETT_PROOF_EMAILS and SVETT_PROOF_USERNAMES each name the owner's and the follower's,
 * separated by a space. The emails are Clerk test addresses, created when missing.
 * It leaves both accounts as it found them: the activities it wrote are deleted, and the
 * follower no longer follows the owner.
 */
import { randomUUID } from "node:crypto";

export type ProofAccount = "owner" | "follower";

export interface SocialProofOptions {
  /** Such as https://svett-app.jservers.net, with no trailing slash. */
  readonly server: string;
  /** A fresh session token for one of the two accounts. */
  readonly token: (account: ProofAccount) => Promise<string>;
  readonly usernames: { readonly owner: string; readonly follower: string };
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

class ProofFailed extends Error {}

const expect = (holds: boolean, message: string) => {
  if (!holds) throw new ProofFailed(message);
};

type Activity = { readonly id: string; readonly title: string; readonly startedAt: number | null };

/** Runs the proof, and throws with what went wrong when any step does not hold. */
export const socialProof = async (options: SocialProofOptions) => {
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
    const answer = (await response.json().catch(() => null)) as unknown;
    return { status: response.status, body: answer };
  };
  const ok = async (as: ProofAccount, method: string, path: string, body?: unknown) => {
    const answer = await call(as, method, path, body);
    expect(
      answer.status === 200,
      `${method} ${path} as the ${as} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
    );
    return answer.body;
  };

  const { owner, follower } = options.usernames;
  await ok("owner", "PUT", "/v1/profile", { username: owner, private: true });
  await ok("follower", "PUT", "/v1/profile", { username: follower, private: true });
  // An earlier run that stopped half way may have left the follow in place.
  await ok("follower", "DELETE", `/v1/profiles/${owner}/follow`);
  options.log(`${owner} has a private profile, and ${follower} does not follow it`);

  const hour = now() - 3_600_000;
  const activity = (
    title: string,
    audience: string,
    hiddenFields: ReadonlyArray<string>,
    startedAt: number,
  ) => ({
    id: randomUUID(),
    updatedAt: now(),
    deletedAt: null,
    kind: "strength",
    startedAt,
    durationS: 3600,
    title,
    notes: "",
    energyKcal: null,
    audience,
    hiddenFields: JSON.stringify(hiddenFields),
    source: "svett",
    sourceId: null,
    fingerprint: null,
    importBatchId: null,
  });
  // Each starts at its own time, so the hidden one's start time is in no other.
  const forFollowers = activity("Social proof, followers", "followers", ["start_time"], hour);
  const forEveryone = activity("Social proof, everyone", "everyone", [], hour + 60_000);
  const forOwner = activity("Social proof, only you", "only_you", [], hour + 120_000);
  const written = [forFollowers, forEveryone, forOwner];
  await ok("owner", "PUT", "/v1/rows", {
    rows: written.map((row) => ({ table: "activity", row })),
  });
  options.log(`${owner} wrote a followers-only, an everyone and an only-you activity`);

  try {
    // Another account knows an activity only by its social ID, which the owner's own
    // profile shows too. Newest first, so a copy an interrupted run left behind loses.
    const mine = (await ok("owner", "GET", `/v1/profiles/${owner}`)) as {
      readonly activities: ReadonlyArray<Activity>;
    };
    const socialId = new Map<string, string>();
    for (const { id, title } of mine.activities) if (!socialId.has(title)) socialId.set(title, id);
    for (const row of written) {
      expect(socialId.has(row.title), `${owner}'s own profile does not show "${row.title}"`);
    }
    const idOf = (row: { readonly title: string }) => socialId.get(row.title);

    const seen = async () => {
      const profile = (await ok("follower", "GET", `/v1/profiles/${owner}`)) as {
        readonly activities: ReadonlyArray<Activity>;
      };
      const sent = JSON.stringify(profile);
      expect(!written.some(({ id }) => sent.includes(id)), "An activity's own ID left the server");
      const ids = new Set(profile.activities.map(({ id }) => id));
      return { profile, has: (row: { readonly title: string }) => ids.has(idOf(row) ?? "") };
    };

    const stranger = await seen();
    expect(stranger.has(forEveryone), "A stranger should see the everyone activity");
    expect(!stranger.has(forFollowers), "A stranger saw the followers-only activity");
    expect(!stranger.has(forOwner), "A stranger saw the only-you activity");
    const lookup = await call("follower", "GET", `/v1/activities/${idOf(forFollowers) ?? ""}`);
    expect(lookup.status === 404, "A stranger read the followers-only activity by its social ID");
    options.log(`Stranger: the followers-only activity is absent, the everyone one present`);

    const followed = (await ok("follower", "PUT", `/v1/profiles/${owner}/follow`)) as {
      readonly follow: string;
    };
    expect(followed.follow === "requested", `Following a private profile gave ${followed.follow}`);
    const requested = await seen();
    expect(!requested.has(forFollowers), "A follower still waiting saw the followers-only one");
    options.log(`Requested: the followers-only activity stays absent until ${owner} approves`);

    const waiting = (await ok("owner", "GET", "/v1/follow-requests")) as {
      readonly requests: ReadonlyArray<{ readonly id: string; readonly username: string }>;
    };
    const request = waiting.requests.find(({ username }) => username === follower);
    if (request === undefined) throw new ProofFailed(`${owner}'s requests do not list ${follower}`);
    await ok("owner", "PUT", `/v1/follow-requests/${encodeURIComponent(request.id)}`);

    const following = await seen();
    expect(following.has(forFollowers), "A follower should see the followers-only activity");
    expect(!following.has(forOwner), "A follower saw the only-you activity");
    const shown = following.profile.activities.find(({ id }) => id === idOf(forFollowers));
    expect(shown?.startedAt === null, "The follower got the hidden start time");
    expect(
      !JSON.stringify(following.profile).includes(String(forFollowers.startedAt)),
      "The hidden start time left the server",
    );
    options.log(
      `Follower: the followers-only activity is present, without its hidden start time, and the only-you one absent`,
    );
  } finally {
    await ok("owner", "PUT", "/v1/rows", {
      rows: written.map((row) => ({
        table: "activity",
        row: { ...row, updatedAt: now() + 1, deletedAt: now() + 1 },
      })),
    });
    await ok("follower", "DELETE", `/v1/profiles/${owner}/follow`);
    options.log("Deleted the proof's activities and ended the follow");
  }
};

const CLERK_API = "https://api.clerk.com/v1";

/**
 * Session tokens for Clerk test users, through the Backend API of a development instance.
 * Each user is found by email or created, gets one session, and a new token per request,
 * as Clerk's session tokens last a minute.
 */
export const clerkTokens = (secretKey: string, emails: Record<ProofAccount, string>) => {
  const clerk = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${CLERK_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json()) as unknown;
    if (!response.ok) {
      throw new ProofFailed(`Clerk answered ${method} ${path} with ${response.status}`);
    }
    return answer;
  };
  const sessions = new Map<ProofAccount, Promise<string>>();
  const session = (account: ProofAccount) => {
    const existing = sessions.get(account);
    if (existing !== undefined) return existing;
    const created = (async () => {
      const email = emails[account];
      const found = (await clerk(
        "GET",
        `/users?email_address=${encodeURIComponent(email)}`,
      )) as ReadonlyArray<{ readonly id: string }>;
      const user =
        found[0] ??
        ((await clerk("POST", "/users", {
          email_address: [email],
          skip_password_requirement: true,
        })) as { readonly id: string });
      const { id } = (await clerk("POST", "/sessions", { user_id: user.id })) as {
        readonly id: string;
      };
      return id;
    })();
    sessions.set(account, created);
    return created;
  };
  return async (account: ProofAccount) => {
    const { jwt } = (await clerk("POST", `/sessions/${await session(account)}/tokens`)) as {
      readonly jwt: string;
    };
    return jwt;
  };
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
    "svett-social-a+clerk_test@example.com svett-social-b+clerk_test@example.com",
  );
  socialProof({
    server: process.env.SVETT_SERVER ?? "https://svett-app.jservers.net",
    token: clerkTokens(secretKey, emails),
    usernames: pair(process.env.SVETT_PROOF_USERNAMES, "social_proof_a social_proof_b"),
    log: (line) => console.log(line),
  }).then(
    () => console.log("The social proof passed"),
    (error: unknown) => {
      console.error(`The social proof failed. ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
