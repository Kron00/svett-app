import {
  CHART_RANGE_LABEL,
  CHART_RANGES,
  type ChartRange,
  editNumberEntry,
  formatDay,
  formatMeasurement,
  formatMeasurementChange,
  isChartRange,
  isMeasurementKind,
  latestMeasurements,
  MEASUREMENT_ENTRY,
  MEASUREMENT_LABEL,
  type MeasurementKind,
  MeasurementKind as MeasurementKinds,
  measurementRangeText,
  measurementSeries,
  measurementUnitText,
  parseMeasurementEntry,
  rangeStart,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { write } from "../data/store";
import { useQuery } from "../data/useQuery";
import type { RootNavigation, RootStackParamList } from "../navigation";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection } from "../ui/List";
import { EntryField, Keypad } from "../ui/NumberEntry";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Sheet } from "../ui/Sheet";
import { ChartCard } from "./ChartCard";
import { addMeasurement, measurements } from "./queries";
import { QueryView } from "./QueryView";

const RANGE_OPTIONS = CHART_RANGES.map((value) => ({ value, label: CHART_RANGE_LABEL[value] }));

/**
 * Body weight, body fat and tape measurements: one kind's chart, every kind's
 * latest value, and a sheet to add today's value. `kind`, `range` and `sheet`
 * come from the route, so a link can open any of them.
 */
export function MeasurementsScreen() {
  const navigation = useNavigation<RootNavigation>();
  const params = useRoute<RouteProp<RootStackParamList, "Measurements">>().params;
  const kind: MeasurementKind = isMeasurementKind(params?.kind) ? params.kind : "body_weight";
  const range: ChartRange = isChartRange(params?.range) ? params.range : "year";
  const sheetOpen = params?.sheet === "open";
  const setParams = (next: { kind?: MeasurementKind; range?: ChartRange; sheet?: "open" }) =>
    navigation.setParams({ kind, range, sheet: undefined, ...next });
  const { state, reload } = useQuery(measurements);

  return (
    <QueryView state={state}>
      {({ rows, now }) => {
        const latest = new Map(latestMeasurements(rows).map((entry) => [entry.kind, entry]));
        const current = latest.get(kind);
        const format = (value: number) => formatMeasurement(kind, value);
        return (
          <>
            <ScrollView
              testID="measurements"
              contentInsetAdjustmentBehavior="automatic"
              className="flex-1 bg-background"
              contentContainerStyle={{ gap: 16, paddingVertical: 16 }}
            >
              <View className="px-gutter">
                <SegmentedControl
                  accessibilityLabel="Chart range"
                  options={RANGE_OPTIONS}
                  selected={range}
                  onSelect={(next) => setParams({ range: next })}
                />
              </View>
              <ChartCard
                testID="chart-measurement"
                title={MEASUREMENT_LABEL[kind]}
                value={current === undefined ? null : format(current.latest.value)}
                detail={
                  current === undefined
                    ? "Not measured yet."
                    : `On ${formatDay(current.latest.measuredAt)}${
                        current.change === null
                          ? "."
                          : `, ${formatMeasurementChange(kind, current.change)} since the one before.`
                      }`
                }
                rule="Each point is one measurement."
                points={measurementSeries(rows, kind, rangeStart(range, now))}
                format={format}
              />
              <View className="px-gutter">
                <Button
                  label={`Add ${MEASUREMENT_LABEL[kind].toLowerCase()}`}
                  symbol="plus"
                  testID="add-measurement"
                  onPress={() => setParams({ sheet: "open" })}
                />
              </View>
              <ListSection header="Measurements">
                {MeasurementKinds.literals.map((each) => {
                  const entry = latest.get(each);
                  return (
                    <ListRow
                      key={each}
                      title={MEASUREMENT_LABEL[each]}
                      subtitle={
                        entry === undefined
                          ? "Not measured yet"
                          : `${formatDay(entry.latest.measuredAt)}${each === kind ? ". In the chart." : ""}`
                      }
                      value={
                        entry === undefined
                          ? undefined
                          : formatMeasurement(each, entry.latest.value)
                      }
                      testID={`measurement-row-${each}`}
                      trailing={{ type: "chevron", onPress: () => setParams({ kind: each }) }}
                    />
                  );
                })}
              </ListSection>
              <AppText
                testID="measurements-end"
                variant="footnote"
                tone="secondary"
                className="px-8"
              >
                Only you can see your measurements.
              </AppText>
            </ScrollView>
            <AddMeasurementSheet
              kind={kind}
              isPresented={sheetOpen}
              onDismiss={() => setParams({})}
              onSaved={() => {
                setParams({});
                reload();
              }}
            />
          </>
        );
      }}
    </QueryView>
  );
}

function AddMeasurementSheet({
  kind,
  isPresented,
  onDismiss,
  onSaved,
}: {
  readonly kind: MeasurementKind;
  readonly isPresented: boolean;
  readonly onDismiss: () => void;
  readonly onSaved: () => void;
}) {
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // State only disables Save after a render, and taps can land before it.
  const savingNow = useRef(false);
  const value = parseMeasurementEntry(kind, entry);
  const close = (done: () => void) => {
    setEntry("");
    setError(null);
    done();
  };
  const save = (measured: number) => {
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    write(addMeasurement(kind, measured))
      .then(
        () => close(onSaved),
        (cause: unknown) => setError(`The measurement was not saved. ${String(cause)}`),
      )
      .finally(() => {
        savingNow.current = false;
        setSaving(false);
      });
  };
  return (
    <Sheet
      isPresented={isPresented}
      onDismiss={() => close(onDismiss)}
      title={MEASUREMENT_LABEL[kind]}
    >
      <View testID="measurement-sheet" className="gap-4">
        <EntryField
          label={MEASUREMENT_LABEL[kind]}
          value={entry}
          unit={measurementUnitText(kind)}
          focused
          onPress={() => {}}
        />
        <Keypad
          limits={MEASUREMENT_ENTRY}
          onKey={(key) => setEntry((current) => editNumberEntry(current, key, MEASUREMENT_ENTRY))}
        />
        <AppText testID="measurement-range" variant="footnote" tone="secondary">
          {measurementRangeText(kind)}
        </AppText>
        {error === null ? null : <AppText tone="destructive">{error}</AppText>}
        <Button
          label="Save"
          testID="save-measurement"
          disabled={value === null || saving}
          onPress={() => {
            if (value !== null) save(value);
          }}
        />
      </View>
    </Sheet>
  );
}
