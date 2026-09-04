import { assertCandidateEnvelope } from "./candidate-manifest.js";
import { assertCanonicalCandidateRepositoryAuthority } from "./candidate-repository.js";
import {
  assertCurrentIsolatedTestAuthority,
  consumeIsolatedTestAuthority,
  isolatedTestAdapterRun,
  registerIsolatedTestAdapter,
} from "./test-authority-realm.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_DISCOVERY_PAGES = 100;
const MAX_GITHUB_RESPONSE_BYTES = 1024 * 1024;
const MAX_GITHUB_REQUEST_BODY_BYTES = 1024;
const MAX_GITHUB_REQUEST_TIMEOUT_MS = 60_000;
const trustedFetch = globalThis.fetch;
const remoteObservationBindings = new WeakMap();
const qaRevocationTestAuthority = consumeIsolatedTestAuthority((capability) => capability);

function requireQaRevocationTestAuthority() {
  if (!qaRevocationTestAuthority) {
    throw new Error("QA revocation test authority is unavailable.");
  }
  assertCurrentIsolatedTestAuthority(qaRevocationTestAuthority);
  return qaRevocationTestAuthority;
}

function observationBinding(candidate) {
  return {
    candidateId: candidate.id,
    projectId: candidate.projectId,
    manifestDigest: candidate.manifestDigest,
    integrationSha: candidate.manifest.integration.sha,
  };
}

function attestRemoteObservation(candidate, result, testAuthority = null) {
  if (!result || !["absent", "closed", "merged"].includes(result.status)) return result;
  if (testAuthority) assertCurrentIsolatedTestAuthority(testAuthority);
  remoteObservationBindings.set(result, {
    ...observationBinding(candidate),
    observation: JSON.stringify(result),
    testAuthority,
  });
  return Object.freeze(result);
}

export function assertQaRevocationRemoteObservation(candidate, observation) {
  const binding = remoteObservationBindings.get(observation);
  const expected = observationBinding(candidate);
  if (binding?.testAuthority) {
    assertCurrentIsolatedTestAuthority(binding.testAuthority);
  }
  if (
    !binding
    || binding.candidateId !== expected.candidateId
    || binding.projectId !== expected.projectId
    || binding.manifestDigest !== expected.manifestDigest
    || binding.integrationSha !== expected.integrationSha
    || binding.observation !== JSON.stringify(observation)
  ) {
    throw new Error("QA revocation settlement lacks an exact remote-observation attestation.");
  }
  return observation;
}

export function createQaRevocationTestObservation(candidate, observation) {
  return attestRemoteObservation(
    candidate,
    observation,
    requireQaRevocationTestAuthority(),
  );
}

export function createQaRevocationTestTransport(run) {
  const testAuthority = requireQaRevocationTestAuthority();
  if (typeof run !== "function") {
    throw new Error("QA revocation test transport requires a function.");
  }
  return registerIsolatedTestAdapter(
    testAuthority,
    "qa-revocation-transport",
    async (...args) => {
      assertCurrentIsolatedTestAuthority(testAuthority);
      const result = await run(...args);
      assertCurrentIsolatedTestAuthority(testAuthority);
      return result;
    },
  );
}

function testTransport(options = {}) {
  const transport = options.testTransport;
  if (!transport) return null;
  const run = isolatedTestAdapterRun(transport, "qa-revocation-transport");
  if (!run) throw new Error("QA revocation test transport was rejected outside its isolated capability.");
  return run;
}

function safeReason(value, token) {
  const text = String(value || "").slice(0, 1000);
  return token ? text.split(String(token)).join("[REDACTED_GITHUB_APP_TOKEN]") : text;
}

function pullRequestNumber(value, repository) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return 0;
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !match
    || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()
  ) return 0;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function safeRefSegment(value) {
  return String(value || "task").replace(/[^A-Za-z0-9._-]/g, "-");
}

function expectedPromotionIdentity(project, candidate) {
  assertCandidateEnvelope(candidate);
  const authority = assertCanonicalCandidateRepositoryAuthority(project);
  return {
    ...authority,
    baseBranch: String(project.defaultBranch || "main"),
    commitSha: candidate.manifest.integration.sha,
    marker: `<!-- studioops-candidate:${candidate.id}:${candidate.manifestDigest} -->`,
  };
}

function expectedPersistedPromotion(project, candidate) {
  const identity = expectedPromotionIdentity(project, candidate);
  const promotion = candidate.promotion;
  const number = pullRequestNumber(promotion?.prUrl, identity.repository);
  if (
    candidate.status !== "release_candidate_ready"
    || candidate.invalidation
    || !promotion
    || !number
    || promotion.branch !== String(promotion.branch || "").trim()
    || !promotion.branch
    || promotion.commitSha !== candidate.manifest.integration.sha
    || promotion.manifestDigest !== candidate.manifestDigest
  ) {
    throw new Error("QA approval revocation requires an exact release-candidate promotion handoff.");
  }
  return {
    ...identity,
    number,
    prUrl: promotion.prUrl,
    branch: promotion.branch,
  };
}

