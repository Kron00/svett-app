import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  countLabel,
  decodeSvettFile,
  type ImportPlan,
  type ImportResult,
  importOutcome,
  isNothingToImport,
  recordsLabel,
  type SvettFile,
} from "@svett/core";
import { Option, Result } from "effect";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import {
  currentDatabase,
  type OpenDatabase,
  sameDatabase,
  useCurrentDatabase,
} from "../data/current";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { changeTransfers, type ImportFileSource, readImportFile, withTransfers } from "./files";
import { formatDay } from "./format";

type State =
  | { readonly kind: "reading" }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly file: SvettFile;
      readonly plan: ImportPlan;
      /** The data the plan compares the file with, the only data Import may change. */
      readonly database: OpenDatabase;
    }
  | { readonly kind: "importing" }
  | { readonly kind: "imported"; readonly result: Option.Option<ImportResult> }
  | { readonly kind: "failed"; readonly message: string };

/** Before Import, a new preview replaces the old one when someone signs in or out. */
const previewing = (state: State) =>
  state.kind === "reading" || state.kind === "refused" || state.kind === "ready";

const sourceOf = (params: RootStackParamList["ImportPreview"]): ImportFileSource | null =>
  params.uri === undefined
    ? params.file === undefined
      ? null
      : { file: params.file }
    : { uri: params.uri };

/** Reads the file, then waits for Import. */
async function preview(source: ImportFileSource | null): Promise<State> {
  if (source === null) return { kind: "refused", message: "No file was chosen." };
  const text = await readImportFile(source);
  const decoded = decodeSvettFile(text);
  if (Result.isFailure(decoded)) return { kind: "refused", message: decoded.failure.message };
  const file = decoded.success;
  const database = currentDatabase();
  const plan = await withTransfers((transfers) => transfers.previewImport(file), database);
  return { kind: "ready", file, plan, database };
}

function Plan({
  file,
  plan,
  onImport,
}: {
  readonly file: SvettFile;
  readonly plan: ImportPlan;
  readonly onImport: (take: ReadonlyArray<string>) => void;
}) {
  const [take, setTake] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setTake((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <>
      <AppText tone="secondary" className="px-gutter">
        A svett export from {formatDay(file.exportedAt)} with {recordsLabel(file.rows)}.
      </AppText>
      {isNothingToImport(plan) ? (
        <View testID="import-nothing-new">
          <EmptyState
            symbol="checkmark.circle"
            title="Nothing new"
            message="Everything in this file is already here, so importing it would change nothing."
          />
        </View>
      ) : (
        <>
          {plan.added.length === 0 ? null : (
            <View testID="import-new">
              <ListSection header="New">
                {plan.added.map(({ table, count }) => (
                  <ListRow key={table} title={countLabel(table, count)} />
                ))}
              </ListSection>
            </View>
          )}
          {plan.changed.length === 0 ? null : (
            <View testID="import-changed">
              <ListSection
                header="Changed since your copy"
                footer="svett keeps yours unless you switch on the file's version. Undo puts yours back."
              >
                {plan.changed.map((item) => (
                  <ListRow
                    key={item.key}
                    title={item.title}
                    subtitle={item.at === null ? undefined : formatDay(item.at)}
                    value={take.has(item.key) ? "File's version" : "Yours"}
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
          {plan.deleted === 0 ? null : (
            <AppText variant="subheadline" tone="secondary" className="px-gutter">
              {recordsLabel(plan.deleted)} deleted before the export stay deleted here.
            </AppText>
          )}
          {plan.unchanged === 0 ? null : (
            <AppText variant="subheadline" tone="secondary" className="px-gutter">
              {recordsLabel(plan.unchanged)} in the file are already here and stay as they are.
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

/** What a svett file adds and changes, before anything is saved. */
export function ImportPreviewScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "ImportPreview">>();
  const [state, setState] = useState<State>({ kind: "reading" });
  const { uri, file: fileName } = params;
  const { owner, handle } = useCurrentDatabase();

  // Reads the file again for whoever is signed in. A preview made for someone else never shows.
  useEffect(() => {
    let current = true;
    const show = (next: State) =>
      current && setState((shown) => (previewing(shown) ? next : shown));
    preview(sourceOf({ uri, file: fileName })).then(show, (error: unknown) =>
      show({ kind: "refused", message: `The file did not open. ${String(error)}` }),
    );
    return () => {
      current = false;
    };
  }, [uri, fileName, owner, handle]);

  const runImport = (database: OpenDatabase, file: SvettFile, take: ReadonlyArray<string>) => {
    setState({ kind: "importing" });
    changeTransfers(database, (transfers) => transfers.applyImport(file, take)).then(
      (result) => setState({ kind: "imported", result }),
      (error: unknown) => setState({ kind: "failed", message: String(error) }),
    );
  };

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"));
  const stale = state.kind === "ready" && !sameDatabase(state.database, { owner, handle });

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
      {state.kind === "ready" && !stale ? (
        <Plan
          file={state.file}
          plan={state.plan}
          onImport={(take) => runImport(state.database, state.file, take)}
        />
      ) : null}
      {state.kind === "imported" ? (
        <View testID="import-done" className="gap-4 px-gutter">
          <AppText variant="title3" accessibilityRole="header">
            Imported
          </AppText>
          <AppText tone="secondary">
            {importOutcome(Option.getOrElse(state.result, () => ({ added: 0, replaced: 0 })))}
          </AppText>
          <View className="flex-row flex-wrap gap-3">
            <Button label="Done" onPress={done} />
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
