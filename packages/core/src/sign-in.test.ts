import { describe, expect, it } from "vite-plus/test";

import {
  clerkErrorCode,
  emailProblem,
  isNewAccount,
  normalizeCode,
  shouldOfferMove,
  SIGN_IN_START,
  type SignInEvent,
  type SignInState,
  signInProblemMessage,
  signInStep,
} from "./sign-in.ts";

const walk = (...events: ReadonlyArray<SignInEvent>): SignInState =>
  events.reduce(signInStep, SIGN_IN_START);

describe("signing in with email", () => {
  it("sends a code to the typed address and signs in with it", () => {
    const states = [
      walk({ type: "chooseEmail" }),
      walk({ type: "chooseEmail" }, { type: "editEmail", email: " Lifter@Example.com " }),
      walk(
        { type: "chooseEmail" },
        { type: "editEmail", email: " Lifter@Example.com " },
        { type: "sendCode" },
      ),
      walk(
        { type: "chooseEmail" },
        { type: "editEmail", email: "lifter@example.com" },
        { type: "sendCode" },
        { type: "codeSent" },
        { type: "editCode", code: "424 242" },
        { type: "checkCode" },
      ),
      walk(
        { type: "chooseEmail" },
        { type: "editEmail", email: "lifter@example.com" },
        { type: "sendCode" },
        { type: "codeSent" },
        { type: "editCode", code: "424242" },
        { type: "checkCode" },
        { type: "signedIn" },
      ),
    ];
    expect(states).toEqual([
      { step: "email", email: "", from: "typed", sending: false },
      { step: "email", email: " Lifter@Example.com ", from: "typed", sending: false },
      { step: "email", email: "lifter@example.com", from: "typed", sending: true },
      { step: "code", email: "lifter@example.com", code: "424242", checking: true },
      { step: "signedIn" },
    ]);
  });

  it("asks for a real address before it sends anything", () => {
    expect(
      walk({ type: "chooseEmail" }, { type: "editEmail", email: "lifter" }, { type: "sendCode" }),
    ).toEqual({
      step: "email",
      email: "lifter",
      from: "typed",
      sending: false,
      problem: "Enter an email address, like name@example.com.",
    });
  });

  it("asks for all six digits before it checks the code", () => {
    const state = walk(
      { type: "chooseEmail" },
      { type: "editEmail", email: "lifter@example.com" },
      { type: "sendCode" },
      { type: "codeSent" },
      { type: "editCode", code: "4242" },
      { type: "checkCode" },
    );
    expect(state).toEqual({
      step: "code",
      email: "lifter@example.com",
      code: "4242",
      checking: false,
      problem: "Enter the six-digit code from the email.",
    });
  });

  it("clears a refused code and says why", () => {
    const state = walk(
      { type: "chooseEmail" },
      { type: "editEmail", email: "lifter@example.com" },
      { type: "sendCode" },
      { type: "codeSent" },
      { type: "editCode", code: "111111" },
      { type: "checkCode" },
      { type: "failed", problem: signInProblemMessage("form_code_incorrect") },
    );
    expect(state).toEqual({
      step: "code",
      email: "lifter@example.com",
      code: "",
      checking: false,
      problem: "That code is not right. Check the email and try again.",
    });
  });

  it("keeps the address when sending fails, so the person can try again", () => {
    const state = walk(
      { type: "chooseEmail" },
      { type: "editEmail", email: "lifter@example.com" },
      { type: "sendCode" },
      { type: "failed", problem: "offline" },
    );
    expect(state).toEqual({
      step: "email",
      email: "lifter@example.com",
      from: "typed",
      sending: false,
      problem: "offline",
    });
  });

  it("ignores edits and repeat presses while a request is out", () => {
    const sending = walk(
      { type: "chooseEmail" },
      { type: "editEmail", email: "lifter@example.com" },
      { type: "sendCode" },
    );
    expect(signInStep(sending, { type: "editEmail", email: "other@example.com" })).toBe(sending);
    expect(signInStep(sending, { type: "sendCode" })).toBe(sending);
    expect(signInStep(sending, { type: "back" })).toBe(sending);
  });

  it("goes back one step at a time", () => {
    const code = walk(
      { type: "chooseEmail" },
      { type: "editEmail", email: "lifter@example.com" },
      { type: "sendCode" },
      { type: "codeSent" },
    );
    const email = signInStep(code, { type: "back" });
    expect(email).toEqual({
      step: "email",
      email: "lifter@example.com",
      from: "typed",
      sending: false,
    });
    expect(signInStep(email, { type: "back" })).toEqual({ step: "choose" });
  });
});

