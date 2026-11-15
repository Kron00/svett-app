import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Schema } from "effect";

import { importedId } from "./ids.ts";
import { ProposalPlan, proposalDraft } from "./proposals.ts";
import { ProposalRepository } from "./repositories/records.ts";
import { EpochMillis, type Proposal, ProposalId } from "./schema.ts";
import { TABLES } from "./table.ts";

/**
 * What a connected assistant may do. Reading and proposing are separate choices on the consent
 * page, and a connection keeps only what the person chose.
 */
export const AssistantScope = Schema.Literals(["svett.read", "svett.propose"]);
export type AssistantScope = typeof AssistantScope.Type;
export const ASSISTANT_SCOPES: ReadonlyArray<AssistantScope> = AssistantScope.literals;

/** How the consent page and Connected apps name each scope. */
export const SCOPE_TEXT: Readonly<
  Record<AssistantScope, { readonly title: string; readonly detail: string }>
> = {
  "svett.read": {
    title: "Read your training",
    detail:
      "Your workouts, exercises, records, routines and body measurements. Never anyone else's, and what your followers see stays as it is.",
  },
  "svett.propose": {
    title: "Propose routines and programs",
    detail: "Each one waits in svett as a proposal. Nothing is saved until you tap Apply.",
  },
};

/**
 * The scopes an authorization request offers the person, in svett's order. A request that names
 * none svett knows, such as one asking only for `openid`, offers both, and the person still
 * chooses on the consent page.
 */
export const requestedScopes = (scope: string | undefined): ReadonlyArray<AssistantScope> => {
  const asked = new Set((scope ?? "").split(" ").filter((word) => word !== ""));
  const known = ASSISTANT_SCOPES.filter((each) => asked.has(each));
  return known.length === 0 ? ASSISTANT_SCOPES : known;
};

/** The scopes as an OAuth `scope` value. */
export const scopeText = (scopes: ReadonlyArray<AssistantScope>): string => scopes.join(" ");

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url, written out because Hermes lacks Uint8Array's base64 methods. */
export const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const chunk = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    text += BASE64URL[(chunk >> 18) & 63]! + BASE64URL[(chunk >> 12) & 63]!;
    if (b !== undefined) text += BASE64URL[(chunk >> 6) & 63]!;
    if (c !== undefined) text += BASE64URL[chunk & 63]!;
  }
  return text;
};

/** RFC 7636's code verifier: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

/** The S256 code challenge of a PKCE code verifier. */
export const pkceChallenge = (verifier: string): string => base64url(sha256(utf8ToBytes(verifier)));

/** Whether `verifier` is a valid code verifier whose S256 challenge is `challenge`. */
export const pkceMatches = (verifier: string, challenge: string): boolean =>
  VERIFIER.test(verifier) && pkceChallenge(verifier) === challenge;

/** The longest client name svett shows. A client chooses its own name, so it is cut. */
export const MAX_CLIENT_NAME = 60;

/** A client's name as svett shows it, or "An assistant" when it gave none. */
export const clientLabel = (name: string | null | undefined): string => {
  const trimmed = (name ?? "").replace(/\s+/gu, " ").trim();
  if (trimmed === "") return "An assistant";
  return trimmed.length <= MAX_CLIENT_NAME ? trimmed : `${trimmed.slice(0, MAX_CLIENT_NAME - 1)}…`;
};

/** One app connected to the signed-in account, as Connected apps lists it. */
export const AssistantConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The host the app sends the person back to after sign-in, such as chatgpt.com. */
  host: Schema.String,
  scopes: Schema.Array(AssistantScope),
  createdAt: Schema.Number,
  /** When it last called a tool that reads the account's data. Null until it first does. */
  lastReadAt: Schema.NullOr(Schema.Number),
});
export type AssistantConnection = typeof AssistantConnection.Type;

export const ConnectionList = Schema.Struct({ connections: Schema.Array(AssistantConnection) });
export type ConnectionList = typeof ConnectionList.Type;

/** What a connection may do, in one line, such as "Read your training". */
export const connectionAccess = (scopes: ReadonlyArray<AssistantScope>): string => {
  const titles = ASSISTANT_SCOPES.filter((scope) => scopes.includes(scope)).map(
    (scope) => SCOPE_TEXT[scope].title,
  );
  if (titles.length === 0) return "Nothing";
  return titles
    .map((title, index) => (index === 0 ? title : title.charAt(0).toLowerCase() + title.slice(1)))
    .join(" and ");
};

/** When a connection last read the account's data, with `formatTime` for the time. */
export const lastReadLine = (lastReadAt: number | null, formatTime: (millis: number) => string) =>
  lastReadAt === null ? "Has not read your data yet" : `Last read your data ${formatTime(lastReadAt)}`;

/** A routine or program a connected assistant proposed, waiting for the phone to take it. */
export const AssistantProposal = Schema.Struct({
  id: Schema.String,
  /** The name of the app that proposed it. */
  from: Schema.String,
  plan: ProposalPlan,
  createdAt: Schema.Number,
});
export type AssistantProposal = typeof AssistantProposal.Type;

export const AssistantProposalList = Schema.Struct({
  proposals: Schema.Array(AssistantProposal),
});
export type AssistantProposalList = typeof AssistantProposalList.Type;

/** The server's side of taking proposals: the ones waiting, and saying which the phone holds. */
export interface AssistantProposalSource<E> {
  readonly waiting: Effect.Effect<AssistantProposalList, E>;
  readonly received: (ids: ReadonlyArray<string>) => Effect.Effect<unknown, E>;
}

/** The local ID of a proposal the server holds as `serverId`, the same on every try. */
export const assistantProposalId = (serverId: string): ProposalId =>
  ProposalId.make(importedId(TABLES.proposal.name, "assistant", serverId));

/**
 * Stores each proposal the server holds for the account as a pending proposal on this phone,
 * then tells the server it has them. A proposal the phone took before, even one dismissed and
 * removed since, is not stored again, so a lost answer and a retry add nothing twice. Gives
 * back how many it stored.
 */
export const receiveAssistantProposals = <E>(source: AssistantProposalSource<E>) =>
  Effect.gen(function* () {
    const { proposals } = yield* source.waiting;
    if (proposals.length === 0) return 0;
    const repository = yield* ProposalRepository;
    let stored = 0;
    for (const proposal of proposals) {
      const added = yield* repository.receive(
        assistantProposalId(proposal.id),
        proposalDraft(proposal.plan, "assistant", null),
        EpochMillis.make(proposal.createdAt),
      );
      if (added) stored++;
    }
    yield* source.received(proposals.map(({ id }) => id));
    return stored;
  });

/** The proposals connected assistants made that wait for Apply, newest first. */
export const waitingAssistantProposals = (
  proposals: ReadonlyArray<Proposal>,
): ReadonlyArray<ProposalId> =>
  proposals
    .filter((proposal) => proposal.origin === "assistant" && proposal.status === "pending")
    .map(({ id }) => id);
