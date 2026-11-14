import { type ChatGPTStatus, signInProblemMessage } from "@svett/core";

import { chatGPTStatus, signInWithChatGPT } from "../chatgpt/native";

export interface ChatGPTEmail {
  readonly email: string | null;
  readonly problem?: string;
}

const NO_EMAIL = "ChatGPT did not share an email address. Continue with email instead.";

const emailOf = (status: ChatGPTStatus) => (status.state === "signedIn" ? status.email : undefined);

/**
 * The email address of the ChatGPT account, to fill in for the svett sign-in. It reuses the
 * coach's ChatGPT sign-in when there is one, and opens the ChatGPT sign-in sheet otherwise.
 */
export const chatGPTEmail = async (): Promise<ChatGPTEmail> => {
  const saved = emailOf(await chatGPTStatus());
  if (saved !== undefined) return { email: saved };
  const result = await signInWithChatGPT("sheet", "returning");
  switch (result.status) {
    case "signedIn": {
      const email = emailOf(result.account);
      return email === undefined ? { email: null, problem: NO_EMAIL } : { email };
    }
    case "failed":
      return { email: null, problem: signInProblemMessage(result.problem) };
    case "cancelled":
      return { email: null };
  }
};
