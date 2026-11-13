import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repo = fileURLToPath(new URL("..", import.meta.url));

// Workflows and other scripts run a script with a shebang directly, and a checkout
// takes the mode from git, so a missing executable bit fails only on the runner.
// Scripts that are only sourced have no shebang.
const committedScripts = execFileSync("git", ["ls-files", "--stage", "--", "scripts/*.sh"], {
  cwd: repo,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .map((line) => {
    const [mode = "", , , path = ""] = line.split(/\s+/);
    return { mode, path };
  });

describe("shell scripts in git", () => {
  it("finds the scripts", () => {
    expect(committedScripts.map(({ path }) => path)).toContain("scripts/publish-release.sh");
  });

  it("commits every script with a shebang as executable", () => {
    const notExecutable = committedScripts
      .filter(({ path }) => readFileSync(join(repo, path), "utf8").startsWith("#!"))
      .filter(({ mode }) => mode !== "100755")
      .map(({ path }) => path);
    expect(notExecutable).toEqual([]);
  });
});
