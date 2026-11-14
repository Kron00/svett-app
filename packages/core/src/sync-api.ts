import { Data, Effect, Schema } from "effect";

import type { SyncApi } from "./repositories/sync.ts";
import { type SyncedTable, SyncPull, SyncPushResult } from "./sync.ts";

export type SyncProblem =
  /** The server did not answer, or the phone has no connection. */
  | "offline"
  /** The session lapsed, so the phone needs a new email code before it syncs again. */
  | "signed_out"
  /** The server has no sign-in set up yet. */
  | "sign_in_unavailable"
  /** The session belongs to another account than the open database. Nothing was sent. */
  | "wrong_account"
  /** The account was deleted, so the server refuses every change and keeps nothing. */
  | "account_deleted"
  /** The account sent too many changes at once. Sync tries again later. */
  | "rate_limited"
  | "server";

export class SyncFailed extends Data.TaggedError("SyncFailed")<{
  readonly problem: SyncProblem;
  readonly message: string;
}> {}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const decodeBase64Url = (text: string): string => {
  let bits = 0;
  let value = 0;
  let escaped = "";
  for (const char of text) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) throw new Error("Not base64url");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      escaped += `%${((value >> bits) & 0xff).toString(16).padStart(2, "0")}`;
    }
  }
  return decodeURIComponent(escaped);
};

/**
 * The account a session token names, read without checking its signature. The server checks
 * that. The phone only makes sure it never sends one account's rows with another's token.
 */
export const tokenSubject = (token: string): string | undefined => {
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(token.split(".")[1] ?? ""));
    return typeof payload === "object" &&
      payload !== null &&
      "sub" in payload &&
      typeof payload.sub === "string"
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
};

export interface HttpSyncOptions {
  /** Such as https://svett-app.jservers.net, with no trailing slash. */
  readonly server: string;
  /** The account whose database this sync reads and writes. */
  readonly accountId: string;
  /** The signed-in session's token, fetched fresh for each request. */
  readonly token: () => Promise<string | null>;
  readonly fetch: typeof globalThis.fetch;
}

const REQUEST_TIMEOUT_MS = 30_000;

const failed = (problem: SyncProblem, message: string) => new SyncFailed({ problem, message });

/** The server's sync API over HTTP. Answers pass through their schemas before use. */
export const httpSyncApi = (options: HttpSyncOptions): SyncApi<SyncFailed> => {
  const call = <A>(
    schema: Schema.Codec<A, unknown>,
    path: string,
    init: { readonly method: "GET" | "PUT"; readonly body?: string },
  ) =>
    Effect.gen(function* () {
      const token = yield* Effect.tryPromise({
        try: options.token,
        catch: () => failed("offline", "Could not read the session."),
      });
      if (token === null) return yield* failed("signed_out", "Nobody is signed in.");
      if (tokenSubject(token) !== options.accountId) {
        return yield* failed("wrong_account", "The session is for another account.");
      }
      const response = yield* Effect.tryPromise({
        // A timer, not Effect's clock, bounds the wait: a test database's clock only moves
        // when told, and a sync must not move it.
        try: (interrupted) => {
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
          interrupted.addEventListener("abort", () => deadline.abort());
          return options
            .fetch(`${options.server}${path}`, {
              method: init.method,
              body: init.body ?? null,
              signal: deadline.signal,
              headers: {
                authorization: `Bearer ${token}`,
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
              },
            })
            .finally(() => clearTimeout(timer));
        },
        catch: () => failed("offline", "Could not reach the svett server."),
      });
      // A proxy in front of the server can answer these without JSON.
      if (response.status === 410) {
        return yield* failed("account_deleted", "The svett account was deleted.");
      }
      if (response.status === 429) {
        return yield* failed("rate_limited", "Too many changes at once.");
      }
      const body: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failed("server", `The server answered ${response.status} without JSON.`),
      });
      if (response.status === 401) return yield* failed("signed_out", "The session has ended.");
      if (response.status === 503) {
        return yield* failed(
          "sign_in_unavailable",
          "Sign-in is not set up on the svett server yet.",
        );
      }
      if (!response.ok) {
        return yield* failed("server", `The server answered ${response.status}.`);
      }
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError((issue) => failed("server", `Unexpected answer. ${issue.message}`)),
      );
    });

  return {
    push: (rows: ReadonlyArray<{ readonly table: SyncedTable; readonly row: unknown }>) =>
      call(SyncPushResult, "/v1/rows", { method: "PUT", body: JSON.stringify({ rows }) }),
    pull: (after: number) => call(SyncPull, `/v1/rows?after=${after}`, { method: "GET" }),
  };
};

/** What the Account screen shows about sync. */
export type SyncStatus =
  | { readonly kind: "waiting" }
  | { readonly kind: "syncing" }
  | { readonly kind: "synced"; readonly queued: number; readonly held: number }
  | { readonly kind: "failed"; readonly problem: SyncProblem; readonly queued: number };

const changes = (count: number) => (count === 1 ? "1 change waits" : `${count} changes wait`);

export const syncStatusMessage = (status: SyncStatus): string => {
  switch (status.kind) {
    case "waiting":
      return "Not synced yet on this launch.";
    case "syncing":
      return "Syncing";
    case "synced":
      if (status.held > 0) {
        return `This phone's clock is ahead of the svett server. ${changes(status.held)} on this phone until the clock is right.`;
      }
      return status.queued === 0 ? "Up to date" : `${changes(status.queued)} to upload.`;
    case "failed":
      switch (status.problem) {
        case "offline":
          return `Cannot reach svett. ${changes(status.queued)} on this phone, and sync tries again soon.`;
        case "signed_out":
          return "Sign in again to sync. Everything stays on this phone meanwhile.";
        case "sign_in_unavailable":
          return "The svett server has no sign-in set up yet, so nothing syncs.";
        case "wrong_account":
          return "The session belongs to another account, so nothing was sent.";
        case "account_deleted":
          return "This account was deleted, so svett keeps nothing more from this phone.";
        case "rate_limited":
          return `svett got a lot of changes at once. ${changes(status.queued)} on this phone, and sync tries again soon.`;
        case "server":
          return "The svett server had a problem. Sync tries again soon.";
      }
  }
};
