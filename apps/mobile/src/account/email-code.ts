import { useSignIn, useSignUp } from "@clerk/expo";
import { clerkErrorCode, isNewAccount, accountProblemMessage } from "@svett/core";
import { useRef } from "react";

const problemOf = (error: unknown) => accountProblemMessage(clerkErrorCode(error));

/**
 * Clerk's email code, for a new or a returning account. Each call resolves to a problem to
 * show, or undefined when it worked. Signing up and signing in look the same to the person.
 */
export function useEmailCode() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const mode = useRef<"signIn" | "signUp">("signIn");

  const sendCode = async (email: string): Promise<string | undefined> => {
    if (signIn === null || signUp === null) return problemOf(undefined);
    const sent = await signIn.emailCode.sendCode({ emailAddress: email });
    if (sent.error === null) {
      mode.current = "signIn";
      return undefined;
    }
    if (!isNewAccount(clerkErrorCode(sent.error))) return problemOf(sent.error);
    const created = await signUp.create({ emailAddress: email });
    if (created.error !== null) return problemOf(created.error);
    const signUpSent = await signUp.verifications.sendEmailCode();
    if (signUpSent.error !== null) return problemOf(signUpSent.error);
    mode.current = "signUp";
    return undefined;
  };

  const checkCode = async (code: string): Promise<string | undefined> => {
    if (signIn === null || signUp === null) return problemOf(undefined);
    if (mode.current === "signIn") {
      const verified = await signIn.emailCode.verifyCode({ code });
      if (verified.error !== null) return problemOf(verified.error);
      if (signIn.status !== "complete") return problemOf(undefined);
      const finished = await signIn.finalize();
      return finished.error === null ? undefined : problemOf(finished.error);
    }
    const verified = await signUp.verifications.verifyEmailCode({ code });
    if (verified.error !== null) return problemOf(verified.error);
    if (signUp.status !== "complete") return problemOf(undefined);
    const finished = await signUp.finalize();
    return finished.error === null ? undefined : problemOf(finished.error);
  };

  return { sendCode, checkCode };
}
