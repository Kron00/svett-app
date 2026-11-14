import {
  type AccountId,
  SocialActivityId,
  Username,
  usernamePrefix,
  usernameProblem,
} from "@svett/core";
import { Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { SignInUnavailable, signedInAccount, Unauthorized } from "./auth.ts";
import {
  CannotFollowSelf,
  NotFound,
  RequestNotFound,
  SocialRows,
  UsernameRequired,
  UsernameTaken,
} from "./social-rows.ts";

const SaveProfile = Schema.Struct({ username: Schema.String, private: Schema.Boolean });

class InvalidUsername extends Data.TaggedError("InvalidUsername")<{
  readonly message: string;
}> {}
const SearchQuery = Schema.Struct({ prefix: Schema.String });
const UsernamePath = Schema.Struct({ username: Schema.String });
const RequestPath = Schema.Struct({ request: Schema.String });
const ActivityPath = Schema.Struct({ activity: SocialActivityId });
const PageQuery = Schema.Struct({ after: Schema.optional(Schema.String) });

const refuse = (error: string, status: number, message?: string) =>
  HttpServerResponse.jsonUnsafe(message === undefined ? { error } : { error, message }, {
    status,
  });

/** The answer for a failure the client caused or can act on, or undefined for any other. */
const refusal = (error: unknown) => {
  if (error instanceof Unauthorized) return refuse("unauthorized", 401);
  if (error instanceof SignInUnavailable) {
    // Clients tell this apart from a refused session, which signing in again would fix.
    return refuse(
      "sign_in_unavailable",
      503,
      "Sign-in is not set up on this server yet, so accounts and their data are unavailable.",
    );
  }
  if (Schema.isSchemaError(error)) return refuse("invalid_request", 400, error.message);
  if (error instanceof InvalidUsername) return refuse("invalid_username", 400, error.message);
  if (error instanceof NotFound) return refuse("not_found", 404);
  if (error instanceof RequestNotFound) return refuse("request_not_found", 404);
  if (error instanceof UsernameTaken) return refuse("username_taken", 409);
  if (error instanceof UsernameRequired) return refuse("username_required", 403);
  if (error instanceof CannotFollowSelf) return refuse("cannot_follow_self", 400);
  return undefined;
};

/**
 * Runs `handle` for the signed-in account and answers its result as JSON. The account comes
 * from the session alone, so nobody reads or writes as someone else. A database failure is
 * left to the router, which answers 500.
 */
const route = <A, E, R>(handle: (account: AccountId) => Effect.Effect<A, E, R>) =>
  signedInAccount.pipe(
    Effect.flatMap(handle),
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
    Effect.catch((error) => {
      const answer = refusal(error);
      return answer === undefined ? Effect.fail(error) : Effect.succeed(answer);
    }),
  );

const username = Effect.map(HttpRouter.schemaPathParams(UsernamePath), (path) => path.username);
const requestId = Effect.map(HttpRouter.schemaPathParams(RequestPath), (path) => path.request);

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

const after = Effect.map(HttpServerRequest.schemaSearchParams(PageQuery), (query) => query.after);

const followers = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* SocialRows).followers(account, yield* username, yield* after);
  }),
);

const following = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* SocialRows).following(account, yield* username, yield* after);
  }),
);

const activity = route((account) =>
  Effect.gen(function* () {
    const path = yield* HttpRouter.schemaPathParams(ActivityPath);
    return yield* (yield* SocialRows).activity(account, path.activity);
  }),
);

const requests = route((account) =>
  Effect.gen(function* () {
    return { requests: yield* (yield* SocialRows).requests(account) };
  }),
);

const approve = route((account) =>
  Effect.gen(function* () {
    yield* (yield* SocialRows).approve(account, yield* requestId);
    return {};
  }),
);

const decline = route((account) =>
  Effect.gen(function* () {
    yield* (yield* SocialRows).decline(account, yield* requestId);
    return {};
  }),
);

/**
 * Profiles, search by username, follows, follow requests and other accounts' activities by
 * their social IDs, for the signed-in account.
 */
export const SocialRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/profile", ownProfile),
  HttpRouter.add("PUT", "/v1/profile", saveProfile),
  HttpRouter.add("GET", "/v1/profiles", search),
  HttpRouter.add("GET", "/v1/profiles/:username", profile),
  HttpRouter.add("PUT", "/v1/profiles/:username/follow", follow),
  HttpRouter.add("DELETE", "/v1/profiles/:username/follow", unfollow),
  HttpRouter.add("GET", "/v1/profiles/:username/followers", followers),
  HttpRouter.add("GET", "/v1/profiles/:username/following", following),
  HttpRouter.add("GET", "/v1/activities/:activity", activity),
  HttpRouter.add("GET", "/v1/follow-requests", requests),
  HttpRouter.add("PUT", "/v1/follow-requests/:request", approve),
  HttpRouter.add("DELETE", "/v1/follow-requests/:request", decline),
);
