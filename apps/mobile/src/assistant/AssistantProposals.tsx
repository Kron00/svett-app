import { ProposalRepository, waitingAssistantProposals } from "@svett/core";
import { Effect } from "effect";
import { View } from "react-native";

import { ProposalCard } from "../coach/ProposalCard";
import type { OpenDatabase } from "../data/current";
import { useOnFocus } from "../data/loaded";
import { readFrom } from "../data/store";
import { AppText } from "../ui/AppText";

const loadWaiting = (database: OpenDatabase) =>
  readFrom(
    database,
    Effect.map(
      Effect.flatMap(Effect.service(ProposalRepository), (proposals) => proposals.list),
      waitingAssistantProposals,
    ),
  );

/**
 * The routines and programs connected apps proposed that wait for Apply, each with Preview.
 * Nothing shows when none waits.
 */
export function AssistantProposals() {
  const loaded = useOnFocus(loadWaiting);
  if (loaded.state !== "ready" || loaded.value.length === 0) return null;
  return (
    <View className="gap-3 self-stretch" testID="assistant-proposals">
      <AppText variant="title3" accessibilityRole="header">
        From connected apps
      </AppText>
      {loaded.value.map((id) => (
        <ProposalCard key={id} id={id} />
      ))}
    </View>
  );
}
