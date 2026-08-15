import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40,64}$/i;

function expand(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

export function resolveWorkspaceRoot(value) {
  return path.resolve(expand(value || path.join(os.homedir(), ".codex", "studioops", "run-workspaces")));
}

function safeSegment(value, fallback = "candidate") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || fallback;
}

export function localCandidateRef(identity = {}) {
  const cycle = Number(identity.candidateCycle || 0);
  const sha = String(identity.commitSha || "").toLowerCase();
  if (!Number.isSafeInteger(cycle) || cycle < 1 || !FULL_SHA.test(sha)) return "";
  return `candidates/${safeSegment(identity.taskId || identity.task || "task")}/${cycle}-${sha}.git`;
}

export function localCandidatePath(root, identity = {}) {
  const ref = String(identity.operationalLocalArtifactRef || localCandidateRef(identity));
  if (!ref || ref.includes("..") || path.isAbsolute(ref)) return "";
  return path.join(resolveWorkspaceRoot(root), ref);
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    env: options.env || process.env,
    timeout: options.timeout || 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function gitOutput(args, options = {}) {
  try { return await git(args, options); } catch { return ""; }
}

export function localGitEnv(base = process.env) {
  const env = { ...base };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "MISSION_CONTROL_GITHUB_TOKEN", "MISSION_CONTROL_GITHUB_APP_AUTH", "MISSION_CONTROL_GITHUB_APP_ROLE", "MISSION_CONTROL_GITHUB_APP_SLUG", "MISSION_CONTROL_GITHUB_REPOSITORY", "MISSION_CONTROL_GIT_USERNAME", "GIT_ASKPASS", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function failure(code, message, remediation) {
  const error = new Error(message);
  error.code = code;
  error.remediation = remediation;
  return error;
}

export async function verifyLocalCandidate(root, identity, options = {}) {
  const candidatePath = localCandidatePath(root, identity);
  if (!candidatePath) throw failure("local_candidate_identity_invalid", "The local candidate identity is incomplete or has an unsafe artifact reference.", "Repair the task candidate identity and rematerialize the candidate before retrying.");
  try { await git(["rev-parse", "--git-dir"], { cwd: candidatePath }); } catch {
    throw failure("local_candidate_artifact_missing", `The managed local candidate artifact is missing: ${identity.operationalLocalArtifactRef || localCandidateRef(identity)}`, "Run the local builder again to rematerialize the candidate; review and candidate cycles were not changed.");
  }
  for (const [key, value, type] of [["commitSha", identity.commitSha, "commit"], ["treeSha", identity.treeSha, "tree"], ["baseSha", identity.baseSha, "commit"]]) {
    if (!FULL_SHA.test(String(value || ""))) throw failure("local_candidate_object_missing", `The local candidate identity is missing a valid ${key}.`, "Repair the candidate identity by rerunning the successful local builder handoff.");
    try { await git(["cat-file", "-e", `${value}^{${type}}`], { cwd: candidatePath }); } catch { throw failure("local_candidate_object_missing", `The managed local candidate is missing object ${value}.`, "Rematerialize the local candidate artifact before retrying review."); }
  }
  const commit = await gitOutput(["rev-parse", "--verify", `${identity.commitSha}^{commit}`], { cwd: candidatePath });
  const tree = await gitOutput(["rev-parse", "--verify", `${identity.commitSha}^{tree}`], { cwd: candidatePath });
  const parent = await gitOutput(["rev-parse", "--verify", `${identity.commitSha}^1`], { cwd: candidatePath });
  if (commit !== identity.commitSha || tree !== identity.treeSha || parent !== identity.baseSha) {
    throw failure("local_candidate_tree_mismatch", "The managed local candidate commit, tree, or base does not match the recorded candidate identity.", "Discard the stale artifact only after active runs are clear, then rerun the builder to create a fresh exact candidate.");
  }
  return { candidatePath, commitSha: commit, treeSha: tree, baseSha: parent };
}

export async function materializeLocalCandidate({ workspacePath, root, identity, branch, taskId, log }) {
  const commitSha = await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: workspacePath });
  const treeSha = await git(["rev-parse", "--verify", "HEAD^{tree}"], { cwd: workspacePath });
  const baseSha = await git(["rev-parse", "--verify", "HEAD^1"], { cwd: workspacePath });
  const candidateCycle = Math.max(1, Number(identity?.candidateCycle || 0));
  const candidateIdentity = { commitSha, treeSha, baseSha, branch: branch || "", candidateCycle, taskId };
  const artifactRef = localCandidateRef(candidateIdentity);
  const artifactPath = localCandidatePath(root, { ...candidateIdentity, operationalLocalArtifactRef: artifactRef });
  await mkdir(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
  await rm(artifactPath, { recursive: true, force: true });
  await git(["clone", "--bare", "--no-hardlinks", workspacePath, artifactPath], { cwd: process.cwd(), timeout: 300_000, env: localGitEnv() });
  try { await git(["remote", "remove", "origin"], { cwd: artifactPath, env: localGitEnv() }); } catch {}
  await chmod(artifactPath, 0o700);
  await verifyLocalCandidate(root, { ...candidateIdentity, operationalLocalArtifactRef: artifactRef });
  log?.write(`Local candidate materialized: ${artifactRef} (${commitSha}, tree ${treeSha})\n`);
  return { ...candidateIdentity, operationalLocalArtifactRef: artifactRef };
}

export async function configureRemotes(workspacePath, originUrl, candidatePath = "") {
  try { await git(["remote", "remove", "origin"], { cwd: workspacePath }); } catch {}
  if (originUrl) await git(["remote", "add", "origin", originUrl], { cwd: workspacePath });
  if (candidatePath) await git(["remote", "add", "local-candidate", candidatePath], { cwd: workspacePath });
}

export async function prepareLocalWorkspace({ sourceRepoPath, workspacePath, branch, originUrl, root, identity, useCandidate, log }) {
  const env = localGitEnv();
  const candidatePath = useCandidate ? (await verifyLocalCandidate(root, identity)).candidatePath : "";
  await git(["clone", "--no-tags", "--no-hardlinks", candidatePath || sourceRepoPath, workspacePath], { cwd: process.cwd(), timeout: 300_000, env });
  const startSha = candidatePath ? identity.commitSha : await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: workspacePath });
  await git(["checkout", "-B", branch, startSha], { cwd: workspacePath, env });
  await configureRemotes(workspacePath, originUrl, candidatePath);
  if (candidatePath) {
    const actualTree = await git(["rev-parse", "--verify", "HEAD^{tree}"], { cwd: workspacePath });
    if (actualTree !== identity.treeSha) throw failure("local_candidate_tree_mismatch", "The isolated workspace tree differs from the recorded candidate tree.", "Repair or rematerialize the candidate before retrying review.");
  }
  log?.write(`Workspace strategy: isolated local candidate clone${candidatePath ? "" : " from local source"}\n`);
  return { candidatePath, startSha };
}
