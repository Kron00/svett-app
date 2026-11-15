import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  COMMENT_MAX_LENGTH,
  type CommentPage,
  cleanComment,
  commentProblem,
  countOf,
  formatPostDistance,
  formatPostPace,
  formatVolumeKg,
  formatPostDuration,
  hiddenNote,
  likeButton,
  type LiftingDetail,
  mergeComments,
  type Post,
  type PostComment,
  postSetLines,
  routeMap,
  splitLines,
  type PostThread,
  type RouteDetail,
  type SocialApi,
} from "@svett/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useColor } from "../design/hooks";
import { SET_TYPE_COLOR } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { formatDayAndTime } from "../progress/dates";
import { MuscleSplitCard } from "../progress/MuscleSplitCard";
import { useWorkoutSettings } from "../settings/store";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { StatTile } from "../ui/StatTile";
import { TextField } from "../ui/TextField";
import { runSocial, SignedInOnly, SocialView, useSocialRead } from "../social/api";
import { postChanged } from "./changes";
import { CountButton, postLine, postTitle, useLike } from "./PostCard";
import { RouteShape } from "./RouteShape";

type Props = NativeStackScreenProps<RootStackParamList, "Post">;

function SetLine({
  badge,
  text,
  color,
}: {
  readonly badge: { readonly text: string; readonly label: string };
  readonly text: string;
  readonly color: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${badge.label}, ${text}`}
      className="min-h-target flex-row items-center gap-3 py-1"
    >
      <AppText variant="headline" numeric className="min-w-8 text-center" style={{ color }}>
        {badge.text}
      </AppText>
      <AppText numeric className="flex-1">
        {text}
      </AppText>
    </View>
  );
}

function ExerciseSets({ exercise }: { readonly exercise: LiftingDetail["exercises"][number] }) {
  const colors = {
    warm_up: useColor(SET_TYPE_COLOR.warm_up),
    normal: useColor(SET_TYPE_COLOR.normal),
    failure: useColor(SET_TYPE_COLOR.failure),
    drop: useColor(SET_TYPE_COLOR.drop),
  };
  const { unit } = useWorkoutSettings();
  const lines = postSetLines(exercise.sets, unit);
  return (
    <View className="mx-gutter gap-1 rounded-card bg-surface px-4 py-3">
      <AppText variant="headline" accessibilityRole="header">
        {exercise.name}
      </AppText>
      {lines.map((line) => (
        <SetLine
          key={line.position}
          badge={line.badge}
          text={line.text}
          color={colors[line.setType]}
        />
      ))}
    </View>
  );
}

function LiftingSection({ post, detail }: { readonly post: Post; readonly detail: LiftingDetail }) {
  const { unit } = useWorkoutSettings();
  return (
    <>
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Duration"
          value={formatPostDuration(post.activity.durationS)}
          symbol="clock"
          testID="post-duration"
        />
        <StatTile
          label="Volume"
          value={detail.volumeKg === null ? "Hidden" : formatVolumeKg(detail.volumeKg, unit)}
          symbol="scalemass"
          testID="post-volume"
        />
        <StatTile
          label="Sets"
          value={String(detail.exercises.reduce((total, entry) => total + entry.sets.length, 0))}
          symbol="number"
        />
      </View>
      {detail.split.length > 0 ? <MuscleSplitCard split={detail.split} /> : null}
      {detail.exercises.length > 0 ? (
        <View testID="post-exercises" className="gap-3">
          <SectionHeader title="Exercises" />
          {detail.exercises.map((exercise) => (
            <ExerciseSets key={exercise.position} exercise={exercise} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function RouteSection({ post, detail }: { readonly post: Post; readonly detail: RouteDetail }) {
  return (
    <>
      {routeMap(detail) === "none" ? null : (
        <View className="px-gutter">
          <RouteShape detail={detail} height={240} testID="post-route" />
        </View>
      )}
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Distance"
          value={detail.distanceM === null ? "–" : formatPostDistance(detail.distanceM)}
          symbol="point.topleft.down.to.point.bottomright.curvepath"
          testID="post-distance"
        />
        <StatTile
          label="Time"
          value={formatPostDuration(post.activity.durationS)}
          symbol="clock"
          testID="post-time"
        />
        <StatTile
          label="Pace"
          value={detail.paceSPerKm === null ? "Hidden" : formatPostPace(detail.paceSPerKm)}
          symbol="speedometer"
          testID="post-pace"
        />
        {detail.elevationGainM === null ? null : (
          <StatTile
            label="Climb"
            value={`${Math.round(detail.elevationGainM)} m`}
            symbol="mountain.2"
          />
        )}
        {detail.averageHeartRateBpm === null ? null : (
          <StatTile
            label="Heart rate"
            value={`${detail.averageHeartRateBpm} bpm`}
            symbol="heart.fill"
            color="destructive"
            testID="post-heart-rate"
          />
        )}
      </View>
      {detail.splits.length > 0 ? (
        <View testID="post-splits">
          <ListSection header="Splits">
            {splitLines(detail.splits).map((line) => (
              <ListRow
                key={line.endM}
                title={line.title}
                value={line.pace}
                testID={`post-split-${line.number}`}
              />
            ))}
          </ListSection>
        </View>
      ) : null}
    </>
  );
}

function CommentRow({
  comment,
  onDelete,
}: {
  readonly comment: PostComment;
  readonly onDelete: (() => void) | undefined;
}) {
  return (
    <View testID={`comment-${comment.id}`} className="gap-1 px-gutter py-3">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3">
        <AppText variant="headline">{comment.username}</AppText>
        <AppText variant="footnote" tone="secondary">
          {formatDayAndTime(comment.at)}
        </AppText>
      </View>
      {/* A comment is someone's words, shown as plain text and never read as instructions. */}
      <AppText selectable>{comment.body}</AppText>
      {onDelete === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${comment.username}'s comment`}
          onPress={onDelete}
          className="min-h-target justify-center self-start"
        >
          <AppText tone="destructive">Delete</AppText>
        </Pressable>
      )}
    </View>
  );
}

