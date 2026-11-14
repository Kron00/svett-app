import {
  ActivityKind,
  editNumberEntry,
  formatSetLoad,
  formatWeightKg,
  type KeypadKey,
  type NumberEntryLimits,
  REPS_ENTRY,
  stepValue,
  WEIGHT_KG_ENTRY,
} from "@svett/core";
import { type RouteProp, useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { type ReactNode, useState } from "react";
import { ScrollView, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import {
  COLOR_TOKENS,
  type ColorToken,
  SPORTS,
  TEXT_STYLES,
  type TextStyleName,
} from "../design/tokens";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Chart, ChartBars, ChartGrid, ChartLine } from "../ui/Chart";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { ListRow, ListSection, SectionHeader } from "../ui/List";
import { EntryField, Keypad, Stepper } from "../ui/NumberEntry";
import { OptionSheet } from "../ui/OptionSheet";
import { SearchField } from "../ui/SearchField";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SetRow, SetRowHeader } from "../ui/SetRow";
import { Sheet } from "../ui/Sheet";
import { StatTile } from "../ui/StatTile";
import { TextField } from "../ui/TextField";
import { WorkoutBar } from "../ui/WorkoutBar";

type SetField = "weight" | "reps";

const LIMITS: Readonly<Record<SetField, NumberEntryLimits>> = {
  weight: WEIGHT_KG_ENTRY,
  reps: REPS_ENTRY,
};

const noop = () => {};

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <View testID={`gallery-${id}`} className="gap-3">
      <SectionHeader title={title} />
      {children}
    </View>
  );
}

function Card({ children }: { readonly children: ReactNode }) {
  return <View className="mx-gutter gap-4 rounded-card bg-surface p-4">{children}</View>;
}

function Swatch({ token }: { readonly token: ColorToken }) {
  const separator = useColor("separator");
  const width = useIsAccessibilityTextSize() ? "w-full" : "min-w-36 grow basis-36";
  return (
    <View className={`${width} flex-row items-center gap-2`}>
      <View
        className="size-7 rounded-lg"
        style={{ backgroundColor: useColor(token), borderColor: separator, borderWidth: 1 }}
      />
      <AppText variant="footnote" className="shrink">
        {token}
      </AppText>
    </View>
  );
}

function NumberEntryDemo() {
  const [entry, setEntry] = useState({ field: "weight" as SetField, weight: "82.5", reps: "" });
  const press = (key: KeypadKey) =>
    setEntry((current) => ({
      ...current,
      [current.field]: editNumberEntry(current[current.field], key, LIMITS[current.field]),
    }));
  return (
    <>
      <View className="flex-row gap-3">
        {(["weight", "reps"] as const).map((field) => (
          <View key={field} className="flex-1 gap-1">
            <AppText variant="footnote" tone="secondary">
              {field === "weight" ? "Weight" : "Reps"}
            </AppText>
            <EntryField
              label={field === "weight" ? "Weight" : "Reps"}
              value={entry[field]}
              placeholder={field === "weight" ? "80" : "8"}
              unit={field === "weight" ? "kg" : "reps"}
              focused={entry.field === field}
              onPress={() => setEntry((current) => ({ ...current, field }))}
            />
          </View>
        ))}
      </View>
      <Keypad limits={LIMITS[entry.field]} onKey={press} />
    </>
  );
}

const SETS = [
  {
    id: "warm-up",
    setType: "warm_up",
    normalSetNumber: 0,
    previous: formatSetLoad(40, 10),
    weight: "40",
    reps: "10",
  },
  {
    id: "first",
    setType: "normal",
    normalSetNumber: 1,
    previous: formatSetLoad(80, 8),
    weight: "80",
    reps: "8",
  },
  {
    id: "second",
    setType: "normal",
    normalSetNumber: 2,
    previous: formatSetLoad(80, 8),
    weight: "82.5",
    reps: "",
  },
  {
    id: "failure",
    setType: "failure",
    normalSetNumber: 2,
    previous: formatSetLoad(80, 6),
    weight: "",
    reps: "",
  },
  { id: "drop", setType: "drop", normalSetNumber: 2, previous: null, weight: "", reps: "" },
] as const;

