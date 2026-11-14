import { useAuth, useUser } from "@clerk/expo";
import {
  clerkErrorCode,
  CODE_LENGTH,
  type MoveCounts,
  moveOfferMessage,
  SIGN_IN_START,
  type SignInEvent,
  accountProblemMessage,
  type SignInState,
  signInStep,
  syncStatusMessage,
} from "@svett/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import {
  movePending,
  ownerOf,
  sessionLapsed,
  signedOut,
  switchOwner,
  useCurrentDatabase,
} from "../data/current";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { TextField } from "../ui/TextField";
import { chatGPTEmail } from "./chatgpt-email";
import { CLERK_PUBLISHABLE_KEY } from "./config";
import { deleteAccount } from "./delete";
import { useEmailCode } from "./email-code";
import { declineMove, moveIntoAccount, pendingMoveOffer, resumeMove } from "./move";
import { syncNow, useSyncStatus } from "./sync";

function Card({ testID, children }: { readonly testID: string; readonly children: ReactNode }) {
  return (
    <View testID={testID} className="mx-gutter gap-4 rounded-card bg-surface p-gutter">
      {children}
    </View>
  );
}

function Heading({ title, message }: { readonly title: string; readonly message: string }) {
  return (
    <View className="gap-1">
      <AppText variant="title3" accessibilityRole="header">
        {title}
      </AppText>
      <AppText tone="secondary">{message}</AppText>
    </View>
  );
}

function Problem({ text }: { readonly text: string | undefined }) {
  return text === undefined ? null : (
    <AppText tone="destructive" accessibilityLiveRegion="polite" testID="sign-in-problem">
      {text}
    </AppText>
  );
}

function SignIn() {
  const [state, setState] = useState<SignInState>(SIGN_IN_START);
  const latest = useRef(state);
  const { sendCode, checkCode } = useEmailCode();

  const settle = (request: Promise<string | undefined>, done: SignInEvent) =>
    request.then(
      (problem) => act(problem === undefined ? done : { type: "failed", problem }),
      (error: unknown) =>
        act({ type: "failed", problem: accountProblemMessage(clerkErrorCode(error)) }),
    );

  // Applies `event`, and starts the request a step needs when the event starts that step. The
  // ref holds the newest state, so a second tap before the next render starts nothing.
  const act = (event: SignInEvent) => {
    const before = latest.current;
    const next = signInStep(before, event);
    latest.current = next;
    setState(next);
    if (next.step === "chatgpt" && before.step !== "chatgpt") {
      void chatGPTEmail().then(
        (result) => act({ type: "chatGPTEnded", ...result }),
        () => act({ type: "chatGPTEnded", email: null }),
      );
    }
    if (next.step === "email" && next.sending && !(before.step === "email" && before.sending)) {
      void settle(sendCode(next.email), { type: "codeSent" });
    }
    if (next.step === "code" && next.checking && !(before.step === "code" && before.checking)) {
      void settle(checkCode(next.code), { type: "signedIn" });
    }
  };
  switch (state.step) {
    case "choose":
    case "chatgpt":
      return (
        <Card testID="sign-in-choose">
          <Heading
            title="Sign in to svett"
            message="An account lets you sync and use the feed. svett emails you a six-digit code each time you sign in."
          />
          <Problem text={state.step === "choose" ? state.problem : undefined} />
          <Button
            label={state.step === "chatgpt" ? "Waiting for ChatGPT" : "Continue with ChatGPT"}
            symbol="bubble.left.and.bubble.right.fill"
            disabled={state.step === "chatgpt"}
            onPress={() => act({ type: "chooseChatGPT" })}
            accessibilityHint="Fills in the email address of your ChatGPT account"
            testID="continue-with-chatgpt"
          />
          <Button
            label="Continue with email"
            symbol="envelope.fill"
            variant="secondary"
            disabled={state.step === "chatgpt"}
            onPress={() => act({ type: "chooseEmail" })}
            testID="continue-with-email"
          />
        </Card>
      );
    case "email":
      return (
        <Card testID="sign-in-email">
          <Heading
            title="Your email"
            message="svett sends a six-digit code to this address. A new address makes a new account."
          />
          <TextField
            label="Email"
            value={state.email}
            onChangeText={(email) => act({ type: "editEmail", email })}
            note={state.from === "chatgpt" ? "Filled in from your ChatGPT sign-in." : undefined}
            problem={state.problem}
            editable={!state.sending}
            placeholder="name@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="send"
            onSubmitEditing={() => act({ type: "sendCode" })}
            testID="email-field"
          />
          <Button
            label={state.sending ? "Sending the code" : "Send code"}
            disabled={state.sending}
            onPress={() => act({ type: "sendCode" })}
            testID="send-code"
          />
          <Button
            label="Back"
            variant="plain"
            disabled={state.sending}
            onPress={() => act({ type: "back" })}
            testID="sign-in-back"
          />
        </Card>
      );
    case "code":
      return (
        <Card testID="sign-in-code">
          <Heading title="Check your email" message={`svett sent a code to ${state.email}.`} />
          <TextField
            label="Code from the email"
            value={state.code}
            onChangeText={(code) => act({ type: "editCode", code })}
            problem={state.problem}
            editable={!state.checking}
            placeholder="123456"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={CODE_LENGTH}
            testID="code-field"
          />
          <Button
            label={state.checking ? "Checking the code" : "Sign in"}
            disabled={state.checking}
            onPress={() => act({ type: "checkCode" })}
            testID="check-code"
          />
          <Button
            label="Use another email"
            variant="plain"
            disabled={state.checking}
            onPress={() => act({ type: "back" })}
            testID="sign-in-back"
          />
        </Card>
      );
    case "signedIn":
      return (
        <Card testID="sign-in-finishing">
          <AppText tone="secondary">Signing in</AppText>
        </Card>
      );
  }
}

