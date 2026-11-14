import type { WorkoutAccess } from "@svett/core";
import { requireNativeModule } from "expo";

// The ChatGPT functions return what Swift sends, unparsed. src/chatgpt/native.ts parses it with
// the schemas in @svett/core. None of them returns a token.
interface SvettNative {
  /** When the kernel started this process, in milliseconds since 1970. */
  readonly launchedAt: number;
  /** The entitlement keys the running app is signed with, or null when they cannot be read. */
  signedEntitlements(): string[] | null;
  requestWorkoutAccess(): Promise<WorkoutAccess>;
  chatGPTStatus(): Promise<unknown>;
  /** Refreshes the sign-in when its access token is about to expire, then reports the status. */
  renewChatGPT(): Promise<unknown>;
  /** `account` is a saved account's id from the status, or null for the one used last. */
  signInWithChatGPT(
    route: "sheet" | "safari",
    choice: "returning" | "anotherAccount" | "allowPlanUsage",
    account: string | null,
  ): Promise<unknown>;
  /**
   * Swift reads the address Safari could not open from the pasteboard and finishes the sign-in
   * with it, so the address never reaches JavaScript. Returns a problem code when it cannot, or
   * null when it was taken.
   */
  pasteSignInAddress(): Promise<string | null>;
  cancelSignIn(): Promise<void>;
  signOutOfChatGPT(): Promise<unknown>;
}

export default requireNativeModule<SvettNative>("SvettNative");
