import { bridgeTransport } from "@svett/tools";
import { uuid } from "expo";

import SvettNative from "../../modules/svett-native";

/** Sends the coach's requests through the Swift module, which adds the ChatGPT token. */
export const swiftTransport = bridgeTransport({
  listen: (onEvent) => SvettNative.addListener("onCoachEvent", onEvent),
  send: (requestId, body) => SvettNative.sendCoachRequest(requestId, body),
  cancel: (requestId) => SvettNative.cancelCoachRequest(requestId),
  newRequestId: () => uuid.v4(),
});
