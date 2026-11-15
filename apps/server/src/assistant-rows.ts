import { createHash, randomBytes, randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  type AssistantConnection,
  type AssistantProposal,
  type AssistantScope,
  ASSISTANT_SCOPES,
  ProposalPlan,
  scopeText,
} from "@svett/core";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/** How long each kind of secret lasts. A refresh token's time starts again at each refresh. */
export const LIFETIME_MS = {
  code: 5 * 60_000,
  access: 60 * 60_000,
  refresh: 60 * 24 * 60 * 60_000,
} as const;

/** How long the access log keeps an entry. */
export const ACCESS_LOG_MS = 90 * 24 * 60 * 60_000;

/** A new secret: 32 random bytes, with a prefix that says what it is. */
export const newSecret = (kind: "code" | "at" | "rt") =>
  `svett_${kind}_${randomBytes(32).toString("base64url")}`;

/** The only form of a code or token the database keeps. */
export const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export interface OAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
}

export interface AuthorizationCode {
  readonly clientId: string;
  readonly accountId: AccountId;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: ReadonlyArray<AssistantScope>;
  readonly expiresMs: number;
}

/** What a valid access token stands for. */
export interface Grant {
  readonly connectionId: string;
  readonly accountId: AccountId;
  readonly name: string;
  readonly scopes: ReadonlyArray<AssistantScope>;
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly scopes: ReadonlyArray<AssistantScope>;
}

