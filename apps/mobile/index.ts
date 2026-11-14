import "./src/launch-start";

import { registerRootComponent } from "expo";

import "./src/checks/background";
import "./src/cardio/recorder";
import App from "./src/App";
import { prepareAppDatabase } from "./src/data/database";

prepareAppDatabase();
registerRootComponent(App);
