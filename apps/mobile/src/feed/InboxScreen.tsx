import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { type InboxItem, inboxLine, type SocialApi } from "@svett/core";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import type { RootNavigation } from "../navigation";
import { formatDayAndTime } from "../progress/dates";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Icon } from "../ui/Icon";
import { runSocial, SignedInOnly } from "../social/api";

type Inbox =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly items: ReadonlyArray<InboxItem>;
      readonly next: string | null;
      readonly loadingMore: boolean;
    };

const SYMBOL = {
  like: "heart.fill",
  comment: "bubble.left.fill",
  follow: "person.fill.checkmark",
  follow_request: "person.badge.clock",
} as const;

function InboxRow({ item }: { readonly item: InboxItem }) {
  const navigation = useNavigation<RootNavigation>();
  const open = () => {
    switch (item.kind) {
      case "like":
      case "comment":
        return navigation.push("Post", { id: item.post.id });
      case "follow":
        return navigation.push("Profile", { username: item.username });
      case "follow_request":
        return navigation.navigate("FollowRequests");
    }
  };
  const line = inboxLine(item);
  const when = formatDayAndTime(item.at);
  return (
    <Pressable
      testID={`inbox-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={[
        item.unread ? "Unread" : undefined,
        line,
        item.kind === "comment" ? item.body : undefined,
        when,
      ]
        .filter((part) => part !== undefined)
        .join(", ")}
      onPress={open}
      className="min-h-target flex-row gap-3 px-gutter py-3"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="w-2 items-center pt-2">
        {item.unread ? (
          <View testID={`inbox-unread-${item.id}`} className="h-2 w-2 rounded-full bg-accent" />
        ) : null}
      </View>
      <Icon
        name={SYMBOL[item.kind]}
        color={item.kind === "like" ? "destructive" : "accent"}
        size={17}
      />
      <View className="flex-1 gap-1">
        <AppText variant={item.unread ? "headline" : "body"}>{line}</AppText>
        {item.kind === "comment" ? (
          <AppText tone="secondary" numberOfLines={3}>
            {item.body}
          </AppText>
        ) : null}
        <AppText variant="footnote" tone="secondary">
          {when}
        </AppText>
      </View>
    </Pressable>
  );
}

function InboxList({ api }: { readonly api: SocialApi }) {
  const [inbox, setInbox] = useState<Inbox>({ status: "loading" });

  // Unread items keep their mark on this visit and read as seen on the next.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void runSocial(api.inbox()).then((result) => {
        if (!current) return;
        if (!result.ok) return setInbox({ status: "failed", message: result.message });
        setInbox({ status: "ready", ...result.value, loadingMore: false });
        const newest = result.value.items[0];
        if (newest !== undefined && result.value.unread > 0) {
          void runSocial(api.markInboxRead(newest.at));
        }
      });
      return () => {
        current = false;
      };
    }, [api]),
  );

  const more = () => {
    if (inbox.status !== "ready" || inbox.next === null) return;
    const cursor = inbox.next;
    setInbox({ ...inbox, loadingMore: true });
    void runSocial(api.inbox(cursor)).then((result) =>
      setInbox((current) =>
        current.status !== "ready" || current.next !== cursor
          ? current
          : result.ok
            ? {
                status: "ready",
                items: [...current.items, ...result.value.items],
                next: result.value.next,
                loadingMore: false,
              }
            : { status: "failed", message: result.message },
      ),
    );
  };

  switch (inbox.status) {
    case "loading":
      return (
        <View testID="inbox-loading" className="items-center p-8">
          <AppText tone="secondary">Asking svett</AppText>
        </View>
      );
    case "failed":
      return (
        <View testID="inbox-failed" className="justify-center">
          <EmptyState
            symbol="exclamationmark.triangle"
            title="The inbox did not load"
            message={inbox.message}
          />
        </View>
      );
    case "ready":
      if (inbox.items.length === 0) {
        return (
          <View testID="inbox-empty">
            <EmptyState
              symbol="bell"
              title="Nothing new"
              message="Likes, comments, follows and follow requests show here."
            />
          </View>
        );
      }
      return (
        <View testID="inbox-items" className="gap-4">
          <View className="mx-gutter overflow-hidden rounded-card bg-surface">
            {inbox.items.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </View>
          {inbox.next === null ? null : (
            <View className="px-gutter">
              <Button
                label="Show older"
                variant="secondary"
                disabled={inbox.loadingMore}
                onPress={more}
                testID="inbox-more"
              />
            </View>
          )}
        </View>
      );
  }
}

/** Likes and comments on your posts, replies where you commented, follows and follow requests. */
export function InboxScreen() {
  return (
    <ScrollView
      testID="inbox"
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      <SignedInOnly
        signedOut={{
          title: "Sign in to see your inbox",
          message: "Likes, comments and follows need a svett account.",
        }}
      >
        {(api) => <InboxList api={api} />}
      </SignedInOnly>
    </ScrollView>
  );
}
