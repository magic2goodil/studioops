import assert from "node:assert/strict";
import test from "node:test";

import { launchAgentPath } from "../src/launch-agent-environment.js";

test("LaunchAgents receive a deterministic PATH for Node, Homebrew gh, and system tools", () => {
  assert.equal(
    launchAgentPath("/custom/node/bin/node"),
    "/custom/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
});

test("LaunchAgent PATH entries remain unique when Node is installed by Homebrew", () => {
  assert.equal(
    launchAgentPath("/opt/homebrew/bin/node"),
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
});
