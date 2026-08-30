import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeliveryTelemetryRepository } from "../src/delivery-telemetry-repository.js";
import { materializeImprovementJournalDate } from "../src/improvement-journal.js";

test("journal materialization is atomic, linked, and byte-stable", async () => {
  const repository = createDeliveryTelemetryRepository();
  const unique = randomUUID();
  const event = await repository.appendDeliveryEvent({
    projectId: "studioops", taskId: "task_766", stage: "qa", eventType: "delivery.reviewed",
    occurredAt: "2040-01-02T19:00:00.000Z", sourceKind: "owner_handoff",
    sourceReference: `task_80:${unique}`, idempotencyKey: `journal-event:${unique}`,
    measures: {}, attributes: { outcome: "accepted" },
  });
  const retrospective = await repository.appendRetrospective({
    projectId: "studioops", eventId: event.record.id, journalDate: "2040-01-02",
    title: "Delivery review", summary: "The evidence remained available after restart.",
    observations: { action: "keep_exact_sha_binding" },
    idempotencyKey: `retrospective:${unique}`, recordedAt: "2040-01-02T19:05:00.000Z",
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "studioops-journal-"));
  const first = await materializeImprovementJournalDate("2040-01-02", { repository, root });
  const firstBytes = await readFile(first.outputPath);
  const second = await materializeImprovementJournalDate("2040-01-02", { repository, root });
  const secondBytes = await readFile(second.outputPath);
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(second.contentSha256, first.contentSha256);
  assert.equal(first.outputPath, path.join(root, "2040", "01", "2040-01-02.md"));
  const markdown = firstBytes.toString("utf8");
  assert.match(markdown, new RegExp(retrospective.record.id));
  assert.match(markdown, new RegExp(event.record.id));
});
