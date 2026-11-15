import {
  type AssistantConnection,
  connectedLine,
  connectionAccess,
  lastReadLine,
} from "@svett/core";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";

import { svettServer } from "../account/sync";
import { formatDay, formatDayAndTime } from "../progress/dates";
import { runSocial, SignedInOnly, SocialView, useSocialRead } from "../social/api";
import { Screen } from "../social/ProfileScreens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { AssistantProposals } from "./AssistantProposals";
import { type ConnectionsApi, connectionsStandIn } from "./stand-in";

const SIGNED_OUT = {
  title: "Sign in to connect apps",
  message:
    "Apps such as ChatGPT connect to your svett account. Everything on the phone works without one.",
};

function Connection({
  api,
  connection,
  onRevoked,
}: {
  readonly api: ConnectionsApi;
  readonly connection: AssistantConnection;
  readonly onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const { id, name } = connection;
  const revoke = () => {
    setBusy(true);
    setProblem(undefined);
    void runSocial(api.revokeConnection(id)).then((result) => {
      setBusy(false);
      // Already gone counts as done, so the list reads again either way.
      if (result.ok || result.problem === "connection_not_found") onRevoked();
      else setProblem(result.message);
    });
  };
  const confirm = () =>
    Alert.alert(
      `Revoke ${name}?`,
      `${name} can no longer read your data or propose routines. Proposals it already made stay in svett.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Revoke access", style: "destructive", onPress: revoke },
      ],
    );
  return (
    <View
      className="mx-gutter gap-2 rounded-card bg-surface p-gutter"
      testID={`connection-${id}`}
    >
      <AppText variant="headline" accessibilityRole="header">
        {name}
      </AppText>
      <AppText tone="secondary">{connection.host}</AppText>
      <AppText testID={`connection-${id}-access`}>{connectionAccess(connection.scopes)}</AppText>
      <AppText tone="secondary" testID={`connection-${id}-read`}>
        {lastReadLine(connection.lastReadAt, formatDayAndTime)}
      </AppText>
      <AppText variant="footnote" tone="secondary">
        {connectedLine(connection.createdAt, formatDay)}
      </AppText>
      <Button
        label={busy ? "Revoking" : "Revoke"}
        variant="destructive"
        disabled={busy}
        onPress={confirm}
        accessibilityLabel={`Revoke ${name}`}
        accessibilityHint={`Cuts ${name} off from your svett data at once`}
        testID={`revoke-${id}`}
      />
      {problem === undefined ? null : (
        <AppText tone="destructive" accessibilityLiveRegion="polite">
          {problem}
        </AppText>
      )}
    </View>
  );
}

function Connections({ api }: { readonly api: ConnectionsApi }) {
  const read = useCallback(() => api.connections(), [api]);
  const { state, reload } = useSocialRead(read);
  return (
    <SocialView state={state} testID="connected-apps">
      {({ connections }) =>
        connections.length === 0 ? (
          <AppText tone="secondary" className="mx-gutter" testID="connected-apps-empty">
            No apps are connected to your svett account.
          </AppText>
        ) : (
          <View className="gap-3">
            {connections.map((connection) => (
              <Connection
                key={connection.id}
                api={api}
                connection={connection}
                onRevoked={reload}
              />
            ))}
          </View>
        )
      }
    </SocialView>
  );
}

/**
 * The apps connected to the svett account, such as ChatGPT: what each may do, when it last read
 * your data, and Revoke. Below them, the proposals they made that wait for Apply.
 */
export function ConnectedAppsScreen() {
  const standIn = connectionsStandIn();
  return (
    <Screen testID="connected-apps-screen">
      <AppText tone="secondary" className="mx-gutter">
        Apps you connect can only do what you allowed when you connected them. They never see
        anyone else&apos;s data, and connecting one changes nothing about what your followers see.
      </AppText>
      {standIn === undefined ? (
        <SignedInOnly signedOut={SIGNED_OUT}>{(api) => <Connections api={api} />}</SignedInOnly>
      ) : (
        <Connections api={standIn} />
      )}
      <View className="mx-gutter">
        <AssistantProposals />
      </View>
      <View className="mx-gutter gap-2" testID="connected-apps-how">
        <AppText variant="headline" accessibilityRole="header">
          Connect ChatGPT
        </AppText>
        <AppText tone="secondary">
          On chatgpt.com, add a custom MCP server with this address, then sign in to svett and
          choose what it may do.
        </AppText>
        <AppText selectable testID="connected-apps-address">{`${svettServer()}/mcp`}</AppText>
      </View>
    </Screen>
  );
}