function expectedDiscoverablePromotion(project, candidate) {
  const identity = expectedPromotionIdentity(project, candidate);
  if (candidate.status !== "qa_passed" || candidate.invalidation || candidate.promotion) {
    throw new Error("QA approval revocation discovery requires an active QA-passed candidate without a persisted promotion handoff.");
  }
  const projectSegment = safeRefSegment(project.key || project.id || "project");
  const digestSegment = String(candidate.manifestDigest || "")
    .replace(/^sha256:/, "")
    .slice(0, 16);
  return {
    ...identity,
    branch: `qa/promotion-${projectSegment}-${digestSegment || "candidate"}`,
  };
}

function exactPullRequest(payload, expected) {
  const state = String(payload?.merged_at ? "merged" : payload?.state || "").toLowerCase();
  return Boolean(
    payload
    && Number(payload.number) === expected.number
    && payload.html_url === expected.prUrl
    && ["open", "closed", "merged"].includes(state)
    && payload.base?.ref === expected.baseBranch
    && String(payload.base?.repo?.full_name || "").toLowerCase() === expected.repository.toLowerCase()
    && payload.head?.ref === expected.branch
    && String(payload.head?.sha || "").toLowerCase() === expected.commitSha
    && String(payload.head?.repo?.full_name || "").toLowerCase() === expected.repository.toLowerCase()
    && String(payload.body || "").includes(expected.marker)
  );
}

function observedState(payload) {
  if (payload?.merged_at) return "merged";
  return String(payload?.state || "").toLowerCase();
}

function inspectedPullRequest(payload, expected) {
  const status = observedState(payload);
  return {
    status,
    prUrl: expected.prUrl,
    observedAt: new Date().toISOString(),
    mergeCommit: status === "merged" ? String(payload.merge_commit_sha || "").toLowerCase() : "",
    mergedAt: status === "merged" ? String(payload.merged_at || "") : "",
  };
}

function githubRequestDescriptor(pathname, options = {}) {
  const rawPathname = String(pathname || "");
  const method = String(options.method || "GET").toUpperCase();
  if (!rawPathname.startsWith("/") || rawPathname.startsWith("//")) {
    throw new Error("QA revocation GitHub request requires a relative API path.");
  }
  const url = new URL(rawPathname, GITHUB_API_BASE);
  if (
    url.origin !== GITHUB_API_BASE
    || url.protocol !== "https:"
    || url.hostname !== "api.github.com"
    || url.port
    || url.username
    || url.password
    || url.hash
    || rawPathname !== `${url.pathname}${url.search}`
  ) {
    throw new Error("QA revocation GitHub request escaped the exact GitHub API origin.");
  }

  const pullRequestRoute = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9][0-9]*$/;
  const discoveryRoute = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls$/;
  const isPullRequest = pullRequestRoute.test(url.pathname) && !url.search;
  const discoveryEntries = [...url.searchParams.entries()];
  const isDiscovery = discoveryRoute.test(url.pathname)
    && discoveryEntries.length === 5
    && url.searchParams.getAll("state").length === 1
    && url.searchParams.get("state") === "all"
    && url.searchParams.getAll("base").length === 1
    && Boolean(url.searchParams.get("base"))
    && url.searchParams.getAll("head").length === 1
    && Boolean(url.searchParams.get("head"))
    && url.searchParams.getAll("per_page").length === 1
    && url.searchParams.get("per_page") === "100"
    && url.searchParams.getAll("page").length === 1
    && /^[1-9][0-9]*$/.test(url.searchParams.get("page") || "")
    && Number(url.searchParams.get("page")) <= MAX_DISCOVERY_PAGES;

  let body;
  if (method === "GET" && (isPullRequest || isDiscovery) && options.body === undefined) {
    body = undefined;
  } else if (
    method === "PATCH"
    && isPullRequest
    && options.body
    && typeof options.body === "object"
    && !Array.isArray(options.body)
    && Object.keys(options.body).length === 1
    && options.body.state === "closed"
  ) {
    body = JSON.stringify(options.body);
  } else {
    throw new Error("QA revocation GitHub request method, route, or body was rejected.");
  }
  if (body && Buffer.byteLength(body, "utf8") > MAX_GITHUB_REQUEST_BODY_BYTES) {
    throw new Error("QA revocation GitHub request body exceeded its limit.");
  }
  return Object.freeze({ url, pathname: rawPathname, method, body });
}

function boundedRequestTimeout(value) {
  const requested = Number(value ?? MAX_GITHUB_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(requested)) return MAX_GITHUB_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_GITHUB_REQUEST_TIMEOUT_MS, Math.trunc(requested)));
}

