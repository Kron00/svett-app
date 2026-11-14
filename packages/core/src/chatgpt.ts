import { Schema } from "effect";

// The ChatGPT sign-in lives in Swift and keeps its tokens there. JavaScript gets the account's
// status and problem codes, parsed here, and words them for the settings screen.

/** The plans ChatGPT's help page lists as able to use their plan in other apps. */
export const PLAN_USAGE_PLANS = "Go, Plus, Pro and Business";

const SignedIn = Schema.Struct({
  state: Schema.Literal("signedIn"),
  email: Schema.optionalKey(Schema.String),
  scope: Schema.String,
  planUsage: Schema.Boolean,
  expiresAt: Schema.Number,
  /** When a refresh last replaced the tokens. */
  renewedAt: Schema.optionalKey(Schema.Number),
  /** The Keychain refused the last write, so svett holds the sign-in in memory only. */
  unsaved: Schema.optionalKey(Schema.Boolean),
});

/** A ChatGPT account this iPhone has signed in to. `id` is how a sign-in returns to it. */
const SavedAccount = Schema.Struct({ id: Schema.String, email: Schema.optionalKey(Schema.String) });
export type SavedAccount = typeof SavedAccount.Type;

const SignedOut = Schema.Struct({
  state: Schema.Literal("signedOut"),
  /** The account the next sign-in returns to, when this iPhone has signed in before. */
  returning: Schema.optionalKey(Schema.Struct({ email: Schema.optionalKey(Schema.String) })),
  /** Every saved account, the one used last first. */
  accounts: Schema.Array(SavedAccount),
  /** Why the last sign-in ended, when ChatGPT ended it rather than the user. */
  ended: Schema.optionalKey(Schema.Literals(["lapsed", "clientRefused"])),
  /** The Keychain could not be read, or refused the last write, so it may still hold tokens. */
  unsaved: Schema.optionalKey(Schema.Boolean),
});

export const ChatGPTStatus = Schema.Union([SignedIn, SignedOut]);
export type ChatGPTStatus = typeof ChatGPTStatus.Type;

const SignInResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signedIn"), account: ChatGPTStatus }),
  Schema.Struct({ status: Schema.Literal("failed"), problem: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
]);
export type SignInResult = typeof SignInResult.Type;

const RenewResult = Schema.Struct({
  account: ChatGPTStatus,
  problem: Schema.optionalKey(Schema.String),
});
export type RenewResult = typeof RenewResult.Type;

const SignOutResult = Schema.Struct({
  /** OpenAI confirmed it ended the sign-in. */
  revoked: Schema.Boolean,
  /** The tokens are gone from the Keychain. */
  cleared: Schema.Boolean,
});
export type SignOutResult = typeof SignOutResult.Type;

export const decodeChatGPTStatus = Schema.decodeUnknownSync(ChatGPTStatus);
export const decodeSignInResult = Schema.decodeUnknownSync(SignInResult);
export const decodeRenewResult = Schema.decodeUnknownSync(RenewResult);
export const decodeSignOutResult = Schema.decodeUnknownSync(SignOutResult);

/** Which sign-in the user asked for. */
export type SignInChoice = "returning" | "anotherAccount" | "allowPlanUsage";

const REFUSED = "ChatGPT did not finish the sign-in. Try again.";

const SIGN_IN_PROBLEMS: Readonly<Record<string, string>> = {
  notTheAddress:
    "That is not the sign-in address. Copy the whole address that starts with http://127.0.0.1 and paste it again.",
  otherAttempt: "That address is from an earlier sign-in. Start the sign-in again.",
  denied: "ChatGPT did not give svett access. Sign in again to allow it.",
  refused: REFUSED,
  unreachable: "Could not reach OpenAI. Check your connection and try again.",
  timedOut: "The sign-in was not finished in time. Try again.",
  busy: "A sign-in is already running.",
  notRunning: "No sign-in is running. Start one first.",
  codeExpired: "The sign-in took too long to finish. Try again.",
  clientRefused:
    "ChatGPT no longer accepts svett's registration, which happens when svett is removed in ChatGPT's settings. Try again to register svett anew.",
  incompleteRegistration: "ChatGPT did not finish registering svett. Try again.",
  otherClient: "ChatGPT answered for another app's registration. Try again.",
  otherAccount:
    "That is not the ChatGPT account this iPhone signed in with before. To use it, choose Use another ChatGPT account.",
  nothingPasted:
    "svett found no address to paste. If iOS asked about pasting, choose Allow Paste. Otherwise, in Safari, copy the whole address that starts with http://127.0.0.1, then come back and paste it.",
  unknownAccount: "That ChatGPT account is no longer saved on this iPhone. Choose another one.",
  storage:
    "svett could not read its saved ChatGPT sign-in from this iPhone's Keychain. Close and reopen svett, then try again.",
};

// Each finishes "because the identity token ...".
const IDENTITY_PROBLEMS: Readonly<Record<string, string>> = {
  badSignature: "has a signature that does not match OpenAI's published keys",
  unknownKey: "is signed with a key OpenAI does not publish",
  unsupportedAlgorithm: "is not signed the way OpenAI signs",
  wrongIssuer: "does not come from OpenAI",
  wrongAudience: "was made for another app",
  expired: "has expired",
  wrongNonce: "belongs to another sign-in",
  missingClaim: "leaves out who signed in",
  malformed: "cannot be read",
};

const IDENTITY_PREFIX = "identity.";

