import { type AccountId, Username, usernamePrefix, usernameProblem } from "@svett/core";
import { Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AccountRows } from "./account-rows.ts";
import { signedInAccount, type SignInUnavailable, type Unauthorized } from "./auth.ts";
import {
  type CannotFollowSelf,
  type NotFound,
  SocialRows,
  type UsernameRequired,
  type UsernameTaken,
} from "./social-rows.ts";

const SaveProfile = Schema.Struct({ username: Schema.String, private: Schema.Boolean });

class InvalidUsername extends Data.TaggedError("InvalidUsername")<{
  readonly message: string;
}> {}
const SearchQuery = Schema.Struct({ prefix: Schema.String });
const UsernamePath = Schema.Struct({ username: Schema.String });

type Refusal =
  | Unauthorized
  | SignInUnavailable
  | Schema.SchemaError
  | InvalidUsername
  | NotFound
  | UsernameTaken
  | UsernameRequired
  | CannotFollowSelf;

const refuse = (error: string, status: number, message?: string) =>
  HttpServerResponse.jsonUnsafe(message === undefined ? { error } : { error, message }, {
    status,
  });

const refusal = (error: Refusal) => {
  switch (error._tag) {
    case "Unauthorized":
      return refuse("unauthorized", 401);
    case "SignInUnavailable":
      // Clients tell this apart from a refused session, which signing in again would fix.
      return refuse(
        "sign_in_unavailable",
        503,
        "Sign-in is not set up on this server yet, so accounts and their data are unavailable.",
      );
    case "SchemaError":
      return refuse("invalid_request", 400, error.message);
    case "InvalidUsername":
      return refuse("invalid_username", 400, error.message);
    case "NotFound":
      return refuse("not_found", 404);
    case "UsernameTaken":
      return refuse("username_taken", 409);
    case "UsernameRequired":
      return refuse("username_required", 403);
    case "CannotFollowSelf":
      return refuse("cannot_follow_self", 400);
  }
};

const REFUSALS: ReadonlySet<string> = new Set<Refusal["_tag"]>([
  "Unauthorized",
  "SignInUnavailable",
  "SchemaError",
  "InvalidUsername",
  "NotFound",
  "UsernameTaken",
  "UsernameRequired",
  "CannotFollowSelf",
]);

const isRefusal = <E>(error: E): error is Extract<E, Refusal> =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  REFUSALS.has(error._tag);

/**
 * Runs `handle` for the signed-in account and answers its result as JSON. The account comes
 * from the session alone, so nobody reads or writes as someone else. A database failure is
 * left to the router, which answers 500.
 */
const route = <A, E, R>(handle: (account: AccountId) => Effect.Effect<A, E, R>) =>
  signedInAccount.pipe(
    Effect.flatMap(handle),
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
    Effect.catchIf(isRefusal, (error) => Effect.succeed(refusal(error))),
  );

const username = Effect.map(HttpRouter.schemaPathParams(UsernamePath), (path) => path.username);

const ownProfile = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* SocialRows).ownProfile(account);
  }),
);

const saveProfile = route((account) =>
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(SaveProfile);
    const problem = usernameProblem(body.username);
    if (problem !== undefined) return yield* new InvalidUsername({ message: problem });
    yield* (yield* AccountRows).ensureAccount(account);
    return yield* (yield* SocialRows).saveProfile(account, {
      username: Username.make(body.username),
      private: body.private,
    });
  }),
);

const search = route((account) =>
  Effect.gen(function* () {
    const { prefix } = yield* HttpServerRequest.schemaSearchParams(SearchQuery);
    const valid = usernamePrefix(prefix);
    return {
      profiles: valid === undefined ? [] : yield* (yield* SocialRows).search(account, valid),
    };
  }),
);

const profile = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* SocialRows).profile(account, yield* username);
  }),
);

const follow = route((account) =>
  Effect.gen(function* () {
    return { follow: yield* (yield* SocialRows).follow(account, yield* username) };
  }),
);

const unfollow = route((account) =>
  Effect.gen(function* () {
    return { follow: yield* (yield* SocialRows).unfollow(account, yield* username) };
  }),
);

const followers = route((account) =>
  Effect.gen(function* () {
    return { profiles: yield* (yield* SocialRows).followers(account, yield* username) };
  }),
);

const following = route((account) =>
  Effect.gen(function* () {
    return { profiles: yield* (yield* SocialRows).following(account, yield* username) };
  }),
);

const requests = route((account) =>
  Effect.gen(function* () {
    return { profiles: yield* (yield* SocialRows).requests(account) };
  }),
);

const approve = route((account) =>
  Effect.gen(function* () {
    yield* (yield* SocialRows).approve(account, yield* username);
    return {};
  }),
);

const decline = route((account) =>
  Effect.gen(function* () {
    yield* (yield* SocialRows).decline(account, yield* username);
    return {};
  }),
);

/** Profiles, search by username, follows and follow requests, for the signed-in account. */
export const SocialRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/profile", ownProfile),
  HttpRouter.add("PUT", "/v1/profile", saveProfile),
  HttpRouter.add("GET", "/v1/profiles", search),
  HttpRouter.add("GET", "/v1/profiles/:username", profile),
  HttpRouter.add("PUT", "/v1/profiles/:username/follow", follow),
  HttpRouter.add("DELETE", "/v1/profiles/:username/follow", unfollow),
  HttpRouter.add("GET", "/v1/profiles/:username/followers", followers),
  HttpRouter.add("GET", "/v1/profiles/:username/following", following),
  HttpRouter.add("GET", "/v1/follow-requests", requests),
  HttpRouter.add("PUT", "/v1/follow-requests/:username", approve),
  HttpRouter.add("DELETE", "/v1/follow-requests/:username", decline),
);
