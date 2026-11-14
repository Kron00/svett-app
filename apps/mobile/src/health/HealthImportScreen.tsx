import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  formatDuration,
  isNothingFromSource,
  type SourceChoices,
  type SourceFile,
  type SourceImportResult,
  sourceFileSummary,
  sourceImportOutcome,
  sourceName,
  type SourcePlan,
  type SourcePlanItem,
  workoutsLabel,
} from "@svett/core";
import { Option, Result } from "effect";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { type OpenDatabase, sameDatabase, useCurrentDatabase } from "../data/current";
import { SPORTS } from "../design/tokens";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { changeTransfers, databaseKey, withTransfers } from "../transfer/files";
import { formatDay } from "../transfer/format";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { readWorkoutFile } from "./files";

type Read =
  | { readonly kind: "reading"; readonly fraction: number }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "read"; readonly file: SourceFile };

type State =
  | { readonly kind: "previewing" }
  | {
      readonly kind: "ready";
      readonly file: SourceFile;
      readonly plan: SourcePlan;
      /** The data the plan compares the file with, the only data Import may change. */
      readonly database: OpenDatabase;
    }
  | { readonly kind: "importing" }
  | { readonly kind: "imported"; readonly result: Option.Option<SourceImportResult> }
  | { readonly kind: "failed"; readonly message: string };

const PREVIEWING: State = { kind: "previewing" };

const firstRead = ({ uri, file }: RootStackParamList["HealthImport"]): Read =>
  uri === undefined && file === undefined
    ? { kind: "refused", message: "No file was chosen." }
    : { kind: "reading", fraction: 0 };

interface Shown {
  readonly params: RootStackParamList["HealthImport"];
  readonly read: Read;
  readonly state: State;
}

/** What `params` shows once `read` is how far its file was read. */
const withRead =
  (params: Shown["params"], read: Read) =>
  (before: Shown): Shown => ({
    params,
    read,
    state: before.params === params ? before.state : PREVIEWING,
  });

/** What `params` shows once `next` changed its state. */
const withState =
  (params: Shown["params"], next: (before: State) => State) =>
  (before: Shown): Shown =>
    before.params === params
      ? { ...before, state: next(before.state) }
      : { params, read: firstRead(params), state: next(PREVIEWING) };

/** A long list stops here, with a line for the rest, so a whole Health history stays quick. */
const LISTED = 30;

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
      <AppText tone="secondary" className="px-gutter" testID="health-summary">
        {sourceFileSummary(file)}
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

/**
 * What an Apple Health export or a GPX file adds, links and changes, before anything is saved.
 * The file is read once. Its plan is made again for whoever is signed in, and Import changes
 * only the data the plan on screen was made for.
 */
export function HealthImportScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "HealthImport">>();
  // A link to another file reuses this screen with new params, which start it over.
  const [shown, show] = useState<Shown>({ params, read: firstRead(params), state: PREVIEWING });
  const fresh = shown.params === params;
  const read = fresh ? shown.read : firstRead(params);
  const state = fresh ? shown.state : PREVIEWING;
  const setState = (next: (before: State) => State) => show(withState(params, next));
  const { owner, handle } = useCurrentDatabase();

  useEffect(() => {
    let current = true;
    const { uri, file: fileName } = params;
    const source = uri !== undefined ? { uri } : fileName !== undefined ? { file: fileName } : null;
    if (source === null) return;
    let percent = 0;
    const progress = (fraction: number) => {
      // One update per percent, not one per megabyte read.
      if (!current || Math.floor(fraction * 100) === percent) return;
      percent = Math.floor(fraction * 100);
      show(withRead(params, { kind: "reading", fraction }));
    };
    readWorkoutFile(source, progress).then(
      (result) =>
        current &&
        show(
          withRead(
            params,
            Result.isFailure(result)
              ? { kind: "refused", message: result.failure.message }
              : { kind: "read", file: result.success },
          ),
        ),
      (error: unknown) =>
        current &&
        show(
          withRead(params, { kind: "refused", message: `The file did not open. ${String(error)}` }),
        ),
    );
    return () => {
      current = false;
    };
  }, [params]);

  // Plans the file against the data open now, and again after someone signs in or out. A plan
  // made for someone else never shows, and once Import is pressed the plan stays as it was.
  const file = read.kind === "read" ? read.file : undefined;
  useEffect(() => {
    if (file === undefined) return;
    let current = true;
    const database = { owner, handle };
    const replace = (next: State) =>
      current &&
      show(
        withState(params, (before) =>
          before.kind === "previewing" || before.kind === "ready" ? next : before,
        ),
      );
    withTransfers((transfers) => transfers.previewSourceImport(file.workouts), database).then(
      (plan) => replace({ kind: "ready", file, plan, database }),
      (error: unknown) => replace({ kind: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [params, file, owner, handle]);

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"));

  /** Imports into the data the plan was made for. It refuses once that is not open. */
  const runImport = (ready: Extract<State, { kind: "ready" }>, choices: SourceChoices) => {
    setState(() => ({ kind: "importing" }));
    changeTransfers(ready.database, (transfers) =>
      transfers.applySourceImport(ready.file.source, ready.file.workouts, choices),
    ).then(
      (result) => setState(() => ({ kind: "imported", result })),
      (error: unknown) =>
        setState(() => ({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        })),
    );
  };

  const stale = state.kind === "ready" && !sameDatabase(state.database, { owner, handle });
  const refused = read.kind === "refused" ? read.message : undefined;

  return (
    <ScrollView
      testID="health-import"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      {read.kind === "reading" ||
      (read.kind === "read" && state.kind === "previewing") ||
      state.kind === "importing" ||
      stale ? (
        <AppText tone="secondary" className="px-gutter" testID="health-reading">
          {state.kind === "importing"
            ? "Importing"
            : read.kind === "reading"
              ? `Reading the file, ${Math.floor(read.fraction * 100)}%`
              : "Reading the file"}
        </AppText>
      ) : null}
      {refused !== undefined || state.kind === "failed" ? (
        <View testID="health-refused">
          <EmptyState
            symbol="exclamationmark.triangle"
            title={refused !== undefined ? "svett cannot import this file" : "Import failed"}
            message={
              refused !== undefined
                ? refused
                : `Nothing was saved. ${state.kind === "failed" ? state.message : ""}`
            }
            action={{ label: "Done", onPress: done }}
          />
        </View>
      ) : null}
      {state.kind === "ready" && !stale ? (
        <Plan
          key={databaseKey(state.database)}
          file={state.file}
          plan={state.plan}
          onImport={(choices) => runImport(state, choices)}
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