function SetRowsDemo() {
  const [done, setDone] = useState<ReadonlyArray<boolean>>([true, true, false, false, false]);
  return (
    <View className="mx-gutter gap-1 rounded-card bg-surface py-3">
      <SetRowHeader />
      {SETS.map((set, index) => (
        <SetRow
          key={set.id}
          setType={set.setType}
          normalSetNumber={set.normalSetNumber}
          previous={set.previous}
          fields={[
            {
              name: "weight",
              value: set.weight,
              placeholder: set.previous === null ? undefined : "80",
              unit: "kg",
            },
            {
              name: "reps",
              value: set.reps,
              placeholder: set.previous === null ? undefined : "8",
              unit: "reps",
            },
          ]}
          done={done[index] ?? false}
          focusedField={index === 2 ? 1 : undefined}
          onPressSetType={noop}
          onPressField={noop}
          onToggleDone={() =>
            setDone((current) => current.map((value, i) => (i === index ? !value : value)))
          }
        />
      ))}
    </View>
  );
}

// Workouts with uneven gaps, as a line spaced by time shows them.
const WORKOUTS = (
  [
    [8, 1, 80],
    [8, 4, 80],
    [8, 8, 82.5],
    [8, 15, 85],
    [9, 13, 82.5],
    [9, 16, 87.5],
    [9, 20, 90],
    [10, 3, 92.5],
  ] as const
).map(([month, day, value], index) => ({
  key: `workout-${index + 1}`,
  value,
  at: Date.UTC(2026, month, day),
}));
const DAYS = (
  [
    ["mon", "M", 12],
    ["tue", "T", 0],
    ["wed", "W", 18],
    ["thu", "T", 9],
    ["fri", "F", 0],
    ["sat", "S", 22],
    ["sun", "S", 6],
  ] as const
).map(([key, label, value]) => ({ key, label, value }));

const MUSCLES = [
  { value: "chest", label: "Chest" },
  { value: "lats", label: "Lats" },
  { value: "shoulders", label: "Shoulders" },
] as const;

type GalleryParams = { Gallery: { sheet?: "open" } | undefined };

/**
 * Every design system component in its states. It is reachable from the You
 * tab, and scripts/sim/gallery.sh screenshots it at the default and the
 * largest text size.
 */
