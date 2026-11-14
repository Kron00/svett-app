import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  type Block,
  type FollowRequest,
  type OwnProfile,
  type ProfilePage,
  type ProfileSummary,
  countOf,
  profileLine,
  type SocialApi,
  USERNAME_MAX,
  USERNAME_MIN,
  usernameProblem,
} from "@svett/core";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { useIsAccessibilityTextSize } from "../design/hooks";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection } from "../ui/List";
import { SearchField } from "../ui/SearchField";
import { TextField } from "../ui/TextField";
import { runSocial, SignedInOnly, type SocialResult, SocialView, useSocialRead } from "./api";
import { Screen } from "./ProfileScreens";

/** A list row's ID, unique per username whatever its case. */
const rowId = (prefix: string, username: string) => `${prefix}-${username.toLowerCase()}`;

function People({
  profiles,
  empty,
  testID,
}: {
  readonly profiles: ReadonlyArray<ProfileSummary>;
  readonly empty: string;
  readonly testID: string;
}) {
  const navigation = useNavigation<RootNavigation>();
  if (profiles.length === 0) {
    return (
      <AppText tone="secondary" className="mx-gutter" testID={`${testID}-empty`}>
        {empty}
      </AppText>
    );
  }
  return (
    <ListSection>
      {profiles.map((profile) => (
        <ListRow
          key={profile.username}
          title={profile.username}
          {...(profileLine(profile) === undefined ? {} : { subtitle: profileLine(profile) })}
          testID={rowId("person", profile.username)}
          trailing={{
            type: "chevron",
            onPress: () => navigation.push("Profile", { username: profile.username }),
          }}
        />
      ))}
    </ListSection>
  );
}

function EditProfileForm({
  api,
  own,
  username: linked,
}: {
  readonly api: SocialApi;
  readonly own: OwnProfile;
  readonly username: string | undefined;
}) {
  const navigation = useNavigation<RootNavigation>();
  const [username, setUsername] = useState(linked ?? own.username ?? "");
  const [isPrivate, setPrivate] = useState(own.private);
  const [edited, setEdited] = useState(linked !== undefined);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const invalid = usernameProblem(username);
  const save = () => {
    setEdited(true);
    if (invalid !== undefined) return;
    setSaving(true);
    setProblem(undefined);
    void runSocial(api.saveProfile({ username, private: isPrivate })).then((result) => {
      setSaving(false);
      if (!result.ok) setProblem(result.message);
      else if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate("OwnProfile");
    });
  };
  return (
    <>
      <View className="mx-gutter">
        <TextField
          label="Username"
          value={username}
          onChangeText={(text) => {
            setUsername(text);
            setEdited(true);
            setProblem(undefined);
          }}
          note={`${USERNAME_MIN} to ${USERNAME_MAX} letters, digits, periods and underscores. Capitals show as you type them, and nobody else can take the same name in other capitals.`}
          problem={problem ?? (edited ? invalid : undefined)}
          editable={!saving}
          placeholder="your.name"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username-new"
          textContentType="username"
          returnKeyType="done"
          onSubmitEditing={save}
          testID="username-field"
        />
      </View>
      <ListSection
        footer={
          isPrivate
            ? "You approve each follower. Only followers you approve see what you share with followers."
            : own.private && own.requests > 0
              ? `Anyone can follow you at once and see what you share with followers. Saving approves ${countOf(own.requests, "waiting request", "waiting requests")}.`
              : "Anyone can follow you at once and see what you share with followers. Turning this on later keeps the followers you have."
        }
      >
        <ListRow
          title="Private profile"
          testID="private-switch"
          trailing={{ type: "switch", value: isPrivate, onValueChange: setPrivate }}
        />
      </ListSection>
      <View className="mx-gutter">
        <Button
          label={saving ? "Saving" : "Save"}
          disabled={saving}
          onPress={save}
          testID="save-profile"
        />
      </View>
    </>
  );
}

