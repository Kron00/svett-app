import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";

export interface StandInIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  /**
   * A session token for `sub`, signed like Clerk's with the published key. `claims` override
   * the defaults, and `key: "unpublished"` signs with a key the key set does not list.
   */
  readonly sessionToken: (
    sub: string,
    options?: { readonly claims?: JWTPayload; readonly key?: "published" | "unpublished" },
  ) => Promise<string>;
  /** The secret key the stand-in's Backend API takes, and the API's address. */
  readonly secretKey: string;
  readonly apiUrl: string;
  /** The users deleted through the Backend API, in order. */
  readonly deletedUsers: () => ReadonlyArray<string>;
  /** Makes the Backend API answer every request with this status, or as Clerk does again. */
  readonly failBackendApi: (status: number | undefined) => void;
  readonly stop: () => Promise<void>;
}

const SECRET_KEY = "sk_test_stand_in";

/**
 * A local stand-in for a Clerk instance's Frontend API. It publishes a key set at the path Clerk
 * uses and signs session tokens the way Clerk does, with RS256 and a key ID. Its Backend API
 * deletes users as Clerk's does, at `DELETE /v1/users/:id`, and a deleted user's sessions end:
 * it signs no new token for them. A token signed before stays valid until it expires, as one
 * of Clerk's does.
 */
export const startStandInIssuer = async (): Promise<StandInIssuer> => {
  const published = await generateKeyPair("RS256");
  const unpublished = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(published.publicKey)),
    kid: "stand-in",
    alg: "RS256",
    use: "sig",
  };

  const deleted: Array<string> = [];
  let failing: number | undefined;
  const server = createServer((request, response) => {
    const user = /^\/v1\/users\/([^/?]+)$/.exec(request.url ?? "");
    if (user?.[1] !== undefined && request.method === "DELETE") {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (failing !== undefined) return json(failing, { errors: [{ code: "unavailable" }] });
      if (request.headers.authorization !== `Bearer ${SECRET_KEY}`) {
        return json(401, { errors: [{ code: "authentication_invalid" }] });
      }
      const id = decodeURIComponent(user[1]);
      if (deleted.includes(id)) return json(404, { errors: [{ code: "resource_not_found" }] });
      deleted.push(id);
      return json(200, { id, object: "user", deleted: true });
    }
    if (request.url === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  return {
    issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    secretKey: SECRET_KEY,
    apiUrl: issuer,
    deletedUsers: () => [...deleted],
    failBackendApi: (status) => {
      failing = status;
    },
    sessionToken: async (sub, options = {}) => {
      if (deleted.includes(sub)) throw new Error(`Clerk ended every session of ${sub}.`);
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iss: issuer,
        sub,
        sid: `sess_${sub}`,
        iat: now,
        nbf: now - 5,
        exp: now + 60,
        v: 2,
        ...options.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "stand-in", typ: "JWT" })
        .sign(options.key === "unpublished" ? unpublished.privateKey : published.privateKey);
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
