import { Redacted } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { connectionFor } from "./pg-tools.ts";

describe("connectionFor", () => {
  it("keeps the password out of the address the tools see on their command line", () => {
    expect(
      connectionFor(
        Redacted.make("postgres://svett:p%40ss%2Fw%3Ard@db:5432/svett?sslmode=disable"),
      ),
    ).toEqual({ dbname: "postgres://svett@db:5432/svett?sslmode=disable", password: "p@ss/w:rd" });
  });

  it("leaves the password unset when the address has none", () => {
    expect(connectionFor(Redacted.make("postgres://svett@db/svett"))).toEqual({
      dbname: "postgres://svett@db/svett",
      password: undefined,
    });
  });
});
