import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  type ActivityPage,
  activityLine,
  followButton,
  type OwnProfile,
  type ProfileView,
  type SocialApi,
} from "@svett/core";
import { type ReactNode, useCallback, useLayoutEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import type { RootNavigation, RootStackParamList } from "../navigation";
import { formatDay } from "../progress/dates";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { runSocial, SignedInOnly, SocialView, useSocialRead } from "./api";

export function Screen({
  testID,
  children,
}: {
  readonly testID: string;
  readonly children: ReactNode;
}) {
  return (
    <ScrollView
      testID={testID}
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}

function Counts({
  username,
  followers,
  following,
  own = false,
}: {
  readonly username: string;
  readonly followers: number;
  readonly following: number;
  /** The signed-in account's own lists, where a follower can be removed. */
  readonly own?: boolean;
}) {
  const navigation = useNavigation<RootNavigation>();
  return (
    <ListSection>
      <ListRow
        title="Followers"
        value={String(followers)}
        testID="followers-row"
        trailing={{
          type: "chevron",
          onPress: () =>
            navigation.push("Connections", {
              username,
              list: "followers",
              ...(own ? { own: "yes" } : {}),
            }),
        }}
      />
      <ListRow
        title="Following"
        value={String(following)}
        testID="following-row"
        trailing={{
          type: "chevron",
          onPress: () => navigation.push("Connections", { username, list: "following" }),
        }}
      />
    </ListSection>
  );
}

function OwnProfileContent({ own }: { readonly own: OwnProfile }) {
  const navigation = useNavigation<RootNavigation>();
  return (
    <>
      <View className="mx-gutter gap-2">
        {own.username === null ? (
          <>
            <AppText variant="title2" accessibilityRole="header" testID="own-username">
              No username yet
            </AppText>
            <AppText tone="secondary">
              Choose a username so people can find you and you can follow them.
            </AppText>
          </>
        ) : (
          <AppText variant="title2" accessibilityRole="header" testID="own-username" selectable>
            {own.username}
          </AppText>
        )}
        <AppText tone="secondary" testID="own-privacy">
          {own.private
            ? "Private profile. You approve each follower."
            : "Public profile. Anyone can follow you at once."}
        </AppText>
      </View>
      {own.username === null ? (
        <View className="mx-gutter">
          <Button
            label="Choose a username"
            onPress={() => navigation.navigate("EditProfile")}
            testID="choose-username"
          />
        </View>
      ) : (
        <Counts
          username={own.username}
          followers={own.followers}
          following={own.following}
          own
        />
      )}
      <ListSection footer="People who asked to follow your private profile wait here until you answer.">
        <ListRow
          title="Follow requests"
          value={String(own.requests)}
          icon={{ symbol: "person.badge.clock", color: "accent" }}
          testID="requests-row"
          trailing={{ type: "chevron", onPress: () => navigation.navigate("FollowRequests") }}
        />
        <ListRow
          title="Find people"
          icon={{ symbol: "magnifyingglass", color: "accent" }}
          testID="find-people-row"
          trailing={{ type: "chevron", onPress: () => navigation.navigate("People") }}
        />
      </ListSection>
      <ListSection footer="Accounts you blocked cannot find you, see your posts, follow, like or comment, and you see none of theirs.">
        <ListRow
          title="Blocked accounts"
          icon={{ symbol: "hand.raised.fill", color: "set-failure" }}
          testID="blocks-row"
          trailing={{ type: "chevron", onPress: () => navigation.navigate("Blocks") }}
        />
      </ListSection>
    </>
  );
}

function OwnProfileRead({ api }: { readonly api: SocialApi }) {
  const read = useCallback(() => api.ownProfile(), [api]);
  const { state } = useSocialRead(read);
  return (
    <SocialView state={state} testID="own-profile">
      {(own) => <OwnProfileContent own={own} />}
    </SocialView>
  );
}

/** Your username, whether your profile is private, your follows and your requests. */
export function OwnProfileScreen() {
  return (
    <Screen testID="own-profile">
      <SignedInOnly>{(api) => <OwnProfileRead api={api} />}</SignedInOnly>
    </Screen>
  );
}

function FollowControl({
  api,
  profile,
  onChange,
}: {
  readonly api: SocialApi;
  readonly profile: ProfileView;
  readonly onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const button = followButton(profile.follow, profile.private);
  const press = () => {
    setBusy(true);
    setProblem(undefined);
    const request =
      button.action === "follow" ? api.follow(profile.username) : api.unfollow(profile.username);
    void runSocial(request).then((result) => {
      setBusy(false);
      if (result.ok) onChange();
      else setProblem(result.message);
    });
  };
  return (
    <View className="mx-gutter gap-2">
      <Button
        label={button.label}
        variant={button.action === "follow" ? "primary" : "secondary"}
        accessibilityHint={button.hint}
        disabled={busy}
        onPress={press}
        testID="follow-button"
      />
      {problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite" testID="follow-problem">
          {problem}
        </AppText>
      )}
    </View>
  );
}

/** The profile's first page of activities, and the pages after it as Show more reads them. */
function ProfileActivities({
  api,
  profile,
}: {
  readonly api: SocialApi;
  readonly profile: ProfileView;
}) {
  const navigation = useNavigation<RootNavigation>();
  // Pages read after an older first page are dropped when the screen reads it again.
  const [more, setMore] = useState<{ readonly after: ProfileView; readonly page: ActivityPage }>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const shown: ActivityPage = more !== undefined && more.after === profile ? more.page : profile;
  const showMore = () => {
    if (shown.next === null) return;
    setLoading(true);
    setProblem(undefined);
    void runSocial(api.profileActivities(profile.username, shown.next)).then((result) => {
      setLoading(false);
      if (!result.ok) setProblem(result.message);
      else {
        setMore({
          after: profile,
          page: {
            activities: [...shown.activities, ...result.value.activities],
            next: result.value.next,
          },
        });
      }
    });
  };
  if (shown.activities.length === 0) {
    return (
      <AppText tone="secondary" className="mx-gutter" testID="no-activities">
        {profile.follow === "following" || profile.self
          ? "No activities to show yet."
          : "Nothing shared with everyone yet. Followers may see more."}
      </AppText>
    );
  }
  return (
    <>
      <ListSection header="Activities">
        {shown.activities.map((activity) => (
          <ListRow
            key={activity.id}
            title={activity.title}
            subtitle={activityLine(activity, formatDay)}
            testID={`activity-${activity.id}`}
            trailing={{
              type: "chevron",
              onPress: () => navigation.push("Post", { id: activity.id }),
            }}
          />
        ))}
      </ListSection>
      {problem === undefined ? null : (
        <AppText tone="destructive" className="mx-gutter" testID="activities-more-failed">
          {problem}
        </AppText>
      )}
      {shown.next === null ? null : (
        <View className="mx-gutter">
          <Button
            label={loading ? "Loading" : "Show more"}
            disabled={loading}
            onPress={showMore}
            testID="activities-more"
          />
        </View>
      )}
    </>
  );
}

/**
 * The profile's Block button in the navigation bar. It asks first, since a block ends any
 * follow between the two accounts.
 */
function useBlockButton(
  api: SocialApi,
  profile: ProfileView,
  onBlocked: () => void,
  onProblem: (message: string) => void,
) {
  const navigation = useNavigation<RootNavigation>();
  useLayoutEffect(() => {
    if (profile.self) return;
    const block = () =>
      void runSocial(api.block(profile.username)).then((result) => {
        if (result.ok) onBlocked();
        else onProblem(result.message);
      });
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "button",
          label: "Block",
          icon: { type: "sfSymbol", name: "hand.raised" },
          accessibilityLabel: `Block ${profile.username}`,
          identifier: "block-profile",
          onPress: () =>
            Alert.alert(
              `Block ${profile.username}?`,
              "Neither of you will find the other, see the other's posts, or follow, like or comment. Any follow between you ends. You can unblock them under Blocked accounts on your profile.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Block", style: "destructive", onPress: block },
              ],
            ),
        },
      ],
    });
    return () => navigation.setOptions({ unstable_headerRightItems: () => [] });
  }, [api, navigation, onBlocked, onProblem, profile.self, profile.username]);
}