type Offer =
  | { readonly kind: "checking" }
  | { readonly kind: "offer"; readonly counts: MoveCounts; readonly moving: boolean }
  | { readonly kind: "answered"; readonly problem?: string };

function MoveOffer({
  counts,
  moving,
  onMove,
  onDecline,
}: {
  readonly counts: MoveCounts;
  readonly moving: boolean;
  readonly onMove: () => void;
  readonly onDecline: () => void;
}) {
  return (
    <Card testID="move-offer">
      <Heading
        title="Move this phone's data into your account?"
        message={`${moveOfferMessage(counts)} Moving it makes it this account's. If you start empty, it stays on this phone and opens again when you sign out.`}
      />
      <Button
        label={moving ? "Moving" : "Move it into my account"}
        disabled={moving}
        onPress={onMove}
        testID="move-data"
      />
      <Button
        label="Start empty"
        variant="secondary"
        disabled={moving}
        onPress={onDecline}
        testID="start-empty"
      />
    </Card>
  );
}

/** Where sync stands for this account, and a way to sync at once. */
function SyncState({ accountId }: { readonly accountId: string }) {
  const { getToken } = useAuth();
  const status = useSyncStatus();
  const owner = ownerOf(accountId);
  return (
    <View className="gap-2">
      <AppText variant="headline" accessibilityRole="header">
        Sync
      </AppText>
      <AppText testID="sync-status" tone="secondary">
        {syncStatusMessage(status)}
      </AppText>
      <Button
        label={status.kind === "syncing" ? "Syncing" : "Sync now"}
        variant="secondary"
        disabled={status.kind === "syncing" || owner.kind !== "account"}
        onPress={() => {
          if (owner.kind === "account") void syncNow(owner.accountId, () => getToken());
        }}
        testID="sync-now"
      />
    </View>
  );
}

type Deletion =
  | { readonly step: "idle" }
  | { readonly step: "choose" }
  | { readonly step: "deleting" }
  | { readonly step: "failed"; readonly problem: string };

const KEEP_MESSAGE =
  "svett deletes your account, profile, follows, likes and comments from its server and signs you out on every phone. Your workouts stay on this phone with no account.";
const ERASE_MESSAGE =
  "svett deletes your account, profile, follows, likes and comments from its server and signs you out on every phone, and erases your workouts from this phone. This cannot be undone.";

/**
 * Deleting the account. It asks what happens to the copy on this phone, then asks once more
 * before anything is deleted.
 */
function DeleteAccount({ accountId }: { readonly accountId: string }) {
  const { getToken, signOut } = useAuth();
  const [state, setState] = useState<Deletion>({ step: "idle" });
  const owner = ownerOf(accountId);
  const run = (keep: boolean) => {
    if (owner.kind !== "account") return;
    setState({ step: "deleting" });
    void deleteAccount(owner.accountId, keep, () => getToken(), signOut).then(
      (problem) => {
        if (problem !== undefined) setState({ step: "failed", problem });
      },
      (error: unknown) =>
        setState({ step: "failed", problem: `The deletion did not finish. ${String(error)}` }),
    );
  };
  const confirm = (keep: boolean) =>
    Alert.alert(
      keep ? "Delete your account and keep a copy?" : "Delete your account and erase this phone?",
      keep ? KEEP_MESSAGE : ERASE_MESSAGE,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete account", style: "destructive", onPress: () => run(keep) },
      ],
    );
  if (state.step === "idle" || state.step === "failed") {
    return (
      <View className="gap-2">
        <Problem text={state.step === "failed" ? state.problem : undefined} />
        <Button
          label="Delete account"
          variant="destructive"
          onPress={() => setState({ step: "choose" })}
          accessibilityHint="Asks what happens to the data on this phone before anything is deleted"
          testID="delete-account"
        />
      </View>
    );
  }
  const deleting = state.step === "deleting";
  return (
    <View className="gap-3" testID="delete-account-choice">
      <Heading
        title={deleting ? "Deleting your account" : "Delete your svett account?"}
        message="svett deletes everything it keeps for you on its server and signs you out on every phone. Choose what happens to the copy on this phone."
      />
      <Button
        label="Keep a copy on this phone"
        variant="secondary"
        disabled={deleting}
        onPress={() => confirm(true)}
        accessibilityHint="Your workouts stay on this phone with no account"
        testID="delete-keep-copy"
      />
      <Button
        label="Erase it from this phone"
        variant="destructive"
        disabled={deleting}
        onPress={() => confirm(false)}
        testID="delete-erase-copy"
      />
      <Button
        label="Cancel"
        variant="plain"
        disabled={deleting}
        onPress={() => setState({ step: "idle" })}
        testID="delete-cancel"
      />
    </View>
  );
}

