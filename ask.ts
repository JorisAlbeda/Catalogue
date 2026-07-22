import { search } from "./search.js"

export async function ask(question: string) {
  const matches = await search(question, 4)

  const context = matches
    .map((m, i) => `[${i + 1}] ${m.source}\n${m.content}`)
    .join("\n\n---\n\n")

  const prompt = `Answer the question using only the context provided.
If the answer is not in the context, say so.
Cite sources by their number in square brackets.

CONTEXT:
${context}

QUESTION: ${question}

ANSWER:`

  const r = await fetch("http://localhost:11434/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3:8b",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  })
  const json = await r.json()
  return {
    answer: json.choices[0].message.content,
    sources: matches.map((m) => m.source),
  }
}