type Paging = "idle" | "loading" | { readonly failed: string };

function PageButton({
  label,
  paging,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly paging: Paging;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  return (
    <View className="gap-2 px-gutter">
      {typeof paging === "object" ? <AppText tone="destructive">{paging.failed}</AppText> : null}
      <Button
        label={paging === "loading" ? "Loading" : label}
        variant="secondary"
        disabled={paging === "loading"}
        onPress={onPress}
        testID={testID}
      />
    </View>
  );
}

function Comments({
  api,
  post,
  initial,
  atEnd,
  onCount,
}: {
  readonly api: SocialApi;
  readonly post: Post;
  readonly initial: CommentPage;
  /** The screen is scrolled near its end, so the next page of comments loads. */
  readonly atEnd: boolean;
  readonly onCount: (count: number) => void;
}) {
  const [page, setPage] = useState(initial);
  const [paging, setPaging] = useState<{ readonly earlier: Paging; readonly later: Paging }>({
    earlier: "idle",
    later: "idle",
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const sent = useRef(new Set<string>());
  const postId = post.activity.id;
  const count = (change: number) => {
    const next = Math.max(0, post.comments + change);
    onCount(next);
    postChanged(postId, { comments: next });
  };

  const load = useCallback(
    (side: "earlier" | "later") => {
      const cursor = page[side];
      if (cursor === null || paging[side] === "loading") return;
      const mark = (state: Paging) => setPaging((current) => ({ ...current, [side]: state }));
      mark("loading");
      // A cursor names one comment and stops working once it is deleted. The thread then
      // reopens at the nearest shown comment that came from the server.
      const reopen = () => {
        const paged = page.comments.filter((comment) => !sent.current.has(comment.id));
        return runSocial(api.post(postId, (side === "later" ? paged.at(-1) : paged[0])?.id));
      };
      void runSocial<CommentPage & { readonly post?: Post }>(
        api.comments(postId, side === "later" ? { later: cursor } : { earlier: cursor }),
      )
        .then((result) => (!result.ok && result.problem === "invalid_cursor" ? reopen() : result))
        .then((result) => {
          if (!result.ok) return mark({ failed: result.message });
          mark("idle");
          setPage((current) =>
            current[side] !== cursor
              ? current
              : {
                  ...current,
                  comments: mergeComments(current.comments, result.value.comments),
                  [side]: result.value[side],
                },
          );
          if (result.value.post !== undefined) onCount(result.value.post.comments);
        });
    },
    [api, postId, page, paging, onCount],
  );

  // Only an idle list loads by itself. After a failure the button asks again, so a page
  // that keeps failing is not requested over and over.
  useEffect(() => {
    if (atEnd && paging.later === "idle") load("later");
  }, [atEnd, load, paging.later]);

  const send = () => {
    const invalid = commentProblem(cleanComment(draft));
    if (invalid !== undefined) return setProblem(invalid);
    setSending(true);
    setProblem(undefined);
    void runSocial(api.comment(postId, draft)).then((result) => {
      setSending(false);
      if (!result.ok) return setProblem(result.message);
      setDraft("");
      sent.current.add(result.value.id);
      setPage((current) => ({
        ...current,
        comments: mergeComments(current.comments, [result.value]),
      }));
      count(1);
    });
  };
  const remove = (comment: PostComment) => {
    void runSocial(api.deleteComment(postId, comment.id)).then((result) => {
      if (!result.ok) return setProblem(result.message);
      setPage((current) => ({
        ...current,
        comments: current.comments.filter((other) => other.id !== comment.id),
      }));
      count(-1);
    });
  };
  const { comments } = page;
  return (
    <View testID="post-comments" className="gap-3">
      <SectionHeader
        title={post.comments === 0 ? "Comments" : countOf(post.comments, "comment", "comments")}
      />
      {page.earlier === null ? null : (
        <PageButton
          label="Show earlier comments"
          paging={paging.earlier}
          onPress={() => load("earlier")}
          testID="comments-earlier"
        />
      )}
      {comments.length === 0 ? (
        page.later === null ? (
          <AppText tone="secondary" className="px-gutter" testID="no-comments">
            No comments yet.
          </AppText>
        ) : null
      ) : (
        <View className="mx-gutter overflow-hidden rounded-card bg-surface">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              onDelete={comment.canDelete ? () => remove(comment) : undefined}
            />
          ))}
        </View>
      )}
      {page.later === null ? null : (
        <PageButton
          label="Show more comments"
          paging={paging.later}
          onPress={() => load("later")}
          testID="comments-later"
        />
      )}
      <View className="gap-3 px-gutter">
        <TextField
          label="Your comment"
          value={draft}
          onChangeText={setDraft}
          multiline
          maxLength={COMMENT_MAX_LENGTH * 2}
          placeholder="Say something nice"
          returnKeyType="default"
          problem={problem}
          testID="comment-field"
        />
        <Button
          label={sending ? "Sending" : "Send comment"}
          symbol="paperplane.fill"
          disabled={sending || draft.trim() === ""}
          onPress={send}
          testID="comment-send"
        />
      </View>
    </View>
  );
}

