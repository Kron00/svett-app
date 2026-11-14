import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  countLabel,
  decodeHevyFile,
  decodeSvettFile,
  exerciseNames,
  type HevyFile,
  hevyFileLabel,
  hevyImport,
  type ImportPlan,
  type ImportResult,
  importOutcome,
  isNothingToImport,
  type PossibleDuplicate,
  recordsLabel,
  skippedLabel,
  suggestExercises,
  type SvettFile,
  type ToInstant,
} from "@svett/core";
import { Option, Result } from "effect";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import { type OpenDatabase, sameDatabase, stillOpen, useCurrentDatabase } from "../data/current";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import {
  changeAliases,
  changeTransfers,
  DATABASE_SWITCHED,
  type ImportFileSource,
  readImportFile,
  withAliases,
  withExercises,
  withTransfers,
} from "./files";
import { formatDay } from "./format";
import { HevyMatch, type MatchExercise, type NameChoices, type UnknownName } from "./HevyMatch";

type Loaded =
  | { readonly kind: "svett"; readonly file: SvettFile }
  | { readonly kind: "hevy"; readonly file: HevyFile };

type State =
  | { readonly kind: "reading" }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "matching";
      readonly file: HevyFile;
      readonly names: ReadonlyArray<UnknownName>;
      readonly exercises: ReadonlyArray<MatchExercise>;
      /** The data the names were looked up in, the only data the choices may be saved to. */
      readonly database: OpenDatabase;
    }
  | {
      readonly kind: "ready";
      readonly loaded: Loaded;
      readonly plan: ImportPlan;
      readonly keep: ReadonlySet<string>;
      /** The data the plan compares the file with, the only data Import may change. */
      readonly database: OpenDatabase;
    }
  | { readonly kind: "importing" }
  | { readonly kind: "imported"; readonly result: Option.Option<ImportResult> }
  | { readonly kind: "failed"; readonly message: string };

/** Before Import, a new preview replaces the old one when someone signs in or out. */
const previewing = (state: State) =>
  state.kind === "reading" ||
  state.kind === "refused" ||
  state.kind === "matching" ||
  state.kind === "ready";

/** The data a match screen or plan was read from, if it shows one. */
const readFrom = (state: State) =>
  state.kind === "matching" || state.kind === "ready" ? state.database : undefined;

// Each open database gets its own key, so a match screen or plan read from other data starts
// over instead of keeping choices made for it.
const databaseKeys = new WeakMap<object, string>();
let nextKey = 0;
const keyOf = ({ handle }: OpenDatabase) => {
  let key = databaseKeys.get(handle);
  if (key === undefined) {
    key = String(nextKey++);
    databaseKeys.set(handle, key);
  }
  return key;
};

/** Hevy writes the phone's clock time with no zone, so svett reads it in this phone's zone. */
const phoneClock: ToInstant = (time) =>
  new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second).getTime();

const sourceOf = (params: RootStackParamList["ImportPreview"]): ImportFileSource | null =>
  params.uri === undefined
    ? params.file === undefined
      ? null
      : { file: params.file }
    : { uri: params.uri };

const inputOf = (loaded: Loaded, keep: ReadonlySet<string>) =>
  loaded.kind === "svett" ? loaded.file : hevyImport(loaded.file, keep);

const plan = async (
  loaded: Loaded,
  database: OpenDatabase,
  keep: ReadonlySet<string> = new Set(),
): Promise<State> => ({
  kind: "ready",
  loaded,
  keep,
  plan: await withTransfers(
    (transfers) => transfers.previewImport(inputOf(loaded, keep)),
    database,
  ),
  database,
});

/**
 * The names no earlier choice, bundled match or earlier import accounts for, with every
 * exercise here to match them to.
 */
async function unknownNames(
  file: HevyFile,
  database: OpenDatabase,
): Promise<{
  readonly names: ReadonlyArray<UnknownName>;
  readonly exercises: ReadonlyArray<MatchExercise>;
}> {
  const matches = await withAliases(
    (aliases) => aliases.matchHevyNames(exerciseNames(file)),
    database,
  );
  const unknown = matches.filter((match) => match.exerciseId === null);
  if (unknown.length === 0) return { names: [], exercises: [] };
  const exercises = await withExercises((repository) => repository.list, database);
  return {
    names: unknown.map(({ name }) => ({ name, suggestions: suggestExercises(name, exercises) })),
    exercises,
  };
}