export function GalleryScreen() {
  const [range, setRange] = useState<"week" | "month" | "year">("week");
  const [awake, setAwake] = useState(true);
  const [unit, setUnit] = useState<"kg" | "lb">("kg");
  const [weight, setWeight] = useState(80);
  const [reps, setReps] = useState(8);
  const [search, setSearch] = useState("bench");
  const [name, setName] = useState("");
  const [muscle, setMuscle] = useState<(typeof MUSCLES)[number]["value"] | null>("chest");
  const [optionsOpen, setOptionsOpen] = useState(false);
  // The sheet's state is a route param so svett://gallery?sheet=open can show it.
  const navigation = useNavigation<NativeStackNavigationProp<GalleryParams, "Gallery">>();
  const sheetOpen = useRoute<RouteProp<GalleryParams>>().params?.sheet === "open";
  const setSheetOpen = (open: boolean) =>
    navigation.setParams({ sheet: open ? "open" : undefined });

  return (
    <ScrollView
      testID="gallery"
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-background"
      contentContainerStyle={{ gap: 32, paddingVertical: 16 }}
    >
      <Section id="colours" title="Colours">
        <View className="flex-row flex-wrap gap-3 px-gutter">
          {COLOR_TOKENS.map((token) => (
            <Swatch key={token} token={token} />
          ))}
        </View>
      </Section>

      <Section id="sports" title="Sports">
        <ListSection>
          {ActivityKind.literals.map((kind) => (
            <ListRow
              key={kind}
              title={SPORTS[kind].label}
              icon={{ symbol: SPORTS[kind].symbol, color: SPORTS[kind].color }}
            />
          ))}
        </ListSection>
      </Section>

      <Section id="type" title="Type">
        <View className="gap-2 px-gutter">
          {(Object.keys(TEXT_STYLES) as ReadonlyArray<TextStyleName>).map((variant) => (
            <AppText key={variant} variant={variant}>
              {variant}, Bench press 82.5 kg
            </AppText>
          ))}
        </View>
      </Section>

      <Section id="buttons" title="Buttons">
        <View className="gap-3 px-gutter">
          <Button label="Start workout" symbol="play.fill" onPress={noop} />
          <Button label="Add exercise" symbol="plus" variant="secondary" onPress={noop} />
          <Button label="Discard workout" symbol="trash" variant="destructive" onPress={noop} />
          <Button label="Add set" variant="plain" onPress={noop} />
          <Button label="Finish" disabled onPress={noop} />
          <View className="flex-row gap-2">
            <IconButton symbol="arrow.up" label="Move up" onPress={noop} />
            <IconButton symbol="arrow.down" label="Move down" disabled onPress={noop} />
            <IconButton symbol="trash" label="Remove" destructive onPress={noop} />
            <IconButton symbol="ellipsis.circle" label="Options" variant="plain" onPress={noop} />
          </View>
        </View>
      </Section>

      <Section id="text-fields" title="Text fields">
        <View className="gap-4 px-gutter">
          <TextField
            label="Email"
            value="lifter@example.com"
            note="Filled in from your ChatGPT sign-in."
            onChangeText={noop}
          />
          <TextField
            label="Code from the email"
            value="4242"
            problem="Enter the six-digit code from the email."
            onChangeText={noop}
          />
          <TextField label="Email" placeholder="name@example.com" editable={false} />
        </View>
      </Section>

      <Section id="lists" title="Lists">
        <SectionHeader title="Recent workouts" action={{ label: "See all", onPress: noop }} />
        <ListSection
          header="Settings"
          footer="Rows stack their value under the title at accessibility text sizes."
        >
          <ListRow
            title="Units"
            value="kg"
            icon={{ symbol: "scalemass.fill", color: "sport-ride" }}
            trailing={{ type: "chevron", onPress: noop }}
          />
          <ListRow
            title="Keep screen awake"
            icon={{ symbol: "sun.max.fill", color: "sport-run" }}
            trailing={{ type: "switch", value: awake, onValueChange: setAwake }}
          />
          <ListRow
            title="Export data"
            subtitle="Everything in one file"
            icon={{ symbol: "square.and.arrow.up", color: "sport-walk" }}
            trailing={{ type: "chevron", onPress: noop }}
          />
          <ListRow title="Version" value="0.1" />
        </ListSection>
        <ListSection header="Weight unit" footer="A check row picks one choice of its section.">
          <ListRow
            title="Kilograms"
            trailing={{ type: "check", selected: unit === "kg", onPress: () => setUnit("kg") }}
          />
          <ListRow
            title="Pounds"
            trailing={{ type: "check", selected: unit === "lb", onPress: () => setUnit("lb") }}
          />
        </ListSection>
      </Section>

      <Section id="segmented" title="Segmented control">
        <View className="px-gutter">
          <SegmentedControl
            accessibilityLabel="Chart range"
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
              { value: "year", label: "Year" },
            ]}
            selected={range}
            onSelect={setRange}
          />
        </View>
      </Section>

      <Section id="fields" title="Fields">
        <Card>
          <SearchField
            label="Search exercises"
            placeholder="Search exercises"
            value={search}
            onChangeText={setSearch}
          />
          <TextField
            label="Name"
            placeholder="Landmine press"
            value={name}
            onChangeText={setName}
          />
          <Button
            label={MUSCLES.find((option) => option.value === muscle)?.label ?? "All muscles"}
            symbol="figure.strengthtraining.traditional"
            variant="secondary"
            onPress={() => setOptionsOpen(true)}
          />
        </Card>
        <OptionSheet
          title="Muscle"
          mode="single"
          noneLabel="All muscles"
          options={MUSCLES}
          selected={muscle}
          onSelect={setMuscle}
          isPresented={optionsOpen}
          onDismiss={() => setOptionsOpen(false)}
        />
      </Section>

      <Section id="steppers" title="Steppers">
        <Card>
          <Stepper
            label="Weight"
            valueText={formatWeightKg(weight)}
            unit="kg"
            onIncrement={() => setWeight((value) => stepValue(value, 1, WEIGHT_KG_ENTRY))}
            onDecrement={() => setWeight((value) => stepValue(value, -1, WEIGHT_KG_ENTRY))}
            decrementDisabled={weight === 0}
          />
          <Stepper
            label="Reps"
            valueText={String(reps)}
            onIncrement={() => setReps((value) => stepValue(value, 1, REPS_ENTRY))}
            onDecrement={() => setReps((value) => stepValue(value, -1, REPS_ENTRY))}
            decrementDisabled={reps === 0}
          />
        </Card>
      </Section>

      <Section id="keypad" title="Number pad">
        <Card>
          <NumberEntryDemo />
        </Card>
      </Section>

      <Section id="sets" title="Set rows">
        <SetRowsDemo />
      </Section>

      <Section id="stats" title="Stat tiles">
        <View className="flex-row flex-wrap gap-3 px-gutter">
          <StatTile label="Duration" value="72" unit="min" symbol="clock.fill" />
          <StatTile label="Volume" value="12450" unit="kg" symbol="scalemass.fill" />
          <StatTile label="Sets" value="24" symbol="list.number" />
          <StatTile label="Records" value="3" symbol="trophy.fill" color="set-warm-up" />
        </View>
      </Section>

      <Section id="charts" title="Charts">
        <Card>
          <AppText variant="subheadline" tone="secondary">
            Bench press, best set
          </AppText>
          <Chart
            points={WORKOUTS}
            spacing="time"
            formatValue={formatWeightKg}
            accessibilityLabel="Bench press best set over eight workouts from 1 September to 3 November, rising from 80 to 92.5 kilograms"
          >
            <ChartGrid />
            <ChartLine />
          </Chart>
        </Card>
        <Card>
          <AppText variant="subheadline" tone="secondary">
            Sets this week
          </AppText>
          <Chart
            points={DAYS}
            includeZero
            accessibilityLabel="Sets per day this week, 67 in total, most on Saturday with 22"
          >
            <ChartGrid />
            <ChartBars color="sport-ride" />
          </Chart>
        </Card>
      </Section>

      <Section id="empty" title="Empty state">
        <View className="mx-gutter rounded-card bg-surface">
          <EmptyState
            symbol="clock.arrow.circlepath"
            title="No workouts yet"
            message="Workouts you finish show up here."
            action={{ label: "Start workout", onPress: noop }}
          />
        </View>
      </Section>

      <Section id="workout-bar" title="Workout in progress">
        {/* The bar floats over content in the app, so here it sits on a chart to show its glass. */}
        <View className="mx-gutter">
          <View className="rounded-card bg-surface p-4">
            <Chart points={DAYS} includeZero accessibilityLabel="Sets per day this week">
              <ChartGrid />
              <ChartBars color="sport-run" />
            </Chart>
          </View>
          <View className="absolute inset-x-3 bottom-16">
            <WorkoutBar title="Push day" elapsed="42:07" onPress={noop} />
          </View>
        </View>
      </Section>

      <Section id="sheet" title="Sheet">
        <View className="px-gutter">
          <Button
            label="Show sheet"
            variant="secondary"
            testID="gallery-open-sheet"
            onPress={() => setSheetOpen(true)}
          />
        </View>
        <Sheet isPresented={sheetOpen} onDismiss={() => setSheetOpen(false)} title="Weight">
          <View testID="gallery-sheet" className="gap-4">
            <NumberEntryDemo />
            <Button label="Done" testID="gallery-sheet-done" onPress={() => setSheetOpen(false)} />
          </View>
        </Sheet>
      </Section>

      <View testID="gallery-end" className="px-gutter pb-8">
        <AppText variant="footnote" tone="secondary" className="text-center">
          End of gallery
        </AppText>
      </View>
    </ScrollView>
  );
}
