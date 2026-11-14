import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  COMMENT_MAX_LENGTH,
  cleanComment,
  commentProblem,
  formatPostDistance,
  formatPostPace,
  formatVolumeKg,
  formatPostDuration,
  hiddenNote,
  likeButton,
  type LiftingDetail,
  type Post,
  type PostComment,
  postSetLines,
  splitLines,
  type PostThread,
  type RouteDetail,
  type SocialApi,
} from "@svett/core";
import { useCallback, useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useColor } from "../design/hooks";
import { SET_TYPE_COLOR } from "../design/tokens";
import type { RootStackParamList } from "../navigation";
import { formatDayAndTime } from "../progress/dates";
import { MuscleSplitCard } from "../progress/MuscleSplitCard";
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
  const lines = postSetLines(exercise.sets);
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
  return (
    <>
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Duration"
          value={formatPostDuration(post.activity.durationS)}
          symbol="clock"
        />
        <StatTile
          label="Volume"
          value={detail.volumeKg === null ? "Hidden" : formatVolumeKg(detail.volumeKg)}
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
      <View className="px-gutter">
        <RouteShape route={detail.route} height={240} testID="post-route" />
      </View>
      <View className="flex-row flex-wrap gap-3 px-gutter">
        <StatTile
          label="Distance"
          value={detail.distanceM === null ? "–" : formatPostDistance(detail.distanceM)}
          symbol="point.topleft.down.to.point.bottomright.curvepath"
          testID="post-distance"
        />
        <StatTile label="Time" value={formatPostDuration(post.activity.durationS)} symbol="clock" />
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

function Comments({
  api,
  thread,
  onChange,
}: {
  readonly api: SocialApi;
  readonly thread: PostThread;
  readonly onChange: (comments: ReadonlyArray<PostComment>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { post, comments } = thread;
  const update = (next: ReadonlyArray<PostComment>) => {
    onChange(next);
    postChanged(post.activity.id, { comments: next.length });
  };
  const send = () => {
    const invalid = commentProblem(cleanComment(draft));
    if (invalid !== undefined) return setProblem(invalid);
    setSending(true);
    setProblem(undefined);
    void runSocial(api.comment(post.activity.id, draft)).then((result) => {
      setSending(false);
      if (!result.ok) return setProblem(result.message);
      setDraft("");
      update([...comments, result.value]);
    });
  };
  const remove = (comment: PostComment) => {
    void runSocial(api.deleteComment(post.activity.id, comment.id)).then((result) => {
      if (!result.ok) return setProblem(result.message);
      update(comments.filter((other) => other.id !== comment.id));
    });
  };
  return (
    <View testID="post-comments" className="gap-3">
      <SectionHeader title="Comments" />
      {comments.length === 0 ? (
        <AppText tone="secondary" className="px-gutter" testID="no-comments">
          No comments yet.
        </AppText>
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
}: {
  readonly api: SocialApi;
  readonly initial: PostThread;
}) {
  const [thread, setThread] = useState(initial);
  const { post } = thread;
  const like = useLike(api, post, (likes) =>
    setThread((current) => ({ ...current, post: { ...current.post, ...likes } })),
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
      <Comments
        api={api}
        thread={thread}
        onChange={(comments) =>
          setThread((current) => ({
            post: { ...current.post, comments: comments.length },
            comments,
          }))
        }
      />
    </>
  );
}

function ThreadRead({ api, route, navigation }: Props & { readonly api: SocialApi }) {
  const { id } = route.params;
  const read = useCallback(() => api.post(id), [api, id]);
  const { state } = useSocialRead(read);
  const title = state.status === "ready" ? postTitle(state.value.post) : "Post";
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  return (
    <SocialView state={state} testID="post">
      {(thread) => <ThreadContent key={thread.post.activity.id} api={api} initial={thread} />}
    </SocialView>
  );
}

/** One post in full: its sets or route, its likes and its comments. */
export function PostScreen(props: Props) {
  return (
    <ScrollView
      testID="post"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <SignedInOnly>{(api) => <ThreadRead {...props} api={api} />}</SignedInOnly>
    </ScrollView>
  );
}
