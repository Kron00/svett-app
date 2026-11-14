import "./src/launch-start";

import { registerRootComponent } from "expo";

import "./src/checks/background";
import App from "./src/App";
import { prepareAppDatabase } from "./src/data/current";

prepareAppDatabase();
registerRootComponent(App);
