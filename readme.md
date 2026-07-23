# Catalogue

A local-only RAG (retrieval-augmented generation) system built with [Ollama](https://ollama.com/) and TypeScript, based on [this dev.to guide](https://dev.to/pavelespitia/building-a-local-only-rag-system-with-ollama-and-typescript-430c). It indexes a folder of source documents into a local vector database, answers questions grounded in that content, and can automatically compile a structured "codex" of the named entities (buildings, characters, events, locations, relics) found across the documents.

Everything runs locally: embeddings and chat completions go to a local Ollama server, and the vector index is a local SQLite database (via [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) and [`sqlite-vec`](https://github.com/asg017/sqlite-vec)). No data leaves your machine.

## Requirements

- Node.js 22+
- [Ollama](https://ollama.com/) running locally, with these models pulled:
  ```
  ollama pull nomic-embed-text
  ollama pull qwen3:8b
  ```

## Setup

```
npm install
npm run setup
```

`npm run setup` recursively indexes every `.md`/`.txt` file under `documents/` into `rag.db`, chunking and embedding each file. It's safe to re-run — re-indexing a file replaces its previous chunks rather than duplicating them.

## Usage

### Ask a question

```
npm start
npm start -- "What animal did Lilianne use as a mount?"
```

Without an argument, `index.ts` falls back to a hardcoded sample question. Answers are generated only from the retrieved context and cite their sources.

### Build the codex

```
npm run catalogue
```

Runs a two-phase pipeline over `documents/`:

1. **Discovery** — extracts every named entity per document into one of five categories, merges duplicates across documents, sets up the `codex/<category>/` folders, and writes `codex/manifest.json`.
2. **Population** — for each entity (locations first, so every other category can link to a real location), retrieves the most relevant indexed chunks and writes a structured entry to `codex/<category>/<slug>.md` with:
   - **Description** and **History** (longer for entities that recur across many documents)
   - **Location** — a cross-reference to an entry in `codex/locations/`, or `Unknown` if none applies

If population is interrupted partway through (crash, reboot, etc.), rerun with:

```
npm run catalogue:continue
```

This reuses the existing `codex/manifest.json` instead of re-running discovery, and skips any `codex/<category>/<slug>.md` that's already been written.

### Update the codex with a new folder of documents

```
npm run catalogue:update -- <path-to-new-folder>
```

Once a codex already exists, use this to integrate a second (or third, ...) folder of documents without rebuilding from scratch. It:

1. Indexes every file under `<path-to-new-folder>` into `rag.db`, same as `npm run setup` does for `documents/`.
2. Extracts entities from those files, reusing an existing entity's exact name where the text matches one already in `codex/manifest.json`.
3. Re-runs duplicate/alias reconciliation, but only for categories that actually received a new or changed entity this run — untouched categories are left alone.
4. Regenerates the codex entry for every new entity and every existing entity that gained a new source document, using its complete (old + new) context. Entities untouched by this batch keep their existing `.md` file as-is. Any file orphaned by a reconciliation rename/merge is removed.

Requires `codex/manifest.json` to already exist — run `npm run catalogue` first if this is the first batch of documents.

### Syncing the manifest after manual edits

`codex/` is git-tracked, and it's fine to hand-edit, rename, or delete files directly in it. `codex/manifest.json` won't know about those changes on its own, though, so run:

```
npm run catalogue:sync
```

to reconcile it: files that vanished are dropped from the manifest, new files get a fresh entry, and — since `codex/` is tracked in git — a renamed file is detected via git's own rename detection and keeps its source history under the new name instead of starting over. Both `catalogue:update` and `codex:command` (below) run this automatically before doing anything else, so you don't normally need to run it by hand except after a batch of manual edits you want reflected right away.

### Giving the LLM a free-form command over the codex

```
npm run codex:command -- --category <characters|events|buildings|locations|relics|all> "<instruction>"
```

For bulk edits that don't fit the fixed extract/populate pipeline — adding a field, applying a global style change, anything expressible as an instruction. Examples:

```
npm run codex:command -- --category characters "Give every character a Status section noting whether they are alive, deceased, or unknown, based on the source material."
npm run codex:command -- --category events "Give each event a Year section, based on documents/timeline.md."
npm run codex:command -- --category all "Convert every entry to British spelling."
```

For each targeted entry, it feeds the model the entry's current content, the same source context `catalogue` uses, and — if the instruction mentions a document by name (like "timeline" above) — that document's full content, then asks it to apply the instruction. Existing sections are preserved unless the instruction changes them; a new instruction-driven fact (like a Status or Year) is appended as a new section rather than replacing anything.

Because `codex/` is git-tracked, this refuses to run if `codex/` already has uncommitted changes (commit or stash first), so the run's own diff is always clean: `git diff -- codex/` shows exactly what it changed, and `git checkout -- codex/` undoes it if a result looks wrong.

## Project structure

| File | Purpose |
| --- | --- |
| `chunk.ts` | Splits text into overlapping chunks for embedding |
| `embed.ts` | Calls Ollama's embeddings API |
| `llm.ts` | Calls Ollama's chat API (plain text and JSON-mode) |
| `db.ts` | SQLite + sqlite-vec setup and indexing (`indexFile`) |
| `search.ts` | Vector similarity search over indexed chunks |
| `ask.ts` | Question answering over search results |
| `setup.ts` | Entry point: indexes `documents/` into `rag.db` |
| `index.ts` | Entry point: asks a question via `ask.ts` |
| `catalogue.ts` | Entry point: builds/updates the entity codex from `documents/`, and manifest sync |
| `command.ts` | Entry point: free-form LLM commands over existing codex entries |
| `documents/` | Source material (not generated) |
| `codex/` | Entity catalogue — LLM-generated and hand-edited, tracked in git |
| `rag.db` | Generated vector index (not committed) |
