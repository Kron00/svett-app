import { requireNativeModule } from "expo";

export interface ChatGPTSession {
  readonly scope: string;
  readonly expiresAt: number;
}

export type SignInResult =
  | { readonly status: "signedIn"; readonly session: ChatGPTSession }
  | { readonly status: "failed"; readonly problem: string }
  | { readonly status: "cancelled" };

export interface WorkoutAccessResult {
  readonly available: boolean;
  readonly error?: string;
  readonly workouts?: number;
}

interface SvettNative {
  /** When this process started, in milliseconds since 1970. */
  readonly launchedAt: number;
  /** The entitlement keys the running app is signed with, or null when they cannot be read. */
  signedEntitlements(): string[] | null;
  requestWorkoutAccess(): Promise<WorkoutAccessResult>;
  /** The stored ChatGPT sign-in, without its tokens. */
  chatGPTSession(): Promise<ChatGPTSession | null>;
  signInWithChatGPT(route: "sheet" | "safari"): Promise<SignInResult>;
  /** Returns why the address cannot finish the sign-in, or null when it was taken. */
  pasteSignInAddress(address: string): Promise<string | null>;
  cancelSignIn(): Promise<void>;
}

export default requireNativeModule<SvettNative>("SvettNative");
