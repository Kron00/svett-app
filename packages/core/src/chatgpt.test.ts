import { describe, expect, it } from "vite-plus/test";

import {
  type ChatGPTStatus,
  accountLabels,
  decodeChatGPTStatus,
  decodeRenewResult,
  decodeSignInResult,
  decodeSignOutResult,
  describeChatGPT,
  renewProblemMessage,
  signInProblemMessage,
  signOutMessage,
} from "./chatgpt.ts";

const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const T0 = Date.parse("2026-11-13T15:00:00Z");

const signedIn: ChatGPTStatus = {
  state: "signedIn",
  email: "you@example.com",
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  planUsage: true,
  expiresAt: T0 + 3_600_000,
};

describe("what Swift sends", () => {
  it("reads a signed-in status, which carries no token", () => {
    expect(decodeChatGPTStatus({ ...signedIn, renewedAt: T0 })).toEqual({
      ...signedIn,
      renewedAt: T0,
    });
  });

  it("reads a signed-out status with every saved account by its id", () => {
    const status = {
      state: "signedOut",
      accounts: [{ id: "oaiapp_b", email: "b@example.com" }, { id: "oaiapp_a" }],
      returning: { email: "b@example.com" },
      ended: "lapsed",
      unsaved: true,
    };
    expect(decodeChatGPTStatus(status)).toEqual(status);
    expect(decodeChatGPTStatus({ state: "signedOut", accounts: [] })).toEqual({
      state: "signedOut",
      accounts: [],
    });
  });

  it("refuses a status it does not know", () => {
    expect(() => decodeChatGPTStatus({ state: "signedIn" })).toThrow();
    expect(() =>
      decodeChatGPTStatus({ state: "signedOut", accounts: [], ended: "forgotten" }),
    ).toThrow();
    expect(() => decodeChatGPTStatus({ state: "signedOut" })).toThrow();
  });

  it("reads each sign-in result", () => {
    expect(decodeSignInResult({ status: "signedIn", account: signedIn })).toEqual({
      status: "signedIn",
      account: signedIn,
    });
    expect(decodeSignInResult({ status: "failed", problem: "denied" })).toEqual({
      status: "failed",
      problem: "denied",
    });
    expect(decodeSignInResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
  });

  it("reads a renewal and a sign-out", () => {
    expect(decodeRenewResult({ account: signedIn, problem: "unreachable" })).toEqual({
      account: signedIn,
      problem: "unreachable",
    });
    expect(decodeSignOutResult({ revoked: false, cleared: true })).toEqual({
      revoked: false,
      cleared: true,
    });
    expect(() => decodeSignOutResult({ revoked: true })).toThrow();
  });
});

describe("signInProblemMessage", () => {
  it("says why svett turned down each identity token check", () => {
    expect(signInProblemMessage("identity.badSignature")).toBe(
      "svett turned the sign-in down, because the identity token has a signature that does not match OpenAI's published keys. Nothing was saved. Try again.",
    );
    expect(signInProblemMessage("identity.wrongAudience")).toContain("was made for another app");
    expect(signInProblemMessage("identity.expired")).toContain("has expired");
    expect(signInProblemMessage("identity.somethingNew")).toContain("did not pass svett's checks");
  });

  it("words every problem Swift can send", () => {
    const codes = [
      "notTheAddress",
      "otherAttempt",
      "denied",
      "refused",
      "unreachable",
      "timedOut",
      "busy",
      "notRunning",
      "codeExpired",
      "clientRefused",
      "incompleteRegistration",
      "otherClient",
      "otherAccount",
      "nothingPasted",
      "unknownAccount",
      "storage",
    ];
    const messages = codes.map(signInProblemMessage);
    expect(new Set(messages).size).toBe(codes.length);
    expect(signInProblemMessage("otherAccount")).toContain("Use another ChatGPT account");
  });

  it("falls back to a plain refusal for a code it does not know", () => {
    expect(signInProblemMessage("new")).toBe(signInProblemMessage("refused"));
  });
});

describe("renewProblemMessage", () => {
  it("speaks only to problems that leave the sign-in in place", () => {
    expect(renewProblemMessage("unreachable")).toContain("Could not reach OpenAI");
    expect(renewProblemMessage("refused")).toContain("sign out and sign in again");
    expect(renewProblemMessage("lapsed")).toBeUndefined();
    expect(renewProblemMessage(undefined)).toBeUndefined();
  });
});

describe("signOutMessage", () => {
  it("says so when OpenAI did not confirm the revocation", () => {
    expect(signOutMessage({ revoked: true, cleared: true })).toBeUndefined();
    expect(signOutMessage({ revoked: false, cleared: true })).toContain(
      "remove svett in ChatGPT's settings",
    );
  });

  it("says so when the Keychain kept the tokens", () => {
    expect(signOutMessage({ revoked: true, cleared: false })).toContain(
      "could not delete it from this iPhone's Keychain",
    );
    const neither = signOutMessage({ revoked: false, cleared: false });
    expect(neither).toContain("could not delete the sign-in");
    expect(neither).toContain("remove svett in ChatGPT's settings");
  });
});

describe("describeChatGPT", () => {
  it("offers the first sign-in", () => {
    expect(describeChatGPT({ state: "signedOut", accounts: [] }, time)).toEqual({
      rows: [{ title: "ChatGPT", value: "Not signed in" }],
      notice: undefined,
      actions: ["continue"],
      continueAs: undefined,
      otherAccounts: [],
    });
  });

  it("names the account a returning sign-in uses, and offers another", () => {
    const view = describeChatGPT(
      { state: "signedOut", accounts: [{ id: "oaiapp_a", email: "you@example.com" }] },
      time,
    );
    expect(view.rows).toContainEqual({ title: "Last account", value: "you@example.com" });
    expect(view.actions).toEqual(["continue", "anotherAccount"]);
    expect(view.continueAs).toBe("oaiapp_a");
    expect(view.otherAccounts).toEqual([]);
  });

  it("offers a way back to each earlier account by its id", () => {
    const view = describeChatGPT(
      {
        state: "signedOut",
        accounts: [
          { id: "oaiapp_b", email: "b@example.com" },
          { id: "oaiapp_a", email: "you@example.com" },
          { id: "oaiapp_old" },
        ],
      },
      time,
    );
    expect(view.continueAs).toBe("oaiapp_b");
    expect(view.otherAccounts).toEqual([
      { id: "oaiapp_a", label: "you@example.com" },
      { id: "oaiapp_old", label: "ChatGPT account" },
    ]);
  });

  it("says when the Keychain did not take the last change", () => {
    const out = describeChatGPT({ state: "signedOut", accounts: [], unsaved: true }, time);
    expect(out.notice?.tone).toBe("warning");
    expect(out.notice?.text).toContain("Keychain");
    const signedInUnsaved = describeChatGPT({ ...signedIn, unsaved: true }, time);
    expect(signedInUnsaved.notice?.tone).toBe("warning");
    expect(signedInUnsaved.notice?.text).toContain("you may have to sign in again");
  });

  it("says when the sign-in lapsed or ChatGPT dropped the registration", () => {
    const lapsed = describeChatGPT(
      {
        state: "signedOut",
        accounts: [{ id: "oaiapp_a", email: "you@example.com" }],
        ended: "lapsed",
      },
      time,
    );
    expect(lapsed.notice?.tone).toBe("warning");
    expect(lapsed.notice?.text).toContain("30 days");
    const refused = describeChatGPT(
      { state: "signedOut", accounts: [], ended: "clientRefused" },
      time,
    );
    expect(refused.notice?.text).toContain("register svett again");
    expect(refused.actions).toEqual(["continue"]);
  });

  it("shows the account and when the sign-in last renewed itself", () => {
    expect(describeChatGPT(signedIn, time).rows).toEqual([
      { title: "Account", value: "you@example.com" },
      { title: "Plan usage", value: "Allowed" },
      { title: "Sign-in", value: "Renews itself while you use the coach" },
    ]);
    expect(describeChatGPT({ ...signedIn, renewedAt: T0 }, time).rows).toContainEqual({
      title: "Sign-in",
      value: "Renewed at 15:00",
    });
    expect(describeChatGPT(signedIn, time).actions).toEqual(["manageUsage", "signOut"]);
  });

  it("turns the coach off and names the plans when plan usage was not allowed", () => {
    const view = describeChatGPT({ ...signedIn, planUsage: false }, time);
    expect(view.rows).toContainEqual({ title: "Plan usage", value: "Not allowed" });
    expect(view.notice).toEqual({
      tone: "warning",
      text: "ChatGPT did not let svett use your plan, so the coach is off. OpenAI lists Go, Plus, Pro and Business as plans that allow it. A Free plan does not.",
    });
    expect(view.actions).toEqual(["allowPlanUsage", "signOut"]);
  });
});

describe("accountLabels", () => {
  it("tells apart accounts that share an email address or have none", () => {
    expect(
      accountLabels([
        { id: "1", email: "you@example.com" },
        { id: "2", email: "you@example.com" },
        { id: "3" },
        { id: "4", email: "b@example.com" },
      ]),
    ).toEqual(["you@example.com (1)", "you@example.com (2)", "ChatGPT account", "b@example.com"]);
  });
});
