import { SocialActivityId } from "@svett/core";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { FeedRows } from "./feed-rows.ts";
import { route } from "./social-routes.ts";

const Page = Schema.Struct({ cursor: Schema.optional(Schema.String) });
const PostPath = Schema.Struct({ post: SocialActivityId });
const CommentPath = Schema.Struct({ post: SocialActivityId, comment: Schema.String });
const NewComment = Schema.Struct({ body: Schema.String });
const ReadUntil = Schema.Struct({ until: Schema.Finite });

const cursor = Effect.map(HttpServerRequest.schemaSearchParams(Page), (page) => page.cursor);
const post = Effect.map(HttpRouter.schemaPathParams(PostPath), (path) => path.post);

const feed = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* FeedRows).feed(account, yield* cursor);
  }),
);

const thread = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* FeedRows).post(account, yield* post);
  }),
);

const like = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* FeedRows).like(account, yield* post);
  }),
  "likes",
);

const unlike = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* FeedRows).unlike(account, yield* post);
  }),
  "likes",
);

const comment = route((account) =>
  Effect.gen(function* () {
    const { body } = yield* HttpServerRequest.schemaBodyJson(NewComment);
    return yield* (yield* FeedRows).comment(account, yield* post, body);
  }),
  "comments",
);

const deleteComment = route((account) =>
  Effect.gen(function* () {
    const path = yield* HttpRouter.schemaPathParams(CommentPath);
    yield* (yield* FeedRows).deleteComment(account, path.post, path.comment);
    return {};
  }),
  "comments",
);

const inbox = route((account) =>
  Effect.gen(function* () {
    return yield* (yield* FeedRows).inbox(account, yield* cursor);
  }),
);

const markRead = route((account) =>
  Effect.gen(function* () {
    const { until } = yield* HttpServerRequest.schemaBodyJson(ReadUntil);
    yield* (yield* FeedRows).markRead(account, until);
    return {};
  }),
);

/**
 * The feed, posts with their likes and comments, and the inbox, for the signed-in account.
 * A post is named by its activity's social ID.
 */
export const FeedRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/feed", feed),
  HttpRouter.add("GET", "/v1/posts/:post", thread),
  HttpRouter.add("PUT", "/v1/posts/:post/like", like),
  HttpRouter.add("DELETE", "/v1/posts/:post/like", unlike),
  HttpRouter.add("POST", "/v1/posts/:post/comments", comment),
  HttpRouter.add("DELETE", "/v1/posts/:post/comments/:comment", deleteComment),
  HttpRouter.add("GET", "/v1/inbox", inbox),
  HttpRouter.add("PUT", "/v1/inbox/read", markRead),
);
