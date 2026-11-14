import { planSummary, planTitle, PROPOSAL_STATUS_TEXT } from "@svett/core";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { useProposal } from "./proposals";

/** A routine or program the coach proposed, under its answer, with Preview. */
export function ProposalCard({ id }: { readonly id: string }) {
  const navigation = useNavigation<RootNavigation>();
  const loaded = useProposal(id);
  if (loaded.state === "loading") return null;
  if (loaded.state === "failed" || loaded.value === null) {
    return (
      <AppText tone="secondary" className="px-2">
        This proposal is no longer on the phone.
      </AppText>
    );
  }
  const { plan, status } = loaded.value;
  const title = planTitle(plan);
  return (
    <View className="gap-2 self-stretch rounded-card bg-surface px-4 py-3">
      <AppText variant="headline">{title}</AppText>
      <AppText tone="secondary">{planSummary(plan)}</AppText>
      <AppText variant="footnote" tone="secondary">
        {PROPOSAL_STATUS_TEXT[status]}
      </AppText>
      <Button
        label="Preview"
        accessibilityLabel={`Preview ${title}`}
        variant="secondary"
        onPress={() => navigation.navigate("Proposal", { id })}
      />
    </View>
  );
}
