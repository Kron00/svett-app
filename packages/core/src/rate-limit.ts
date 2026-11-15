import { Schema } from "effect";

/** The groups of server routes that each have their own limit per account. */
export const RateLimitGroup = Schema.Literals([
  "likes",
  "comments",
  "follows",
  "search",
  "sync_push",
]);
export type RateLimitGroup = typeof RateLimitGroup.Type;

/**
 * A token bucket. It holds up to `capacity` requests, each request takes one, and it fills
 * again by `perSecond`, so a burst of `capacity` goes through at once and a steady stream at
 * `perSecond`.
 */
export interface RateLimit {
  readonly capacity: number;
  readonly perSecond: number;
}

/**
 * Generous for a person, tight for a script. A first sync of two years of training is about
 * 15 pushes of 500 rows, well inside one burst.
 */
export const RATE_LIMITS: Readonly<Record<RateLimitGroup, RateLimit>> = {
  likes: { capacity: 60, perSecond: 1 / 10 },
  comments: { capacity: 20, perSecond: 1 / 30 },
  follows: { capacity: 30, perSecond: 1 / 30 },
  search: { capacity: 60, perSecond: 1 },
  sync_push: { capacity: 120, perSecond: 2 },
};

/** A bucket as stored: how many tokens it held at `atMillis`. */
export interface Bucket {
  readonly tokens: number;
  readonly atMillis: number;
}

export type Take =
  | { readonly allowed: true; readonly bucket: Bucket }
  | { readonly allowed: false; readonly bucket: Bucket; readonly retryAfterSeconds: number };

/**
 * Takes one token from `bucket` at `nowMillis`, after filling it for the time since it was
 * stored. A bucket never seen before starts full. A clock that went back fills nothing. When
 * the bucket is empty, `retryAfterSeconds` is the whole seconds until the next token.
 */
export const takeToken = (
  bucket: Bucket | undefined,
  limit: RateLimit,
  nowMillis: number,
): Take => {
  const elapsed = bucket === undefined ? 0 : Math.max(0, nowMillis - bucket.atMillis) / 1000;
  const tokens =
    bucket === undefined
      ? limit.capacity
      : Math.min(limit.capacity, bucket.tokens + elapsed * limit.perSecond);
  const at = bucket === undefined ? nowMillis : Math.max(nowMillis, bucket.atMillis);
  if (tokens >= 1) return { allowed: true, bucket: { tokens: tokens - 1, atMillis: at } };
  return {
    allowed: false,
    bucket: { tokens, atMillis: at },
    retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / limit.perSecond)),
  };
};

/** What the app says when the server answers that an account sent too many requests. */
export const rateLimitedMessage = (retryAfterSeconds: number | undefined): string => {
  if (retryAfterSeconds === undefined)
    return "That was a lot at once. Wait a moment and try again.";
  if (retryAfterSeconds < 60) {
    return `That was a lot at once. Try again in ${retryAfterSeconds} ${retryAfterSeconds === 1 ? "second" : "seconds"}.`;
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `That was a lot at once. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
};

/** The whole seconds a `Retry-After` header asks for, or undefined when it names none. */
export const retryAfterSeconds = (header: string | null | undefined): number | undefined => {
  if (header === null || header === undefined || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
};
