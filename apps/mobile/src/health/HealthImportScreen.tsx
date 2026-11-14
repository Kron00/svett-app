import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  formatDuration,
  isNothingFromSource,
  type SourceChoices,
  type SourceFile,
  type SourceImportResult,
  sourceImportOutcome,
  sourceName,
  type SourcePlan,
  type SourcePlanItem,
  workoutsLabel,
} from "@svett/core";
import { Option, Result } from "effect";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { SPORTS } from "../design/tokens";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { withTransfers } from "../transfer/files";
import { formatDay } from "../transfer/format";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { readWorkoutFile } from "./files";

type State =
  | { readonly kind: "reading"; readonly fraction: number }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly file: SourceFile; readonly plan: SourcePlan }
  | { readonly kind: "importing" }
  | { readonly kind: "imported"; readonly result: Option.Option<SourceImportResult> }
  | { readonly kind: "failed"; readonly message: string };

/** A long list stops here, with a line for the rest, so a whole Health history stays quick. */
const LISTED = 30;

const fileSummary = (file: SourceFile) =>
  file.source === "gpx"
    ? `A GPX file with ${file.workouts[0]?.title ?? "one workout"}.`
    : `An Apple Health export with ${workoutsLabel(file.workouts.length)}.`;

const toggled = (key: string) => (current: ReadonlySet<string>) => {
  const next = new Set(current);
  if (!next.delete(key)) next.add(key);
  return next;
};

const subtitle = (item: SourcePlanItem) =>
  `${SPORTS[item.workout.kind].label}, ${formatDay(item.workout.startedAt)}`;

function Plan({
  file,
  plan,
  onImport,
  onDecline,
}: {
  readonly file: SourceFile;
  readonly plan: SourcePlan;
  readonly onImport: (choices: SourceChoices) => void;
  readonly onDecline: () => void;
}) {
  const [keepBoth, setKeepBoth] = useState<ReadonlySet<string>>(new Set());
  const [take, setTake] = useState<ReadonlySet<string>>(new Set());
  const newItems = plan.items.filter((item) => item.status === "new");

  return (
    <>
      <AppText tone="secondary" className="px-gutter">
        {fileSummary(file)}
        {file.skipped > 0 ? ` svett could not read ${file.skipped} of its entries.` : ""}
      </AppText>
      {isNothingFromSource(plan) ? (
        <View testID="health-nothing-new" className="gap-4">
          <EmptyState
            symbol="checkmark.circle"
            title="Nothing new"
            message="Every workout in this file is already here, so importing it would change nothing."
            action={{ label: "Done", onPress: onDecline }}
          />
        </View>
      ) : (
        <>
          {newItems.length === 0 ? null : (
            <View testID="health-new">
              <ListSection
                header={`New, ${workoutsLabel(newItems.length)}`}
                footer={
                  newItems.length > LISTED
                    ? `And ${workoutsLabel(newItems.length - LISTED)} more.`
                    : undefined
                }
              >
                {newItems.slice(0, LISTED).map((item) => (
                  <ListRow key={item.key} title={item.workout.title} subtitle={subtitle(item)} />
                ))}
              </ListSection>
            </View>
          )}
          {plan.duplicates.length === 0 ? null : (
            <View testID="health-duplicates">
              <ListSection
                header="Possible duplicates"
                footer="Each overlaps a workout from another source. Linking keeps one workout, with its sets and this file's heart rate. Switch one off to keep both."
              >
                {plan.duplicates.map((item, index) => (
                  <ListRow
                    key={item.key}
                    testID={`health-duplicate-${index}`}
                    title={item.workout.title}
                    subtitle={`Same time as ${item.match.title}, from ${sourceName(item.match.source)}`}
                    value={keepBoth.has(item.key) ? "Keep both" : "Link"}
                    trailing={{
                      type: "switch",
                      value: !keepBoth.has(item.key),
                      onValueChange: () => setKeepBoth(toggled(item.key)),
                    }}
                  />
                ))}
              </ListSection>
            </View>
          )}
          {plan.changed.length === 0 ? null : (
            <View testID="health-changed">
              <ListSection
                header="Changed since your copy"
                footer="svett keeps yours unless you switch on the file's version. Undo puts yours back."
              >
                {plan.changed.map((item) => (
                  <ListRow
                    key={item.key}
                    title={item.workout.title}
                    subtitle={
                      item.linked
                        ? `${subtitle(item)}, linked to a workout from another source`
                        : subtitle(item)
                    }
                    value={take.has(item.key) ? "File's version" : "Yours"}
                    trailing={{
                      type: "switch",
                      value: take.has(item.key),
                      onValueChange: () => setTake(toggled(item.key)),
                    }}
                  />
                ))}
              </ListSection>
            </View>
          )}
          {plan.collisions.length === 0 ? null : (
            <View testID="health-collisions">
              <ListSection
                header="Same start in this file"
                footer="These share a start, a type and a source, but not their content. svett keeps each as its own workout."
              >
                {plan.collisions.slice(0, LISTED).map((item) => (
                  <ListRow
                    key={item.key}
                    title={item.workout.title}
                    subtitle={subtitle(item)}
                    value={formatDuration(item.workout.durationS)}
                  />
                ))}
              </ListSection>
            </View>
          )}
          {plan.unchanged === 0 ? null : (
            <AppText variant="subheadline" tone="secondary" className="px-gutter">
              {workoutsLabel(plan.unchanged)} in the file are already here and stay as they are.
            </AppText>
          )}
          <View className="flex-row flex-wrap gap-3 px-gutter">
            <Button
              label="Import"
              symbol="square.and.arrow.down"
              testID="health-apply"
              onPress={() => onImport({ keepBoth: [...keepBoth], take: [...take] })}
            />
            <Button
              label="Don't import"
              variant="secondary"
              testID="health-decline"
              onPress={onDecline}
            />
          </View>
        </>
      )}
    </>
  );
}

