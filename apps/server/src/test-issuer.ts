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
  readonly stop: () => Promise<void>;
}

/**
 * A local stand-in for a Clerk instance's Frontend API. It publishes a key set at the path Clerk
 * uses and signs session tokens the way Clerk does, with RS256 and a key ID.
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

  const server = createServer((request, response) => {
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
    sessionToken: (sub, options = {}) => {
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
