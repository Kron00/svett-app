import type { WorkoutAccess } from "@svett/core";
import { requireNativeModule } from "expo";

// The ChatGPT functions return what Swift sends, unparsed. src/chatgpt/native.ts parses it with
// the schemas in @svett/core. None of them returns a token.
interface SvettNative {
  /** When this process started, in milliseconds since 1970. */
  readonly launchedAt: number;
  /** The entitlement keys the running app is signed with, or null when they cannot be read. */
  signedEntitlements(): string[] | null;
  requestWorkoutAccess(): Promise<WorkoutAccess>;
  chatGPTStatus(): Promise<unknown>;
  /** Refreshes the sign-in when its access token is about to expire, then reports the status. */
  renewChatGPT(): Promise<unknown>;
  signInWithChatGPT(
    route: "sheet" | "safari",
    choice: "returning" | "anotherAccount" | "allowPlanUsage",
  ): Promise<unknown>;
  /** Returns a problem code when the address cannot finish the sign-in, or null when it was taken. */
  pasteSignInAddress(address: string): Promise<string | null>;
  cancelSignIn(): Promise<void>;
  signOutOfChatGPT(): Promise<unknown>;
}

export default requireNativeModule<SvettNative>("SvettNative");
