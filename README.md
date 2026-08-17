# dsh-engram

> Controlled cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — every write is **proposed by the model, approved by a human**, and lands on an append-only version chain with cited evidence.

[![license](https://img.shields.io/npm/l/dsh-engram)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-engram)](https://nodejs.org)

`dsh-engram` gives a DSH agent **declarative memory** (facts, preferences, lessons) that survives conversations — without the failure modes of auto-remembering plugins. The model proposes; a human approves from the web panel. Nothing is written any other way.

## ✨ Features

- 🚧 **Approval gate** — `propose → pending → panel approve/deny` is the *only* write path. No auto-approval, no direct store surface.
- 🔗 **Append-only version chain** — every entity keeps its current version + 4 recent ones; older versions fold into a summary node that **never drops citations**.
- 🧾 **Cited evidence** — each version carries a citation pointer *and* a self-contained excerpt snapshot, so a memory stays traceable even after the source log is gone.
- ⚖️ **Two-layer conflict detection** — deterministic same-name grouping + lexical FTS candidates. The system only *surfaces* candidates; a human decides (contradict / coexist / merge).
- 🧭 **Workspace isolation** — memories scope to a git-origin-derived workspace key (four-step normalization + fallback chain), so repos don't bleed into each other.
- 🔍 **FTS5 retrieval** — normalized (simplified/half-width/lowercased) terms with synonym expansion, indexed once at write time.
- 🛡️ **Drift interception** — approving a proposal whose entity moved on (`base_rev` mismatch) is blocked and the real change chain is shown, never silently applied.
- 📊 **Panel UI** — a settings-section approval page, a sidebar badge with pending count, and a floating overlay, all sharing one approval list.

## 🚀 Quick Start

```sh
dsh plugin --profile web add dsh-engram
dsh web
```

Then, in a conversation:

1. Ask the model to remember something: *"记住：生产环境端口是 8899"* → it calls `memory_propose`.
2. Click the 🧠 badge in the sidebar foot (or open **Settings → 记忆审批**).
3. **Approve** or **deny** the proposal. Only then does the memory take effect.

Memories persist to `~/.dsh/engram.db` (override with `ENGRAM_DB_PATH`).

## ⚙️ Configuration

The bundle patch mounts the plugin with a persistent default; override via the row in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: memory
  name: dsh-engram
  config:
    dbPath: !!js process.env.ENGRAM_DB_PATH ?? (process.env.HOME ?? '/root') + '/.dsh/engram.db'
    snapshotBudget: 4000    # hard cap on total stable text injected as a snapshot
    entryBudget: 2000       # per-entry text budget (throws, never truncates)
    synonymGroups: []       # seed synonym groups for recall OR-expansion
```

| Field | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `~/.dsh/engram.db` | SQLite path; `':memory:'` for ephemeral (tests) |
| `snapshotBudget` | `4000` | Sum of stable current-version texts (snapshot channel hard cap) |
| `entryBudget` | `2000` | Per-entry text length; over-budget throws `BudgetExceededError` |
| `synonymGroups` | `[]` | Seed synonym groups for recall expansion |

## 💬 Model tools

| Tool | What it does |
| --- | --- |
| `memory_propose` | Propose a memory for approval; returns pending id + conflict candidates |
| `memory_query` | Search active memories + this session's own pending proposals |

## 🏗️ How it works

- **Storage** — SQLite (WAL, `node:sqlite`) with five tables + an FTS5 virtual table + a scope index. The provider is private to `MemoryService`; reads go through a read-only facade.
- **Write path** — `propose` (evidence completion → conflict detection → kind derivation → budget check → pending with `base_rev`) → `approve` (first-come-first-served + drift check + conflict cascade + single transaction) or `deny`.
- **Kind derivation** — deterministic defaults (`user+global → stable`, `agent → situational`, `user+workspace → situational`); the model may suggest, the approver has the final say.
- **Approval API** — `GET /api/engram/pending`, `POST /api/engram/approve`, `POST /api/engram/deny` (open approval by design; `user` is recorded for audit only).

## 🧪 Development

```sh
npm run check   # typecheck + vitest (35 tests) + build
```

The suite locks the core invariants: approval-only writes, budget enforcement, append-only version chain, drift interception, and FTS consistency.

## 📄 License

[MIT](LICENSE)
