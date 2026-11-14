import { LegendList } from "@legendapp/list/react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { Post, SocialApi } from "@svett/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";

import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { runSocial, SignedInOnly } from "../social/api";
import { onPostChange } from "./changes";
import { PostCard } from "./PostCard";

type Feed =
  | { readonly status: "loading" }
  | { readonly status: "no_username" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly posts: ReadonlyArray<Post>;
      readonly next: string | null;
      readonly more: "idle" | "loading" | { readonly failed: string };
    };

/** Shows the inbox as a native bar button, with its unread count as a badge. */
function useInboxButton(api: SocialApi) {
  const navigation = useNavigation<RootNavigation>();
  const [unread, setUnread] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void runSocial(api.inbox()).then((result) => {
        if (current && result.ok) setUnread(result.value.unread);
      });
      return () => {
        current = false;
      };
    }, [api]),
  );
  useLayoutEffect(() => {
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "Inbox",
          icon: { type: "sfSymbol", name: unread > 0 ? "bell.badge" : "bell" },
          accessibilityLabel: unread > 0 ? `Inbox, ${unread} unread` : "Inbox",
          identifier: "inbox",
          ...(unread > 0 ? { badge: { value: unread > 99 ? "99+" : unread } } : {}),
          onPress: () => navigation.navigate("Inbox"),
        },
      ],
    });
  }, [navigation, unread]);
}

function FeedList({ api }: { readonly api: SocialApi }) {
  const navigation = useNavigation<RootNavigation>();
  const [feed, setFeed] = useState<Feed>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const loaded = useRef(false);
  useInboxButton(api);

  const load = useCallback(() => {
    let current = true;
    void runSocial(api.feed()).then((result) => {
      if (!current) return;
      setRefreshing(false);
      if (result.ok) {
        loaded.current = true;
        setFeed({ status: "ready", ...result.value, more: "idle" });
      } else if (result.problem === "username_required") {
        setFeed({ status: "no_username" });
      } else {
        setFeed({ status: "failed", message: result.message });
      }
    });
    return () => {
      current = false;
    };
  }, [api]);

  // The feed reads once when it first shows, then on pull to refresh, so returning from a
  // post keeps your place.
  useFocusEffect(
    useCallback(() => {
      if (!loaded.current) return load();
      return undefined;
    }, [load]),
  );

  useEffect(
    () =>
      onPostChange((postId, change) =>
        setFeed((current) =>
          current.status === "ready"
            ? {
                ...current,
                posts: current.posts.map((post) =>
                  post.activity.id === postId ? { ...post, ...change } : post,
                ),
              }
            : current,
        ),
      ),
    [],
  );

  const loadMore = () => {
    if (feed.status !== "ready" || feed.next === null || feed.more === "loading") return;
    const cursor = feed.next;
    setFeed({ ...feed, more: "loading" });
    void runSocial(api.feed(cursor)).then((result) =>
      setFeed((current) => {
        if (current.status !== "ready" || current.next !== cursor) return current;
        if (!result.ok) return { ...current, more: { failed: result.message } };
        const seen = new Set(current.posts.map((post) => post.activity.id));
        return {
          status: "ready",
          posts: [
            ...current.posts,
            ...result.value.posts.filter((post) => !seen.has(post.activity.id)),
          ],
          next: result.value.next,
          more: "idle",
        };
      }),
    );
  };

  switch (feed.status) {
    case "loading":
      return (
        <View
          testID="feed-loading"
          className="flex-1 items-center justify-center bg-background p-8"
        >
          <AppText tone="secondary">Asking svett</AppText>
        </View>
      );
    case "no_username":
      return (
        <View testID="feed-no-username" className="flex-1 justify-center bg-background">
          <EmptyState
            symbol="person.crop.circle.badge.plus"
            title="Choose a username"
            message="Your feed shows your posts and the people you follow. Choose a username so they can find you."
            action={{
              label: "Choose a username",
              onPress: () => navigation.navigate("EditProfile"),
            }}
          />
        </View>
      );
    case "failed":
      return (
        <View testID="feed-failed" className="flex-1 justify-center bg-background">
          <EmptyState
            symbol="exclamationmark.triangle"
            title="The feed did not load"
            message={feed.message}
            action={{ label: "Try again", onPress: load }}
          />
        </View>
      );
    case "ready":
      return (
        <View className="flex-1 bg-background">
          <LegendList
            testID="feed"
            data={feed.posts}
            keyExtractor={(post) => `${post.username}/${post.activity.id}`}
            renderItem={({ item }) => <PostCard api={api} post={item} />}
            estimatedItemSize={360}
            drawDistance={1200}
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ gap: 16, paddingTop: 12 }}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            onEndReached={loadMore}
            onEndReachedThreshold={1}
            ListEmptyComponent={
              <EmptyState
                symbol="person.2"
                title="Nothing here yet"
                message="Your posts and those of the people you follow show here, newest first."
                action={{ label: "Find people", onPress: () => navigation.navigate("People") }}
              />
            }
            ListFooterComponent={
              <View testID="feed-end" className="gap-3 px-gutter pb-12 pt-2">
                {typeof feed.more === "object" ? (
                  <>
                    <AppText tone="destructive">{feed.more.failed}</AppText>
                    <Button label="Try again" variant="secondary" onPress={loadMore} />
                  </>
                ) : feed.next === null && feed.posts.length > 0 ? (
                  <AppText tone="secondary" className="text-center">
                    You are all caught up.
                  </AppText>
                ) : null}
              </View>
            }
          />
        </View>
      );
  }
}

/** Home: your posts and those of the people you follow, newest first. */
export function FeedScreen() {
  return (
    <SignedInOnly
      signedOut={{
        title: "Sign in to see your feed",
        message:
          "The feed shows your posts and the people you follow. It needs a svett account. Logging works without one.",
      }}
    >
      {(api) => <FeedList api={api} />}
    </SignedInOnly>
  );
}
