import {
  type ChatGPTAction,
  type ChatGPTStatus,
  MANAGE_USAGE_URL,
  type SignInChoice,
  describeChatGPT,
  renewProblemMessage,
  signInProblemMessage,
  signOutMessage,
} from "@svett/core";
import { useEffect, useState } from "react";
import { Linking, ScrollView, View } from "react-native";

import { AppText, type TextTone } from "../ui/AppText";
import { Button, type ButtonVariant } from "../ui/Button";
import { ListRow, ListSection } from "../ui/List";
import {
  type SignInRoute,
  cancelSignIn,
  pasteSignInAddress,
  renewChatGPT,
  signInWithChatGPT,
  signOutOfChatGPT,
} from "./native";
import { SafariPaste } from "./SafariPaste";

type Message = { readonly tone: TextTone; readonly text: string };

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const failure = (error: unknown): Message => ({
  tone: "destructive",
  text: error instanceof Error ? error.message : String(error),
});

const ACTIONS: Readonly<
  Record<ChatGPTAction, { label: string; variant: ButtonVariant; testID: string }>
> = {
  continue: { label: "Continue with ChatGPT", variant: "primary", testID: "chatgpt-continue" },
  anotherAccount: {
    label: "Use another ChatGPT account",
    variant: "plain",
    testID: "chatgpt-another",
  },
  allowPlanUsage: { label: "Allow plan usage", variant: "primary", testID: "chatgpt-allow" },
  manageUsage: { label: "Manage usage in ChatGPT", variant: "secondary", testID: "chatgpt-manage" },
  signOut: { label: "Sign out", variant: "destructive", testID: "chatgpt-sign-out" },
};

/** The sign-in that Safari stands in for: the one the screen offers first. */
const safariChoice = (actions: ReadonlyArray<ChatGPTAction>): SignInChoice | undefined =>
  actions.includes("continue")
    ? "returning"
    : actions.includes("allowPlanUsage")
      ? "allowPlanUsage"
      : undefined;

export function ChatGPTScreen() {
  const [status, setStatus] = useState<ChatGPTStatus>();
  const [route, setRoute] = useState<SignInRoute>();
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState<Message>();

  // Opening the screen renews a sign-in that is due, so one that ChatGPT ended shows as ended.
  useEffect(() => {
    renewChatGPT().then(
      ({ account, problem }) => {
        setStatus(account);
        const text = renewProblemMessage(problem);
        if (text !== undefined) setMessage({ tone: "warning", text });
      },
      (error: unknown) => setMessage(failure(error)),
    );
  }, []);

  const signIn = async (by: SignInRoute, choice: SignInChoice, account?: string) => {
    setMessage(undefined);
    setRoute(by);
    try {
      const result = await signInWithChatGPT(by, choice, account);
      if (result.status === "signedIn") setStatus(result.account);
      if (result.status === "failed") {
        setMessage({ tone: "destructive", text: signInProblemMessage(result.problem) });
      }
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setRoute(undefined);
    }
  };

  const signOut = async () => {
    setMessage(undefined);
    setSigningOut(true);
    try {
      const text = signOutMessage(await signOutOfChatGPT());
      setStatus((await renewChatGPT()).account);
      if (text !== undefined) setMessage({ tone: "warning", text });
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setSigningOut(false);
    }
  };

  const view = status === undefined ? undefined : describeChatGPT(status, formatTime);
  const safari = view === undefined ? undefined : safariChoice(view.actions);

  const press = (action: ChatGPTAction) => {
    switch (action) {
      case "continue":
        return void signIn("sheet", "returning", view?.continueAs);
      case "anotherAccount":
        return void signIn("sheet", "anotherAccount");
      case "allowPlanUsage":
        return void signIn("sheet", "allowPlanUsage");
      case "manageUsage":
        return void Linking.openURL(MANAGE_USAGE_URL);
      case "signOut":
        return void signOut();
    }
  };

  return (
    <ScrollView
      testID="chatgpt"
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <AppText tone="secondary" className="px-gutter">
        The coach runs on your own ChatGPT plan. The sign-in stays in this iPhone's Keychain, and
        svett sends it only to OpenAI.
      </AppText>
      {view === undefined || status === undefined ? (
        <AppText tone="secondary" className="px-gutter">
          Checking your sign-in…
        </AppText>
      ) : (
        <View testID={`chatgpt-state-${status.state}`}>
          <ListSection>
            {view.rows.map((row) => (
              <ListRow key={row.title} title={row.title} value={row.value} />
            ))}
          </ListSection>
        </View>
      )}
      {view?.notice === undefined ? null : (
        <AppText testID="chatgpt-notice" tone={view.notice.tone} className="px-gutter">
          {view.notice.text}
        </AppText>
      )}
      {message === undefined ? null : (
        <AppText testID="chatgpt-message" tone={message.tone} selectable className="px-gutter">
          {message.text}
        </AppText>
      )}
      {route !== undefined ? (
        <View className="gap-3 px-gutter">
          <AppText tone="secondary">
            {route === "safari"
              ? "Sign in in Safari, then come back. If Safari cannot open the last page, copy its address, come back and paste it here."
              : "Signing in…"}
          </AppText>
          {route === "safari" ? <SafariPaste paste={pasteSignInAddress} /> : null}
          <Button
            label="Cancel"
            variant="secondary"
            testID="chatgpt-cancel"
            onPress={() => void cancelSignIn()}
          />
        </View>
      ) : signingOut ? (
        <AppText tone="secondary" className="px-gutter">
          Signing out…
        </AppText>
      ) : view === undefined ? null : (
        <View className="gap-3 px-gutter">
          {view.actions.map((action) => (
            <Button key={action} {...ACTIONS[action]} onPress={() => press(action)} />
          ))}
          {view.otherAccounts.map((account, index) => (
            <Button
              key={account.id}
              label={`Continue as ${account.label}`}
              variant="secondary"
              testID={`chatgpt-account-${index}`}
              onPress={() => void signIn("sheet", "returning", account.id)}
            />
          ))}
          {safari === undefined ? null : (
            <View className="gap-3 pt-4">
              <AppText variant="footnote" tone="secondary">
                Trouble signing in? If the sign-in page does not come back to svett, sign in with
                Safari instead.
              </AppText>
              <Button
                label="Sign in with Safari"
                variant="secondary"
                testID="chatgpt-safari"
                onPress={() =>
                  void signIn(
                    "safari",
                    safari,
                    safari === "returning" ? view.continueAs : undefined,
                  )
                }
              />
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}
