import {
  type ChatGPTStatus,
  type RenewResult,
  type SignInChoice,
  type SignInResult,
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

export const signInWithChatGPT = async (
  route: SignInRoute,
  choice: SignInChoice,
): Promise<SignInResult> => decodeSignInResult(await SvettNative.signInWithChatGPT(route, choice));

/** Returns why the address cannot finish the sign-in, or null when it was taken. */
export const pasteSignInAddress = async (address: string): Promise<string | null> => {
  const problem = await SvettNative.pasteSignInAddress(address);
  return problem === null ? null : signInProblemMessage(problem);
};

export const cancelSignIn = () => SvettNative.cancelSignIn();

/** Returns whether OpenAI confirmed it ended the sign-in. */
export const signOutOfChatGPT = async (): Promise<boolean> =>
  decodeSignOutResult(await SvettNative.signOutOfChatGPT()).revoked;
