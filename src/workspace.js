import { chmod, lstat, mkdir, stat } from "node:fs/promises";
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
  const expectedRef = localCandidateRef(identity);
  const ref = String(identity.operationalLocalArtifactRef || expectedRef);
  if (!expectedRef || ref !== expectedRef || ref.includes("..") || path.isAbsolute(ref)) return "";
  return path.join(resolveWorkspaceRoot(root), ref);
}

async function assertManagedPath(root, artifactRef, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(root);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  let current = workspaceRoot;
  for (const segment of path.dirname(artifactRef).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw failure("local_candidate_path_unsafe", `The managed local candidate path is not a safe directory: ${artifactRef}`, "Remove the conflicting path only after confirming no active run or current candidate references it, then retry.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!options.create) throw failure("local_candidate_artifact_missing", `The managed local candidate artifact is missing: ${artifactRef}`, "Run the local builder again to rematerialize the candidate; review and candidate cycles were not changed.");
      await mkdir(current, { mode: 0o700 });
    }
    await chmod(current, 0o700);
  }
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
  if (!String(identity.branch || "").trim() || !Number.isSafeInteger(Number(identity.candidateCycle)) || Number(identity.candidateCycle) < 1) {
    throw failure("local_candidate_identity_invalid", "The local candidate identity is missing its recorded branch or candidate cycle.", "Repair the task candidate identity and rematerialize the candidate before retrying.");
  }
  const artifactRef = identity.operationalLocalArtifactRef || localCandidateRef(identity);
  await assertManagedPath(root, artifactRef);
  try {
    const artifactStat = await lstat(candidatePath);
    if (artifactStat.isSymbolicLink() || !artifactStat.isDirectory()) throw new Error("unsafe artifact");
    await git(["rev-parse", "--git-dir"], { cwd: candidatePath });
  } catch {
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
  await assertManagedPath(root, artifactRef, { create: true });
  let artifactExists = false;
  try {
    const existing = await stat(artifactPath);
    artifactExists = true;
    if (!existing.isDirectory()) throw failure("local_candidate_artifact_conflict", `The managed local candidate path is not a Git artifact: ${artifactRef}`, "Move the conflicting artifact aside after confirming no active run references it, then retry.");
    const current = await verifyLocalCandidate(root, { ...candidateIdentity, operationalLocalArtifactRef: artifactRef });
    log?.write(`Local candidate already materialized: ${artifactRef} (${current.commitSha}, tree ${current.treeSha})\n`);
    return { ...candidateIdentity, operationalLocalArtifactRef: artifactRef };
  } catch (error) {
    if (error?.code && error.code !== "ENOENT" && (error.code !== "local_candidate_artifact_missing" || artifactExists)) {
      if (artifactExists && error.code === "local_candidate_artifact_missing") {
        throw failure("local_candidate_artifact_conflict", `The managed local candidate artifact is stale or malformed: ${artifactRef}`, "Move the conflicting artifact aside after confirming no active run references it, then retry.");
      }
      throw error;
    }
  }
  await git(["clone", "--bare", "--no-hardlinks", workspacePath, artifactPath], { cwd: process.cwd(), timeout: 300_000, env: localGitEnv() });
  try { await git(["remote", "remove", "origin"], { cwd: artifactPath, env: localGitEnv() }); } catch {}
  await chmod(artifactPath, 0o700);
  await verifyLocalCandidate(root, { ...candidateIdentity, operationalLocalArtifactRef: artifactRef });
  log?.write(`Local candidate materialized: ${artifactRef} (${commitSha}, tree ${treeSha})\n`);
  return { ...candidateIdentity, operationalLocalArtifactRef: artifactRef };
}

export async function configureRemotes(workspacePath, originUrl, candidatePath = "") {
  const env = localGitEnv();
  const inertOriginUrl = sanitizeOriginUrl(originUrl);
  try { await git(["remote", "remove", "origin"], { cwd: workspacePath, env }); } catch {}
  if (inertOriginUrl) await git(["remote", "add", "origin", inertOriginUrl], { cwd: workspacePath, env });
  if (candidatePath) await git(["remote", "add", "local-candidate", candidatePath], { cwd: workspacePath, env });
}

export function sanitizeOriginUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) && !parsed.password) return raw;
    if (["http:", "https:"].includes(parsed.protocol)) parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

export async function prepareLocalWorkspace({ sourceRepoPath, workspacePath, branch, originUrl, root, identity, useCandidate, log }) {
  const env = localGitEnv();
  if (useCandidate && String(identity?.branch || "") !== String(branch || "")) {
    throw failure("local_candidate_identity_mismatch", "The requested workspace branch differs from the recorded candidate branch.", "Restore the task branch and candidate identity together before retrying review.");
  }
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
