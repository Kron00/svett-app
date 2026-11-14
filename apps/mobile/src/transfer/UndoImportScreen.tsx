import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import {
  ImportBatchId,
  importTitle,
  type UndoPreview,
  type UndoResult,
  undoOutcome,
  undoPlanLabel,
} from "@svett/core";
import { Option, Schema } from "effect";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";

import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ListRow, ListSection } from "../ui/List";
import { withTransfers } from "./files";
import { formatDay } from "./format";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: UndoPreview }
  | { readonly kind: "undoing" }
  | { readonly kind: "undone"; readonly result: UndoResult }
  | { readonly kind: "failed"; readonly message: string };

const decodeBatchId = Schema.decodeUnknownOption(ImportBatchId);

function Plan({
  preview,
  onUndo,
}: {
  readonly preview: UndoPreview;
  readonly onUndo: (
    alsoEdited: ReadonlyArray<UndoPreview["changes"][number]["change"]["id"]>,
  ) => void;
}) {
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set());
  const { batch, changes } = preview;
  const edited = changes.filter((entry) => entry.edited);
  const taken = changes.filter((entry) => !entry.edited || included.has(entry.change.id));
  const toggle = (id: string) =>
    setIncluded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (batch.status !== "applied") {
    return (
      <View testID="undo-already">
        <EmptyState
          symbol="arrow.uturn.backward.circle"
          title="Already undone"
          message="This import was undone earlier. To bring its records back, import the file again and switch each record to the file's version."
        />
      </View>
    );
  }

  return (
    <>
      <AppText tone="secondary" className="px-gutter">
        {importTitle(batch.source)} from {formatDay(batch.createdAt)}.{" "}
        {undoPlanLabel({
          removing: taken.filter((entry) => entry.change.change === "added").length,
          restoring: taken.filter((entry) => entry.change.change === "replaced").length,
        })}
      </AppText>
      {edited.length === 0 ? null : (
        <View testID="undo-edited">
          <ListSection
            header="Changed after the import"
            footer="svett leaves these as they are unless you switch them on."
          >
            {edited.map(({ change }) => (
              <ListRow
                key={change.id}
                title={change.title}
                subtitle={change.itemAt === null ? undefined : formatDay(change.itemAt)}
                value={included.has(change.id) ? "Undo too" : "Keep"}
                trailing={{
                  type: "switch",
                  value: included.has(change.id),
                  onValueChange: () => toggle(change.id),
                }}
              />
            ))}
          </ListSection>
        </View>
      )}
      <View className="flex-row px-gutter">
        <Button
          label="Undo import"
          symbol="arrow.uturn.backward"
          variant="destructive"
          testID="undo-apply"
          onPress={() =>
            onUndo(
              edited.filter(({ change }) => included.has(change.id)).map(({ change }) => change.id),
            )
          }
        />
      </View>
    </>
  );
}

/** Takes an import back: what it added goes, and what it replaced comes back. */
export function UndoImportScreen() {
  const navigation = useNavigation<RootNavigation>();
  const { params } = useRoute<RouteProp<RootStackParamList, "UndoImport">>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const { importBatchId } = params;

  useEffect(() => {
    let current = true;
    const batchId = decodeBatchId(importBatchId);
    (Option.isSome(batchId)
      ? withTransfers((transfers) => transfers.previewUndo(batchId.value))
      : Promise.reject(new Error("This import does not exist."))
    ).then(
      (preview) => current && setState({ kind: "ready", preview }),
      (error: unknown) => current && setState({ kind: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [importBatchId]);

  const done = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Tabs"));

  return (
    <ScrollView
      testID="undo-import"
      className="flex-1 bg-background"
      contentContainerClassName="gap-6 pt-4 pb-12"
      contentInsetAdjustmentBehavior="automatic"
    >
      {state.kind === "loading" || state.kind === "undoing" ? (
        <AppText tone="secondary" className="px-gutter">
          {state.kind === "loading" ? "Reading the import" : "Undoing"}
        </AppText>
      ) : null}
      {state.kind === "ready" ? (
        <Plan
          preview={state.preview}
          onUndo={(alsoEdited) => {
            setState({ kind: "undoing" });
            withTransfers((transfers) =>
              transfers.undoImport(state.preview.batch.id, alsoEdited),
            ).then(
              (result) => setState({ kind: "undone", result }),
              (error: unknown) => setState({ kind: "failed", message: String(error) }),
            );
          }}
        />
      ) : null}
      {state.kind === "undone" ? (
        <View testID="undo-done" className="gap-4 px-gutter">
          <AppText variant="title3" accessibilityRole="header">
            Import undone
          </AppText>
          <AppText tone="secondary">{undoOutcome(state.result)}</AppText>
          <View className="flex-row">
            <Button label="Done" onPress={done} />
          </View>
        </View>
      ) : null}
      {state.kind === "failed" ? (
        <EmptyState
          symbol="exclamationmark.triangle"
          title="Undo did not run"
          message={`Nothing changed. ${state.message}`}
          action={{ label: "Done", onPress: done }}
        />
      ) : null}
    </ScrollView>
  );
}
