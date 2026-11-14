/** Where the email in the email step came from. */
export type EmailFrom = "typed" | "chatgpt";

/**
 * The svett account sign-in. Both choices end in the same step: Clerk emails a six-digit code
 * and the person types it in. Continue with ChatGPT only fills in the email address that the
 * ChatGPT sign-in verified.
 */
export type SignInState =
  | { readonly step: "choose"; readonly problem?: string }
  | { readonly step: "chatgpt" }
  | {
      readonly step: "email";
      readonly email: string;
      readonly from: EmailFrom;
      readonly sending: boolean;
      readonly problem?: string;
    }
  | {
      readonly step: "code";
      readonly email: string;
      readonly code: string;
      readonly checking: boolean;
      readonly problem?: string;
    }
  | { readonly step: "signedIn" };

export type SignInEvent =
  | { readonly type: "chooseEmail" }
  | { readonly type: "chooseChatGPT" }
  /** The ChatGPT sign-in ended. `email` is the address it verified, if it gave one. */
  | { readonly type: "chatGPTEnded"; readonly email: string | null; readonly problem?: string }
  | { readonly type: "editEmail"; readonly email: string }
  | { readonly type: "sendCode" }
  | { readonly type: "codeSent" }
  | { readonly type: "editCode"; readonly code: string }
  | { readonly type: "checkCode" }
  | { readonly type: "signedIn" }
  | { readonly type: "failed"; readonly problem: string }
  | { readonly type: "back" };

export const SIGN_IN_START: SignInState = { step: "choose" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Why `email` cannot get a code, or undefined when it can. */
export const emailProblem = (email: string): string | undefined =>
  EMAIL.test(normalizeEmail(email)) ? undefined : "Enter an email address, like name@example.com.";

/** The digits of a code as typed or pasted, at most six. */
export const normalizeCode = (code: string) => code.replaceAll(/\D/g, "").slice(0, 6);

export const CODE_LENGTH = 6;

/** The next state of the sign-in after `event`. Events that do not fit the step change nothing. */
export const signInStep = (state: SignInState, event: SignInEvent): SignInState => {
  switch (event.type) {
    case "chooseEmail":
      return state.step === "choose"
        ? { step: "email", email: "", from: "typed", sending: false }
        : state;
    case "chooseChatGPT":
      return state.step === "choose" ? { step: "chatgpt" } : state;
    case "chatGPTEnded":
      if (state.step !== "chatgpt") return state;
      if (event.email === null) {
        return event.problem === undefined
          ? { step: "choose" }
          : { step: "choose", problem: event.problem };
      }
      return { step: "email", email: normalizeEmail(event.email), from: "chatgpt", sending: false };
    case "editEmail":
      return state.step === "email" && !state.sending
        ? { step: "email", email: event.email, from: "typed", sending: false }
        : state;
    case "sendCode": {
      if (state.step !== "email" || state.sending) return state;
      const problem = emailProblem(state.email);
      return problem === undefined
        ? { step: "email", email: normalizeEmail(state.email), from: state.from, sending: true }
        : { ...state, problem };
    }
    case "codeSent":
      return state.step === "email" && state.sending
        ? { step: "code", email: state.email, code: "", checking: false }
        : state;
    case "editCode":
      return state.step === "code" && !state.checking
        ? { step: "code", email: state.email, code: normalizeCode(event.code), checking: false }
        : state;
    case "checkCode":
      if (state.step !== "code" || state.checking) return state;
      return state.code.length === CODE_LENGTH
        ? { step: "code", email: state.email, code: state.code, checking: true }
        : { ...state, problem: "Enter the six-digit code from the email." };
    case "signedIn":
      return state.step === "code" && state.checking ? { step: "signedIn" } : state;
    case "failed":
      if (state.step === "email" && state.sending) {
        return { ...state, sending: false, problem: event.problem };
      }
      if (state.step === "code" && state.checking) {
        return { ...state, checking: false, code: "", problem: event.problem };
      }
      return state;
    case "back":
      if (state.step === "email" && !state.sending) return { step: "choose" };
      if (state.step === "code" && !state.checking) {
        return { step: "email", email: state.email, from: "typed", sending: false };
      }
      return state;
  }
};

/** The error code of a Clerk failure: the first API error's code, or the error's own. */
export const clerkErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const errors: unknown = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const first: unknown = errors[0];
    if (typeof first === "object" && first !== null) {
      const code: unknown = (first as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/** Clerk answers this when no account has the email yet, so svett signs up instead. */
export const isNewAccount = (code: string | undefined) => code === "form_identifier_not_found";

/** What to tell the person about a Clerk failure. */
export const signInProblemMessage = (code: string | undefined): string => {
  switch (code) {
    case "form_code_incorrect":
      return "That code is not right. Check the email and try again.";
    case "verification_expired":
      return "That code has expired. Go back and send a new one.";
    case "verification_failed":
    case "too_many_requests":
      return "Too many tries. Wait a few minutes, then send a new code.";
    case "form_param_format_invalid":
    case "form_identifier_invalid":
      return "Enter an email address, like name@example.com.";
    case "network_error":
      return "svett could not reach the sign-in service. Check the connection and try again.";
    default:
      return "The sign-in did not work. Try again in a moment.";
  }
};

/**
 * Whether to offer to move the data on the phone into the account that just signed in. The
 * phone asks once, the first time someone signs in, and only when there is data to move.
 */
export const shouldOfferMove = (input: {
  readonly alreadyAsked: boolean;
  readonly anonymousRows: number;
}) => !input.alreadyAsked && input.anonymousRows > 0;
