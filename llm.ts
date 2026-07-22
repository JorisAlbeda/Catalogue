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
  retries = 2,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const content = await callOllama(model, prompt, "json")
    try {
      return JSON.parse(content) as T
    } catch (err) {
      if (attempt >= retries) throw err
      console.warn(
        `chatJSON: model returned malformed JSON (attempt ${attempt + 1}/${retries + 1}), retrying`,
      )
    }
  }
}
