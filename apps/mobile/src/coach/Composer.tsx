import { useState } from "react";
import { TextInput, useWindowDimensions, View } from "react-native";

import { useColor, useIsAccessibilityTextSize } from "../design/hooks";
import { Button } from "../ui/Button";

/** The body style's line height at the default text size, from global.css. */
const BODY_LINE_HEIGHT = 22;
const FIELD_PADDING = 16;
export const COMPOSER_MAX_LINES = 5;

/**
 * The question field grows with its text up to five lines, then scrolls inside. It stops at a
 * quarter of the screen, so at the largest text sizes the chat stays in view above the keyboard.
 */
export function composerMaxHeight(fontScale: number, windowHeight: number): number {
  return Math.min(
    COMPOSER_MAX_LINES * BODY_LINE_HEIGHT * fontScale + FIELD_PADDING,
    windowHeight / 4,
  );
}

/** The coach's question field and Send, side by side, or stacked at accessibility text sizes. */
export function Composer({
  busy,
  onSend,
}: {
  readonly busy: boolean;
  readonly onSend: (question: string) => void;
}) {
  const [text, setText] = useState("");
  const { fontScale, height } = useWindowDimensions();
  const stacked = useIsAccessibilityTextSize();
  const send = () => {
    const question = text.trim();
    if (question === "" || busy) return;
    setText("");
    onSend(question);
  };
  return (
    <View
      testID="coach-composer"
      className={`gap-2 border-t border-separator bg-background px-gutter py-2 ${stacked ? "" : "flex-row items-end"}`}
    >
      {/* Stacked in a column, flex-1 would pin the field at its minimum height and clip its text. */}
      <TextInput
        accessibilityLabel="Question for the coach"
        testID="coach-input"
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Ask about your training"
        placeholderTextColor={useColor("secondary-label")}
        selectionColor={useColor("accent")}
        style={{ maxHeight: composerMaxHeight(fontScale, height) }}
        className={`min-h-target rounded-field bg-control px-3 py-2 text-body text-label ${stacked ? "" : "flex-1"}`}
      />
      <Button
        label="Send"
        testID="coach-send"
        disabled={busy || text.trim() === ""}
        onPress={send}
      />
    </View>
  );
}
