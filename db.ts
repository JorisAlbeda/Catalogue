import fs from "node:fs"

import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"

import { chunk } from "./chunk.js"
import { embed } from "./embed.js"

export const db = new Database("rag.db")
sqliteVec.load(db)

db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    id INTEGER PRIMARY KEY,
    embedding FLOAT[768]
  );
`)

const deleteVecForSource = db.prepare(
  "DELETE FROM vec_chunks WHERE id IN (SELECT id FROM chunks WHERE source = ?)",
)
const deleteChunksForSource = db.prepare("DELETE FROM chunks WHERE source = ?")
const insertChunk = db.prepare(
  "INSERT INTO chunks (source, content) VALUES (?, ?)",
)
const insertVec = db.prepare(
  "INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)",
)

export async function indexFile(filePath: string) {
  // Re-indexing a file would otherwise duplicate its chunks, so clear any
  // existing ones for this source first.
  deleteVecForSource.run(filePath)
  deleteChunksForSource.run(filePath)

  const text = fs.readFileSync(filePath, "utf8")
  const pieces = chunk(text)
  for (const piece of pieces) {
    const result = insertChunk.run(filePath, piece)
    const vec = await embed(piece)
    insertVec.run(BigInt(result.lastInsertRowid), JSON.stringify(vec))
  }
}
