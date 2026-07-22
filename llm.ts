const CHAT_URL = "http://localhost:11434/api/chat"

async function callOllama(
  model: string,
  prompt: string,
  format?: "json",
): Promise<string> {
  const r = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      ...(format ? { format } : {}),
    }),
  })
  const json = await r.json()
  return json.message.content as string
}

export async function chat(prompt: string, model = "qwen3:8b"): Promise<string> {
  return callOllama(model, prompt)
}

export async function chatJSON<T>(
  prompt: string,
  model = "qwen3:8b",
): Promise<T> {
  const content = await callOllama(model, prompt, "json")
  return JSON.parse(content) as T
}
