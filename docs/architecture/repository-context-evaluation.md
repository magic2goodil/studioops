# Repository context retrieval evaluation

The production feature is an advisory structural and lexical index. Embeddings are an offline experiment in the evaluation script, with no embedding dependency or provider in the runner.

## Fixed corpus and labels

`test/fixtures/repository-context-evaluation.json` contains 26 source-grounded queries across five repositories. The 14 StudioOps queries are the primary evaluation. The other four repositories each have three smoke queries. Needed-file labels, confusing-file labels, query text, and commit SHAs were selected by reading source before running retrieval. They were not tuned to ranking results.

The suite covers exact identifiers and paths, conceptual wording, confusing neighboring modules, an absent identifier, and foreign-repository identifiers. Foreign identifiers test retrieval noise separately from cross-repository leakage. A noisy local result is a failed abstention, while a foreign result is an isolation failure.

| Repository key | Immutable source commit | Queries |
| --- | --- | ---: |
| studioops | `1cc6d4498e8a2adf7bc88b70628c18342b3e1208` | 14 |
| dollos | `3ddeec37fc77f1e1148d0b7d4d1ca374a2515f72` | 3 |
| miss-dolly-site | `311c0b2cc2c609788644527b1ff9a3cbb5afaf56` | 3 |
| vbwinery-redesign | `3bf9d8cbae7635736a84ab7733cbafdeb7dee292` | 3 |
| event-horizons-web | `7bcec4dd6a99829aa383c5bd8f139528e92a4c96` | 3 |

The harness verifies each required path exists in the recorded Git commit before scoring it. Indexing never writes to those source repositories. Reports use repository keys and relative file paths. Generated reports, model files, caches, and the optional Python environment belong under `~/.codex/workspaces/`.

## Measurements

The baseline calls the existing impact planner and formatter. Its candidate set includes every eligible indexed file covered by the authored allowed and supporting scopes. It is an unranked set: there is no artificial five-file cutoff and no baseline reciprocal-rank score. This is scope discoverability, not proof that the existing worker would eventually fail to discover a file.

Structural retrieval runs the production ranker and formatter with five results and a 10,000-byte output ceiling. Recall measures how many labeled needed files appear in the returned set. Mean reciprocal rank measures the position of the first needed file for queries with a needed file. Queries with no needed file are excluded from recall and measured for abstention.

Labels are deliberately narrow. Non-labeled neighbors, tests, and helpers are **unjudged**, not automatically irrelevant. Only explicitly confusing/forbidden labels and results for null queries count as known irrelevant. Every returned structural file must belong to the bound Git commit.

Output bytes are actual prompt text for baseline and structural methods. The structural packet is additive to the mandatory impact packet, so a smaller advisory packet does not mean the total worker prompt shrinks. Experimental semantic and hybrid byte counts describe path/score JSON, not equivalent production prompt packets.

Timings cover index creation/loading and local retrieval only. They do not measure agent completion speed, tokens consumed by a full task, correctness of resulting code, or review time. This small manually labeled set is a regression and feasibility experiment, not a general code-search benchmark.

## Results and decision

The final run completed on 2026-09-05 at 11:23 UTC on an Apple M2 Pro, macOS/Darwin 25.5.0, Node 23.11.0. It used cache policy 4 and extractor `tree-sitter-wasm-0.3.1-v2`. The harness verified implementation hashes did not change during the run. The frozen fixture digest is `2f010feb658a66979b49e029515ebf5845210b74c8144370692e3741d351e261`.

StudioOps has 12 queries with one needed file each, plus two null queries:

| Method | Needed-file recall | Mean reciprocal rank | Returned files | Unjudged hits | Known irrelevant hits | Null abstentions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Authored-map scope baseline | 5/12 (41.7%) | Unranked | 296 | 288 | 3 | 2/2 |
| Structural and lexical, top 5 | 8/12 (66.7%) | 0.667 | 65 | 50 | 7 | 1/2 |
| Local semantic, top 5 | 9/12 (75.0%) | 0.750 | 70 | 51 | 10 | 0/2 |
| Experimental hybrid, top 5 | 11/12 (91.7%) | 0.813 | 70 | 47 | 12 | 0/2 |

