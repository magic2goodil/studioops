import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDeliveryTelemetryRepository } from "./delivery-telemetry-repository.js";
import { utcDate } from "./delivery-telemetry.js";
import { improvementJournalRoot } from "./runtime-paths.js";

function singleLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

export function renderImprovementJournal(journalDate, retrospectives) {
  const date = utcDate(journalDate, "journalDate");
  const ordered = [...retrospectives].sort((left, right) => (
    left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id)
  ));
  const lines = [
    `# StudioOps improvement journal — ${date}`,
    "",
    "This file is a deterministic projection of the authoritative append-only SQLite ledger.",
    "",
  ];
  if (!ordered.length) {
    lines.push("_No retrospective records._", "");
  }
  for (const item of ordered) {
    lines.push(
      `## ${singleLine(item.title)}`,
      "",
      `- Retrospective: [${item.id}](studioops://retrospectives/${encodeURIComponent(item.id)})`,
      `- Delivery event: [${item.eventId}](studioops://delivery-events/${encodeURIComponent(item.eventId)})`,
      `- Project: ${singleLine(item.projectId)}`,
      `- Recorded (UTC): ${item.recordedAt}`,
      "",
      singleLine(item.summary),
      "",
    );
    const observations = Object.entries(item.observations || {});
    if (observations.length) {
      lines.push("Observations:", "");
      for (const [key, value] of observations) lines.push(`- ${key}: ${singleLine(value)}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function allRetrospectives(repository, journalDate) {
  const items = [];
  let cursor = null;
  do {
    const page = await repository.listRetrospectivesByDate({ journalDate, cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function materializeImprovementJournalDate(journalDate, options = {}) {
  const date = utcDate(journalDate, "journalDate");
  const repository = options.repository || createDeliveryTelemetryRepository();
  const root = path.resolve(options.root || improvementJournalRoot());
  const directory = path.join(root, date.slice(0, 4), date.slice(5, 7));
  const outputPath = path.join(directory, `${date}.md`);
  const relativePath = path.posix.join("improvement-journal", date.slice(0, 4), date.slice(5, 7), `${date}.md`);
  const retrospectives = await allRetrospectives(repository, date);
  const content = renderImprovementJournal(date, retrospectives);
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${date}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  const through = retrospectives.at(-1);
  const checkpointTime = through?.recordedAt || `${date}T00:00:00.000Z`;
  await repository.appendJournalExport({
    idempotencyKey: `journal:${date}:${contentSha256}`,
    journalDate: date,
    relativePath,
    contentSha256,
    entryCount: retrospectives.length,
    throughRecordedAt: through?.recordedAt || "",
    throughId: through?.id || "",
    recordedAt: checkpointTime,
    exportedAt: checkpointTime,
  });
  return { outputPath, relativePath, contentSha256, entryCount: retrospectives.length, content };
}
