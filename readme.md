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
| `catalogue.ts` | Entry point: builds the entity codex from `documents/` |
| `documents/` | Source material (not generated) |
| `codex/` | Generated entity catalogue (not committed) |
| `rag.db` | Generated vector index (not committed) |
