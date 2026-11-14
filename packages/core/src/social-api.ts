import { Data, Effect, Option, Schema } from "effect";

import { FeedPage, InboxPage, Likes, PostComment, PostThread } from "./feed.ts";
import { ActivityView, FollowState, type SocialActivityId } from "./privacy.ts";
import { usernamePrefix } from "./username.ts";

/** The signed-in account's own profile. `username` is null until they choose one. */
export const OwnProfile = Schema.Struct({
  username: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
  followers: Schema.Int,
  following: Schema.Int,
  /** Follow requests waiting for an answer. */
  requests: Schema.Int,
});
export type OwnProfile = typeof OwnProfile.Type;

/** Another account in a list, with where the signed-in account's follow of it stands. */
export const ProfileSummary = Schema.Struct({
  username: Schema.String,
  private: Schema.Boolean,
  follow: FollowState,
});
export type ProfileSummary = typeof ProfileSummary.Type;

export const ProfileList = Schema.Struct({ profiles: Schema.Array(ProfileSummary) });
export type ProfileList = typeof ProfileList.Type;

/**
 * One page of a profile's followers or follows, by username. `next` asks for the page after
 * it, and is null on the last page.
 */
export const ProfilePage = Schema.Struct({
  profiles: Schema.Array(ProfileSummary),
  next: Schema.NullOr(Schema.String),
});
export type ProfilePage = typeof ProfilePage.Type;

/**
 * Someone waiting for the signed-in account to approve their follow. Approve and Decline
 * name the request by `id`, never by username, so a stale answer never reaches whoever
 * holds the username now.
 */
export const FollowRequest = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  private: Schema.Boolean,
  follow: FollowState,
});
export type FollowRequest = typeof FollowRequest.Type;

export const FollowRequestList = Schema.Struct({ requests: Schema.Array(FollowRequest) });
export type FollowRequestList = typeof FollowRequestList.Type;

/** A profile and the activities the privacy rule lets the signed-in account see, newest first. */
export const ProfileView = Schema.Struct({
  username: Schema.String,
  private: Schema.Boolean,
  self: Schema.Boolean,
  followers: Schema.Int,
  following: Schema.Int,
  follow: FollowState,
  /** The owner follows the signed-in account. */
  followsYou: Schema.Boolean,
  activities: Schema.Array(ActivityView),
});
export type ProfileView = typeof ProfileView.Type;

export const FollowResult = Schema.Struct({ follow: FollowState });
export type FollowResult = typeof FollowResult.Type;

const Done = Schema.Struct({});

/** The error codes the server answers social requests with, beside sign-in's. */
const SERVER_PROBLEMS = [
  "not_found",
  "username_taken",
  "invalid_username",
  "username_required",
  "cannot_follow_self",
  "request_not_found",
  "post_not_found",
  "invalid_comment",
  "invalid_cursor",
] as const;

export type SocialProblem =
  | (typeof SERVER_PROBLEMS)[number]
  | "offline"
  | "signed_out"
  | "sign_in_unavailable"
  | "server";

export class SocialFailed extends Data.TaggedError("SocialFailed")<{
  readonly problem: SocialProblem;
  readonly message: string;
}> {}

export const socialProblemMessage = (failed: SocialFailed): string => {
  switch (failed.problem) {
    case "offline":
      return "Cannot reach svett. Check the connection and try again.";
    case "signed_out":
      return "Sign in again to see profiles.";
    case "sign_in_unavailable":
      return "The svett server has no sign-in set up yet, so profiles are unavailable.";
    case "not_found":
      return "Nobody has that username.";
    case "username_taken":
      return "Someone already has that username.";
    case "invalid_username":
      return failed.message;
    case "username_required":
      return "Choose a username before you follow anyone.";
    case "cannot_follow_self":
      return "You cannot follow yourself.";
    case "request_not_found":
      return "That request was already answered or taken back.";
    case "post_not_found":
      return "This post is not here. It may be deleted, or no longer shared with you.";
    case "invalid_comment":
      return failed.message;
    case "invalid_cursor":
      return "The feed changed while you scrolled. Pull to refresh.";
    case "server":
      return "The svett server had a problem. Try again soon.";
  }
};

export interface HttpSocialOptions {
  /** Such as https://svett-app.jservers.net, with no trailing slash. */
  readonly server: string;
  /** The signed-in session's token, fetched fresh for each request. */
  readonly token: () => Promise<string | null>;
  readonly fetch: typeof globalThis.fetch;
}

const REQUEST_TIMEOUT_MS = 30_000;

const failed = (problem: SocialProblem, message: string) => new SocialFailed({ problem, message });

const ErrorBody = Schema.Struct({ error: Schema.String, message: Schema.optional(Schema.String) });

const isServerProblem = (code: string): code is (typeof SERVER_PROBLEMS)[number] =>
  (SERVER_PROBLEMS as ReadonlyArray<string>).includes(code);

const at = (username: string) => `/v1/profiles/${encodeURIComponent(username)}`;
const postAt = (id: string) => `/v1/posts/${encodeURIComponent(id)}`;
const page = (after: string | undefined) =>
  after === undefined ? "" : `?after=${encodeURIComponent(after)}`;

