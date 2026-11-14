import type { ChatGPTStatus } from "@svett/core";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";

import type { RootNavigation } from "../navigation";
import { ListRow } from "../ui/List";
import { chatGPTStatus } from "./native";

const summary = (status: ChatGPTStatus | undefined): string | undefined => {
  if (status === undefined) return undefined;
  if (status.state === "signedOut") return "Off";
  return status.planUsage ? "On" : "Plan usage off";
};

/** The You tab's way into the ChatGPT settings, with whether the coach can use the plan. */
export function ChatGPTRow() {
  const navigation = useNavigation<RootNavigation>();
  const [status, setStatus] = useState<ChatGPTStatus>();
  useFocusEffect(
    useCallback(() => {
      chatGPTStatus().then(setStatus, () => setStatus(undefined));
    }, []),
  );
  return (
    <ListRow
      title="ChatGPT"
      value={summary(status)}
      testID="chatgpt-row"
      icon={{ symbol: "sparkles", color: "accent" }}
      trailing={{ type: "chevron", onPress: () => navigation.navigate("ChatGPT") }}
    />
  );
}
