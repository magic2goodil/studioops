import { ownershipManifestDigest } from "../src/impact-manifest.js";

export const exactShaOwnershipManifestFixture = {
  schemaVersion: "studioops.component-ownership.v1",
  fullRegressionCommands: ["npm run check"],
  environmentContract: { id: "studioops.test.v1" },
  components: {
    "control-plane-core": {
      owner: "StudioOps test maintainers",
      classification: "bounded",
      paths: ["src/store.js"],
      entryAdapters: [],
      workflowReleaseSurfaces: [],
      ownedTests: [],
      publicContracts: ["test store contract"],
      ownedData: ["test state"],
      allowedDependencies: [],
      impactEdges: [],
      rollbackBoundary: "Test fixtures are replaced atomically.",
      testLayers: ["unit"],
      validationCommands: ["npm run check"],
    },
  },
};

export function exactShaEvidenceFixture(sourceSha, input = {}) {
  const artifactDigest = input.artifactDigest || `sha256:${"a".repeat(64)}`;
  const ownershipManifest = input.ownershipManifest || exactShaOwnershipManifestFixture;
  return {
    schemaVersion: "studioops.exact-sha-validation.v1",
    sourceSha,
    manifestDigest: input.manifestDigest || ownershipManifestDigest(ownershipManifest),
    ownershipManifest,
    changedPaths: input.changedPaths || ["src/store.js"],
    affectedComponents: input.affectedComponents || ["control-plane-core"],
    selectedComponents: input.selectedComponents || ["control-plane-core"],
    unknown: false,
    shared: false,
    ambiguous: false,
    multiComponent: false,
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