describe("Continue with ChatGPT", () => {
  it("fills in the address ChatGPT verified, and still asks for the email code", () => {
    const filled = walk(
      { type: "chooseChatGPT" },
      { type: "chatGPTEnded", email: "Lifter@Example.com" },
    );
    expect(filled).toEqual({
      step: "email",
      email: "lifter@example.com",
      from: "chatgpt",
      sending: false,
    });
    expect(signInStep(signInStep(filled, { type: "sendCode" }), { type: "codeSent" })).toEqual({
      step: "code",
      email: "lifter@example.com",
      code: "",
      checking: false,
    });
  });

  it("returns to the choice when the ChatGPT sign-in gives no address", () => {
    expect(walk({ type: "chooseChatGPT" }, { type: "chatGPTEnded", email: null })).toEqual({
      step: "choose",
    });
    expect(
      walk(
        { type: "chooseChatGPT" },
        { type: "chatGPTEnded", email: null, problem: "ChatGPT did not share an email address." },
      ),
    ).toEqual({ step: "choose", problem: "ChatGPT did not share an email address." });
  });

  it("marks a filled-in address as typed once the person edits it", () => {
    const state = walk(
      { type: "chooseChatGPT" },
      { type: "chatGPTEnded", email: "lifter@example.com" },
      { type: "editEmail", email: "other@example.com" },
    );
    expect(state).toMatchObject({ from: "typed", email: "other@example.com" });
  });
});

describe("input rules", () => {
  it("accepts an email address and refuses anything else", () => {
    expect(emailProblem("a@b.co")).toBeUndefined();
    expect(emailProblem("  A@B.CO ")).toBeUndefined();
    for (const bad of ["", "a", "a@b", "a b@c.de", "@b.co"]) {
      expect(emailProblem(bad)).toBe("Enter an email address, like name@example.com.");
    }
  });

  it("keeps the digits of a typed or pasted code, at most six", () => {
    expect(normalizeCode("424 242")).toBe("424242");
    expect(normalizeCode("Code: 424-242-9")).toBe("424242");
  });
});

describe("Clerk errors", () => {
  it("reads the code of an API error and of a plain Clerk error", () => {
    expect(
      clerkErrorCode({ code: "api_response_error", errors: [{ code: "form_code_incorrect" }] }),
    ).toBe("form_code_incorrect");
    expect(clerkErrorCode({ code: "network_error" })).toBe("network_error");
    expect(clerkErrorCode(new Error("boom"))).toBeUndefined();
    expect(clerkErrorCode(null)).toBeUndefined();
  });

  it("signs up an email that has no account yet", () => {
    expect(isNewAccount("form_identifier_not_found")).toBe(true);
    expect(isNewAccount("form_code_incorrect")).toBe(false);
  });

  it("says what went wrong in plain words", () => {
    expect(signInProblemMessage("verification_expired")).toBe(
      "That code has expired. Go back and send a new one.",
    );
    expect(signInProblemMessage("something_new")).toBe(
      "The sign-in did not work. Try again in a moment.",
    );
  });
});

describe("moving the phone's data into the account", () => {
  it("asks once, and only when there is data to move", () => {
    expect(shouldOfferMove({ alreadyAsked: false, anonymousRows: 12 })).toBe(true);
    expect(shouldOfferMove({ alreadyAsked: true, anonymousRows: 12 })).toBe(false);
    expect(shouldOfferMove({ alreadyAsked: false, anonymousRows: 0 })).toBe(false);
  });
});
