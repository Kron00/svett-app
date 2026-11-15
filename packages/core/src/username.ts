import { Schema } from "effect";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Names nobody may take, because they would pass for svett itself, a role, or a screen.
 * A name matches one when it equals it after dropping its periods and underscores.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "about",
  "account",
  "admin",
  "administrator",
  "api",
  "app",
  "everyone",
  "explore",
  "feed",
  "follow",
  "followers",
  "following",
  "help",
  "inbox",
  "login",
  "logout",
  "me",
  "moderator",
  "null",
  "official",
  "privacy",
  "profile",
  "requests",
  "root",
  "search",
  "security",
  "settings",
  "signin",
  "signout",
  "signup",
  "staff",
  "support",
  "svett",
  "system",
  "team",
  "terms",
  "undefined",
  "user",
  "www",
]);

/** Why `name` cannot be a username, or undefined when it can. */
export const usernameProblem = (name: string): string | undefined => {
  if (name.length < USERNAME_MIN) return `A username has at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `A username has at most ${USERNAME_MAX} characters.`;
  if (!/^[A-Za-z0-9._]+$/.test(name)) return "Use only letters, digits, periods and underscores.";
  if (!/^[A-Za-z0-9]/.test(name)) return "Start with a letter or a digit.";
  if (name.endsWith(".")) return "A username cannot end with a period.";
  if (name.includes("..")) return "A username cannot have two periods in a row.";
  if (RESERVED_USERNAMES.has(name.toLowerCase().replace(/[._]/g, ""))) {
    return "That username is reserved.";
  }
  return undefined;
};

/** A username as its owner typed it. Two that differ only in case are the same username. */
export const Username = Schema.String.check(
  Schema.makeFilter((name: string) => usernameProblem(name)),
).pipe(Schema.brand("Username"));
export type Username = typeof Username.Type;

/** The form usernames are unique and searched by. */
export const usernameKey = (name: string) => name.toLowerCase();

/**
 * The prefix a search for `text` looks for, or undefined when no username could start
 * with it. A leading @ is dropped, as people type one before a name.
 */
export const usernamePrefix = (text: string): string | undefined => {
  const prefix = usernameKey(text.trim().replace(/^@/, ""));
  return prefix.length > 0 && prefix.length <= USERNAME_MAX && /^[a-z0-9._]+$/.test(prefix)
    ? prefix
    : undefined;
};
