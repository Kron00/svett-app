/**
 * Proves on a running svett server that a block keeps the blocked account out, and that
 * deleting an account ends its sessions and refuses what a second, offline device sends later.
 *
 * Against the live server, with a Clerk development instance's secret key:
 *
 *   CLERK_SECRET_KEY=sk_test_... node apps/server/src/safety-proof.ts
 *
 * SVETT_SERVER names another server, https://svett-app.jservers.net by default.
 * SVETT_PROOF_EMAILS names the owner's, the blocked account's and the deleted account's Clerk
 * test addresses, separated by spaces, created when missing. SVETT_PROOF_USERNAMES names the
 * first two's usernames. The deleted account is a new Clerk user each run, as deleting it
 * deletes the user. The owner and the blocked account end as they started: no block, no
 * follow, and no activity left by the proof.
 */
import { randomUUID } from "node:crypto";

import { clerkTokens } from "./social-proof.ts";

export type SafetyAccount = "owner" | "blocked" | "leaver";

export interface SafetyProofOptions {
  /** Such as https://svett-app.jservers.net, with no trailing slash. */
  readonly server: string;
  /** A fresh session token for one of the accounts. It fails once Clerk ended its sessions. */
  readonly token: (account: SafetyAccount) => Promise<string>;
  readonly usernames: { readonly owner: string; readonly blocked: string };
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

class ProofFailed extends Error {}

const expect = (holds: boolean, message: string) => {
  if (!holds) throw new ProofFailed(message);
};

type Answer = { readonly status: number; readonly body: unknown };

/** Runs the proof, and throws with what went wrong when any step does not hold. */
export const safetyProof = async (options: SafetyProofOptions) => {
  const now = options.now ?? Date.now;
  const send = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Answer> => {
    const response = await fetch(`${options.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let answer: unknown = text;
    try {
      answer = JSON.parse(text);
    } catch {
      // The export is JSON too, so only a proxy's error page lands here.
    }
    return { status: response.status, body: answer };
  };
  const call = async (as: SafetyAccount, method: string, path: string, body?: unknown) =>
    send(await options.token(as), method, path, body);
  const ok = async (as: SafetyAccount, method: string, path: string, body?: unknown) => {
    const answer = await call(as, method, path, body);
    expect(
      answer.status === 200,
      `${method} ${path} as the ${as} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
    );
    return answer.body;
  };
  const status = async (as: SafetyAccount, method: string, path: string, body?: unknown) =>
    (await call(as, method, path, body)).status;

  const activity = (title: string) => ({
    id: randomUUID(),
    updatedAt: now(),
    deletedAt: null,
    kind: "run",
    startedAt: now() - 3_600_000,
    durationS: 1800,
    title,
    notes: "",
    energyKcal: null,
    audience: "everyone",
    hiddenFields: "[]",
    source: "svett",
    sourceId: null,
    fingerprint: null,
    importBatchId: null,
  });

  const { owner, blocked } = options.usernames;
  await ok("owner", "PUT", "/v1/profile", { username: owner, private: false });
  await ok("blocked", "PUT", "/v1/profile", { username: blocked, private: false });
  // An earlier run that stopped half way may have left the block or the follow in place.
  const left = (await ok("owner", "GET", "/v1/blocks")) as {
    readonly blocks: ReadonlyArray<{ readonly id: string; readonly username: string }>;
  };
  for (const block of left.blocks) {
    if (block.username === blocked) await ok("owner", "DELETE", `/v1/blocks/${block.id}`);
  }

  const shared = activity("Safety proof, everyone");
  await ok("owner", "PUT", "/v1/rows", { rows: [{ table: "activity", row: shared }] });
  try {
    await ok("blocked", "PUT", `/v1/profiles/${owner}/follow`);
    const seen = (await ok("blocked", "GET", `/v1/profiles/${owner}`)) as {
      readonly activities: ReadonlyArray<{ readonly id: string; readonly title: string }>;
    };
    const post = seen.activities.find((each) => each.title === shared.title);
    expect(post !== undefined, `${blocked} does not see the everyone activity before the block`);
    options.log(`${blocked} follows ${owner} and sees the everyone activity`);

    await ok("owner", "PUT", `/v1/profiles/${blocked}/block`);
    const postPath = `/v1/posts/${post!.id}`;
    expect(
      (await status("blocked", "GET", `/v1/profiles/${owner}`)) === 404,
      `${blocked} still finds ${owner}'s profile after the block`,
    );
    const found = (await ok("blocked", "GET", `/v1/profiles?prefix=${owner}`)) as {
      readonly profiles: ReadonlyArray<{ readonly username: string }>;
    };
    expect(
      !found.profiles.some((profile) => profile.username === owner),
      `${blocked} still finds ${owner} in search after the block`,
    );
    const feed = (await ok("blocked", "GET", "/v1/feed")) as {
      readonly posts: ReadonlyArray<{ readonly username: string }>;
    };
    expect(
      !feed.posts.some((each) => each.username === owner),
      `${owner}'s posts are still in ${blocked}'s feed after the block`,
    );
    expect((await status("blocked", "GET", postPath)) === 404, "The post still opens");
    expect((await status("blocked", "PUT", `${postPath}/like`)) === 404, "A like went through");
    expect(
      (await status("blocked", "POST", `${postPath}/comments`, { body: "Hi" })) === 404,
      "A comment went through",
    );
    expect(
      (await status("blocked", "PUT", `/v1/profiles/${owner}/follow`)) === 404,
      "A follow went through",
    );
    const counts = (await ok("owner", "GET", "/v1/profile")) as { readonly followers: number };
    expect(counts.followers === 0, `${owner} still has a follower after blocking them`);
    options.log(
      `Blocked: ${blocked} finds no profile, search result, feed post or post of ${owner}, and cannot follow, like or comment`,
    );
  } finally {
    const blocks = (await ok("owner", "GET", "/v1/blocks")) as {
      readonly blocks: ReadonlyArray<{ readonly id: string; readonly username: string }>;
    };
    for (const block of blocks.blocks) {
      if (block.username === blocked) await ok("owner", "DELETE", `/v1/blocks/${block.id}`);
    }
    await ok("owner", "PUT", "/v1/rows", {
      rows: [{ table: "activity", row: { ...shared, updatedAt: now() + 1, deletedAt: now() + 1 } }],
    });
    options.log("Ended the block and deleted the proof's activity");
  }

  const kept = activity("Safety proof, deleted account");
  await ok("leaver", "PUT", "/v1/rows", { rows: [{ table: "activity", row: kept }] });
  const exported = (await ok("leaver", "GET", "/v1/export")) as {
    readonly format?: string;
    readonly tables?: Readonly<Record<string, ReadonlyArray<{ readonly id: string }>>>;
  };
  expect(
    exported.format === "svett" && (exported.tables?.["activity"] ?? []).some((row) => row.id === kept.id),
    "The export does not hold the account's activity",
  );
  // A second phone of the same account, offline during the deletion, still holds this token.
  const offlineToken = await options.token("leaver");
  await ok("leaver", "DELETE", "/v1/me");
  const ended = await options.token("leaver").then(
    () => false,
    () => true,
  );
  expect(ended, "Clerk still gives the deleted account a session token");
  const late = activity("Safety proof, from the offline phone");
  const push = await send(offlineToken, "PUT", "/v1/rows", {
    rows: [{ table: "activity", row: late }],
  });
  expect(
    push.status === 410 && (push.body as { readonly error?: string }).error === "account_deleted",
    `The offline phone's upload answered ${push.status}: ${JSON.stringify(push.body)}`,
  );
  const me = await send(offlineToken, "GET", "/v1/me");
  expect(me.status === 410, `The deleted account's /v1/me answered ${me.status}`);
  options.log(
    "Deleted: Clerk ends every session, and the offline phone's upload is refused as account_deleted",
  );
};

const words = (value: string | undefined, fallback: string, count: number) => {
  const found = (value ?? fallback).split(" ").filter(Boolean);
  if (found.length !== count) {
    throw new ProofFailed(`Expected ${count} values separated by spaces, got: ${value}`);
  }
  return found;
};

if (import.meta.main) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (secretKey === undefined || !secretKey.startsWith("sk_test_")) {
    console.error("Set CLERK_SECRET_KEY to a Clerk development instance's secret key.");
    process.exit(64);
  }
  const [ownerEmail, blockedEmail, leaverEmail] = words(
    process.env.SVETT_PROOF_EMAILS,
    "svett-safety-a+clerk_test@example.com svett-safety-b+clerk_test@example.com svett-safety-c+clerk_test@example.com",
    3,
  );
  const [ownerName, blockedName] = words(
    process.env.SVETT_PROOF_USERNAMES,
    "safety_proof_a safety_proof_b",
    2,
  );
  safetyProof({
    server: process.env.SVETT_SERVER ?? "https://svett-app.jservers.net",
    token: clerkTokens<SafetyAccount>(secretKey, {
      owner: ownerEmail!,
      blocked: blockedEmail!,
      leaver: leaverEmail!,
    }),
    usernames: { owner: ownerName!, blocked: blockedName! },
    log: (line) => console.log(line),
  }).then(
    () => console.log("The safety proof passed"),
    (error: unknown) => {
      console.error(`The safety proof failed. ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
