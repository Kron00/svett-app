import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AccountId, ANONYMOUS, databaseFileName } from "./database.ts";

describe("databaseFileName", () => {
  it("keeps data without an owner and each account in separate files", () => {
    expect(databaseFileName(ANONYMOUS)).toBe("svett-anonymous.db");
    expect(databaseFileName({ kind: "account", accountId: AccountId.make("user_2abc") })).toBe(
      "svett-account-user_2abc.db",
    );
  });

  it.each(["", "../other", "a/b", "a b", "a.db"])("refuses the account ID %j", (input) => {
    expect(() => Schema.decodeUnknownSync(AccountId)(input)).toThrow();
  });
});