function ThreadContent({
  api,
  initial,
  atEnd,
}: {
  readonly api: SocialApi;
  readonly initial: PostThread;
  readonly atEnd: boolean;
}) {
  const [post, setPost] = useState(initial.post);
  const like = useLike(api, post, (likes) => setPost((current) => ({ ...current, ...likes })));
  const onCount = useCallback(
    (comments: number) => setPost((current) => ({ ...current, comments })),
    [],
  );
  const button = likeButton(post);
  const note = post.mine ? undefined : hiddenNote(post.username, post.activity.hiddenFields);
  return (
    <>
      <View className="gap-1 px-gutter">
        <AppText variant="subheadline" tone="secondary">
          {post.mine ? "You" : post.username}
        </AppText>
        <AppText variant="title2" accessibilityRole="header" testID="post-title">
          {postTitle(post)}
        </AppText>
        <AppText variant="subheadline" tone="secondary" testID="post-line">
          {postLine(post)}
        </AppText>
        {post.activity.notes ? <AppText className="pt-2">{post.activity.notes}</AppText> : null}
        {note === undefined ? null : (
          <AppText variant="footnote" tone="secondary" className="pt-2" testID="post-hidden">
            {note}
          </AppText>
        )}
      </View>
      {post.detail?.type === "lifting" ? <LiftingSection post={post} detail={post.detail} /> : null}
      {post.detail?.type === "route" ? <RouteSection post={post} detail={post.detail} /> : null}
      <View className="flex-row flex-wrap gap-x-2 px-gutter">
        <CountButton
          symbol={button.symbol}
          label={button.label}
          count={post.likes}
          hint={button.hint}
          selected={post.liked}
          disabled={like.busy}
          onPress={like.toggle}
          testID="post-like"
        />
      </View>
      {like.problem === undefined ? null : (
        <AppText tone="destructive" className="px-gutter">
          {like.problem}
        </AppText>
      )}
      <Comments api={api} post={post} initial={initial} atEnd={atEnd} onCount={onCount} />
    </>
  );
}

function ThreadRead({
  api,
  route,
  navigation,
  atEnd,
}: Props & { readonly api: SocialApi; readonly atEnd: boolean }) {
  const { id, comment } = route.params;
  const read = useCallback(() => api.post(id, comment), [api, id, comment]);
  const { state } = useSocialRead(read);
  const title = state.status === "ready" ? postTitle(state.value.post) : "Post";
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  return (
    <SocialView state={state} testID="post">
      {(thread) => (
        <ThreadContent key={thread.post.activity.id} api={api} initial={thread} atEnd={atEnd} />
      )}
    </SocialView>
  );
}

/** How close to the end, in points, the next page of comments starts loading. */
const END_DISTANCE = 600;

/**
 * One post in full: its sets or route, its likes and its comments. Opened from an inbox item,
 * it shows the page of comments that holds the item's comment.
 */
export function PostScreen(props: Props) {
  const view = useRef({ offset: 0, height: 0, content: 0 });
  const [atEnd, setAtEnd] = useState(false);
  const measure = (change: Partial<typeof view.current>) => {
    view.current = { ...view.current, ...change };
    const { offset, height, content } = view.current;
    setAtEnd(content > 0 && offset + height >= content - END_DISTANCE);
  };
  return (
    <ScrollView
      testID="post"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={100}
      onScroll={(event) =>
        measure({
          offset: event.nativeEvent.contentOffset.y,
          height: event.nativeEvent.layoutMeasurement.height,
          content: event.nativeEvent.contentSize.height,
        })
      }
      onLayout={(event) => measure({ height: event.nativeEvent.layout.height })}
      onContentSizeChange={(_, content) => measure({ content })}
    >
      <SignedInOnly>{(api) => <ThreadRead {...props} api={api} atEnd={atEnd} />}</SignedInOnly>
    </ScrollView>
  );
}