function EditProfileRead({
  api,
  username,
}: {
  readonly api: SocialApi;
  readonly username?: string;
}) {
  const read = useCallback(() => api.ownProfile(), [api]);
  const { state } = useSocialRead(read);
  return (
    <SocialView state={state} testID="edit-profile">
      {(own) => <EditProfileForm api={api} own={own} username={username} />}
    </SocialView>
  );
}

/** Choose or change your username, and whether you approve each follower. */
export function EditProfileScreen() {
  const username = useRoute<RouteProp<RootStackParamList, "EditProfile">>().params?.username;
  return (
    <Screen testID="edit-profile">
      <SignedInOnly>{(api) => <EditProfileRead api={api} username={username} />}</SignedInOnly>
    </Screen>
  );
}

const SEARCH_DELAY_MS = 250;

function PeopleSearch({ api, initial }: { readonly api: SocialApi; readonly initial: string }) {
  const [text, setText] = useState(initial);
  const [found, setFound] = useState<SocialResult<ReadonlyArray<ProfileSummary>>>();
  useEffect(() => {
    let current = true;
    // Typing a name sends one search once the typing stops, not one per letter.
    const soon = setTimeout(() => {
      void runSocial(api.search(text)).then((result) => {
        if (!current) return;
        setFound(result.ok ? { ok: true, value: result.value.profiles } : result);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(soon);
    };
  }, [api, text]);
  return (
    <>
      <View className="mx-gutter">
        <SearchField
          label="Search by username"
          value={text}
          onChangeText={setText}
          placeholder="Username"
          testID="people-search"
        />
      </View>
      {text.trim() === "" ? (
        <AppText tone="secondary" className="mx-gutter" testID="people-hint">
          Type the start of someone's username.
        </AppText>
      ) : found === undefined ? null : found.ok ? (
        <People
          profiles={found.value}
          empty={`Nobody's username starts with “${text.trim()}”.`}
          testID="people"
        />
      ) : (
        <AppText tone="destructive" className="mx-gutter" testID="people-failed">
          {found.message}
        </AppText>
      )}
    </>
  );
}

/** Find people by the start of their username. */
export function PeopleScreen() {
  const q = useRoute<RouteProp<RootStackParamList, "People">>().params?.q ?? "";
  return (
    <Screen testID="people">
      <SignedInOnly>{(api) => <PeopleSearch api={api} initial={q} />}</SignedInOnly>
    </Screen>
  );
}

const isList = (list: string): list is "followers" | "following" =>
  list === "followers" || list === "following";

type ConnectionsProps = {
  readonly api: SocialApi;
  readonly username: string;
  readonly list: "followers" | "following";
  /** The signed-in account's own followers, each of whom can be removed. */
  readonly own: boolean;
};

/** One of your followers, whom you can remove without blocking. */
function Follower({
  api,
  profile,
  onRemoved,
}: {
  readonly api: SocialApi;
  readonly profile: ProfileSummary;
  readonly onRemoved: () => void;
}) {
  const navigation = useNavigation<RootNavigation>();
  const stacked = useIsAccessibilityTextSize();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const remove = () => {
    setBusy(true);
    setProblem(undefined);
    void runSocial(api.removeFollower(profile.username)).then((result) => {
      setBusy(false);
      if (result.ok) onRemoved();
      else setProblem(result.message);
    });
  };
  const confirm = () =>
    Alert.alert(
      `Remove ${profile.username}?`,
      "They stop following you and are not told. They can ask to follow you again.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: remove },
      ],
    );
  return (
    <View
      className="mx-gutter gap-3 rounded-card bg-surface p-gutter"
      testID={rowId("follower", profile.username)}
    >
      <AppText variant="headline">{profile.username}</AppText>
      <View className={stacked ? "gap-2" : "flex-row gap-2"}>
        <Button
          label="Profile"
          variant="secondary"
          disabled={busy}
          onPress={() => navigation.push("Profile", { username: profile.username })}
          accessibilityHint={`Opens ${profile.username}'s profile`}
          testID={rowId("open", profile.username)}
        />
        <Button
          label={busy ? "Removing" : "Remove"}
          variant="destructive"
          disabled={busy}
          onPress={confirm}
          accessibilityHint={`Stops ${profile.username} following you, without blocking them`}
          testID={rowId("remove", profile.username)}
        />
      </View>
      {problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite">
          {problem}
        </AppText>
      )}
    </View>
  );
}

/** The list's first page, and the pages after it as Show more reads them. */
function ConnectionsPages({
  api,
  username,
  list,
  own,
  first,
  reload,
}: ConnectionsProps & { readonly first: ProfilePage; readonly reload: () => void }) {
  // Pages read after an older first page are dropped when the screen reads it again.
  const [more, setMore] = useState<{ readonly after: ProfilePage; readonly page: ProfilePage }>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const shown = more !== undefined && more.after === first ? more.page : first;
  const showMore = () => {
    if (shown.next === null) return;
    setLoading(true);
    setProblem(undefined);
    const next =
      list === "followers"
        ? api.followers(username, shown.next)
        : api.following(username, shown.next);
    void runSocial(next).then((result) => {
      setLoading(false);
      if (!result.ok) setProblem(result.message);
      else {
        setMore({
          after: first,
          page: {
            profiles: [...shown.profiles, ...result.value.profiles],
            next: result.value.next,
          },
        });
      }
    });
  };
  const removable = own && list === "followers";
  return (
    <>
      {removable && shown.profiles.length > 0 ? (
        <View className="gap-3">
          {shown.profiles.map((profile) => (
            <Follower key={profile.username} api={api} profile={profile} onRemoved={reload} />
          ))}
        </View>
      ) : (
        <People
          profiles={shown.profiles}
          empty={
            list === "followers"
              ? `Nobody follows ${username} yet.`
              : `${username} does not follow anyone yet.`
          }
          testID="connections"
        />
      )}
      {problem === undefined ? null : (
        <AppText tone="destructive" className="mx-gutter" testID="connections-more-failed">
          {problem}
        </AppText>
      )}
      {shown.next === null ? null : (
        <View className="mx-gutter">
          <Button
            label={loading ? "Loading" : "Show more"}
            disabled={loading}
            onPress={showMore}
            testID="connections-more"
          />
        </View>
      )}
    </>
  );
}

function ConnectionsRead({ api, username, list, own }: ConnectionsProps) {
  const read = useCallback(
    () => (list === "followers" ? api.followers(username) : api.following(username)),
    [api, list, username],
  );
  const { state, reload } = useSocialRead(read);
  return (
    <SocialView state={state} testID="connections">
      {(first) => (
        <ConnectionsPages
          api={api}
          username={username}
          list={list}
          own={own}
          first={first}
          reload={reload}
        />
      )}
    </SocialView>
  );
}

/** Who follows a profile, or whom it follows. */
export function ConnectionsScreen() {
  const { username, list, own } = useRoute<RouteProp<RootStackParamList, "Connections">>().params;
  return (
    <Screen testID="connections">
      {isList(list) ? (
        <SignedInOnly>
          {(api) => (
            <ConnectionsRead api={api} username={username} list={list} own={own === "yes"} />
          )}
        </SignedInOnly>
      ) : (
        <AppText tone="destructive" className="mx-gutter">
          This link names no list. Use followers or following.
        </AppText>
      )}
    </Screen>
  );
}

function Request({
  api,
  request,
  onAnswered,
}: {
  readonly api: SocialApi;
  readonly request: FollowRequest;
  readonly onAnswered: () => void;
}) {
  const stacked = useIsAccessibilityTextSize();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const answer = (approve: boolean) => {
    setBusy(true);
    setProblem(undefined);
    // The request's own ID, so the answer reaches this request even if its username has
    // since passed to someone else.
    const answering = approve ? api.approve(request.id) : api.decline(request.id);
    void runSocial(answering).then((result) => {
      setBusy(false);
      if (result.ok) onAnswered();
      else setProblem(result.message);
    });
  };
  return (
    <View
      className="mx-gutter gap-3 rounded-card bg-surface p-gutter"
      testID={rowId("request", request.username)}
    >
      <AppText variant="headline">{request.username}</AppText>
      <View className={stacked ? "gap-2" : "flex-row gap-2"}>
        <Button
          label="Approve"
          disabled={busy}
          onPress={() => answer(true)}
          accessibilityHint={`Lets ${request.username} follow you`}
          testID={rowId("approve", request.username)}
        />
        <Button
          label="Decline"
          variant="secondary"
          disabled={busy}
          onPress={() => answer(false)}
          testID={rowId("decline", request.username)}
        />
      </View>
      {problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite">
          {problem}
        </AppText>
      )}
    </View>
  );
}

