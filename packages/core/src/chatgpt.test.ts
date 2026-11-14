import { describe, expect, it } from "vite-plus/test";

import {
  type ChatGPTStatus,
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

  it("reads a signed-out status with the account the next sign-in returns to", () => {
    const status = { state: "signedOut", returning: { email: "you@example.com" }, ended: "lapsed" };
    expect(decodeChatGPTStatus(status)).toEqual(status);
    expect(decodeChatGPTStatus({ state: "signedOut" })).toEqual({ state: "signedOut" });
  });

  it("refuses a status it does not know", () => {
    expect(() => decodeChatGPTStatus({ state: "signedIn" })).toThrow();
    expect(() => decodeChatGPTStatus({ state: "signedOut", ended: "forgotten" })).toThrow();
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
    expect(decodeSignOutResult({ revoked: false })).toEqual({ revoked: false });
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
    expect(signOutMessage(true)).toBeUndefined();
    expect(signOutMessage(false)).toContain("remove svett in ChatGPT's settings");
  });
});

describe("describeChatGPT", () => {
  it("offers the first sign-in", () => {
    expect(describeChatGPT({ state: "signedOut" }, time)).toEqual({
      rows: [{ title: "ChatGPT", value: "Not signed in" }],
      notice: undefined,
      actions: ["continue"],
    });
  });

  it("names the account a returning sign-in uses, and offers another", () => {
    const view = describeChatGPT(
      { state: "signedOut", returning: { email: "you@example.com" } },
      time,
    );
    expect(view.rows).toContainEqual({ title: "Last account", value: "you@example.com" });
    expect(view.actions).toEqual(["continue", "anotherAccount"]);
  });

  it("says when the sign-in lapsed or ChatGPT dropped the registration", () => {
    const lapsed = describeChatGPT(
      { state: "signedOut", returning: { email: "you@example.com" }, ended: "lapsed" },
      time,
    );
    expect(lapsed.notice?.tone).toBe("warning");
    expect(lapsed.notice?.text).toContain("30 days");
    const refused = describeChatGPT({ state: "signedOut", ended: "clientRefused" }, time);
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
