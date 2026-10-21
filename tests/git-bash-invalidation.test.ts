import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitStatus, waitForGitUpdates } from "../git-status.ts";

// Minimal pi harness: register the real extension, then dispatch events by name.
// Mirrors the readiness harness in post-compaction-queue.test.ts.
async function toolResultHarness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "powerline-tool-result-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, "settings.json"), JSON.stringify({ powerline: { welcome: false } }));
  const { default: powerline } = await import("../index.ts");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const ctx = {
    cwd: root,
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "tool-result", getBranch: () => [] },
    ui: { notify() {}, setWorkingMessage() {}, setWidget() {}, setHeader() {} },
  };
  powerline({
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(name, handler),
    registerCommand() {},
  });
  const emit = async (name: string, event: unknown = {}) => { await handlers.get(name)?.(event, ctx); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await emit("session_start", { reason: "new" });
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    t.mock.timers.reset();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { emit };
}

test("bash tool results invalidate the git status cache", async (t) => {
  const { emit } = await toolResultHarness(t);
  const cwd = mkdtempSync(join(tmpdir(), "powerline-bash-invalidation-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main");

  // Epoch-scale base so cache invalidation (timestamp reset to 0) is always
  // older than the configured TTL, as with the real clock.
  let now = 1_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  writeFileSync(join(cwd, "dirty"), "first");
  getGitStatus("main", "full", cwd, 60_000);
  await waitForGitUpdates();
  assert.equal(getGitStatus("main", "full", cwd, 60_000).untracked, 1);

  // A long TTL alone would keep serving stale counts; the completed bash
  // command that touched the working tree must refresh them right away.
  writeFileSync(join(cwd, "generated"), "second");
  await emit("tool_result", { toolName: "bash", input: { command: "echo generated > generated" } });
  getGitStatus("main", "full", cwd, 60_000);
  await waitForGitUpdates();
  assert.equal(getGitStatus("main", "full", cwd, 60_000).untracked, 2);
});
