import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { type ImportBatch, importTitle, recordsLabel } from "@svett/core";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootNavigation } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { exportAndShare, type ImportKind, pickImportFile, withTransfers } from "./files";
import { formatDay } from "./format";

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly name: string; readonly rows: number }
  | { readonly kind: "failed"; readonly message: string };

/** Export everything, import a svett file, and undo a past import. */
export function DataScreen() {
  const navigation = useNavigation<RootNavigation>();
  const [exported, setExported] = useState<ExportState>({ kind: "idle" });
  const [pickProblem, setPickProblem] = useState<string>();
  const [imports, setImports] = useState<ReadonlyArray<ImportBatch>>([]);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      void withTransfers((transfers) => transfers.listImports).then(
        (list) => current && setImports(list),
      );
      return () => {
        current = false;
      };
    }, []),
  );

  const runExport = () => {
    setExported({ kind: "working" });
    exportAndShare().then(
      ({ name, rows }) => setExported({ kind: "done", name, rows }),
      (error: unknown) => setExported({ kind: "failed", message: String(error) }),
    );
  };

  const runImport = (kind: ImportKind) => {
    setPickProblem(undefined);
    pickImportFile(kind).then(
      (source) => source && navigation.navigate("ImportPreview", { ...source, kind }),
      (error: unknown) => setPickProblem(String(error)),
    );
  };

  return (
    <ScrollView
      testID="data"
      className="flex-1 bg-background"
      contentContainerClassName="gap-8 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-3">
        <SectionHeader title="Export" />
        <AppText tone="secondary" className="px-gutter">
          One file with every workout, routine, measurement and coach chat. Keep it as a backup, or
          import it into svett on another phone.
        </AppText>
        <View className="flex-row px-gutter">
          <Button
            label={exported.kind === "working" ? "Exporting" : "Export everything"}
            symbol="square.and.arrow.up"
            testID="export-button"
            disabled={exported.kind === "working"}
            onPress={runExport}
          />
        </View>
        {exported.kind === "done" ? (
          <AppText
            testID="export-done"
            variant="subheadline"
            tone="secondary"
            className="px-gutter"
          >
            Exported {recordsLabel(exported.rows)} as {exported.name}.
          </AppText>
        ) : null}
        {exported.kind === "failed" ? (
          <AppText variant="subheadline" tone="destructive" className="px-gutter">
            The export did not finish. {exported.message}
          </AppText>
        ) : null}
      </View>

      <View className="gap-3">
        <SectionHeader title="Import" />
        <AppText tone="secondary" className="px-gutter">
          Bring back a svett export. You see what it adds and changes before anything is saved, and
          you can undo it afterwards.
        </AppText>
        <View className="flex-row px-gutter">
          <Button
            label="Import a svett file"
            symbol="square.and.arrow.down"
            variant="secondary"
            testID="import-button"
            onPress={() => runImport("svett")}
          />
        </View>
        <AppText tone="secondary" className="px-gutter">
          Or bring your history from Hevy. In Hevy, open Settings, then Export & Import Data, and
          export your workouts. Import the file again later to add new workouts. svett skips the
          ones it already has.
        </AppText>
        <View className="flex-row px-gutter">
          <Button
            label="Import from Hevy"
            symbol="square.and.arrow.down"
            variant="secondary"
            testID="hevy-import-button"
            onPress={() => runImport("hevy")}
          />
        </View>
        {pickProblem === undefined ? null : (
          <AppText variant="subheadline" tone="destructive" className="px-gutter">
            The file did not open. {pickProblem}
          </AppText>
        )}
      </View>

      {imports.length === 0 ? null : (
        <ListSection header="Past imports" footer="Open an import to undo it.">
          {imports.map((batch, index) => (
            <ListRow
              key={batch.id}
              testID={`import-batch-${index}`}
              title={importTitle(batch.source)}
              subtitle={formatDay(batch.createdAt)}
              value={batch.status === "undone" ? "Undone" : undefined}
              trailing={{
                type: "chevron",
                onPress: () => navigation.navigate("UndoImport", { importBatchId: batch.id }),
              }}
            />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}
