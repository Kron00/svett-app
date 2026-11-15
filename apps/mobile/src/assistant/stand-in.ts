import { type ConnectionList, type SocialFailed } from "@svett/core";
import { Effect } from "effect";
import { Settings } from "react-native";

/** What Connected apps asks of the server. */
export interface ConnectionsApi {
  readonly connections: () => Effect.Effect<ConnectionList, SocialFailed>;
  readonly revokeConnection: (
    connection: string,
  ) => Effect.Effect<{ readonly revoked: boolean }, SocialFailed>;
}

/**
 * A stand-in for the server's connections, for scripts/sim/connected-apps.sh, which launches
 * svett with `-svettConnectionsStub one`. It holds one ChatGPT connection that may read and
 * propose, with one read in its access log, until Revoke removes it. It lasts until svett quits.
 */
const standIn = (): ConnectionsApi => {
  let connections: ConnectionList["connections"] = [
    {
      id: "stand-in-chatgpt",
      name: "ChatGPT",
      host: "chatgpt.com",
      scopes: ["svett.read", "svett.propose"],
      createdAt: Date.UTC(2026, 10, 1, 9),
      lastReadAt: Date.UTC(2026, 10, 13, 18, 5),
      recentAccess: [
        { id: "stand-in-read", tool: "list_workouts", at: Date.UTC(2026, 10, 13, 18, 5) },
      ],
    },
  ];
  return {
    connections: () => Effect.sync(() => ({ connections })),
    revokeConnection: (id) =>
      Effect.sync(() => {
        connections = connections.filter((connection) => connection.id !== id);
        return { revoked: true };
      }),
  };
};

let made: ConnectionsApi | undefined;

/** The stand-in when svett was launched with one, or undefined for the real server. */
export const connectionsStandIn = (): ConnectionsApi | undefined => {
  if (Settings.get("svettConnectionsStub") !== "one") return undefined;
  made ??= standIn();
  return made;
};
