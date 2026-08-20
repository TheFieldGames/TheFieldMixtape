import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloneRepo,
  addAndCommit,
  tagCommit,
  pushBranch,
  pushTag,
  getHeadSha,
  COMMIT_EMAIL,
} from "../src/git.js";

function recordingExecFile(calls) {
  return async (bin, args) => {
    calls.push([bin, args]);
    return { stdout: "", stderr: "" };
  };
}

test("cloneRepo builds a shallow single-branch clone command", async () => {
  const calls = [];
  await cloneRepo("https://x-access-token:tok@github.com/Org/Repo.git", "main", "/tmp/dest", {
    runExecFile: recordingExecFile(calls),
  });
  assert.deepEqual(calls, [
    ["git", ["clone", "--depth", "1", "--branch", "main", "https://x-access-token:tok@github.com/Org/Repo.git", "/tmp/dest"]],
  ]);
});

test("addAndCommit stages exactly the given files and commits with a per-commit identity override (no global git config mutation)", async () => {
  const calls = [];
  await addAndCommit(
    "/tmp/clone",
    ["README.md"],
    { authorName: "Alex", message: "Add track: Foo - Bar (submitted by Alex via contribute-app)" },
    { runExecFile: recordingExecFile(calls) }
  );

  assert.deepEqual(calls[0], ["git", ["-C", "/tmp/clone", "add", "README.md"]]);
  assert.deepEqual(calls[1], [
    "git",
    [
      "-C",
      "/tmp/clone",
      "-c",
      "user.name=Alex",
      "-c",
      `user.email=${COMMIT_EMAIL}`,
      "commit",
      "-m",
      "Add track: Foo - Bar (submitted by Alex via contribute-app)",
    ],
  ]);
});

test("addAndCommit never collects or fabricates a real email address for the submitter", async () => {
  const calls = [];
  await addAndCommit("/tmp/c", ["README.md"], { authorName: "Someone Weird <injection@attempt>", message: "msg" }, {
    runExecFile: recordingExecFile(calls),
  });
  const commitArgs = calls[1][1];
  const emailFlagIndex = commitArgs.indexOf("-c") + 1;
  // user.email is always the fixed placeholder regardless of what the submitter's name looks like
  assert.ok(commitArgs.some((a) => a === `user.email=${COMMIT_EMAIL}`));
});

test("tagCommit tags HEAD with the given name", async () => {
  const calls = [];
  await tagCommit("/tmp/clone", "v1.0.12", { runExecFile: recordingExecFile(calls) });
  assert.deepEqual(calls, [["git", ["-C", "/tmp/clone", "tag", "v1.0.12"]]]);
});

test("pushBranch and pushTag are separate calls (not combined via --follow-tags)", async () => {
  const calls = [];
  const exec = recordingExecFile(calls);
  await pushBranch("/tmp/clone", "main", { runExecFile: exec });
  await pushTag("/tmp/clone", "v1.0.12", { runExecFile: exec });
  assert.deepEqual(calls, [
    ["git", ["-C", "/tmp/clone", "push", "origin", "HEAD:main"]],
    ["git", ["-C", "/tmp/clone", "push", "origin", "v1.0.12"]],
  ]);
});

test("pushBranch/pushTag default to non-force (real submissions never force-push)", async () => {
  const calls = [];
  const exec = recordingExecFile(calls);
  await pushBranch("/tmp/clone", "main", { force: false, runExecFile: exec });
  await pushTag("/tmp/clone", "v1.0.12", { force: false, runExecFile: exec });
  assert.ok(!calls[0][1].includes("--force"));
  assert.ok(!calls[1][1].includes("--force"));
});

test("pushBranch/pushTag support force for the reused dry-run branch/tag", async () => {
  const calls = [];
  const exec = recordingExecFile(calls);
  await pushBranch("/tmp/clone", "contribute-app-dry-run", { force: true, runExecFile: exec });
  await pushTag("/tmp/clone", "dryrun-v1.0.12", { force: true, runExecFile: exec });
  assert.deepEqual(calls, [
    ["git", ["-C", "/tmp/clone", "push", "--force", "origin", "HEAD:contribute-app-dry-run"]],
    ["git", ["-C", "/tmp/clone", "push", "--force", "origin", "dryrun-v1.0.12"]],
  ]);
});

test("getHeadSha returns the trimmed commit SHA", async () => {
  const fakeExecFile = async () => ({ stdout: "abc123def456\n" });
  const sha = await getHeadSha("/tmp/clone", { runExecFile: fakeExecFile });
  assert.equal(sha, "abc123def456");
});
