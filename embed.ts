export async function embed(text: string): Promise<number[]> {
  const r = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  })
  const json = await r.json()
  return json.embedding
}
