import { dirname } from "node:path";
import * as core from "@actions/core";
import { main } from "./main.ts";

// GitHub Actions runs the action entry point with the node24 binary specified
// in action.yml, but doesn't add that binary's directory to PATH. Without this,
// spawned processes (pnpm, npm, etc.) resolve to the runner's default node (v20).
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

try {
  const result = await main();
  if (!result.success) {
    throw new Error(result.error || "agent execution failed");
  }
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
  core.setFailed(`action failed: ${errorMessage}`);
}
