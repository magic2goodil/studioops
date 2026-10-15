# Repository context retrieval evaluation

Production retrieval is an advisory structural and lexical index. Embeddings remain an optional offline experiment in the evaluation harness; the runner has no embedding provider or model dependency.

## Public corpus

`test/fixtures/repository-context-evaluation.json` contains 14 queries against the public StudioOps source at `1cc6d4498e8a2adf7bc88b70628c18342b3e1208`: 12 needed-file queries, one deliberately absent identifier and one explicitly synthetic foreign-project case. The 12 source-grounded labels were chosen by reading source before retrieval. They cover exact identifiers/paths, conceptual wording and confusing neighboring modules.

The published fixture was narrowed to StudioOps on October 15, 2026 to remove unrelated repositories and their source identities. The synthetic foreign identifier is a new regression case. Historical multi-repository and embedding measurements are not claimed as measurements of this revised fixture. Re-run the harness and retain its provenance before citing results.

The harness verifies required paths exist at the pinned commit and reads source without modifying it. Reports use repository keys and relative paths. Generated reports, caches and optional model environments belong under `~/.codex/workspaces/`.

## What the metrics mean

The authored-map baseline includes every eligible indexed path in the allowed and supporting scopes. It is an unranked set, with no artificial five-file cutoff or reciprocal-rank score. Structural retrieval uses the production ranker and formatter with five results and a 10,000-byte output ceiling.

Recall measures labeled needed files in the returned set; reciprocal rank measures the first needed result. Null queries are excluded from recall and measured for abstention. Narrow labels leave neighboring tests/helpers unjudged; they are not automatically irrelevant. A noisy local result fails abstention, while a foreign repository result fails isolation. A synthetic forbidden-path case alone is not proof of multi-repository isolation; separate index/cache isolation tests also remain necessary.

Prompt bytes are measured output, not billed tokens. The structural packet is added to the mandatory impact packet: bounded retrieval does not establish a smaller total prompt, faster task completion, better resulting code or lower usage. Timing covers local index/retrieval work only. This small manually labeled set is a regression experiment, not a general code-search benchmark.

## Reproduce without optional models

```sh
node scripts/run-tests.js --test-file test/repository-context-evaluation.test.js
node scripts/evaluate-repository-context.js \
  --cache-root "$HOME/.codex/workspaces/repository-context-evaluation/indexes" \
  --out "$HOME/.codex/workspaces/repository-context-evaluation/results.json"
```

The checkout must contain the recorded commit and expected origin. A history-free source archive does not satisfy that prerequisite by itself. The harness records implementation/fixture hashes, timing and cache status. Use a new cache directory for a cold build and retain the complete report when comparing runs.

## Optional offline embeddings

The harness can experiment with a separately installed local FastEmbed/ONNX environment and `sentence-transformers/all-MiniLM-L6-v2`. It embeds path/language/component/declaration-name metadata, not source bodies, literals or comments. Model downloads happen separately; inference disables telemetry and network access before reading the corpus. Vectors remain in memory and production indexing stays metadata-only.

Use `--embedding-python` and `--embedding-cache-root` only after explicitly preparing that optional environment. Preserve actual model, tokenizer and implementation hashes; a mutable model name alone does not reproduce a run. The experiment's top-five semantic ranking and reciprocal-rank fusion use no calibrated abstention threshold.

**Decision: retain structural retrieval and keep embeddings disabled in production.** Any expansion needs a larger independent fixture, separately calibrated negative cases and measured worker outcomes before adding downloads, dependencies or per-commit vector work to normal runs.
