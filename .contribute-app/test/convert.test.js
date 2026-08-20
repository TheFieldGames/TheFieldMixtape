import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFfmpegArgs, convertToOgg } from "../src/convert.js";

function enoent() {
  const err = new Error("ENOENT");
  err.code = "ENOENT";
  return err;
}

/** Simulates fs.stat: `sequence` holds one entry per call (a size number, or
 * an Error to throw), consumed in order. Used because convertToOgg calls
 * statFile twice — once as a pre-check (should reject: doesn't exist yet),
 * once as a post-check (should resolve: ffmpeg wrote a real file). */
function scriptedStatFile(sequence) {
  let i = 0;
  return async () => {
    const item = sequence[i++];
    if (item instanceof Error) throw item;
    return { size: item };
  };
}

test("buildFfmpegArgs matches convert files/convert.bat's encoder settings (-q:a 5) plus -n for safety", () => {
  const args = buildFfmpegArgs("/tmp/input.mp3", "/tmp/output.ogg");
  assert.deepEqual(args, ["-i", "/tmp/input.mp3", "-q:a", "5", "-n", "/tmp/output.ogg"]);
});

test("convertToOgg invokes the ffmpeg binary via execFile with an argv array (never a shell string)", async () => {
  let calledWith = null;
  const fakeExecFile = async (bin, args) => {
    calledWith = { bin, args };
    return { stdout: "", stderr: "" };
  };

  await convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
    ffmpegPath: "/usr/local/bin/ffmpeg",
    runExecFile: fakeExecFile,
    statFile: scriptedStatFile([enoent(), 1024]),
  });

  assert.equal(calledWith.bin, "/usr/local/bin/ffmpeg");
  assert.deepEqual(calledWith.args, ["-i", "/tmp/in.mp3", "-q:a", "5", "-n", "/tmp/out.ogg"]);
});

test("convertToOgg rejects immediately if the output path already exists, without ever calling ffmpeg", async () => {
  let ffmpegCalled = false;
  const fakeExecFile = async () => {
    ffmpegCalled = true;
    return {};
  };

  await assert.rejects(
    convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([2048]), // pre-check: stat succeeds -> already exists
    }),
    /already exists/
  );
  assert.equal(ffmpegCalled, false);
});

test("convertToOgg wraps a failing ffmpeg invocation in a clear error including stderr", async () => {
  const fakeExecFile = async () => {
    const err = new Error("Command failed");
    err.stderr = "Unknown encoder 'libvorbis'";
    throw err;
  };

  await assert.rejects(
    convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([enoent()]),
    }),
    /ffmpeg conversion failed.*libvorbis/s
  );
});

test("convertToOgg defaults ffmpegPath to env FFMPEG_PATH or 'ffmpeg'", async () => {
  let usedBin = null;
  const fakeExecFile = async (bin) => {
    usedBin = bin;
    return {};
  };
  const prev = process.env.FFMPEG_PATH;
  delete process.env.FFMPEG_PATH;
  try {
    await convertToOgg("/tmp/a", "/tmp/b", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([enoent(), 1024]),
    });
    assert.equal(usedBin, "ffmpeg");
  } finally {
    if (prev !== undefined) process.env.FFMPEG_PATH = prev;
  }
});

// Regression coverage for a real bug found via integration testing:
// ffmpeg's `-n` flag exits 0 (success) even when it silently refuses to
// overwrite/produce the output file, so neither the exit code nor a naive
// "does the file exist now" check afterward is sufficient on its own.
test("convertToOgg throws if ffmpeg exits 0 but produced no output file at all", async () => {
  const fakeExecFile = async () => ({ stdout: "", stderr: "File already exists. Exiting." });

  await assert.rejects(
    convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([enoent(), enoent()]),
    }),
    /no output file was produced/
  );
});

test("convertToOgg throws if the output file exists after conversion but is empty", async () => {
  const fakeExecFile = async () => ({ stdout: "", stderr: "" });

  await assert.rejects(
    convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([enoent(), 0]),
    }),
    /output file at \/tmp\/out\.ogg is empty/
  );
});

test("convertToOgg succeeds when the output path is initially free and ffmpeg produces a non-empty file", async () => {
  const fakeExecFile = async () => ({ stdout: "", stderr: "" });
  await assert.doesNotReject(
    convertToOgg("/tmp/in.mp3", "/tmp/out.ogg", {
      runExecFile: fakeExecFile,
      statFile: scriptedStatFile([enoent(), 4096]),
    })
  );
});
