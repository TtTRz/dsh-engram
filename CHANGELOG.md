# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-17

### Added

- `MemoryService` + approval gate: `propose → pending → panel approve/deny` as the only write path, with `base_rev` drift interception and first-come-first-served concurrency.
- SQLite storage (`node:sqlite`): five tables + FTS5 + scope index; append-only version chain (current + 4 history, older folded with citations preserved).
- Two-layer conflict detection (same-name deterministic + lexical FTS candidates, surfaced not judged).
- Budget enforcement: per-entry `entryBudget` (throws) and `snapshotBudget` pre-check (flags).
- Normalization pipeline (simplified/half-width/lowercase + term extraction + synonym expansion) and git-origin workspace-key resolution with a fallback chain.
- `memory_propose` / `memory_query` model tools.
- Approval JSON API (`GET /api/engram/pending`, `POST /api/engram/approve`, `POST /api/engram/deny`).
- Browser panel: settings-section approval page + sidebar badge with pending count + floating overlay.
- 35 tests locking the core invariants (approval-only writes, budget, version chain, drift, FTS consistency).