/** What an Apple Health export or a GPX file adds, links and changes, before anything is saved. */
export function HealthImportScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "HealthImport">>();
  const { uri, file: fileName } = params;
  const [state, setState] = useState<State>(() =>
    uri === undefined && fileName === undefined
      ? { kind: "refused", message: "No file was chosen." }
      : { kind: "reading", fraction: 0 },
  );

  useEffect(() => {
    let current = true;
    const source = uri !== undefined ? { uri } : fileName !== undefined ? { file: fileName } : null;
    if (source === null) return;
    let shown = 0;
    const progress = (fraction: number) => {
      // One update per percent, not one per megabyte read.
      if (!current || Math.floor(fraction * 100) === shown) return;
      shown = Math.floor(fraction * 100);
      setState({ kind: "reading", fraction });
    };
    readWorkoutFile(source, progress)
      .then(async (read) => {
        if (!current) return;
        if (Result.isFailure(read)) {
          setState({ kind: "refused", message: read.failure.message });
          return;
        }
        const file = read.success;
        const plan = await withTransfers((transfers) =>
          transfers.previewSourceImport(file.workouts),
        );
        if (current) setState({ kind: "ready", file, plan });
      })
      .catch(
        (error: unknown) =>
          current &&
          setState({ kind: "refused", message: `The file did not open. ${String(error)}` }),
      );
    return () => {
      current = false;
    };
  }, [uri, fileName]);

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"));

  const runImport = (file: SourceFile, choices: SourceChoices) => {
    setState({ kind: "importing" });
    withTransfers((transfers) =>
      transfers.applySourceImport(file.source, file.workouts, choices),
    ).then(
      (result) => setState({ kind: "imported", result }),
      (error: unknown) => setState({ kind: "failed", message: String(error) }),
    );
  };

  return (
    <ScrollView
      testID="health-import"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      {state.kind === "reading" || state.kind === "importing" ? (
        <AppText tone="secondary" className="px-gutter" testID="health-reading">
          {state.kind === "reading"
            ? `Reading the file, ${Math.floor(state.fraction * 100)}%`
            : "Importing"}
        </AppText>
      ) : null}
      {state.kind === "refused" || state.kind === "failed" ? (
        <View testID="health-refused">
          <EmptyState
            symbol="exclamationmark.triangle"
            title={state.kind === "refused" ? "svett cannot import this file" : "Import failed"}
            message={
              state.kind === "refused" ? state.message : `Nothing was saved. ${state.message}`
            }
            action={{ label: "Done", onPress: done }}
          />
        </View>
      ) : null}
      {state.kind === "ready" ? (
        <Plan
          file={state.file}
          plan={state.plan}
          onImport={(choices) => runImport(state.file, choices)}
          onDecline={done}
        />
      ) : null}
      {state.kind === "imported" ? (
        <View testID="health-done" className="gap-4 px-gutter">
          <AppText variant="title3" accessibilityRole="header">
            Imported
          </AppText>
          <AppText tone="secondary" testID="health-outcome">
            {Option.match(state.result, {
              onNone: () => "Nothing changed.",
              onSome: sourceImportOutcome,
            })}
          </AppText>
          <View className="flex-row flex-wrap gap-3">
            <Button label="Done" onPress={done} />
            {Option.match(state.result, {
              onNone: () => null,
              onSome: ({ importBatchId }) => (
                <Button
                  label="Undo import"
                  variant="secondary"
                  testID="health-undo"
                  onPress={() => navigation.replace("UndoImport", { importBatchId })}
                />
              ),
            })}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