async function boundedResponseText(response) {
  const declaredLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_RESPONSE_BYTES) {
    throw new Error("GitHub response body exceeded its limit.");
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_GITHUB_RESPONSE_BYTES) {
      throw new Error("GitHub response body exceeded its limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("GitHub response body exceeded its limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return `${text}${decoder.decode()}`;
}

async function githubRequest(pathname, options = {}) {
  let request;
  try {
    request = githubRequestDescriptor(pathname, options);
  } catch (error) {
    return { ok: false, status: 0, payload: null, reason: safeReason(error.message, options.githubToken) };
  }
  const execute = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedRequestTimeout(options.timeoutMs));
    try {
      if (typeof trustedFetch !== "function") {
        throw new Error("The trusted GitHub transport is unavailable.");
      }
      const response = await Reflect.apply(trustedFetch, globalThis, [request.url, {
        method: request.method,
        headers: {
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "studioops-owner-qa-revocation",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          Authorization: `Bearer ${options.githubToken}`,
        },
        body: request.body,
        signal: controller.signal,
        redirect: "error",
      }]);
      const text = await boundedResponseText(response);
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      return {
        ok: response.ok,
        status: response.status,
        payload,
        reason: response.ok ? "" : safeReason(payload?.message || text || `GitHub returned HTTP ${response.status}`, options.githubToken),
      };
    } catch (error) {
      return { ok: false, status: 0, payload: null, reason: safeReason(error.message || "GitHub request failed", options.githubToken) };
    } finally {
      clearTimeout(timeout);
    }
  };
  const run = testTransport(options);
  const result = run
    ? await run({ pathname: request.pathname, method: request.method, body: options.body, execute })
    : await execute();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, status: 0, payload: null, reason: "QA revocation transport returned an invalid result." };
  }
  return {
    ok: result.ok === true,
    status: Number(result.status || 0),
    payload: result.payload ?? null,
    reason: safeReason(result.reason || "", options.githubToken),
  };
}

async function inspect(expected, options) {
  const [owner, repository] = expected.repository.split("/");
  const response = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${expected.number}`,
    options,
  );
  if (!response.ok) return { status: "unavailable", reason: response.reason };
  if (!exactPullRequest(response.payload, expected)) {
    return { status: "invalid", reason: "The release pull request no longer matches the immutable candidate identity." };
  }
  return inspectedPullRequest(response.payload, expected);
}

async function discoverPromotionPullRequest(expected, options) {
  const [owner, repository] = expected.repository.split("/");
  const pulls = [];
  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += 1) {
    const query = new URLSearchParams({
      state: "all",
      base: expected.baseBranch,
      head: `${owner}:${expected.branch}`,
      per_page: "100",
      page: String(page),
    });
    const response = await githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?${query}`,
      options,
    );
    if (!response.ok) return { status: "unavailable", reason: response.reason };
    if (!Array.isArray(response.payload)) {
      return { status: "invalid", reason: "GitHub returned an invalid promotion pull-request discovery response." };
    }
    pulls.push(...response.payload);
    if (response.payload.length < 100) break;
    if (page === MAX_DISCOVERY_PAGES) {
      return { status: "unavailable", reason: "Promotion pull-request discovery exceeded its authoritative page limit." };
    }
  }

  if (pulls.length === 0) {
    return { status: "absent", observedAt: new Date().toISOString() };
  }
  if (pulls.length !== 1) {
    return { status: "invalid", reason: "Promotion pull-request discovery was ambiguous for the immutable candidate branch." };
  }

  const payload = pulls[0];
  const number = Number(payload?.number);
  const prUrl = String(payload?.html_url || "");
  const discovered = {
    ...expected,
    number,
    prUrl,
  };
  if (
    !Number.isSafeInteger(number)
    || number <= 0
    || pullRequestNumber(prUrl, expected.repository) !== number
    || !exactPullRequest(payload, discovered)
  ) {
    return { status: "invalid", reason: "The discovered promotion pull request does not match the immutable candidate identity." };
  }
  return { status: "exact", expected: discovered };
}

export async function settleReleaseCandidatePullRequestForRevocation(project, candidate, options = {}) {
  if (!String(options.githubToken || "")) {
    throw new Error("Release-candidate QA revocation requires repository-scoped GitHub authentication.");
  }
  const observationTestAuthority = options.testTransport
    ? (testTransport(options), requireQaRevocationTestAuthority())
    : null;
  let expected;
  if (candidate.status === "release_candidate_ready") {
    expected = expectedPersistedPromotion(project, candidate);
  } else {
    const discovery = await discoverPromotionPullRequest(expectedDiscoverablePromotion(project, candidate), options);
    if (discovery.status !== "exact") {
      return attestRemoteObservation(candidate, discovery, observationTestAuthority);
    }
    expected = discovery.expected;
  }
  const first = await inspect(expected, options);
  if (first.status !== "open") {
    return attestRemoteObservation(candidate, first, observationTestAuthority);
  }

  const [owner, repository] = expected.repository.split("/");
  const closed = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${expected.number}`,
    { ...options, method: "PATCH", body: { state: "closed" } },
  );
  const final = await inspect(expected, options);
  if (final.status === "closed" || final.status === "merged") {
    return attestRemoteObservation(candidate, final, observationTestAuthority);
  }
  return {
    status: "unavailable",
    reason: final.reason || closed.reason || "The exact release pull request could not be authoritatively closed and verified.",
  };
}
