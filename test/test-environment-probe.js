import { DATABASE_FILE, ensureStateDatabase } from "../src/state-database.js";
import {
  missionControlConfigRoot,
  missionControlDataDir,
  missionControlRoot,
} from "../src/runtime-paths.js";

await ensureStateDatabase();
console.log(JSON.stringify({
  testRoot: process.env.STUDIOOPS_TEST_ROOT,
  controlRoot: missionControlRoot(),
  dataDir: missionControlDataDir(),
  configRoot: missionControlConfigRoot(),
  databaseFile: DATABASE_FILE,
  inheritedCredentialKeys: [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "MISSION_CONTROL_GITHUB_TOKEN",
    "STUDIOOPS_GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ].filter((key) => process.env[key]),
}));
