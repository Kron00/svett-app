import { useState } from "react";
import { View } from "react-native";

import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

/**
 * Finishes a Safari sign-in. When iOS suspends svett while Safari is in front, Safari cannot
 * open the address ChatGPT sends it back to, so the user copies it there. Swift reads it from the
 * pasteboard, because it holds a one-time code that JavaScript must never see.
 */
export function SafariPaste({ paste }: { readonly paste: () => Promise<string | null> }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View className="w-full gap-2">
      {problem === null ? null : (
        <AppText variant="subheadline" tone="destructive">
          {problem}
        </AppText>
      )}
      <Button
        label="Paste address from Safari"
        testID="chatgpt-paste-use"
        onPress={() => void paste().then(setProblem)}
      />
    </View>
  );
}
