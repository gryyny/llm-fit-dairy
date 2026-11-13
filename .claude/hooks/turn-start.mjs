// Records HEAD when a turn starts so the Stop hook also sees commits made during the turn (AR-9).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

try {
  writeFileSync(git("rev-parse", "--git-path", "claude-turn-start"), git("rev-parse", "HEAD"));
} catch {
  // Not a git checkout or no commits yet: the Stop hook falls back to working-tree changes.
}
