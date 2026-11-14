import {
  type ChatGPTStatus,
  CoachMessageRepository,
  type CoachFailure,
  coachFailure,
  ConversationId,
} from "@svett/core";
import { askCoach, type ChatEntry, chatEntries } from "@svett/tools";
import { type RouteProp, useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import { Effect } from "effect";
import { uuid } from "expo";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Linking,
  ScrollView,
  type ScrollViewInstance,
  View,
} from "react-native";

import { chatGPTStatus } from "../chatgpt/native";
import { appDatabase } from "../data/database";
import type { CoachNavigation, CoachStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { NoticeScreen } from "../ui/NoticeScreen";
import { Composer } from "./Composer";
import { swiftTransport } from "./native";

type CoachRoute = RouteProp<CoachStackParamList, "CoachRoot">;

/** The question being answered: what the coach has read so far and the answer as it arrives. */
type Pending = {
  readonly question: string;
  readonly reads: ReadonlyArray<string>;
  readonly draft: string;
};

const NO_SOURCES: ReadonlyArray<string> = [];

const newConversation = () => ConversationId.make(uuid.v4());

const loadEntries = (conversationId: ConversationId) =>
  appDatabase().runPromise(
    Effect.map(
      Effect.flatMap(Effect.service(CoachMessageRepository), (messages) =>
        messages.conversation(conversationId),
      ),
      chatEntries,
    ),
  );

const latestConversation = () =>
  appDatabase().runPromise(
    Effect.flatMap(
      Effect.service(CoachMessageRepository),
      (messages) => messages.latestConversation,
    ),
  );

function readLine(sources: ReadonlyArray<string>) {
  return sources.length === 0 ? "Read none of your data" : `Read: ${sources.join(" · ")}`;
}

function Question({
  text,
  sources,
}: {
  readonly text: string;
  readonly sources: ReadonlyArray<string>;
}) {
  return (
    <View className="max-w-[85%] gap-1 self-end">
      <View className="rounded-card bg-accent-fill px-4 py-2">
        <AppText tone="onAccent" selectable>
          {text}
        </AppText>
      </View>
      {/* A question that failed after reading data still says what it read. */}
      {sources.length === 0 ? null : (
        <AppText variant="footnote" tone="secondary" className="px-2">
          {readLine(sources)}
        </AppText>
      )}
    </View>
  );
}

function Answer({ entry, last }: { readonly entry: ChatEntry; readonly last: boolean }) {
  return (
    <View className="gap-1 self-stretch">
      <View className="rounded-card bg-surface px-4 py-3">
        <AppText testID={last ? "coach-answer" : undefined} selectable>
          {entry.text}
        </AppText>
      </View>
      <AppText
        testID={last ? "coach-sources" : undefined}
        variant="footnote"
        tone="secondary"
        className="px-2"
      >
        {readLine(entry.sources)}
      </AppText>
    </View>
  );
}

function FailureNotice({
  failure,
  openSettings,
}: {
  readonly failure: CoachFailure;
  readonly openSettings: () => void;
}) {
  return (
    <View testID={`coach-failure-${failure.kind}`} className="gap-3 self-stretch">
      <AppText testID="coach-failure" tone="warning" selectable>
        {failure.text}
      </AppText>
      {failure.link === undefined ? null : (
        <Button
          label={failure.link.label}
          variant="secondary"
          testID="coach-usage-settings"
          onPress={() => void Linking.openURL(failure.link!.url)}
        />
      )}
      {failure.kind === "signIn" || failure.kind === "planUsageOff" ? (
        <Button label="Open ChatGPT settings" variant="secondary" onPress={openSettings} />
      ) : null}
    </View>
  );
}

/** The Coach tab: a chat with the user's ChatGPT plan that answers from their own data. */
export function CoachScreen() {
  const navigation = useNavigation<CoachNavigation>();
  const route = useRoute<CoachRoute>();
  const scroll = useRef<ScrollViewInstance>(null);
  const [status, setStatus] = useState<ChatGPTStatus>();
  const [statusFailed, setStatusFailed] = useState(false);
  // Asking again before ChatGPT's next status check would only hit the plan's limit again.
  const [limited, setLimited] = useState(false);
  const [conversationId, setConversationId] = useState<ConversationId>();
  const [entries, setEntries] = useState<ReadonlyArray<ChatEntry>>([]);
  const [pending, setPending] = useState<Pending>();
  const [failure, setFailure] = useState<CoachFailure>();

  const checkStatus = useCallback(() => {
    chatGPTStatus().then(
      (next) => {
        setStatus(next);
        setStatusFailed(false);
        setLimited(false);
      },
      () => setStatusFailed(true),
    );
  }, []);
  useFocusEffect(checkStatus);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") checkStatus();
    });
    return () => subscription.remove();
  }, [checkStatus]);

  useEffect(() => {
    latestConversation().then(
      async (latest) => {
        const id = latest ?? newConversation();
        setEntries(latest === null ? [] : await loadEntries(id));
        setConversationId(id);
      },
      () => setConversationId(newConversation()),
    );
  }, []);

  const ready = status?.state === "signedIn" && status.planUsage && conversationId !== undefined;

  const ask = useCallback(
    async (question: string) => {
      if (conversationId === undefined || pending !== undefined) return;
      setFailure(undefined);
      setPending({ question, reads: [], draft: "" });
      try {
        const outcome = await appDatabase().runPromise(
          askCoach({
            conversationId,
            question,
            transport: swiftTransport,
            offsetMinutes: -new Date().getTimezoneOffset(),
            hooks: {
              onText: (delta) => setPending((now) => now && { ...now, draft: now.draft + delta }),
              onRead: (source) =>
                setPending((now) => now && { ...now, reads: [...now.reads, source], draft: "" }),
            },
          }),
        );
        if (outcome.type === "failed") {
          setFailure(outcome.failure);
          if (outcome.failure.kind === "planLimit") setLimited(true);
        }
      } catch (error) {
        setFailure({
          ...coachFailure("other"),
          text: error instanceof Error ? error.message : String(error),
        });
      }
      setEntries(await loadEntries(conversationId));
      setPending(undefined);
      chatGPTStatus().then(setStatus, () => undefined);
    },
    [conversationId, pending],
  );

  // scripts/sim/coach.sh asks through svett://coach?ask=..., because agent-device cannot type
  // into screen content on iOS 27.
  const linked = route.params?.ask;
  useEffect(() => {
    if (linked === undefined || !ready || pending !== undefined) return;
    navigation.setParams({ ask: undefined });
    // A link is an event from outside React, so the question starts here.
    // oxlint-disable-next-line react/set-state-in-effect
    void ask(linked);
  }, [linked, ready, pending, ask, navigation]);

  const openSettings = () => navigation.navigate("ChatGPT");

  if (status === undefined && statusFailed) {
    return (
      <NoticeScreen testID="coach-status-failed" className="gap-4 px-gutter">
        <AppText tone="warning" selectable>
          svett could not read your ChatGPT sign-in. Everything else in svett still works.
        </AppText>
        <Button label="Try again" variant="secondary" testID="coach-retry" onPress={checkStatus} />
      </NoticeScreen>
    );
  }

  if (status === undefined || conversationId === undefined) {
    return (
      <NoticeScreen testID="coach" className="items-center">
        <AppText tone="secondary">Opening the coach…</AppText>
      </NoticeScreen>
    );
  }

  if (status.state === "signedOut") {
    return (
      <NoticeScreen testID="coach-signed-out">
        <EmptyState
          symbol="sparkles"
          title="Coach"
          message="The coach answers from your own training data and runs on your ChatGPT plan. Everything else in svett works without it."
          action={{ label: "Continue with ChatGPT", onPress: openSettings }}
        />
      </NoticeScreen>
    );
  }

  if (!status.planUsage) {
    return (
      <NoticeScreen testID="coach-plan-usage-off" className="gap-4 px-gutter">
        <FailureNotice failure={coachFailure("planUsageOff")} openSettings={openSettings} />
      </NoticeScreen>
    );
  }

  const lastAnswer = entries.reduce(
    (last, entry, index) => (entry.role === "assistant" ? index : last),
    -1,
  );
  return (
    <>
      <ScrollView
        ref={scroll}
        testID="coach"
        className="flex-1 bg-background"
        contentContainerClassName="gap-3 px-gutter py-4"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {entries.length === 0 && pending === undefined ? (
          <AppText tone="secondary" className="text-center">
            Ask about your workouts, records or measurements. Each answer says which of your data it
            read.
          </AppText>
        ) : (
          <Button
            label="New chat"
            variant="plain"
            testID="coach-new"
            disabled={pending !== undefined}
            onPress={() => {
              setEntries([]);
              if (!limited) setFailure(undefined);
              setConversationId(newConversation());
            }}
          />
        )}
        {entries.map((entry, index) =>
          entry.role === "user" ? (
            <Question key={entry.id} text={entry.text} sources={entry.sources} />
          ) : (
            <Answer
              key={entry.id}
              entry={entry}
              last={index === lastAnswer && pending === undefined}
            />
          ),
        )}
        {pending === undefined ? null : (
          <View testID="coach-pending" className="gap-3 self-stretch">
            <Question text={pending.question} sources={NO_SOURCES} />
            <View className="rounded-card bg-surface px-4 py-3">
              <AppText testID="coach-draft" tone={pending.draft === "" ? "secondary" : "label"}>
                {pending.draft === "" ? "Reading your data…" : pending.draft}
              </AppText>
            </View>
            {pending.reads.length === 0 ? null : (
              <AppText variant="footnote" tone="secondary" className="px-2">
                {readLine(pending.reads)}
              </AppText>
            )}
          </View>
        )}
        {failure === undefined ? null : (
          <FailureNotice failure={failure} openSettings={openSettings} />
        )}
      </ScrollView>
      {/* Only the composer avoids the keyboard. Its padding shrinks the scroll view above it. */}
      <KeyboardAvoidingView behavior="padding" className="bg-background">
        <Composer
          busy={pending !== undefined || !ready || limited}
          onSend={(question) => void ask(question)}
        />
      </KeyboardAvoidingView>
    </>
  );
}