export interface AssistantRowsShape {
  readonly registerClient: (client: {
    readonly name: string;
    readonly redirectUris: ReadonlyArray<string>;
    readonly nowMillis: number;
  }) => Effect.Effect<string, SqlError>;
  readonly client: (id: string) => Effect.Effect<Option.Option<OAuthClient>, SqlError>;
  /** Stores a new authorization code and gives back the code itself, which is never stored. */
  readonly createCode: (
    code: Omit<AuthorizationCode, "expiresMs">,
    nowMillis: number,
  ) => Effect.Effect<string, SqlError>;
  /** Takes the code out for good, so a code works once, valid or not. */
  readonly takeCode: (code: string) => Effect.Effect<Option.Option<AuthorizationCode>, SqlError>;
  /**
   * Connects the client to the account with the code's scopes, replacing any connection the
   * same client had to the account, and gives back its first tokens. Run it as the account.
   */
  readonly connect: (
    code: AuthorizationCode,
    client: OAuthClient,
    nowMillis: number,
  ) => Effect.Effect<Tokens, SqlError>;
  /** The account a refresh token belongs to, while it is valid for the client. */
  readonly refreshOwner: (
    refreshToken: string,
    clientId: string,
    nowMillis: number,
  ) => Effect.Effect<Option.Option<AccountId>, SqlError>;
  /**
   * Replaces both tokens of the connection that holds `refreshToken`, so the old ones stop
   * working. None when the token is not valid any more. Run it as the account.
   */
  readonly refresh: (
    refreshToken: string,
    clientId: string,
    nowMillis: number,
  ) => Effect.Effect<Option.Option<Tokens>, SqlError>;
  /** The connection an access token stands for, while the token is valid. */
  readonly grantOf: (
    accessToken: string,
    nowMillis: number,
  ) => Effect.Effect<Option.Option<Grant>, SqlError>;
  /**
   * Whether the connection is still there, holding it until the running transaction ends, so
   * a revoke waits for a tool call already running and every later call sees it gone.
   */
  readonly holdConnection: (connectionId: string) => Effect.Effect<boolean, SqlError>;
  /** Records a tool call in the access log, and when it read the account's data. */
  readonly logAccess: (
    grant: Grant,
    tool: string,
    read: boolean,
    nowMillis: number,
  ) => Effect.Effect<void, SqlError>;
  readonly connections: (
    account: AccountId,
  ) => Effect.Effect<ReadonlyArray<AssistantConnection>, SqlError>;
  /** Deletes the connection and its tokens. Gives back whether the account had it. */
  readonly revoke: (account: AccountId, connectionId: string) => Effect.Effect<boolean, SqlError>;
  /** Keeps a plan a connected app proposed until the phone takes it. Gives back its ID. */
  readonly propose: (
    grant: Grant,
    plan: ProposalPlan,
    nowMillis: number,
  ) => Effect.Effect<string, SqlError>;
  readonly waitingProposals: (
    account: AccountId,
  ) => Effect.Effect<ReadonlyArray<AssistantProposal>, SqlError>;
  /** Forgets the proposals the phone now holds. Gives back how many it forgot. */
  readonly proposalsReceived: (
    account: AccountId,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<number, SqlError>;
}

/** A connection's next pair of tokens, with the hashes and ends the database keeps. */
const newTokens = (nowMillis: number) => {
  const accessToken = newSecret("at");
  const refreshToken = newSecret("rt");
  return {
    accessToken,
    refreshToken,
    accessHash: secretHash(accessToken),
    refreshHash: secretHash(refreshToken),
    accessExpires: nowMillis + LIFETIME_MS.access,
    refreshExpires: nowMillis + LIFETIME_MS.refresh,
  };
};

/** The scopes a stored scope list names, in svett's order. */
const scopesOf = (stored: string): ReadonlyArray<AssistantScope> => {
  const named = new Set(stored.split(" "));
  return ASSISTANT_SCOPES.filter((scope) => named.has(scope));
};

const encodePlan = Schema.encodeSync(ProposalPlan);
const decodePlan = Schema.decodeUnknownOption(ProposalPlan);

/** The most proposals the phone takes in one answer. The rest wait for the next. */
const PROPOSAL_PAGE = 50;

export class AssistantRows extends Context.Service<AssistantRows, AssistantRowsShape>()(
  "svett/server/AssistantRows",
) {
  static readonly layer: Layer.Layer<AssistantRows, never, PgClient.PgClient> = Layer.effect(
    AssistantRows,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      return AssistantRows.of({
        registerClient: ({ name, redirectUris, nowMillis }) =>
          Effect.gen(function* () {
            const id = `svett_client_${randomUUID()}`;
            yield* sql`
              insert into oauth_client (id, name, redirect_uris, created_ms)
              values (${id}, ${name}, ${JSON.stringify(redirectUris)}::jsonb, ${nowMillis})
            `;
            return id;
          }),
        client: (id) =>
          Effect.map(
            sql<{ readonly id: string; readonly name: string; readonly redirectUris: unknown }>`
              select id, name, redirect_uris as "redirectUris" from oauth_client where id = ${id}
            `,
            ([row]) =>
              row === undefined
                ? Option.none()
                : Option.some({
                    id: row.id,
                    name: row.name,
                    redirectUris: Array.isArray(row.redirectUris)
                      ? row.redirectUris.filter((uri): uri is string => typeof uri === "string")
                      : [],
                  }),
          ),
        createCode: (code, nowMillis) =>
          Effect.gen(function* () {
            const secret = newSecret("code");
            yield* sql`
              insert into oauth_code
                (code_hash, client_id, account_id, redirect_uri, code_challenge, scopes, expires_ms)
              values (${secretHash(secret)}, ${code.clientId}, ${code.accountId},
                ${code.redirectUri}, ${code.codeChallenge}, ${scopeText(code.scopes)},
                ${nowMillis + LIFETIME_MS.code})
            `;
            return secret;
          }),
        takeCode: (code) =>
          Effect.map(
            sql<{
              readonly clientId: string;
              readonly accountId: AccountId;
              readonly redirectUri: string;
              readonly codeChallenge: string;
              readonly scopes: string;
              readonly expiresMs: string;
            }>`
              delete from oauth_code where code_hash = ${secretHash(code)}
              returning client_id as "clientId", account_id as "accountId",
                redirect_uri as "redirectUri", code_challenge as "codeChallenge", scopes,
                expires_ms as "expiresMs"
            `,
            ([row]) =>
              row === undefined
                ? Option.none()
                : Option.some({
                    ...row,
                    scopes: scopesOf(row.scopes),
                    expiresMs: Number(row.expiresMs),
                  }),
          ),
        connect: (code, client, nowMillis) =>
          Effect.gen(function* () {
            const tokens = newTokens(nowMillis);
            yield* sql`
              delete from assistant_connection
              where account_id = ${code.accountId} and client_id = ${client.id}
            `;
            yield* sql`
              insert into assistant_connection
                (id, account_id, client_id, name, host, scopes, created_ms, access_hash,
                 access_expires_ms, refresh_hash, refresh_expires_ms)
              values (${randomUUID()}, ${code.accountId}, ${client.id}, ${client.name},
                ${new URL(code.redirectUri).host}, ${scopeText(code.scopes)}, ${nowMillis},
                ${tokens.accessHash}, ${tokens.accessExpires}, ${tokens.refreshHash},
                ${tokens.refreshExpires})
            `;
            return {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresInSeconds: LIFETIME_MS.access / 1000,
              scopes: code.scopes,
            };
          }),
        refreshOwner: (refreshToken, clientId, nowMillis) =>
          Effect.map(
            sql<{ readonly accountId: AccountId }>`
              select account_id as "accountId" from assistant_connection
              where refresh_hash = ${secretHash(refreshToken)} and client_id = ${clientId}
                and refresh_expires_ms > ${nowMillis}
            `,
            ([row]) => Option.fromNullishOr(row?.accountId),
          ),
        refresh: (refreshToken, clientId, nowMillis) =>
          Effect.gen(function* () {
            const tokens = newTokens(nowMillis);
            const [row] = yield* sql<{ readonly scopes: string }>`
              update assistant_connection
              set access_hash = ${tokens.accessHash}, access_expires_ms = ${tokens.accessExpires},
                refresh_hash = ${tokens.refreshHash}, refresh_expires_ms = ${tokens.refreshExpires}
              where refresh_hash = ${secretHash(refreshToken)} and client_id = ${clientId}
                and refresh_expires_ms > ${nowMillis}
              returning scopes
            `;
            if (row === undefined) return Option.none();
            return Option.some({
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresInSeconds: LIFETIME_MS.access / 1000,
              scopes: scopesOf(row.scopes),
            });
          }),
        grantOf: (accessToken, nowMillis) =>
          Effect.map(
            sql<Omit<Grant, "scopes"> & { readonly scopes: string }>`
              select id as "connectionId", account_id as "accountId", name, scopes
              from assistant_connection
              where access_hash = ${secretHash(accessToken)} and access_expires_ms > ${nowMillis}
            `,
            ([row]) =>
              row === undefined
                ? Option.none()
                : Option.some({ ...row, scopes: scopesOf(row.scopes) }),
          ),
        holdConnection: (connectionId) =>
          Effect.map(
            sql`select 1 from assistant_connection where id = ${connectionId} for share`,
            (rows) => rows.length > 0,
          ),
        logAccess: (grant, tool, read, nowMillis) =>
          Effect.gen(function* () {
            yield* sql`
              insert into assistant_access (id, account_id, connection_id, tool, at_ms)
              values (${randomUUID()}, ${grant.accountId}, ${grant.connectionId}, ${tool},
                ${nowMillis})
            `;
            yield* sql`
              delete from assistant_access
              where account_id = ${grant.accountId} and at_ms < ${nowMillis - ACCESS_LOG_MS}
            `;
            if (read) {
              yield* sql`
                update assistant_connection set last_read_ms = ${nowMillis}
                where id = ${grant.connectionId}
              `;
            }
          }),
        connections: (account) =>
          Effect.map(
            sql<{
              readonly id: string;
              readonly name: string;
              readonly host: string;
              readonly scopes: string;
              readonly createdMs: string;
              readonly lastReadMs: string | null;
            }>`
              select id, name, host, scopes, created_ms as "createdMs",
                last_read_ms as "lastReadMs"
              from assistant_connection where account_id = ${account}
              order by created_ms desc, id
            `,
            (rows) =>
              rows.map((row) => ({
                id: row.id,
                name: row.name,
                host: row.host,
                scopes: scopesOf(row.scopes),
                createdAt: Number(row.createdMs),
                lastReadAt: row.lastReadMs === null ? null : Number(row.lastReadMs),
              })),
          ),
        revoke: (account, connectionId) =>
          Effect.map(
            sql`
              delete from assistant_connection
              where account_id = ${account} and id = ${connectionId}
              returning id
            `,
            (rows) => rows.length > 0,
          ),
        propose: (grant, plan, nowMillis) =>
          Effect.gen(function* () {
            const id = randomUUID();
            yield* sql`
              insert into assistant_proposal
                (id, account_id, connection_id, source_name, plan, created_ms)
              values (${id}, ${grant.accountId}, ${grant.connectionId}, ${grant.name},
                ${JSON.stringify(encodePlan(plan))}::jsonb, ${nowMillis})
            `;
            return id;
          }),
        waitingProposals: (account) =>
          Effect.map(
            sql<{
              readonly id: string;
              readonly sourceName: string;
              readonly plan: unknown;
              readonly createdMs: string;
            }>`
              select id, source_name as "sourceName", plan, created_ms as "createdMs"
              from assistant_proposal where account_id = ${account}
              order by created_ms, id
              limit ${PROPOSAL_PAGE}
            `,
            (rows) =>
              rows.flatMap((row) =>
                Option.match(decodePlan(row.plan), {
                  onNone: () => [],
                  onSome: (plan) => [
                    { id: row.id, from: row.sourceName, plan, createdAt: Number(row.createdMs) },
                  ],
                }),
              ),
          ),
        proposalsReceived: (account, ids) =>
          ids.length === 0
            ? Effect.succeed(0)
            : Effect.map(
                sql`
                  delete from assistant_proposal
                  where account_id = ${account} and id in ${sql.in(ids)}
                  returning id
                `,
                (rows) => rows.length,
              ),
      });
    }),
  );
}
