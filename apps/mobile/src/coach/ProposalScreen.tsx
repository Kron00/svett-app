import {
  planRoutines,
  planSummary,
  planTitle,
  PROPOSAL_STATUS_TEXT,
  type ProposalId,
  type ProposalStatus,
  type ProposalView,
} from "@svett/core";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useLayoutEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootNavigation, RootStackParamList } from "../navigation";
import { RoutineExercises } from "../routines/RoutineExercises";
import { useWorkoutSettings } from "../settings/store";
import { AppText } from "../ui/AppText";
import { EmptyState } from "../ui/EmptyState";
import { apply, type ProposalOutcome, undo, useProposal } from "./proposals";

/**
 * The header's item: Apply while the proposal waits, Undo once applied, else none. Native bar
 * items keep the bar's size at every text size.
 */
export const proposalItems = (
  status: ProposalStatus | undefined,
  act: (action: "apply" | "undo") => void,
): Array<NativeStackHeaderItem> => {
  if (status === "pending") {
    return [
      {
        type: "button",
        label: "Apply",
        variant: "prominent",
        accessibilityLabel: "Apply",
        accessibilityHint: "Adds what the coach proposed to the Train tab",
        onPress: () => act("apply"),
      },
    ];
  }
  if (status === "applied") {
    return [
      {
        type: "button",
        label: "Undo",
        variant: "plain",
        accessibilityLabel: "Undo",
        accessibilityHint: "Removes what Apply added, unless you changed it since",
        onPress: () => act("undo"),
      },
    ];
  }
  return [];
};

/** Exactly what Apply creates: the folder for a program, and each routine with its sets. */
function Preview({ view, problem }: { readonly view: ProposalView; readonly problem?: string }) {
  const { plan } = view;
  const { unit } = useWorkoutSettings();
  return (
    <>
      <View className="gap-2 px-gutter">
        <AppText variant="title1" accessibilityRole="header" testID="proposal-title">
          {planTitle(plan)}
        </AppText>
        <AppText tone="secondary">{planSummary(plan)}</AppText>
        <AppText testID="proposal-status">{PROPOSAL_STATUS_TEXT[view.status]}</AppText>
        {problem === undefined ? null : (
          <AppText tone="warning" testID="proposal-problem" selectable>
            {problem}
          </AppText>
        )}
      </View>
      {planRoutines(plan).map((routine, routineIndex) => (
        <View key={`routine-${routine.title}-${String(routineIndex)}`} className="gap-4">
          <View className="gap-1 px-gutter">
            <AppText
              variant={plan.kind === "program" ? "title2" : "title3"}
              accessibilityRole="header"
              testID={`proposal-routine-${routineIndex}`}
            >
              {plan.kind === "program" ? routine.title : "Routine"}
            </AppText>
            {routine.notes === "" ? null : <AppText tone="secondary">{routine.notes}</AppText>}
          </View>
          <RoutineExercises
            names={view.names}
            unit={unit}
            testIDPrefix={`proposal-set-${routineIndex}`}
            exercises={routine.exercises.map((exercise, exerciseIndex) => ({
              key: `${exerciseIndex}`,
              exerciseId: exercise.exerciseId,
              notes: exercise.notes,
              sets: exercise.sets.map((set, setIndex) => ({ ...set, key: `${setIndex}` })),
            }))}
          />
        </View>
      ))}
      <AppText variant="footnote" tone="secondary" className="px-gutter" testID="proposal-end">
        {plan.kind === "program"
          ? `Apply adds the folder ${plan.folder} with these routines to the Train tab.`
          : "Apply adds this routine to the Train tab."}{" "}
        Undo removes it again, as long as you have not changed it.
      </AppText>
    </>
  );
}

/** A coach proposal's preview, with Apply and Undo in the header. */
export function ProposalScreen() {
  const { id } = useRoute<RouteProp<RootStackParamList, "Proposal">>().params;
  const navigation = useNavigation<RootNavigation>();
  const loaded = useProposal(id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const view = loaded.state === "ready" ? loaded.value : null;
  const { reload } = loaded;
  const status = view?.status;

  useLayoutEffect(() => {
    const act = (action: "apply" | "undo") => {
      if (busy || view === null) return;
      setBusy(true);
      setProblem(undefined);
      const proposalId: ProposalId = view.id;
      (action === "apply" ? apply(proposalId) : undo(proposalId))
        .then((result: ProposalOutcome) => {
          if (!result.done) setProblem(result.why);
        })
        .catch((error: unknown) => setProblem(String(error)))
        .finally(() => {
          setBusy(false);
          reload();
        });
    };
    navigation.setOptions({
      unstable_headerRightItems: () => (busy ? [] : proposalItems(status, act)),
    });
  }, [navigation, busy, status, view, reload]);

  return (
    <ScrollView
      testID="proposal"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 24, paddingVertical: 16 }}
    >
      {view !== null ? <Preview view={view} problem={problem} /> : null}
      {loaded.state === "ready" && loaded.value === null ? (
        <EmptyState
          symbol="questionmark.circle"
          title="Proposal not found"
          message="The chat it came from may have been deleted, or the link names no proposal."
        />
      ) : null}
      {loaded.state === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="The proposal did not load"
          message={loaded.message}
        />
      ) : null}
    </ScrollView>
  );
}
