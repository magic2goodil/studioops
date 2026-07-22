import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const TABLES = {
  projects: "projects",
  tasks: "tasks",
  comments: "comments",
  reviews: "reviews",
  events: "events",
  runs: "runs",
  qaBundles: "qa_bundles",
};

export function readPersistedState(root) {
  const db = new DatabaseSync(path.join(root, "data", "mission-control.sqlite3"), { readOnly: true });
  try {
    const meta = db.prepare("SELECT payload FROM state_meta WHERE singleton_id = 1").get();
    const state = { meta: JSON.parse(meta.payload) };
    for (const [key, table] of Object.entries(TABLES)) {
      state[key] = db.prepare(`SELECT payload FROM ${table} ORDER BY sequence ASC`)
        .all()
        .map((row) => JSON.parse(row.payload));
    }
    return state;
  } finally {
    db.close();
  }
}

