import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTcliBuildArgs, buildPackage, buildTcliPublishArgs, publishPackage } from "../src/tcli.js";

// --- build ---

test("buildTcliBuildArgs is local-only (no --token, no --file) and omits --package-version when not given", () => {
  const args = buildTcliBuildArgs("/tmp/clone/thunderstore.toml");
  assert.deepEqual(args, ["build", "--config-path", "/tmp/clone/thunderstore.toml"]);
});

test("buildTcliBuildArgs includes --package-version when given, so the built zip's manifest and filename are correctly versioned", () => {
  const args = buildTcliBuildArgs("/tmp/clone/thunderstore.toml", "1.0.13");
  assert.deepEqual(args, ["build", "--config-path", "/tmp/clone/thunderstore.toml", "--package-version", "1.0.13"]);
});

test("buildPackage calls the configured tcli binary with the built args", async () => {
  let calledWith = null;
  const fakeExecFile = async (bin, args) => {
    calledWith = { bin, args };
    return { stdout: "", stderr: "" };
  };

  await buildPackage(
    { configPath: "/tmp/c/thunderstore.toml", versionNumber: "1.0.13", tcliPath: "/usr/local/bin/tcli" },
    { runExecFile: fakeExecFile }
  );

  assert.equal(calledWith.bin, "/usr/local/bin/tcli");
  assert.deepEqual(calledWith.args, [
    "build",
    "--config-path",
    "/tmp/c/thunderstore.toml",
    "--package-version",
    "1.0.13",
  ]);
});

test("buildPackage surfaces tcli's stderr in a clear wrapped error", async () => {
  const fakeExecFile = async () => {
    const err = new Error("exit code 1");
    err.stderr = "Icon not found";
    throw err;
  };

  await assert.rejects(
    buildPackage({ configPath: "/tmp/c/thunderstore.toml" }, { runExecFile: fakeExecFile }),
    /tcli build failed.*Icon not found/s
  );
});

// Regression: found via real testing that tcli writes its actual diagnostic
// output (warnings, "file not found", etc.) to STDOUT, not stderr — the
// original `err.stderr || err.message` fallback silently dropped it,
// leaving only the useless generic "Command failed: tcli build ..." message
// on a real failure.
test("buildPackage surfaces tcli's stdout when stderr is empty (tcli's real failure-output channel)", async () => {
  const fakeExecFile = async () => {
    const err = new Error("Command failed: tcli build --config-path /tmp/x/thunderstore.toml");
    err.stdout = "WARNING: Nothing found at ./my mixtape, looked from /tmp/x/./my mixtape\nBuild failed.";
    err.stderr = "";
    throw err;
  };

  await assert.rejects(
    buildPackage({ configPath: "/tmp/x/thunderstore.toml" }, { runExecFile: fakeExecFile }),
    /tcli build failed.*Nothing found at .\/my mixtape/s
  );
});

test("build: falls back to err.message only when stdout AND stderr are both genuinely empty", async () => {
  const fakeExecFile = async () => {
    const err = new Error("spawn tcli ENOENT");
    err.stdout = "";
    err.stderr = "";
    throw err;
  };

  await assert.rejects(
    buildPackage({ configPath: "/tmp/x" }, { runExecFile: fakeExecFile }),
    /tcli build failed: spawn tcli ENOENT/
  );
});

test("buildPackage defaults tcliPath to env TCLI_PATH or 'tcli'", async () => {
  let usedBin = null;
  const fakeExecFile = async (bin) => {
    usedBin = bin;
    return {};
  };
  const prev = process.env.TCLI_PATH;
  delete process.env.TCLI_PATH;
  try {
    await buildPackage({ configPath: "/tmp/x" }, { runExecFile: fakeExecFile });
    assert.equal(usedBin, "tcli");
  } finally {
    if (prev !== undefined) process.env.TCLI_PATH = prev;
  }
});

// --- publish ---

test("buildTcliPublishArgs uses --file (verified: skips tcli's internal build entirely), never --token or --package-version", () => {
  const args = buildTcliPublishArgs("/tmp/clone/thunderstore.toml", "/tmp/clone/build/TheField-TheFieldMixtape-1.0.13.zip");
  assert.deepEqual(args, [
    "publish",
    "--config-path",
    "/tmp/clone/thunderstore.toml",
    "--file",
    "/tmp/clone/build/TheField-TheFieldMixtape-1.0.13.zip",
  ]);
  assert.ok(!args.includes("--token"));
  assert.ok(!args.includes("--package-version"));
});

test("publishPackage calls the configured tcli binary with the built args", async () => {
  let calledWith = null;
  const fakeExecFile = async (bin, args) => {
    calledWith = { bin, args };
    return { stdout: "", stderr: "" };
  };

  await publishPackage(
    {
      configPath: "/tmp/c/thunderstore.toml",
      filePath: "/tmp/c/build/pkg.zip",
      tcliPath: "/usr/local/bin/tcli",
    },
    { runExecFile: fakeExecFile }
  );

  assert.equal(calledWith.bin, "/usr/local/bin/tcli");
  assert.deepEqual(calledWith.args, ["publish", "--config-path", "/tmp/c/thunderstore.toml", "--file", "/tmp/c/build/pkg.zip"]);
});

test("publishPackage surfaces tcli's stdout/stderr in a clear wrapped error", async () => {
  const fakeExecFile = async () => {
    const err = new Error("exit code 1");
    err.stdout = "Building...\nSome warning";
    err.stderr = "Fatal: upload rejected";
    throw err;
  };

  await assert.rejects(
    publishPackage({ configPath: "/tmp/x", filePath: "/tmp/x/build/pkg.zip" }, { runExecFile: fakeExecFile }),
    /Some warning[\s\S]*Fatal: upload rejected/
  );
});

test("publishPackage defaults tcliPath to env TCLI_PATH or 'tcli'", async () => {
  let usedBin = null;
  const fakeExecFile = async (bin) => {
    usedBin = bin;
    return {};
  };
  const prev = process.env.TCLI_PATH;
  delete process.env.TCLI_PATH;
  try {
    await publishPackage({ configPath: "/tmp/x", filePath: "/tmp/x/build/pkg.zip" }, { runExecFile: fakeExecFile });
    assert.equal(usedBin, "tcli");
  } finally {
    if (prev !== undefined) process.env.TCLI_PATH = prev;
  }
});
