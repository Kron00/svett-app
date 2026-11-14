import type { ExerciseId } from "@svett/core";
import { useState } from "react";
import { View } from "react-native";

import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { ListRow, ListSection } from "../ui/List";

export interface UnknownName {
  readonly name: string;
  readonly suggestions: ReadonlyArray<{ readonly id: ExerciseId; readonly name: string }>;
}

/** Each unknown name's choice: an exercise here, or a new exercise with the Hevy name. */
export type NameChoices = ReadonlyMap<string, ExerciseId | "new">;

/**
 * The Hevy exercise names svett does not know, each matched to an exercise here or to a new
 * one. A new exercise is the default, so nothing is matched to the wrong exercise unasked.
 */
export function HevyMatch({
  names,
  onContinue,
}: {
  readonly names: ReadonlyArray<UnknownName>;
  readonly onContinue: (choices: NameChoices) => void;
}) {
  const [choices, setChoices] = useState<ReadonlyMap<string, ExerciseId | "new">>(new Map());
  const choose = (name: string, choice: ExerciseId | "new") =>
    setChoices((current) => new Map(current).set(name, choice));
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
        <ListSection key={name} header={name}>
          <ListRow
            title="New exercise"
            subtitle={`Named ${name}`}
            testID={`match-${index}-new`}
            trailing={{
              type: "check",
              selected: chosen(name) === "new",
              onPress: () => choose(name, "new"),
            }}
          />
          {suggestions.map((exercise, option) => (
            <ListRow
              key={exercise.id}
              title={exercise.name}
              testID={`match-${index}-${option}`}
              trailing={{
                type: "check",
                selected: chosen(name) === exercise.id,
                onPress: () => choose(name, exercise.id),
              }}
            />
          ))}
        </ListSection>
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
