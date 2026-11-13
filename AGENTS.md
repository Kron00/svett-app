# svett.app

svett is an iPhone app for lifting and cardio. It has one feed for every kind of workout. Users can export all their data and import it back. A coach runs on the user's own ChatGPT plan after **Continue with ChatGPT**.

`docs/plan.html` is the approved build plan. Read it before you change anything. It names every pull request, its proof, and the rules the code keeps.

## Machines

| Machine | Job |
| --- | --- |
| rena-devbox (Linux) | Main working copy. Agents, package installs, type checks, lint, unit tests, the Metro dev server, and the phase 6 server. |
| rena-devbook (Mac) | Native iOS builds and the iPhone 16 Pro Max simulator. The simulator loads TypeScript from Metro on rena-devbox over Tailscale. |
| rena (Mac laptop) | Real-phone work through iPhone Mirroring, only when a task needs the phone. |
| GitHub hosted runners | Lint, type checks, tests, an iOS compile check, and the release job after each merge. Never add a self-hosted runner: the repo is public. |

## Rules

- Every pull request goes through the sol loop and then the council. It merges only when both council reviewers score it 9 or higher.
- Phone sessions are read-only unless the task says otherwise. Do not sign in or out, buy, start trials, post, like, follow, comment, or save or delete any workout or activity.
- Never commit `research/screenshots/`, real names, email addresses, IP addresses, user names, tokens or a real Hevy export.
- `research/features.md` is the Hevy and Strava feature inventory the plan is based on.
