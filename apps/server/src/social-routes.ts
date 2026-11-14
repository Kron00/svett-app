import {
  type AccountId,
  type RateLimitGroup,
  SocialActivityId,
  Username,
  usernamePrefix,
  usernameProblem,
} from "@svett/core";
import { Data, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { InvalidRow } from "./account-rows.ts";
import { SignInUnavailable, signedInAccount, Unauthorized } from "./auth.ts";
import { SessionEndFailed } from "./clerk-users.ts";
import { InvalidComment, PostNotFound } from "./feed-rows.ts";
import { InvalidCursor } from "./paging.ts";
import { AccountDeleted, RateLimited, Safety } from "./safety.ts";
import {
  BlockNotFound,
  CannotBlockSelf,
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
const BlockPath = Schema.Struct({ block: Schema.String });
const ActivityPath = Schema.Struct({ activity: SocialActivityId });
const PageQuery = Schema.Struct({ after: Schema.optional(Schema.String) });
const CursorQuery = Schema.Struct({ cursor: Schema.optional(Schema.String) });

const refuse = (error: string, status: number, message?: string) =>
  HttpServerResponse.jsonUnsafe(message === undefined ? { error } : { error, message }, {
    status,
  });

/** The answer for a failure the client caused or can act on, or undefined for any other. */
export const refusal = (error: unknown) => {
  if (error instanceof AccountDeleted) {
    return refuse(
      "account_deleted",
      410,
      "This account was deleted. svett keeps nothing it sends.",
    );
  }
  if (error instanceof RateLimited) {
    return HttpServerResponse.jsonUnsafe(
      { error: "rate_limited", group: error.group, retryAfter: error.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(error.retryAfterSeconds) } },
    );
  }
  if (error instanceof SessionEndFailed) return refuse("session_end_failed", 502, error.reason);
  if (error instanceof InvalidRow) {
    return HttpServerResponse.jsonUnsafe(
      { error: "invalid_row", table: error.table, index: error.index, message: error.message },
      { status: 400 },
    );
  }
  if (error instanceof CannotBlockSelf) return refuse("cannot_block_self", 400);
  if (error instanceof BlockNotFound) return refuse("block_not_found", 404);
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
  if (error instanceof PostNotFound) return refuse("post_not_found", 404);
  if (error instanceof InvalidComment) return refuse("invalid_comment", 400, error.message);
  if (error instanceof InvalidCursor) return refuse("invalid_cursor", 400);
  return undefined;
};

/** Answers a failure the client can act on, and leaves any other to the router's 500. */
export const answerRefusals = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) => {
      const answer = refusal(error);
      return answer === undefined ? Effect.fail(error) : Effect.succeed(answer);
    }),
  );

/**
 * Runs `handle` for the signed-in account and answers its result as JSON. The account comes
 * from the session alone, so nobody reads or writes as someone else. A deleted account is
 * refused, and `group` names the rate limit the request counts against. A database failure
 * is left to the router, which answers 500.
 */
export const route = <A, E, R>(
  handle: (account: AccountId) => Effect.Effect<A, E, R>,
  group?: RateLimitGroup,
) =>
  answerRefusals(
    Effect.gen(function* () {
      const account = yield* signedInAccount;
      const safety = yield* Safety;
      return HttpServerResponse.jsonUnsafe(
        yield* safety.asAccount(account, group, handle(account)),
      );
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

const search = route(
  (account) =>
    Effect.gen(function* () {
      const { prefix } = yield* HttpServerRequest.schemaSearchParams(SearchQuery);
      const valid = usernamePrefix(prefix);
      return {
        profiles: valid === undefined ? [] : yield* (yield* SocialRows).search(account, valid),
      };
    }),
  "search",
);

const profile = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* SocialRows).profile(account, yield* username);
  }),
);

const follow = route(
  (account) =>
    Effect.gen(function* () {
      return { follow: yield* (yield* SocialRows).follow(account, yield* username) };
    }),
  "follows",
);

const unfollow = route(
  (account) =>
    Effect.gen(function* () {
      return { follow: yield* (yield* SocialRows).unfollow(account, yield* username) };
    }),
  "follows",
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

const activities = route((account) =>
  Effect.gen(function* () {
    const { cursor } = yield* HttpServerRequest.schemaSearchParams(CursorQuery);
    return yield* (yield* SocialRows).activities(account, yield* username, cursor);
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

const approve = route(
  (account) =>
    Effect.gen(function* () {
      yield* (yield* SocialRows).approve(account, yield* requestId);
      return {};
    }),
  "follows",
);

const decline = route(
  (account) =>
    Effect.gen(function* () {
      yield* (yield* SocialRows).decline(account, yield* requestId);
      return {};
    }),
  "follows",
);

const block = route(
  (account) =>
    Effect.gen(function* () {
      yield* (yield* SocialRows).block(account, yield* username);
      return {};
    }),
  "follows",
);

const blocks = route((account) =>
  Effect.gen(function* () {
    return { blocks: yield* (yield* SocialRows).blocks(account) };
  }),
);

const unblock = route(
  (account) =>
    Effect.gen(function* () {
      const path = yield* HttpRouter.schemaPathParams(BlockPath);
      yield* (yield* SocialRows).unblock(account, path.block);
      return {};
    }),
  "follows",
);

const removeFollower = route(
  (account) =>
    Effect.gen(function* () {
      yield* (yield* SocialRows).removeFollower(account, yield* username);
      return {};
    }),
  "follows",
);

/**
 * Profiles, search by username, follows, follow requests, blocks and other accounts'
 * activities by their social IDs, for the signed-in account.
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
  HttpRouter.add("GET", "/v1/profiles/:username/activities", activities),
  HttpRouter.add("GET", "/v1/activities/:activity", activity),
  HttpRouter.add("GET", "/v1/follow-requests", requests),
  HttpRouter.add("PUT", "/v1/follow-requests/:request", approve),
  HttpRouter.add("DELETE", "/v1/follow-requests/:request", decline),
  HttpRouter.add("PUT", "/v1/profiles/:username/block", block),
  HttpRouter.add("GET", "/v1/blocks", blocks),
  HttpRouter.add("DELETE", "/v1/blocks/:block", unblock),
  HttpRouter.add("DELETE", "/v1/followers/:username", removeFollower),
);
