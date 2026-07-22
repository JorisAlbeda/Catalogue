import { walk } from "./catalogue.js"
import { indexFile } from "./db.js"

// Index a folder
const files = walk("./documents")
for (const f of files) await indexFile(f)
console.log(`Indexed ${files.length} file(s).`)