/** Reads the file, then asks for unknown exercise names, then waits for Import. */
async function preview(
  source: ImportFileSource | null,
  kind: "svett" | "hevy",
  database: OpenDatabase,
): Promise<State> {
  if (source === null) return { kind: "refused", message: "No file was chosen." };
  const text = await readImportFile(source);
  if (kind === "svett") {
    const decoded = decodeSvettFile(text);
    if (Result.isFailure(decoded)) return { kind: "refused", message: decoded.failure.message };
    return plan({ kind: "svett", file: decoded.success }, database);
  }
  const decoded = decodeHevyFile(text, phoneClock);
  if (Result.isFailure(decoded)) return { kind: "refused", message: decoded.failure.message };
  const file = decoded.success;
  if (file.workouts.length === 0) {
    return { kind: "refused", message: "This Hevy export has no workouts." };
  }
  const { names, exercises } = await unknownNames(file, database);
  return names.length > 0
    ? { kind: "matching", file, names, exercises, database }
    : plan({ kind: "hevy", file }, database);
}

const duplicateReason = ({ reason, other }: PossibleDuplicate) => {
  const day = other.at === null ? "" : `, ${formatDay(other.at)}`;
  switch (reason) {
    case "same_start":
      return `Same start as ${other.title}`;
    case "same_sets":
      return `Same sets as ${other.title}${day}`;
    case "overlap":
      return `Overlaps ${other.title}${day}`;
  }
};

function FileSummary({ loaded }: { readonly loaded: Loaded }) {
  if (loaded.kind === "svett") {
    return (
      <AppText tone="secondary" className="px-gutter">
        A svett export from {formatDay(loaded.file.exportedAt)} with{" "}
        {recordsLabel(loaded.file.rows)}.
      </AppText>
    );
  }
  return (
    <View className="gap-2 px-gutter">
      <AppText tone="secondary" testID="hevy-summary">
        {hevyFileLabel(loaded.file)}
      </AppText>
      {loaded.file.localTimes ? (
        <AppText variant="subheadline" tone="secondary">
          Hevy writes start times without a time zone, so svett reads them in this phone's zone.
        </AppText>
      ) : null}
    </View>
  );
}

