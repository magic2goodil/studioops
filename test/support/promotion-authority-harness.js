import {
  registerPromotionRemoteObservationTestHarness,
} from "../../src/promotion-remote-observation.js";
import { registerPromotionAncestryTestHarness } from "../../src/promotion-ancestry-observation.js";
import {
  consumeIsolatedTestAuthority,
  registerIsolatedTestAdapter,
} from "../../src/test-authority-realm.js";

const registered = consumeIsolatedTestAuthority((capability) => ({
  capability,
  remote: registerPromotionRemoteObservationTestHarness(capability),
  ancestry: registerPromotionAncestryTestHarness(capability),
}));

if (!registered) {
  throw new Error("Promotion authority test harness requires a verified hermetic test root at process startup.");
}

export const createPromotionRemoteTestObservation =
  registered.remote.createPromotionRemoteTestObservation;
export const createMergedPromotionRecoveryTestObservation =
  registered.remote.createMergedPromotionRecoveryTestObservation;
export const createPromotionMergeAncestryTestObservation =
  registered.ancestry.createPromotionMergeAncestryTestObservation;

export function createPromotionTestGitHubApi(run) {
  return registerIsolatedTestAdapter(registered.capability, "promotion-github-api", run);
}

export function createPromotionTestGitRunner(run) {
  return registerIsolatedTestAdapter(registered.capability, "promotion-git", run);
}
