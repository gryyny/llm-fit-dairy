// AR-9: supplementary end-of-turn gate. Runs `pnpm check` when code changed during the turn
// (working tree, untracked files or new commits), blocks once with exit code 2 on failure,
// and never blocks twice in a row (`stop_hook_active`). CI remains the authority.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const LIMIT_SECONDS = 540; // below the 600 s hook timeout, whose expiry would discard this output

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active === true) process.exit(0);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);

const changed = new Set(
  git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    .split("\0")
    .filter(Boolean)
    .map((line) => line.slice(3)),
);
const startFile = git("rev-parse", "--git-path", "claude-turn-start").trim();
if (existsSync(startFile)) {
  const start = readFileSync(startFile, "utf8").trim();
  if (start && start !== git("rev-parse", "HEAD").trim()) {
    for (const file of git("diff", "--name-only", start, "HEAD").split("\n")) {
      if (file) changed.add(file);
    }
  }
}
// Markdown is covered by the documentation checks in AGENTS.md, not by the code gate.
if (![...changed].some((file) => !file.endsWith(".md"))) process.exit(0);

const run = spawnSync("pnpm", ["check"], {
  encoding: "utf8",
  timeout: LIMIT_SECONDS * 1000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
});
if (run.status === 0) process.exit(0);

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
  .replace(/\b(postgres(?:ql)?:\/\/)[^@\s]+@/g, "$1***@")
  .replace(/\bfdk_[A-Za-z0-9_-]+/g, "fdk_***");
let reason;
if (run.error?.code === "ETIMEDOUT") reason = `pnpm check timed out after ${LIMIT_SECONDS} s.`;
else if (run.error) reason = `pnpm check could not run (${run.error.code ?? run.error.message}).`;
else if (/ECONNREFUSED|database .* does not exist|password authentication failed/.test(output))
  reason = "pnpm check could not reach PostgreSQL; report the gate as blocked, not passed.";
else reason = `pnpm check failed with exit code ${run.status}.`;

const tail = output.trim().split("\n").slice(-30).join("\n");
process.stderr.write(`${reason}\nFix it or report it honestly. Last output lines:\n${tail}\n`);
process.exit(2);