function Blocked({ username }: { readonly username: string }) {
  const navigation = useNavigation<RootNavigation>();
  return (
    <View testID="profile-blocked">
      <EmptyState
        symbol="hand.raised.fill"
        title={`You blocked ${username}`}
        message="Neither of you sees the other any more, and any follow between you ended."
        action={{ label: "Blocked accounts", onPress: () => navigation.navigate("Blocks") }}
      />
    </View>
  );
}

function ProfileContent({
  api,
  profile,
  reload,
}: {
  readonly api: SocialApi;
  readonly profile: ProfileView;
  readonly reload: () => void;
}) {
  const [blocked, setBlocked] = useState(false);
  const [problem, setProblem] = useState<string>();
  const onBlocked = useCallback(() => setBlocked(true), []);
  useBlockButton(api, profile, onBlocked, setProblem);
  if (blocked) return <Blocked username={profile.username} />;
  const notes = [
    profile.private ? "Private profile" : "Public profile",
    profile.followsYou ? "Follows you" : undefined,
  ].filter((note) => note !== undefined);
  return (
    <>
      <View className="mx-gutter gap-1">
        <AppText variant="title2" accessibilityRole="header" testID="profile-username" selectable>
          {profile.username}
        </AppText>
        <AppText tone="secondary">{notes.join(" · ")}</AppText>
        {problem === undefined ? null : (
          <AppText tone="destructive" accessibilityLiveRegion="polite" testID="block-problem">
            {problem}
          </AppText>
        )}
      </View>
      {profile.self ? null : <FollowControl api={api} profile={profile} onChange={reload} />}
      <Counts
        username={profile.username}
        followers={profile.followers}
        following={profile.following}
      />
      <ProfileActivities api={api} profile={profile} />
    </>
  );
}

function ProfileRead({ api, username }: { readonly api: SocialApi; readonly username: string }) {
  const read = useCallback(() => api.profile(username), [api, username]);
  const { state, reload } = useSocialRead(read);
  return (
    <SocialView state={state} testID="profile">
      {(profile) => <ProfileContent api={api} profile={profile} reload={reload} />}
    </SocialView>
  );
}

/** Someone's profile: follow it, see its follows, and the activities they let you see. */
export function ProfileScreen() {
  const { username } = useRoute<RouteProp<RootStackParamList, "Profile">>().params;
  return (
    <Screen testID="profile">
      <SignedInOnly>{(api) => <ProfileRead api={api} username={username} />}</SignedInOnly>
    </Screen>
  );
}
