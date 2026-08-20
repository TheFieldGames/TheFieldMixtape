import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * Pure: builds the ffmpeg argv for mp3(or whatever)->ogg conversion.
 * Matches convert files/convert.bat's `-q:a 5` encoder setting exactly,
 * plus `-n` (never overwrite) as cheap defense-in-depth even though the
 * destination is always a fresh temp path.
 */
export function buildFfmpegArgs(inputPath, outputPath) {
  return ["-i", inputPath, "-q:a", "5", "-n", outputPath];
}

/**
 * I/O wrapper: runs the real ffmpeg binary via execFile (argv array, no shell).
 *
 * Verified directly (not assumed): ffmpeg's `-n` flag exits with code 0 even
 * when it refuses to overwrite an existing output file — it just logs
 * "already exists" to stderr and leaves the (possibly stale, non-empty)
 * existing file untouched. That means neither the exit code nor an
 * after-the-fact "is the output non-empty" check can reliably detect a
 * silent no-op — a stale file from a prior run would pass both. Since the
 * caller always converts into a freshly-generated unique temp path, an
 * output path that already exists is itself the bug: fail immediately,
 * before ever invoking ffmpeg, rather than trusting its exit code.
 */
export async function convertToOgg(
  inputPath,
  outputPath,
  { ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", runExecFile = execFileAsync, statFile = fsp.stat } = {}
) {
  const alreadyExists = await statFile(outputPath).then(
    () => true,
    () => false
  );
  if (alreadyExists) {
    throw new Error(`ffmpeg conversion failed: output path ${outputPath} already exists (refusing to convert into it)`);
  }

  try {
    await runExecFile(ffmpegPath, buildFfmpegArgs(inputPath, outputPath));
  } catch (err) {
    throw new Error(`ffmpeg conversion failed: ${err.stderr || err.message}`);
  }

  let stat;
  try {
    stat = await statFile(outputPath);
  } catch {
    throw new Error(`ffmpeg conversion failed: no output file was produced at ${outputPath}`);
  }
  if (stat.size === 0) {
    throw new Error(`ffmpeg conversion failed: output file at ${outputPath} is empty`);
  }
}
