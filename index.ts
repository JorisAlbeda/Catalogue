import { ask } from "./ask.js"

const question =
  process.argv.slice(2).join(" ") ||
  "What animal did Lilianne use as a mount?"

const result = await ask(question)
console.log(result.answer)
console.log("Sources:", result.sources)
