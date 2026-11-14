import { useNavigation } from "@react-navigation/native";
import {
  activityLine,
  AUDIENCE_LABEL,
  countOf,
  likeButton,
  liftingLine,
  MUSCLE_LABEL,
  type Post,
  type PostDetail,
  routeLine,
  type SocialApi,
} from "@svett/core";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SPORTS } from "../design/tokens";
import type { RootNavigation } from "../navigation";
import { formatDay } from "../progress/dates";
import { AppText } from "../ui/AppText";
import { Icon } from "../ui/Icon";
import { runSocial } from "../social/api";
import { postChanged } from "./changes";
import { RouteShape } from "./RouteShape";

/** The title a post shows, or its sport's name when it has none. */
export const postTitle = (post: Post) =>
  post.activity.title.trim() || SPORTS[post.activity.kind].label;

/** The line under a post's title: sport, length, day, and who sees it when it is yours. */
export const postLine = (post: Post) =>
  [
    activityLine(post.activity, formatDay),
    post.audience === null ? undefined : AUDIENCE_LABEL[post.audience],
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

function DetailSummary({ detail, id }: { readonly detail: PostDetail; readonly id: string }) {
  if (detail.type === "route") {
    return (
      <View className="gap-2">
        <RouteShape route={detail.route} height={160} testID={`post-route-${id}`} />
        <AppText variant="headline" numeric testID={`post-numbers-${id}`}>
          {routeLine(detail)}
        </AppText>
      </View>
    );
  }
  const muscles = detail.split
    .slice(0, 3)
    .map((share) => `${MUSCLE_LABEL[share.muscle]} ${share.percent}%`)
    .join(" · ");
  return (
    <View className="gap-1">
      <AppText variant="headline" numeric testID={`post-numbers-${id}`}>
        {liftingLine(detail)}
      </AppText>
      {detail.exercises.slice(0, 3).map((exercise) => (
        <AppText key={exercise.position} tone="secondary">
          {`${exercise.name} · ${countOf(exercise.sets.length, "set", "sets")}`}
        </AppText>
      ))}
      {detail.exercises.length > 3 ? (
        <AppText tone="secondary">{`and ${detail.exercises.length - 3} more`}</AppText>
      ) : null}
      {muscles === "" ? null : (
        <AppText variant="subheadline" tone="accent" testID={`post-muscles-${id}`}>
          {muscles}
        </AppText>
      )}
    </View>
  );
}

/** A small button with an icon and a count, such as the like button, 44 points tall. */
export function CountButton({
  symbol,
  label,
  count,
  hint,
  selected = false,
  disabled = false,
  onPress,
  testID,
}: {
  readonly symbol: "heart" | "heart.fill" | "bubble.left";
  readonly label: string;
  readonly count: number;
  readonly hint: string;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityHint={hint}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      className="min-h-target min-w-target flex-row items-center gap-2 px-2"
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Icon name={symbol} color={selected ? "destructive" : "secondary-label"} size={20} />
      <AppText tone="secondary" numeric>
        {`${label} · ${count}`}
      </AppText>
    </Pressable>
  );
}

/** Likes or takes back the like, and tells the feed. */
export function useLike(
  api: SocialApi,
  post: Post,
  onChange: (likes: Pick<Post, "likes" | "liked">) => void,
) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const toggle = () => {
    setBusy(true);
    setProblem(undefined);
    const request = post.liked ? api.unlike(post.activity.id) : api.like(post.activity.id);
    void runSocial(request).then((result) => {
      setBusy(false);
      if (!result.ok) return setProblem(result.message);
      onChange(result.value);
      postChanged(post.activity.id, result.value);
    });
  };
  return { busy, problem, toggle };
}

/** One post in the feed: who, what, the numbers that matter, and its likes and comments. */
export function PostCard({ api, post }: { readonly api: SocialApi; readonly post: Post }) {
  const navigation = useNavigation<RootNavigation>();
  const id = post.activity.id;
  const like = useLike(api, post, () => undefined);
  const button = likeButton(post);
  const open = () => navigation.push("Post", { id: post.activity.id });
  return (
    <View testID={`post-${id}`} className="mx-gutter gap-3 rounded-card bg-surface p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={post.mine ? "Your profile" : `${post.username}'s profile`}
        onPress={() =>
          post.mine
            ? navigation.navigate("OwnProfile")
            : navigation.push("Profile", { username: post.username })
        }
        className="min-h-target flex-row items-center gap-2 self-start"
      >
        <Icon
          name={SPORTS[post.activity.kind].symbol}
          color={SPORTS[post.activity.kind].color}
          size={17}
        />
        <AppText variant="headline">{post.mine ? "You" : post.username}</AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${postTitle(post)}, ${postLine(post)}`}
        accessibilityHint="Opens the post with its comments"
        onPress={open}
        testID={`post-open-${id}`}
        className="gap-2"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <View className="gap-0.5">
          <AppText variant="title3">{postTitle(post)}</AppText>
          <AppText variant="subheadline" tone="secondary">
            {postLine(post)}
          </AppText>
        </View>
        {post.detail === null ? null : <DetailSummary detail={post.detail} id={id} />}
      </Pressable>
      <View className="flex-row flex-wrap gap-x-2">
        <CountButton
          symbol={button.symbol}
          label={button.label}
          count={post.likes}
          hint={button.hint}
          selected={post.liked}
          disabled={like.busy}
          onPress={like.toggle}
          testID={`post-like-${id}`}
        />
        <CountButton
          symbol="bubble.left"
          label="Comments"
          count={post.comments}
          hint="Opens the comments"
          onPress={open}
          testID={`post-comments-${id}`}
        />
      </View>
      {like.problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite">
          {like.problem}
        </AppText>
      )}
    </View>
  );
}