function SignedIn({ accountId }: { readonly accountId: string }) {
  const { signOut } = useAuth();
  const { user } = useUser();
  const [offer, setOffer] = useState<Offer>({ kind: "checking" });
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let live = true;
    resumeMove()
      .then(pendingMoveOffer)
      .then(
        (counts) =>
          live &&
          setOffer(
            counts === undefined ? { kind: "answered" } : { kind: "offer", counts, moving: false },
          ),
        (error: unknown) =>
          live &&
          setOffer({ kind: "answered", problem: `The move did not finish. ${String(error)}` }),
      );
    return () => {
      live = false;
    };
  }, []);

  const move = (counts: MoveCounts) => {
    const owner = ownerOf(accountId);
    if (owner.kind !== "account") return;
    // The session's database may not be open yet when the offer is answered at once.
    switchOwner(owner);
    setOffer({ kind: "offer", counts, moving: true });
    moveIntoAccount(owner.accountId).then(
      () => setOffer({ kind: "answered" }),
      (error: unknown) =>
        setOffer({ kind: "answered", problem: `The move did not finish. ${String(error)}` }),
    );
  };

  if (offer.kind === "checking") {
    return (
      <Card testID="account-checking">
        <AppText tone="secondary">Opening your account</AppText>
      </Card>
    );
  }
  if (offer.kind === "offer") {
    return (
      <MoveOffer
        counts={offer.counts}
        moving={offer.moving}
        onMove={() => move(offer.counts)}
        onDecline={() => {
          declineMove();
          setOffer({ kind: "answered" });
        }}
      />
    );
  }
  return (
    <Card testID="signed-in">
      <Heading
        title="Signed in"
        message="This phone shows this account's data. Signing out keeps it on the phone for when you sign in again."
      />
      <AppText testID="account-email" selectable>
        {user?.primaryEmailAddress?.emailAddress ?? accountId}
      </AppText>
      <Problem text={offer.problem} />
      <SyncState accountId={accountId} />
      <Button
        label={signingOut ? "Signing out" : "Sign out"}
        variant="destructive"
        disabled={signingOut}
        onPress={() => {
          setSigningOut(true);
          signOut()
            .then(signedOut)
            .finally(() => setSigningOut(false));
        }}
        testID="sign-out"
      />
      <DeleteAccount accountId={accountId} />
    </Card>
  );
}

function Lapsed() {
  return (
    <Card testID="session-lapsed">
      <Heading
        title="Sign in again to sync"
        message="Your sign-in ended, as it does every 7 days. This phone still shows your account's data and keeps everything you log. Sign in with the same email to sync again."
      />
      <Button
        label="Sign out"
        variant="destructive"
        onPress={signedOut}
        accessibilityHint="Closes this account's data, which stays on the phone for when you sign in again"
        testID="lapsed-sign-out"
      />
    </Card>
  );
}

function MoveUnfinished() {
  return (
    <Card testID="move-unfinished">
      <Heading
        title="Your data is moving into an account"
        message="The move has not finished, so svett shows and saves nothing while nobody is signed in. Sign in to that account to finish it."
      />
    </Card>
  );
}

function ClerkAccount() {
  const { isLoaded, userId } = useAuth();
  const database = useCurrentDatabase();
  if (!isLoaded) {
    return (
      <Card testID="account-loading">
        <AppText tone="secondary">Opening your account</AppText>
      </Card>
    );
  }
  if (userId) return <SignedIn key={userId} accountId={userId} />;
  return (
    <>
      {sessionLapsed(database, userId) ? <Lapsed /> : null}
      {movePending(database) ? <MoveUnfinished /> : null}
      <SignIn />
    </>
  );
}

/** Sign in to a svett account, the move offer on the first sign-in, and sign out. */
export function AccountScreen() {
  return (
    <ScrollView
      testID="account"
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {CLERK_PUBLISHABLE_KEY === undefined ? (
        <View testID="accounts-off">
          <EmptyState
            symbol="person.crop.circle.badge.exclamationmark"
            title="Accounts are not set up"
            message="This build has no Clerk key, so it cannot sign in. Everything on the phone works without an account."
          />
        </View>
      ) : (
        <ClerkAccount />
      )}
    </ScrollView>
  );
}