/** Profiles, follows and follow requests on the svett server. Answers pass their schemas. */
export const httpSocialApi = (options: HttpSocialOptions) => {
  const call = <A>(
    schema: Schema.Codec<A, unknown>,
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const token = yield* Effect.tryPromise({
        try: options.token,
        catch: () => failed("offline", "Could not read the session."),
      });
      if (token === null) return yield* failed("signed_out", "Nobody is signed in.");
      const response = yield* Effect.tryPromise({
        try: (interrupted) => {
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
          interrupted.addEventListener("abort", () => deadline.abort());
          return options
            .fetch(`${options.server}${path}`, {
              method,
              body: body === undefined ? null : JSON.stringify(body),
              signal: deadline.signal,
              headers: {
                authorization: `Bearer ${token}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
            })
            .finally(() => clearTimeout(timer));
        },
        catch: () => failed("offline", "Could not reach the svett server."),
      });
      // A proxy in front of the server can answer these without JSON.
      if (response.status === 401) return yield* failed("signed_out", "The session has ended.");
      if (response.status === 503) {
        return yield* failed("sign_in_unavailable", "Sign-in is not set up on the server yet.");
      }
      const answer: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failed("server", `The server answered ${response.status} without JSON.`),
      });
      if (!response.ok) {
        const error = Schema.decodeUnknownOption(ErrorBody)(answer);
        if (Option.isSome(error) && isServerProblem(error.value.error)) {
          return yield* failed(error.value.error, error.value.message ?? error.value.error);
        }
        return yield* failed("server", `The server answered ${response.status}.`);
      }
      return yield* Schema.decodeUnknownEffect(schema)(answer).pipe(
        Effect.mapError((issue) => failed("server", `Unexpected answer. ${issue.message}`)),
      );
    });

  return {
    ownProfile: () => call(OwnProfile, "GET", "/v1/profile"),
    saveProfile: (profile: { readonly username: string; readonly private: boolean }) =>
      call(OwnProfile, "PUT", "/v1/profile", profile),
    /** Profiles whose username starts with `text`. Text no username could start with finds none. */
    search: (text: string) => {
      const prefix = usernamePrefix(text);
      return prefix === undefined
        ? Effect.succeed<ProfileList>({ profiles: [] })
        : call(ProfileList, "GET", `/v1/profiles?prefix=${encodeURIComponent(prefix)}`);
    },
    profile: (username: string) => call(ProfileView, "GET", at(username)),
    follow: (username: string) => call(FollowResult, "PUT", `${at(username)}/follow`),
    unfollow: (username: string) => call(FollowResult, "DELETE", `${at(username)}/follow`),
    /** A page of the profile's followers, after the page whose `next` is `after`. */
    followers: (username: string, after?: string) =>
      call(ProfilePage, "GET", `${at(username)}/followers${page(after)}`),
    /** A page of the accounts the profile follows, after the page whose `next` is `after`. */
    following: (username: string, after?: string) =>
      call(ProfilePage, "GET", `${at(username)}/following${page(after)}`),
    /** Another account's activity by its social ID, when the privacy rule lets you see it. */
    activity: (id: SocialActivityId) =>
      call(ActivityView, "GET", `/v1/activities/${encodeURIComponent(id)}`),
    requests: () => call(FollowRequestList, "GET", "/v1/follow-requests"),
    /** Approves the request with this `FollowRequest.id`. */
    approve: (request: string) =>
      call(Done, "PUT", `/v1/follow-requests/${encodeURIComponent(request)}`),
    /** Declines the request with this `FollowRequest.id`. */
    decline: (request: string) =>
      call(Done, "DELETE", `/v1/follow-requests/${encodeURIComponent(request)}`),
    /** Your posts and those of the accounts you follow, newest first, after `cursor`. */
    feed: (cursor?: string) =>
      call(
        FeedPage,
        "GET",
        cursor === undefined ? "/v1/feed" : `/v1/feed?cursor=${encodeURIComponent(cursor)}`,
      ),
    /** A post by its social ID, with its comments. */
    post: (id: string) => call(PostThread, "GET", postAt(id)),
    like: (id: string) => call(Likes, "PUT", `${postAt(id)}/like`),
    unlike: (id: string) => call(Likes, "DELETE", `${postAt(id)}/like`),
    comment: (id: string, body: string) =>
      call(PostComment, "POST", `${postAt(id)}/comments`, { body }),
    deleteComment: (id: string, commentId: string) =>
      call(Done, "DELETE", `${postAt(id)}/comments/${encodeURIComponent(commentId)}`),
    inbox: (cursor?: string) =>
      call(
        InboxPage,
        "GET",
        cursor === undefined ? "/v1/inbox" : `/v1/inbox?cursor=${encodeURIComponent(cursor)}`,
      ),
    /** Marks every inbox item up to `until` read. */
    markInboxRead: (until: number) => call(Done, "PUT", "/v1/inbox/read", { until }),
  };
};

export type SocialApi = ReturnType<typeof httpSocialApi>;
