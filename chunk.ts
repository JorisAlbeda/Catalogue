export function chunk(text: string, size = 800, overlap = 100): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let buffer = ""
  for (const s of sentences) {
    if ((buffer + " " + s).length > size && buffer) {
      chunks.push(buffer.trim())
      buffer = buffer.slice(-overlap) + " " + s
    } else {
      buffer = buffer ? buffer + " " + s : s
    }
  }
  if (buffer) chunks.push(buffer.trim())
  return chunks
}
