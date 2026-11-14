import { Effect, Exit } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { httpSocialApi, SocialFailed, socialProblemMessage } from "./social-api.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly authorization: string | undefined;
}

/** A server that answers each request with `status` and `body`, and records what it got. */
const server = (status: number, body: unknown, token: string | null = "token-1") => {
  const sent: Array<Sent> = [];
  const api = httpSocialApi({
    server: "https://svett.test",
    token: async () => token,
    fetch: async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: (init?.body as string | null) ?? null,
        authorization: headers["authorization"],
      });
      return new Response(JSON.stringify(body), { status });
    },
  });
  return { api, sent };
};

const failure = async <A>(effect: Effect.Effect<A, SocialFailed>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  if (!(error instanceof SocialFailed)) throw new Error("expected SocialFailed");
  return error;
};

const PROFILE = {
  username: "Anna.K",
  private: true,
  self: false,
  followers: 2,
  following: 1,
  follow: "following",
  followsYou: false,
  activities: [],
};

describe("httpSocialApi", () => {
  it("sends the session token and a username in its path", async () => {
    const { api, sent } = server(200, PROFILE);
    expect(await Effect.runPromise(api.profile("Anna.K"))).toEqual(PROFILE);
    expect(sent).toEqual([
      {
        url: "https://svett.test/v1/profiles/Anna.K",
        method: "GET",
        body: null,
        authorization: "Bearer token-1",
      },
    ]);
  });

  it("sends a username and the private choice as JSON", async () => {
    const own = { username: "anna", private: false, followers: 0, following: 0, requests: 0 };
    const { api, sent } = server(200, own);
    expect(await Effect.runPromise(api.saveProfile({ username: "anna", private: false }))).toEqual(
      own,
    );
    expect(sent[0]).toMatchObject({
      method: "PUT",
      url: "https://svett.test/v1/profile",
      body: JSON.stringify({ username: "anna", private: false }),
    });
  });

  it("searches by the lower-case prefix, and asks nothing for text no username starts with", async () => {
    const { api, sent } = server(200, { profiles: [] });
    await Effect.runPromise(api.search(" @Ann "));
    await Effect.runPromise(api.search("ann k"));
    expect(sent.map(({ url }) => url)).toEqual(["https://svett.test/v1/profiles?prefix=ann"]);
  });

  it.each([
    [409, { error: "username_taken" }, "username_taken", "Someone already has that username."],
    [
      400,
      { error: "invalid_username", message: "That username is reserved." },
      "invalid_username",
      "That username is reserved.",
    ],
    [404, { error: "not_found" }, "not_found", "Nobody has that username."],
    [
      403,
      { error: "username_required" },
      "username_required",
      "Choose a username before you follow anyone.",
    ],
    [401, { error: "unauthorized" }, "signed_out", "Sign in again to see profiles."],
    [
      503,
      { error: "sign_in_unavailable" },
      "sign_in_unavailable",
      "The svett server has no sign-in set up yet, so profiles are unavailable.",
    ],
    [500, { error: "boom" }, "server", "The svett server had a problem. Try again soon."],
  ])("turns a %i %j into %s", async (status, body, problem, message) => {
    const error = await failure(server(status, body).api.follow("anna"));
    expect(error.problem).toBe(problem);
    expect(socialProblemMessage(error)).toBe(message);
  });

  it("asks nothing when nobody is signed in", async () => {
    const { api, sent } = server(200, PROFILE, null);
    expect((await failure(api.profile("anna"))).problem).toBe("signed_out");
    expect(sent).toEqual([]);
  });

  it("refuses an answer that does not match its schema", async () => {
    const error = await failure(server(200, { follow: "maybe" }).api.follow("anna"));
    expect(error.problem).toBe("server");
  });

  it("says the server is out of reach when the request fails", async () => {
    const api = httpSocialApi({
      server: "https://svett.test",
      token: async () => "token-1",
      fetch: async () => {
        throw new TypeError("Network request failed");
      },
    });
    expect((await failure(api.requests())).problem).toBe("offline");
  });
});
