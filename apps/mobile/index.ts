import "./src/launch-start";

import { registerRootComponent } from "expo";

import { stopLeftoverLocation } from "./src/checks/background";
import App from "./src/App";
import { prepareAppDatabase } from "./src/data/current";
import { markLaunch } from "./src/data/launch-timing";

prepareAppDatabase();
registerRootComponent(App);
void stopLeftoverLocation().then(
  (stopped) => stopped && markLaunch("locationStopped"),
  () => undefined,
);
