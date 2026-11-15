import { createHash, randomBytes, randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  type AccountId,
  type AssistantConnection,
  type AssistantProposal,
  type AssistantScope,
  ASSISTANT_SCOPES,
  ProposalPlan,
  RECENT_ACCESS_COUNT,
  scopeText,
} from "@svett/core";
import { Clock, Context, Data, Effect, Layer, Option, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/** How long each kind of secret lasts. A refresh token's time starts again at each refresh. */
export const LIFETIME_MS = {
  code: 5 * 60_000,
  access: 60 * 60_000,
  refresh: 60 * 24 * 60 * 60_000,
} as const;

/** How long a registered client may wait for its first connection before it is removed. */
export const UNCONNECTED_CLIENT_MS = 24 * 60 * 60_000;

/** How long the access log keeps an entry. */
export const ACCESS_LOG_MS = 90 * 24 * 60 * 60_000;

/** A new secret: 32 random bytes, with a prefix that says what it is. */
export const newSecret = (kind: "code" | "at" | "rt") =>
  `svett_${kind}_${randomBytes(32).toString("base64url")}`;

/** The only form of a code or token the database keeps. */
export const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** The client was removed, by the day's cleanup, after the token endpoint read it. */
export class ClientGone extends Data.TaggedError("ClientGone")<{}> {}

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
  /**
   * Removes the clients registered before `nowMillis` less `UNCONNECTED_CLIENT_MS` that never
   * connected an account and hold no unexpired code, with their codes. Gives back how many it
   * removed.
   */
  readonly expireClients: (nowMillis: number) => Effect.Effect<number, SqlError>;
  /**
   * Stores a new authorization code and gives back the code itself, which is never stored.
   * None when the client is gone.
   */
  readonly createCode: (
    code: Omit<AuthorizationCode, "expiresMs">,
    nowMillis: number,
  ) => Effect.Effect<Option.Option<string>, SqlError>;
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
  ) => Effect.Effect<Tokens, SqlError | ClientGone>;
  /**
   * The account a refresh token belongs to, while it is valid for the client or after its
   * connection spent it.
   */
  readonly refreshOwner: (
    refreshToken: string,
    clientId: string,
    nowMillis: number,
  ) => Effect.Effect<Option.Option<AccountId>, SqlError>;
  /**
   * Replaces both tokens of the connection that holds `refreshToken`, so the old ones stop
   * working, and keeps the spent token's hash. A spent token that comes back means someone else
   * holds a copy, so it deletes the connection, which ends every token it has (RFC 9700
   * section 4.14.2). None when the token is not valid any more. Run it as the account.
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
  /** The account's connections, each with its latest access log entries, newest first. */
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
        expireClients: (nowMillis) =>
          sql.withTransaction(
            Effect.gen(function* () {
              // Holding the clients first means a code issued for one either committed before
              // the check below reads the codes, or waits and then finds its client gone.
              const candidates = yield* sql<{ readonly id: string }>`
                select id from oauth_client
                where connected_ms is null and created_ms < ${nowMillis - UNCONNECTED_CLIENT_MS}
                order by id
                for update
              `;
              if (candidates.length === 0) return 0;
              const removed = yield* sql<{ readonly id: string }>`
                delete from oauth_client
                where id in ${sql.in(candidates.map(({ id }) => id))}
                  and not exists (
                    select 1 from oauth_code
                    where oauth_code.client_id = oauth_client.id
                      and oauth_code.expires_ms > ${nowMillis}
                  )
                returning id
              `;
              const ids = removed.map(({ id }) => id);
              if (ids.length > 0)
                yield* sql`delete from oauth_code where client_id in ${sql.in(ids)}`;
              return ids.length;
            }),
          ),
        createCode: (code, nowMillis) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const [client] = yield* sql`
                select 1 from oauth_client where id = ${code.clientId} for share
              `;
              if (client === undefined) return Option.none();
              const secret = newSecret("code");
              yield* sql`
              insert into oauth_code
                (code_hash, client_id, account_id, redirect_uri, code_challenge, scopes, expires_ms)
              values (${secretHash(secret)}, ${code.clientId}, ${code.accountId},
                ${code.redirectUri}, ${code.codeChallenge}, ${scopeText(code.scopes)},
                ${nowMillis + LIFETIME_MS.code})
            `;
              return Option.some(secret);
            }),
          ),
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
            const marked = yield* sql<{ readonly id: string }>`
              update oauth_client set connected_ms = coalesce(connected_ms, ${nowMillis})
              where id = ${client.id}
              returning id
            `;
            if (marked.length === 0) return yield* new ClientGone();
            yield* sql`
              delete from assistant_refresh_used
              where connection_id in (
                select id from assistant_connection
                where account_id = ${code.accountId} and client_id = ${client.id}
              )
            `;
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
              union all
              select used.account_id from assistant_refresh_used used
              join assistant_connection connection on connection.id = used.connection_id
              where used.refresh_hash = ${secretHash(refreshToken)}
                and connection.client_id = ${clientId}
              limit 1
            `,
            ([row]) => Option.fromNullishOr(row?.accountId),
          ),
        refresh: (refreshToken, clientId, nowMillis) =>
          Effect.gen(function* () {
            const tokens = newTokens(nowMillis);
            const spent = secretHash(refreshToken);
            // The update holds the connection's row, so of two refreshes with one token the
            // second waits, then finds the token spent below and deletes the connection.
            const [row] = yield* sql<{
              readonly id: string;
              readonly accountId: AccountId;
              readonly scopes: string;
            }>`
              update assistant_connection
              set access_hash = ${tokens.accessHash}, access_expires_ms = ${tokens.accessExpires},
                refresh_hash = ${tokens.refreshHash}, refresh_expires_ms = ${tokens.refreshExpires}
              where refresh_hash = ${spent} and client_id = ${clientId}
                and refresh_expires_ms > ${nowMillis}
              returning id, account_id as "accountId", scopes
            `;
            if (row === undefined) {
              const reused = yield* sql<{ readonly connectionId: string }>`
                select used.connection_id as "connectionId"
                from assistant_refresh_used used
                join assistant_connection connection on connection.id = used.connection_id
                where used.refresh_hash = ${spent} and connection.client_id = ${clientId}
              `;
              const ids = reused.map(({ connectionId }) => connectionId);
              if (ids.length > 0) {
                yield* sql`delete from assistant_refresh_used where connection_id in ${sql.in(ids)}`;
                yield* sql`delete from assistant_connection where id in ${sql.in(ids)}`;
              }
              return Option.none();
            }
            yield* sql`
              insert into assistant_refresh_used (refresh_hash, connection_id, account_id, used_ms)
              values (${spent}, ${row.id}, ${row.accountId}, ${nowMillis})
            `;
            // A token spent this long ago had expired anyway, so its hash proves nothing more.
            yield* sql`
              delete from assistant_refresh_used
              where connection_id = ${row.id} and used_ms < ${nowMillis - LIFETIME_MS.refresh}
            `;
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
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const rows = yield* sql<{
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
            `;
            const entries = yield* sql<{
              readonly id: string;
              readonly connectionId: string;
              readonly tool: string;
              readonly atMs: string;
            }>`
              select id, connection_id as "connectionId", tool, at_ms as "atMs" from (
                select id, connection_id, tool, at_ms,
                  row_number() over (partition by connection_id order by at_ms desc, id desc) as n
                from assistant_access
                where account_id = ${account} and at_ms >= ${now - ACCESS_LOG_MS}
              ) latest
              where n <= ${RECENT_ACCESS_COUNT}
              order by at_ms desc, n
            `;
            return rows.map((row) => ({
              id: row.id,
              name: row.name,
              host: row.host,
              scopes: scopesOf(row.scopes),
              createdAt: Number(row.createdMs),
              lastReadAt: row.lastReadMs === null ? null : Number(row.lastReadMs),
              recentAccess: entries
                .filter(({ connectionId }) => connectionId === row.id)
                .map((entry) => ({ id: entry.id, tool: entry.tool, at: Number(entry.atMs) })),
            }));
          }),
        revoke: (account, connectionId) =>
          Effect.gen(function* () {
            yield* sql`
              delete from assistant_refresh_used
              where account_id = ${account} and connection_id = ${connectionId}
            `;
            const removed = yield* sql`
              delete from assistant_connection
              where account_id = ${account} and id = ${connectionId}
              returning id
            `;
            return removed.length > 0;
          }),
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
