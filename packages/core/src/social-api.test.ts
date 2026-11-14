import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { SocialActivityId } from "./privacy.ts";
import { httpSocialApi, SocialFailed, socialProblemMessage } from "./social-api.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly authorization: string | undefined;
}

/**
 * A server that answers each request with `status` and `body`, as JSON unless `body` is a
 * string, and records what it got.
 */
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
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  });
  return { api, sent };
};

const failure = async <A>(effect: Effect.Effect<A, SocialFailed>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
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

  it("answers a follow request by its ID, never by the username", async () => {
    const requests = {
      requests: [
        {
          id: "0190a0b2-0000-4000-8000-000000000001",
          username: "ben",
          private: true,
          follow: "none",
        },
      ],
    };
    const { api, sent } = server(200, requests);
    expect(await Effect.runPromise(api.requests())).toEqual(requests);
    const { api: answering, sent: answers } = server(200, {});
    await Effect.runPromise(answering.approve("0190a0b2-0000-4000-8000-000000000001"));
    await Effect.runPromise(answering.decline("a/b"));
    expect([...sent, ...answers].map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://svett.test/v1/follow-requests",
      "PUT https://svett.test/v1/follow-requests/0190a0b2-0000-4000-8000-000000000001",
      "DELETE https://svett.test/v1/follow-requests/a%2Fb",
    ]);
  });

  it("says a request is gone when it was answered or taken back", async () => {
    const error = await failure(
      server(404, { error: "request_not_found" }).api.approve(
        "0190a0b2-0000-4000-8000-000000000001",
      ),
    );
    expect(error.problem).toBe("request_not_found");
    expect(socialProblemMessage(error)).toBe("That request was already answered or taken back.");
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

  it.each([
    [401, "signed_out"],
    [503, "sign_in_unavailable"],
  ])("reads a %i from a proxy that answers without JSON as %s", async (status, problem) => {
    const error = await failure(server(status, "<html>Unauthorized</html>").api.follow("anna"));
    expect(error.problem).toBe(problem);
  });

  it("asks for the page after a list's `next`", async () => {
    const page = { profiles: [{ username: "ben", private: true, follow: "none" }], next: "ben" };
    const { api, sent } = server(200, page);
    expect(await Effect.runPromise(api.followers("Anna.K"))).toEqual(page);
    await Effect.runPromise(api.following("Anna.K", "a&b"));
    expect(sent.map(({ url }) => url)).toEqual([
      "https://svett.test/v1/profiles/Anna.K/followers",
      "https://svett.test/v1/profiles/Anna.K/following?after=a%26b",
    ]);
  });

  it("reads another account's activity by its social ID", async () => {
    const id = SocialActivityId.make("6f1c2a4e-93b0-4d5e-8a71-0c9e4b2d7f13");
    const view = {
      id,
      kind: "run",
      startedAt: null,
      durationS: 1800,
      title: "Easy run",
      notes: "",
      energyKcal: null,
      hiddenFields: ["start_time"],
    };
    const { api, sent } = server(200, view);
    expect(await Effect.runPromise(api.activity(id))).toEqual(view);
    expect(sent.map(({ url }) => url)).toEqual([`https://svett.test/v1/activities/${id}`]);
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