/** What to tell the user about a sign-in that did not finish, from the problem code Swift sent. */
export function signInProblemMessage(code: string): string {
  if (code.startsWith(IDENTITY_PREFIX)) {
    const reason =
      IDENTITY_PROBLEMS[code.slice(IDENTITY_PREFIX.length)] ?? "did not pass svett's checks";
    return `svett turned the sign-in down, because the identity token ${reason}. Nothing was saved. Try again.`;
  }
  return SIGN_IN_PROBLEMS[code] ?? REFUSED;
}

/**
 * What to tell the user when renewing the sign-in did not work. A sign-in that ChatGPT ended
 * shows as signed out with its own notice, so it gets nothing here.
 */
export function renewProblemMessage(code: string | undefined): string | undefined {
  switch (code) {
    case "unreachable":
      return "Could not reach OpenAI to renew the sign-in. svett tries again the next time it needs it.";
    case "refused":
      return "OpenAI turned down renewing the sign-in. If this keeps happening, sign out and sign in again.";
    default:
      return undefined;
  }
}

export function signOutMessage({ revoked, cleared }: SignOutResult): string | undefined {
  if (!cleared) {
    return revoked
      ? "OpenAI ended the sign-in, but svett could not delete it from this iPhone's Keychain. svett tries again while it is open. The tokens no longer work."
      : "svett could not delete the sign-in from this iPhone's Keychain, and OpenAI did not confirm it ended it. svett tries again while it is open. To be sure, remove svett in ChatGPT's settings.";
  }
  return revoked
    ? undefined
    : "Signed out on this iPhone, but OpenAI did not confirm it ended the sign-in. To be sure, remove svett in ChatGPT's settings.";
}

/**
 * A distinct label for each saved account, in the same order. Two accounts can share an email
 * address, and an account may have none.
 */
export function accountLabels(accounts: ReadonlyArray<SavedAccount>): ReadonlyArray<string> {
  const names = accounts.map((account) => account.email ?? "ChatGPT account");
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const shared = names.filter((other) => other === name).length > 1;
    return shared ? `${name} (${count})` : name;
  });
}

export type ChatGPTAction =
  | "continue"
  | "anotherAccount"
  | "allowPlanUsage"
  | "manageUsage"
  | "signOut";

export interface ChatGPTView {
  readonly rows: ReadonlyArray<{ readonly title: string; readonly value: string }>;
  readonly notice: { readonly tone: "warning" | "secondary"; readonly text: string } | undefined;
  readonly actions: ReadonlyArray<ChatGPTAction>;
  /** The saved account that Continue with ChatGPT returns to, when there is one. */
  readonly continueAs: string | undefined;
  /** The other saved accounts, each offered as its own way back. */
  readonly otherAccounts: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

const UNSAVED_SIGNED_IN =
  "svett could not save your ChatGPT sign-in to this iPhone's Keychain. It keeps it while svett is open and tries again. If svett closes first, you may have to sign in again.";
const UNSAVED_SIGNED_OUT =
  "svett could not update its saved ChatGPT sign-in in this iPhone's Keychain. It tries again while svett is open.";

/** What the ChatGPT settings screen shows for a status. */
export function describeChatGPT(
  status: ChatGPTStatus,
  formatTime: (ms: number) => string,
): ChatGPTView {
  if (status.state === "signedOut") {
    const [last, ...others] = status.accounts;
    const labels = accountLabels(status.accounts);
    return {
      rows: [
        { title: "ChatGPT", value: "Not signed in" },
        ...(last === undefined ? [] : [{ title: "Last account", value: labels[0] ?? "" }]),
      ],
      notice:
        status.unsaved === true
          ? { tone: "warning", text: UNSAVED_SIGNED_OUT }
          : endedNotice(status.ended),
      actions: last === undefined ? ["continue"] : ["continue", "anotherAccount"],
      continueAs: last?.id,
      otherAccounts: others.map((account, index) => ({
        id: account.id,
        label: labels[index + 1] ?? "",
      })),
    };
  }
  const unsaved =
    status.unsaved === true ? { tone: "warning" as const, text: UNSAVED_SIGNED_IN } : undefined;
  const account = { title: "Account", value: status.email ?? "Signed in" };
  if (!status.planUsage) {
    return {
      rows: [account, { title: "Plan usage", value: "Not allowed" }],
      notice: unsaved ?? {
        tone: "warning",
        text: `ChatGPT did not let svett use your plan, so the coach is off. OpenAI lists ${PLAN_USAGE_PLANS} as plans that allow it. A Free plan does not.`,
      },
      actions: ["allowPlanUsage", "signOut"],
      continueAs: undefined,
      otherAccounts: [],
    };
  }
  return {
    rows: [
      account,
      { title: "Plan usage", value: "Allowed" },
      {
        title: "Sign-in",
        value:
          status.renewedAt === undefined
            ? "Renews itself while you use the coach"
            : `Renewed at ${formatTime(status.renewedAt)}`,
      },
    ],
    notice: unsaved ?? {
      tone: "secondary",
      text: "The coach counts toward your ChatGPT plan's limits, the same as using ChatGPT. Manage usage shows and caps what svett may use.",
    },
    actions: ["manageUsage", "signOut"],
    continueAs: undefined,
    otherAccounts: [],
  };
}

function endedNotice(ended: "lapsed" | "clientRefused" | undefined): ChatGPTView["notice"] {
  switch (ended) {
    case "lapsed":
      return {
        tone: "warning",
        text: "Your ChatGPT sign-in lapsed, because svett went unused for 30 days or ChatGPT ended it. Continue with ChatGPT to sign in again.",
      };
    case "clientRefused":
      return {
        tone: "warning",
        text: "ChatGPT no longer accepts svett's registration, which happens when svett is removed in ChatGPT's settings. Continue with ChatGPT to register svett again.",
      };
    case undefined:
      return undefined;
  }
}

/** ChatGPT's page where the user sees and caps what each app may use of their plan. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
