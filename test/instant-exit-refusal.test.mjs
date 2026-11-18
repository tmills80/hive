import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the instant-exit refusal tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { paneCommandState, paneProcessState, sessionName } = await import("../dist/tmux.js");

// A tmux that has not noticed a dead pane yet: the death probe answers "alive" for a pane whose
// process is already gone. Every other verb is the real tmux, so the pane is a real pane.
function tmuxThatHasNotNoticed() {
  const dir = mkdtempSync(join(tmpdir(), "hive-laggingtmux-"));
  const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(dir, "tmux"),
    `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "#{pane_id} #{pane_dead}" ]; then
  t=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-t" ]; then t="$a"; fi
    prev="$a"
  done
  printf '%s 0\\n' "$t"
  exit 0
fi
exec ${real} "$@"
`,
    { mode: 0o755 },
  );
  return dir;
}

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AUTO_ATTACH: "0" } });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("the OS's answer about a pane's process", () => {
  it("reads a process that has exited as exited, and a process that runs as running", async () => {
    const dead = spawn("sh", ["-c", "exit 0"]);
    const deadPid = String(dead.pid);
    await new Promise((resolve) => dead.on("exit", resolve));

    const live = spawn("sleep", ["60"]);
    try {
      assert.equal(paneProcessState(deadPid), "exited", "a process that has exited reads as exited");
      assert.equal(paneCommandState(deadPid), "exited", "and it reads as exited before anything else is asked");
      assert.equal(paneProcessState(String(live.pid)), "running", "a process that runs reads as running");
    } finally {
      live.kill("SIGKILL");
    }
  });

  it("answers unknown for a pid that was never a process, and for a process with no tty of its own", async () => {
    assert.equal(paneCommandState(""), "unknown", "no pid is no fact, not a guess");
    assert.equal(paneCommandState("not-a-pid"), "unknown", "a pid that is not a pid is no fact either");

    const live = spawn("sleep", ["60"]);
    try {
      assert.equal(
        paneCommandState(String(live.pid)),
        "unknown",
        "a process with no tty of its own never establishes, so the careful read says unknown rather than guessing",
      );
    } finally {
      live.kill("SIGKILL");
    }
  });
});

describe("a command that exits at once", () => {
  it(
    "is refused even when tmux still reports its pane as alive",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      const lagging = tmuxThatHasNotNoticed();
      const client = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AUTO_ATTACH: "0", PATH: `${lagging}:${process.env.PATH}` },
      });
      await client.start();
      try {
        await client.call("agent_spawn", { name: "lagging-anchor", command: "sleep", extra_args: ["600"] });

        const name = "lagging-tmux-instant";
        await assert.rejects(
          client.call("agent_spawn", { name, command: "false", placement: "window" }),
          /exited immediately/,
          "the refusal is the OS's answer, so a tmux that has not noticed the death cannot overturn it",
        );
        const { agents } = await mcp.call("agent_list", { include_closed: true });
        assert.deepEqual(agents.filter((a) => a.name === name), [], "and nothing is recorded for it");
      } finally {
        await client.close();
      }
    },
  );
});
