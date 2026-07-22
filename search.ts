import { db } from "./db.js"
import { embed } from "./embed.js"

export async function search(query: string, k = 4) {
  const queryVec = await embed(query)
  const rows = db
    .prepare(
      `
    SELECT chunks.source, chunks.content, vec_chunks.distance
    FROM vec_chunks
    JOIN chunks ON chunks.id = vec_chunks.id
    WHERE vec_chunks.embedding MATCH ? AND k = ?
    ORDER BY distance
  `,
    )
    .all(JSON.stringify(queryVec), k) as Array<{
    source: string
    content: string
    distance: number
  }>
  return rows
}

// Similarity search ranks globally across all sources, so a document that's
// only lightly related to the query can still be crowded out entirely by a
// more prolific one. This grabs chunks straight from one known source file,
// as a fallback to guarantee it contributes to an entity's context.
export function searchBySource(source: string, k = 2) {
  const rows = db
    .prepare("SELECT source, content FROM chunks WHERE source = ? LIMIT ?")
    .all(source, k) as Array<{ source: string; content: string }>
  return rows
}
