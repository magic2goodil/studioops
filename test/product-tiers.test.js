import test from "node:test";
import assert from "node:assert/strict";
import { localProductAccess, productCatalog } from "../src/product-tiers.js";

test("community includes the complete local engineering loop", () => {
  const access = localProductAccess();
  assert.equal(access.planId, "community");
  assert.equal(access.connectedToCloud, false);
  assert.ok(access.features.includes("structured-intake"));
  assert.ok(access.features.includes("builder-and-reviewer-workflows"));
  assert.ok(access.features.includes("human-release-gate"));
});

test("paid tiers extend rather than remove community capabilities", () => {
  const catalog = productCatalog();
  const community = catalog.find((tier) => tier.id === "community");
  for (const tier of catalog.filter((item) => item.id !== "community")) {
    for (const feature of community.features) assert.ok(tier.features.includes(feature));
  }
});