The hybrid experiment recovered the notification-delay, promotion-ancestry, and failure-backoff files that structural retrieval missed. All methods missed the maintenance-lock paraphrase's specific lease module. Semantic retrieval alone missed the exact `createSelfUpdateLease` identifier, while structural retrieval found it first. These results support keeping exact lookup and show that embeddings can help conceptual queries; they do not establish a reliable confidence threshold or universal improvement.

The four additional smoke suites each have two needed-file queries and one foreign-repository query:

| Repository | Baseline recall | Structural recall | Semantic recall | Hybrid recall | Structural null abstentions |
| --- | ---: | ---: | ---: | ---: | ---: |
| dollos | 0/2 | 2/2 | 2/2 | 2/2 | 0/1 |
| miss-dolly-site | 0/2 | 2/2 | 2/2 | 2/2 | 0/1 |
| vbwinery-redesign | 1/2 | 2/2 | 2/2 | 2/2 | 0/1 |
| event-horizons-web | 0/2 | 2/2 | 2/2 | 2/2 | 0/1 |

No method returned a foreign repository file in any of the 26 queries. Structural retrieval returned local lexical matches for each foreign identifier, so these cases passed repository isolation but failed abstention. Both semantic methods also returned local results for every null query. The pinned DollOS and Event Horizons commits lack the default component map, which explains their empty baseline scope; this is a measured fallback condition, not a comparison against a map that exists elsewhere or at a newer commit.

The output and timing measurements are:

| Repository | Mean baseline prompt bytes | Mean additive structural bytes | Mean baseline ms | Mean structural ms |
| --- | ---: | ---: | ---: | ---: |
| studioops | 2,251 | 3,795 | 0.96 | 13.31 |
| dollos | 1,425 | 4,226 | 0.11 | 20.62 |
| miss-dolly-site | 1,667 | 2,812 | 0.09 | 1.58 |
| vbwinery-redesign | 2,204 | 3,081 | 7.59 | 22.34 |
| event-horizons-web | 1,455 | 3,919 | 0.06 | 6.15 |

This demonstrates better needed-file discovery with a bounded additional packet. It does **not** demonstrate fewer total prompt bytes: the StudioOps impact packet plus advisory packet averaged about 6,046 bytes. Avoid claiming agent speed or token-cost savings from this table.

| Repository | Files indexed | Parsed / path-only | Cold index ms | Warm index ms | Index JSON bytes | Embedding build seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| studioops | 227 | 133 / 94 | 852 | 82 | 688,131 | 13.47 |
| dollos | 423 | 288 / 135 | 1,298 | 60 | 659,680 | 15.64 |
| miss-dolly-site | 110 | 55 / 55 | 157 | 53 | 71,446 | 2.11 |
| vbwinery-redesign | 3,512 | 1,283 / 2,229 | 1,548 | 189 | 1,186,924 | 50.94 |
| event-horizons-web | 304 | 183 / 121 | 373 | 51 | 343,417 | 7.91 |

Every first index load was a cache miss and every immediate warm load a cache hit. Every labeled needed file was indexed. No duration/file-count/total-byte extraction limit was hit in the final run. Coverage remains explicitly partial in every repository because templates/assets have path-only records and imports include external packages or unresolved static relationships; parsed-file counts do not imply complete semantic resolution. Privacy and generated/dependency exclusions remain active, including vendored backup trees in the winery repository.

The embedding model adds about 90 MB of weights, a Python/ONNX environment, a 149 ms load on this host, and per-commit vector generation. The five corpora produced 6,605 chunks occupying 10,145,280 bytes of vector arrays, separate from model memory and Python overhead. Mean semantic query times ranged from 2.33 to 15.86 ms after vector construction.

**Decision: deliver structural retrieval and keep embeddings disabled in production.** The hybrid recall gain is promising, but this small fixture does not justify silently adding model downloads, Python dependencies, per-commit vector work, and failed abstention to every worker. A subsequent opt-in trial should freeze a larger independent query set, include conceptual and negative cases from fresh repositories, calibrate abstention on separate development data, and measure actual worker discovery effort before considering production activation. The evaluation CLI already supports repeating that experiment without changing scope or release authority.

