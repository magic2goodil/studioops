const COMMUNITY_FEATURES = Object.freeze([
  "local-project-board",
  "structured-intake",
  "project-standards",
  "builder-and-reviewer-workflows",
  "local-qa-gates",
  "human-release-gate",
  "codex-plugin",
]);

const PRO_FEATURES = Object.freeze([
  ...COMMUNITY_FEATURES,
  "hosted-sync",
  "private-standards-packs",
  "cross-project-insights",
  "managed-automation",
  "priority-updates",
]);

const TEAM_FEATURES = Object.freeze([
  ...PRO_FEATURES,
  "shared-workspaces",
  "role-based-access",
  "policy-enforcement",
  "audit-history",
  "team-analytics",
]);

export const PRODUCT_TIERS = Object.freeze([
  Object.freeze({
    id: "community",
    name: "Community",
    audience: "Individual developers and open-source projects",
    delivery: "Local-first, self-hosted",
    features: COMMUNITY_FEATURES,
  }),
  Object.freeze({
    id: "pro",
    name: "Pro",
    audience: "Professional developers running multiple products",
    delivery: "Community core plus StudioOps Cloud",
    features: PRO_FEATURES,
  }),
  Object.freeze({
    id: "team",
    name: "Team",
    audience: "Engineering teams that need shared governance",
    delivery: "StudioOps Cloud workspace",
    features: TEAM_FEATURES,
  }),
]);

export function productCatalog() {
  return PRODUCT_TIERS.map((tier) => ({ ...tier, features: [...tier.features] }));
}

export function localProductAccess() {
  return {
    planId: "community",
    planName: "Community",
    source: "local-open-core",
    connectedToCloud: false,
    features: [...COMMUNITY_FEATURES],
    premiumBoundary: "studioops-cloud",
  };
}
