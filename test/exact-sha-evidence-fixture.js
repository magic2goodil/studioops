export function exactShaEvidenceFixture(sourceSha, input = {}) {
  const artifactDigest = input.artifactDigest || `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: "studioops.exact-sha-validation.v1",
    sourceSha,
    manifestDigest: input.manifestDigest || `sha256:${"9".repeat(64)}`,
    changedPaths: input.changedPaths || ["src/store.js"],
    affectedComponents: input.affectedComponents || ["control-plane-core"],
    selectedComponents: input.selectedComponents || ["control-plane-core"],
    unknown: false,
    shared: false,
    fullRegression: false,
    fullRegressionReasons: [],
    commands: [{
      command: input.command || "npm run check",
      outcome: "passed",
      durationMs: 1,
      retries: 0,
      skips: [],
      artifactDigests: [artifactDigest],
    }],
    environmentContract: {
      id: "studioops.test.v1",
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    artifactDigests: [artifactDigest],
  };
}
