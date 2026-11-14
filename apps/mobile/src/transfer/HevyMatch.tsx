import {
  type Exercise,
  type ExerciseId,
  exerciseSummary,
  NO_FILTER,
  searchExercises,
} from "@svett/core";
import { useDeferredValue, useMemo, useState } from "react";
import { View } from "react-native";

import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection } from "../ui/List";
import { SearchField } from "../ui/SearchField";

export type MatchExercise = Pick<
  Exercise,
  "id" | "name" | "equipment" | "primaryMuscles" | "source"
>;

export interface UnknownName {
  readonly name: string;
  readonly suggestions: ReadonlyArray<MatchExercise>;
}

/** Each unknown name's choice: an exercise here, or a new exercise with the Hevy name. */
export type NameChoices = ReadonlyMap<string, ExerciseId | "new">;

/** Search results shown under one name. Typing more narrows a longer list. */
const SHOWN_RESULTS = 8;

function exerciseRow(
  exercise: MatchExercise,
  selected: boolean,
  onPress: () => void,
  testID: string,
) {
  return (
    <ListRow
      key={exercise.id}
      title={exercise.name}
      subtitle={exerciseSummary(exercise)}
      value={exercise.source === "svett" ? "Custom" : undefined}
      testID={testID}
      trailing={{ type: "check", selected, onPress }}
    />
  );
}

function NameMatch({
  name,
  index,
  suggestions,
  exercises,
  chosen,
  onChoose,
}: UnknownName & {
  readonly index: number;
  readonly exercises: ReadonlyArray<MatchExercise>;
  readonly chosen: ExerciseId | "new";
  readonly onChoose: (choice: ExerciseId | "new") => void;
}) {
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const found = useMemo(
    () => (query.trim() === "" ? [] : searchExercises(exercises, { ...NO_FILTER, text: query })),
    [exercises, query],
  );
  const suggested = new Set(suggestions.map((exercise) => exercise.id));
  const results = found.filter((exercise) => !suggested.has(exercise.id));
  const shown = results.slice(0, SHOWN_RESULTS);
  // A choice from an earlier search stays on screen after the search changes.
  const earlier =
    chosen === "new" || suggested.has(chosen) || shown.some((exercise) => exercise.id === chosen)
      ? undefined
      : exercises.find((exercise) => exercise.id === chosen);

  return (
    <View className="gap-3">
      <ListSection header={name}>
        {[
          <ListRow
            key="new"
            title="New exercise"
            subtitle={`Named ${name}`}
            testID={`match-${index}-new`}
            trailing={{
              type: "check",
              selected: chosen === "new",
              onPress: () => onChoose("new"),
            }}
          />,
          ...suggestions.map((exercise, option) =>
            exerciseRow(
              exercise,
              chosen === exercise.id,
              () => onChoose(exercise.id),
              `match-${index}-${option}`,
            ),
          ),
          ...(earlier ? [exerciseRow(earlier, true, () => {}, `match-${index}-chosen`)] : []),
        ]}
      </ListSection>
      <View className="px-gutter">
        <SearchField
          label={`Search every exercise for ${name}`}
          placeholder="Search every exercise"
          value={text}
          onChangeText={setText}
          testID={`match-${index}-search`}
        />
      </View>
      {shown.length > 0 ? (
        <ListSection
          footer={
            results.length > shown.length
              ? `Showing ${shown.length} of ${results.length}. Type more to narrow the list.`
              : undefined
          }
        >
          {shown.map((exercise, option) =>
            exerciseRow(
              exercise,
              chosen === exercise.id,
              () => onChoose(exercise.id),
              `match-${index}-result-${option}`,
            ),
          )}
        </ListSection>
      ) : query.trim() === "" ? null : (
        <AppText variant="footnote" tone="secondary" className="px-8">
          {found.length === 0
            ? `No exercise here matches "${query.trim()}".`
            : "Only the suggestions above match."}
        </AppText>
      )}
    </View>
  );
}

/**
 * The Hevy exercise names svett does not know, each matched to an exercise here or to a new
 * one. A new exercise is the default, so nothing is matched to the wrong exercise unasked.
 * Next to each name's suggestions, a search finds any exercise here.
 */
export function HevyMatch({
  names,
  exercises,
  onContinue,
}: {
  readonly names: ReadonlyArray<UnknownName>;
  readonly exercises: ReadonlyArray<MatchExercise>;
  readonly onContinue: (choices: NameChoices) => void;
}) {
  const [choices, setChoices] = useState<ReadonlyMap<string, ExerciseId | "new">>(new Map());
  const chosen = (name: string) => choices.get(name) ?? "new";

  return (
    <View testID="hevy-match" className="gap-6">
      <AppText tone="secondary" className="px-gutter">
        svett does not know{" "}
        {names.length === 1 ? "one exercise name" : `${names.length} exercise names`} in this file.
        Match each to an exercise here, or keep it as a new exercise. svett remembers your choice
        for the next import.
      </AppText>
      {names.map(({ name, suggestions }, index) => (
        <NameMatch
          key={name}
          name={name}
          index={index}
          suggestions={suggestions}
          exercises={exercises}
          chosen={chosen(name)}
          onChoose={(choice) => setChoices((current) => new Map(current).set(name, choice))}
        />
      ))}
      <View className="flex-row px-gutter">
        <Button
          label="Continue"
          testID="match-continue"
          onPress={() => onContinue(new Map(names.map(({ name }) => [name, chosen(name)])))}
        />
      </View>
    </View>
  );
}
