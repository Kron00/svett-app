import {
  type ChatGPTStatus,
  type RenewResult,
  type SignInChoice,
  type SignInResult,
  type SignOutResult,
  decodeChatGPTStatus,
  decodeRenewResult,
  decodeSignInResult,
  decodeSignOutResult,
  signInProblemMessage,
} from "@svett/core";

import SvettNative from "../../modules/svett-native";

export type SignInRoute = "sheet" | "safari";

export const chatGPTStatus = async (): Promise<ChatGPTStatus> =>
  decodeChatGPTStatus(await SvettNative.chatGPTStatus());

export const renewChatGPT = async (): Promise<RenewResult> =>
  decodeRenewResult(await SvettNative.renewChatGPT());

/** `account` is a saved account's id, for a returning sign-in to an account other than the last. */
export const signInWithChatGPT = async (
  route: SignInRoute,
  choice: SignInChoice,
  account?: string,
): Promise<SignInResult> =>
  decodeSignInResult(await SvettNative.signInWithChatGPT(route, choice, account ?? null));

/**
 * Finishes a Safari sign-in with the address on the pasteboard, which Swift reads. Returns why it
 * cannot, or null when it was taken.
 */
export const pasteSignInAddress = async (): Promise<string | null> => {
  const problem = await SvettNative.pasteSignInAddress();
  return problem === null ? null : signInProblemMessage(problem);
};

export const cancelSignIn = () => SvettNative.cancelSignIn();

/** Says whether OpenAI confirmed it ended the sign-in, and whether the Keychain let it go. */
export const signOutOfChatGPT = async (): Promise<SignOutResult> =>
  decodeSignOutResult(await SvettNative.signOutOfChatGPT());
