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
