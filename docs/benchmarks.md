# Embedding benchmark record

[Home](../README.md) · [Machine-readable results](../benchmarks/results/2026-10-07.json)

These measurements compare the default **Qwen3-Embedding-8B 4-bit DWQ** model with the original **Qwen3-Embedding-8B BF16** weights. Both ran through MLX on the same machine on **2026-10-07**.

They describe embedding similarity and retrieval on two datasets, not language-model answer quality, Qdrant approximate-search performance, or a full MTEB evaluation.

## Results

Higher is better for the quality metrics.

| Dataset and metric     | 4-bit DWQ | Original BF16 |
| ---------------------- | --------: | ------------: |
| Chinese STSB: Spearman |   0.86271 |       0.86249 |
| Chinese STSB: Pearson  |   0.85302 |       0.85250 |
| SciFact: nDCG@10       |   0.78643 |       0.78758 |
| SciFact: Recall@10     |   0.90389 |       0.91333 |
| SciFact: Hit@5         |   0.87000 |       0.86000 |
| STSB encoding time     |  5.39 min |      6.78 min |
| SciFact encoding time  | 42.70 min |     44.46 min |
| Model weight bytes     |   4.26 GB |      15.13 GB |

Times cover embedding inference for all unique inputs in each dataset, not downloads, scoring, or total application latency. Weight sizes are decimal GB of model weights, **not total RAM usage**. The BF16 weight files are approximately 3.55 times larger.

Paired bootstrap differences are **BF16 minus 4-bit**:

| Metric            | Difference | 95% bootstrap interval |
| ----------------- | ---------: | ---------------------- |
| STSB Spearman     |   -0.00022 | [-0.00260, +0.00217]   |
| SciFact nDCG@10   |   +0.00115 | [-0.00781, +0.00999]   |
| SciFact Recall@10 |   +0.00944 | [-0.00333, +0.02444]   |
| SciFact Hit@5     |   -0.01000 | [-0.02667, +0.00667]   |

These intervals contain zero. The measurements do not establish a consistent quality advantage for either precision on these two tests, and they do not prove equivalence on other tasks.

## Method

Machine: **Apple M5, 24 GiB memory, macOS 27.0.1 arm64**. Runtime: Python 3.12.14, MLX 0.32.3, mlx-lm 0.32.0, Transformers 5.19.0.

Both models produced 4096-dimensional embeddings from the last non-padding token, followed by float32 L2 normalization. Inputs ran serially without padding, chat templates, or silent truncation. Original BF16 weights ran through the same MLX inference path; this was not the upstream PyTorch evaluation.

| Model                                                                                                         | Pinned revision                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [mlx-community/Qwen3-Embedding-8B-4bit-DWQ](https://huggingface.co/mlx-community/Qwen3-Embedding-8B-4bit-DWQ) | `885642d6b98742ea03b77a1673579c92ca961efd` |
| [Qwen/Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B)                                     | `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` |

### Chinese STSB

[C-MTEB/STSB](https://huggingface.co/datasets/C-MTEB/STSB), full test split: **1361 sentence pairs**, **2456 unique sentences**, **63,916 encoded tokens**. Dataset revision: `0cde68302b3541bb8b3c340dc0644b0b745b3dc0`.

Both sides used `Instruct: Retrieve semantically similar text\nQuery: ...`. Cosine similarity was compared with gold scores using Spearman and Pearson correlation. The paired Spearman bootstrap used 5000 resamples with seed 20261007.

### BEIR SciFact

[BeIR/scifact](https://huggingface.co/datasets/BeIR/scifact), **all 5183 corpus documents** and **all 300 test queries**: 5483 inputs, **1,718,334 encoded tokens**. Corpus archive MD5: `5f7d1de60b170fc8027bb7898e2efca1`.

Documents were `title + " " + text`, without query instructions. Queries used CiteDock's configured instruction:

```text
Given a question, retrieve relevant passages that answer the question
```

Retrieval ranked the full corpus by exact cosine similarity. No chunking, reranker, or approximate index was used. Documents fit within the configured token limit.

Scoring used NumPy 2.5.3, SciPy 1.18.1, and pytrec-eval-terrier 0.5.10. Paired query bootstrap intervals used 10,000 resamples with seed 20261007. The instruction follows the project's retrieval configuration rather than a task-specific leaderboard configuration; do not compare these values directly to an upstream leaderboard.

The public JSON includes all measured metrics, encoding times, revisions, token counts, input fingerprints, and paired intervals. It contains no imported user documents or model weights. The original local evaluation runner is not currently packaged as a public benchmark command.

## What this means for CiteDock

The default 4-bit model is a practical option on the tested 24 GiB machine. Original BF16 weights use more storage and memory, while the measured retrieval scores and SciFact encoding times were close. More datasets and repeated measurements are needed before drawing broader conclusions. To reproduce an application-level comparison with a different runtime, keep input data and query instructions fixed and use separate collections.
