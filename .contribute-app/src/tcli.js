import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * tcli writes its actual diagnostic output (warnings, "file not found",
 * etc.) to stdout, not stderr — found by testing: `err.stderr` alone was
 * consistently empty on a real failure, silently dropping the useful part
 * and leaving only the generic "Command failed: <cmd>" message. Include
 * both, and say so plainly if genuinely neither has anything.
 */
function describeTcliFailure(err) {
  const parts = [err.stdout, err.stderr].map((s) => (s || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : err.message;
}

/** Pure: builds the `tcli build` argv. `versionNumber` is optional — when
 * given, it's embedded in the built zip's manifest.json and determines the
 * deterministic output filename (`{namespace}-{name}-{versionNumber}.zip`),
 * needed so callers can locate and stat the exact file that will later be
 * published. No auth, no network — purely local. */
export function buildTcliBuildArgs(configPath, versionNumber) {
  const args = ["build", "--config-path", configPath];
  if (versionNumber) args.push("--package-version", versionNumber);
  return args;
}

export async function buildPackage(
  { configPath, versionNumber, tcliPath = process.env.TCLI_PATH || "tcli" },
  { runExecFile = execFileAsync } = {}
) {
  try {
    await runExecFile(tcliPath, buildTcliBuildArgs(configPath, versionNumber));
  } catch (err) {
    throw new Error(`tcli build failed: ${describeTcliFailure(err)}`);
  }
}

/**
 * Pure: builds the `tcli publish` argv for publishing an already-built zip
 * (verified against tcli's source: providing `--file` skips its internal
 * build entirely and uploads exactly that file — `BuildCommand.DoBuild` is
 * never called). `--config-path` is still required even with `--file`: it
 * supplies the `[publish]` repository/communities/categories, none of which
 * are embedded in the zip itself. No `--package-version` here — irrelevant
 * once `--file` is used, since there's no build step to apply it to; the
 * zip's version is whatever `tcli build --package-version X` already baked
 * into its manifest.json. No `--token` — TCLI_AUTH_TOKEN is read from the
 * environment natively by tcli, so the token never appears in a process
 * argv listing (e.g. `ps`).
 */
export function buildTcliPublishArgs(configPath, filePath) {
  return ["publish", "--config-path", configPath, "--file", filePath];
}

export async function publishPackage(
  { configPath, filePath, tcliPath = process.env.TCLI_PATH || "tcli" },
  { runExecFile = execFileAsync } = {}
) {
  try {
    // No `env` override passed: execFile inherits process.env by default,
    // which is exactly what we want for TCLI_AUTH_TOKEN.
    await runExecFile(tcliPath, buildTcliPublishArgs(configPath, filePath));
  } catch (err) {
    throw new Error(`tcli publish failed: ${describeTcliFailure(err)}`);
  }
}