## Offline embedding method and provenance

The experiment uses `sentence-transformers/all-MiniLM-L6-v2`, distributed by FastEmbed as `qdrant/all-MiniLM-L6-v2-onnx`, with 384-dimensional vectors and the CPU execution provider using two threads. The model has a 256-token input limit. Metadata is split into chunks of up to 12 declaration names and 1,200 characters, with path, language, and component owner repeated. A file's score is its maximum chunk cosine similarity. Source bodies, literals, comments, and user data never enter the embedding payload.

The model is downloaded separately with no corpus or queries supplied. Inference sets offline flags, disables ONNX telemetry, and blocks Python socket connections before reading the corpus from standard input. No remote embedding service is used. Vectors remain in process memory; the production index stays metadata-only.

| Item | Measured version or identity |
| --- | --- |
| Python | 3.11.2 |
| FastEmbed | 0.7.3 |
| ONNX Runtime | 1.29.0 |
| NumPy | 2.4.6 |
| Tokenizers | 0.23.2 |
| Hugging Face Hub | 0.36.2 |
| Model checkpoint revision | `5f1b8cd78bc4fb444dd171e59b18f3a3af89a079` |
| ONNX model bytes | 90,387,630 |
| ONNX model SHA-256 | `bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5` |
| Tokenizer SHA-256 | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` |

The JSON report records hashes of every model artifact and evaluation implementation file. Exact model provenance is identified by artifact hashes, not a mutable model name alone. Preserve the downloaded checkpoint and compare these hashes before treating another run as a reproduction of the same model.

Semantic retrieval returns five files with no tuned confidence threshold. Hybrid retrieval uses reciprocal rank fusion of the structural and semantic top-five lists with constant 60. This simple experiment deliberately exposes semantic false positives and exact-name regressions; it does not imply these are the best possible embedding models, chunking methods, or fusion strategies.

## Reproduction

Run the metric and fixture tests through the repository's isolated test runner:

```sh
node scripts/run-tests.js --test-file test/repository-context-evaluation.test.js
```

Run StudioOps alone without optional dependencies:

```sh
node scripts/evaluate-repository-context.js \
  --cache-root "$HOME/.codex/workspaces/repository-context-evaluation/indexes" \
  --out "$HOME/.codex/workspaces/repository-context-evaluation/results.json"
```

Supply additional read-only checkouts with repeated `--repo key=/absolute/path` arguments using the keys in the table. They must contain the pinned commits and their expected origin repositories. Missing local checkouts are not fabricated or cloned automatically.

To reproduce the optional embedding experiment, create a local environment and download the public model first:

```sh
SO_EVAL_ROOT="$HOME/.codex/workspaces/repository-context-evaluation"
python3 -m venv "$SO_EVAL_ROOT/venv"
"$SO_EVAL_ROOT/venv/bin/python" -m pip install \
  --cache-dir "$SO_EVAL_ROOT/pip" \
  fastembed==0.7.3 onnxruntime==1.29.0 numpy==2.4.6 \
  tokenizers==0.23.2 huggingface-hub==0.36.2
HF_HOME="$SO_EVAL_ROOT/huggingface" \
"$SO_EVAL_ROOT/venv/bin/python" -c \
  'import sys; from fastembed import TextEmbedding; TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2", cache_dir=sys.argv[1], threads=2)' \
  "$SO_EVAL_ROOT/models"
node scripts/evaluate-repository-context.js \
  --cache-root "$SO_EVAL_ROOT/indexes" \
  --embedding-python "$SO_EVAL_ROOT/venv/bin/python" \
  --embedding-cache-root "$SO_EVAL_ROOT/models" \
  --out "$SO_EVAL_ROOT/results-with-embeddings.json"
```

Use a new cache directory to measure a cold index build. The report marks first-load cache hits explicitly and measures an immediate warm load separately. Hardware, concurrent work, model package availability, and future implementation changes can change timings and results; retain the generated provenance hashes when comparing runs.