function RequestsRead({ api }: { readonly api: SocialApi }) {
  const read = useCallback(() => api.requests(), [api]);
  const { state, reload } = useSocialRead(read);
  return (
    <SocialView state={state} testID="requests">
      {({ requests }) =>
        requests.length === 0 ? (
          <AppText tone="secondary" className="mx-gutter" testID="requests-empty">
            Nobody is waiting. When your profile is private, people who ask to follow you show here.
          </AppText>
        ) : (
          <View className="gap-3">
            {requests.map((request) => (
              <Request key={request.id} api={api} request={request} onAnswered={reload} />
            ))}
          </View>
        )
      }
    </SocialView>
  );
}

/** People waiting for you to approve their follow. */
export function FollowRequestsScreen() {
  return (
    <Screen testID="requests">
      <SignedInOnly>{(api) => <RequestsRead api={api} />}</SignedInOnly>
    </Screen>
  );
}

function BlockedAccount({
  api,
  block,
  onUnblocked,
}: {
  readonly api: SocialApi;
  readonly block: Block;
  readonly onUnblocked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const unblock = () => {
    setBusy(true);
    setProblem(undefined);
    // The block's own ID, so this never reaches whoever holds the username now.
    void runSocial(api.unblock(block.id)).then((result) => {
      setBusy(false);
      if (result.ok) onUnblocked();
      else setProblem(result.message);
    });
  };
  return (
    <View
      className="mx-gutter gap-3 rounded-card bg-surface p-gutter"
      testID={rowId("blocked", block.username)}
    >
      <AppText variant="headline">{block.username}</AppText>
      <Button
        label={busy ? "Unblocking" : "Unblock"}
        variant="secondary"
        disabled={busy}
        onPress={unblock}
        accessibilityHint={`Lets ${block.username} find you and ask to follow you again`}
        testID={rowId("unblock", block.username)}
      />
      {problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite">
          {problem}
        </AppText>
      )}
    </View>
  );
}

function BlocksRead({ api }: { readonly api: SocialApi }) {
  const read = useCallback(() => api.blocks(), [api]);
  const { state, reload } = useSocialRead(read);
  return (
    <SocialView state={state} testID="blocks">
      {({ blocks }) =>
        blocks.length === 0 ? (
          <AppText tone="secondary" className="mx-gutter" testID="blocks-empty">
            You have not blocked anyone. Block someone from the button at the top of their
            profile.
          </AppText>
        ) : (
          <View className="gap-3">
            {blocks.map((block) => (
              <BlockedAccount key={block.id} api={api} block={block} onUnblocked={reload} />
            ))}
          </View>
        )
      }
    </SocialView>
  );
}

/** The accounts you blocked, each of which you can unblock. */
export function BlocksScreen() {
  return (
    <Screen testID="blocks">
      <SignedInOnly>{(api) => <BlocksRead api={api} />}</SignedInOnly>
    </Screen>
  );
}
