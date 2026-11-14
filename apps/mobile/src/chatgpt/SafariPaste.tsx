import { useState } from "react";
import { TextInput, View } from "react-native";

import { useColor } from "../design/hooks";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/**
 * Finishes a Safari sign-in. When iOS suspends svett while Safari is in front, Safari cannot
 * open the address ChatGPT sends it back to, so the user pastes that address here.
 */
export function SafariPaste({
  paste,
}: {
  readonly paste: (address: string) => Promise<string | null>;
}) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View className="w-full gap-2">
      <TextInput
        accessibilityLabel="Address Safari could not open"
        testID="chatgpt-paste-address"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="http://127.0.0.1:…/auth/callback?…"
        placeholderTextColor={useColor("secondary-label")}
        className="min-h-target rounded-field bg-control px-3 py-2 text-body text-label"
      />
      {problem === null ? null : (
        <AppText variant="subheadline" tone="destructive">
          {problem}
        </AppText>
      )}
      <Button
        label="Use address"
        testID="chatgpt-paste-use"
        onPress={() => void paste(address).then(setProblem)}
      />
    </View>
  );
}