function Plan({
  loaded,
  plan: current,
  onToggleDuplicate,
  onImport,
}: {
  readonly loaded: Loaded;
  readonly plan: ImportPlan;
  readonly onToggleDuplicate: (key: string) => void;
  readonly onImport: (take: ReadonlyArray<string>) => void;
}) {
  const [take, setTake] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setTake((chosen) => {
      const next = new Set(chosen);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <FileSummary loaded={loaded} />
      {current.skipped === 0 ? null : (
        <AppText
          variant="subheadline"
          tone="secondary"
          className="px-gutter"
          testID="import-skipped"
        >
          {skippedLabel(current.skipped)}
        </AppText>
      )}
      {isNothingToImport(current) ? (
        <View testID="import-nothing-new">
          <EmptyState
            symbol="checkmark.circle"
            title="Nothing new"
            message="Everything in this file is already here, so importing it would change nothing."
          />
        </View>
      ) : (
        <>
          {current.added.length === 0 ? null : (
            <View testID="import-new">
              <ListSection header="New">
                {current.added.map(({ table, count }) => (
                  <ListRow key={table} title={countLabel(table, count)} />
                ))}
              </ListSection>
            </View>
          )}
          {current.changed.length === 0 ? null : (
            <View testID="import-changed">
              <ListSection
                header="Changed since your copy"
                footer="svett keeps yours unless you switch on the file's version. Undo puts yours back."
              >
                {current.changed.map((item, index) => (
                  <ListRow
                    key={item.key}
                    title={item.title}
                    subtitle={item.at === null ? undefined : formatDay(item.at)}
                    value={take.has(item.key) ? "File's version" : "Yours"}
                    testID={`import-changed-${index}`}
                    trailing={{
                      type: "switch",
                      value: take.has(item.key),
                      onValueChange: () => toggle(item.key),
                    }}
                  />
                ))}
              </ListSection>
            </View>
          )}
          {current.duplicates.length === 0 ? null : (
            <View testID="import-duplicates">
              <ListSection
                header="Possible duplicates"
                footer="svett leaves these out unless you switch them on."
              >
                {current.duplicates.map((duplicate, index) => (
                  <ListRow
                    key={duplicate.key}
                    title={duplicate.summary.title}
                    subtitle={`${duplicate.summary.at === null ? "" : `${formatDay(duplicate.summary.at)}. `}${duplicateReason(duplicate)}`}
                    value={duplicate.kept ? "Import" : "Leave out"}
                    testID={`import-duplicate-${index}`}
                    trailing={{
                      type: "switch",
                      value: duplicate.kept,
                      onValueChange: () => onToggleDuplicate(duplicate.key),
                    }}
                  />
                ))}
              </ListSection>
            </View>
          )}
          {current.deleted === 0 ? null : (
            <AppText variant="subheadline" tone="secondary" className="px-gutter">
              {recordsLabel(current.deleted)} deleted before the export stay deleted here.
            </AppText>
          )}
          {current.unchanged === 0 ? null : (
            <AppText
              variant="subheadline"
              tone="secondary"
              className="px-gutter"
              testID="import-unchanged"
            >
              {recordsLabel(current.unchanged)} in the file are already here and stay as they are.
            </AppText>
          )}
          <View className="flex-row px-gutter">
            <Button
              label="Import"
              symbol="square.and.arrow.down"
              testID="import-apply"
              onPress={() => onImport([...take])}
            />
          </View>
        </>
      )}
    </>
  );
}

/** What a svett file or a Hevy export adds and changes, before anything is saved. */
export function ImportPreviewScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ImportPreview">>();
  // A link to the file already on screen reuses this screen with a new params object. State
  // read for earlier params is never shown, so each navigation here starts a fresh preview,
  // also after an import of the same file.
  const [shown, show] = useState<{ readonly params: typeof params; readonly state: State }>({
    params,
    state: { kind: "reading" },
  });
  const state: State = shown.params === params ? shown.state : { kind: "reading" };
  const setState = (next: State) => show({ params, state: next });
  const { owner, handle } = useCurrentDatabase();

  // Reads the file again for whoever is signed in. A preview made for someone else never shows.
  useEffect(() => {
    let current = true;
    const replace = (next: State) =>
      current &&
      show((before) =>
        before.params === params && !previewing(before.state) ? before : { params, state: next },
      );
    preview(sourceOf(params), params.kind ?? "svett", { owner, handle }).then(
      replace,
      (error: unknown) =>
        replace({ kind: "refused", message: `The file did not open. ${String(error)}` }),
    );
    return () => {
      current = false;
    };
  }, [params, owner, handle]);

  const fail = (error: unknown) => setState({ kind: "failed", message: String(error) });

  /**
   * Runs the next preview step on `database`, the data the screen read. A step started after
   * someone signed in or out refuses, and a result that comes back after it is dropped, since
   * the screen has moved on to a preview of the data open now.
   */
  const nextStep = (database: OpenDatabase, step: () => Promise<State>) => {
    if (!stillOpen(database)) return fail(new Error(DATABASE_SWITCHED));
    step().then(
      (next) => stillOpen(database) && setState(next),
      (error: unknown) => stillOpen(database) && fail(error),
    );
  };

  const matched = (file: HevyFile, database: OpenDatabase, choices: NameChoices) => {
    const chosen = [...choices].flatMap(([name, choice]) =>
      choice === "new" ? [] : [{ name, exerciseId: choice }],
    );
    nextStep(database, async () => {
      setState({ kind: "reading" });
      await changeAliases(database, (aliases) => aliases.remember("hevy", chosen));
      return plan({ kind: "hevy", file }, database);
    });
  };

  const toggleDuplicate = (
    loaded: Loaded,
    database: OpenDatabase,
    keep: ReadonlySet<string>,
    key: string,
  ) => {
    const next = new Set(keep);
    if (!next.delete(key)) next.add(key);
    nextStep(database, () => plan(loaded, database, next));
  };

  const runImport = (
    loaded: Loaded,
    database: OpenDatabase,
    keep: ReadonlySet<string>,
    take: ReadonlyArray<string>,
  ) => {
    setState({ kind: "importing" });
    changeTransfers(database, (transfers) =>
      transfers.applyImport(inputOf(loaded, keep), take),
    ).then((result) => setState({ kind: "imported", result }), fail);
  };

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"));
  const shownFrom = readFrom(state);
  const stale = shownFrom !== undefined && !sameDatabase(shownFrom, { owner, handle });

  return (
    <ScrollView
      testID="import-preview"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      {state.kind === "reading" || state.kind === "importing" || stale ? (
        <AppText tone="secondary" className="px-gutter">
          {state.kind === "importing" ? "Importing" : "Reading the file"}
        </AppText>
      ) : null}
      {state.kind === "refused" || state.kind === "failed" ? (
        <View testID="import-refused">
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
      {state.kind === "matching" && !stale ? (
        <HevyMatch
          key={keyOf(state.database)}
          names={state.names}
          exercises={state.exercises}
          onContinue={(choices) => matched(state.file, state.database, choices)}
        />
      ) : null}
      {state.kind === "ready" && !stale ? (
        <Plan
          key={keyOf(state.database)}
          loaded={state.loaded}
          plan={state.plan}
          onToggleDuplicate={(key) =>
            toggleDuplicate(state.loaded, state.database, state.keep, key)
          }
          onImport={(take) => runImport(state.loaded, state.database, state.keep, take)}
        />
      ) : null}
      {state.kind === "imported" ? (
        <View testID="import-done" className="gap-4 px-gutter">
          <AppText variant="title3" accessibilityRole="header">
            Imported
          </AppText>
          <AppText tone="secondary" testID="import-outcome">
            {importOutcome(Option.getOrElse(state.result, () => ({ added: 0, replaced: 0 })))}
          </AppText>
          <View className="flex-row flex-wrap gap-3">
            <Button label="Done" testID="import-close" onPress={done} />
            {Option.match(state.result, {
              onNone: () => null,
              onSome: ({ importBatchId }) => (
                <Button
                  label="Undo import"
                  variant="secondary"
                  testID="import-undo"
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
