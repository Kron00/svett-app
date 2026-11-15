import type { SymbolName } from "../design/tokens";

export type FirstRunPage = {
  readonly id: string;
  readonly symbol: SymbolName;
  readonly title: string;
  readonly body: string;
};

/** What a new person needs to know before the first workout, one point a page. */
export const FIRST_RUN_PAGES: ReadonlyArray<FirstRunPage> = [
  {
    id: "feed",
    symbol: "figure.run",
    title: "Lifting and cardio in one feed",
    body: "Log a lifting session, a run, a ride, a walk or a hike. Every workout lands in one history, with one set of charts and records.",
  },
  {
    id: "data",
    symbol: "iphone",
    title: "Your data stays on this phone",
    body: "svett works offline and keeps what you log on this iPhone. You can export all of it as one file from You, Your data, and import it back at any time.",
  },
  {
    id: "account",
    symbol: "person.crop.circle",
    title: "An account is optional",
    body: "You need one only for the feed and to sync between phones. Logging, history, progress, export and import all work without one.",
  },
  {
    id: "coach",
    symbol: "sparkles",
    title: "The coach runs on your ChatGPT plan",
    body: "When you want it, tap Continue with ChatGPT on the Coach tab. It answers from your own training data and costs nothing on top of your plan.",
  },
];
