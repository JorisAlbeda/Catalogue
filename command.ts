import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CATEGORIES,
  Category,
  CatalogueEntity,
  assertCleanCodexTree,
  buildContext,
  syncManifest,
  walk,
} from "./catalogue.js"
import { chat } from "./llm.js"

const CODEX_DIR = "./codex"
const MANIFEST_PATH = path.join(CODEX_DIR, "manifest.json")
const DOCUMENTS_DIR = "./documents"

type Scope = Category | "all"

function parseArgs(argv: string[]): { scope: Scope; instruction: string } {
  const categoryIdx = argv.indexOf("--category")
  if (categoryIdx === -1 || !argv[categoryIdx + 1]) {
    throw new Error(
      'Usage: npm run codex:command -- --category <characters|events|buildings|locations|relics|all> "<instruction>"',
    )
  }
  const categoryArg = argv[categoryIdx + 1]
  if (
    categoryArg !== "all" &&
    !(CATEGORIES as readonly string[]).includes(categoryArg)
  ) {
    throw new Error(
      `Invalid --category "${categoryArg}" — must be one of ${CATEGORIES.join(", ")}, or "all"`,
    )
  }

  const instruction = argv
    .filter((_, i) => i !== categoryIdx && i !== categoryIdx + 1)
    .join(" ")
    .trim()
  if (!instruction) {
    throw new Error("Missing instruction text.")
  }

  return { scope: categoryArg as Scope, instruction }
}

function basenameWords(filePath: string): Set<string> {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "")
  return new Set(
    base
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((w) => w.length >= 4),
  )
}

// Deterministic reference-document lookup: does any word in the instruction
// match a file's basename? No extra LLM call, consistent with resolving
// --category explicitly rather than guessing it from the instruction text.
function findReferenceDocuments(instruction: string): string[] {
  const instructionWords = new Set(
    instruction
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  )

  const candidates = [
    ...walk(DOCUMENTS_DIR),
    ...(fs.existsSync(CODEX_DIR)
      ? fs
          .readdirSync(CODEX_DIR, { withFileTypes: true })
          .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name))
          .map((e) => path.join(CODEX_DIR, e.name))
      : []),
  ]

  return candidates.filter((file) => {
    const words = basenameWords(file)
    return [...words].some((w) => instructionWords.has(w))
  })
}

// Renaming an entity is catalogue:sync's job (via a manual file rename), not
// a bulk command's — so the original title line is always kept verbatim,
// regardless of what heading the model produced. Trailing whitespace is
// trimmed per line since the model sometimes adds stray trailing spaces
// that would otherwise show up as pure diff noise on every touched line.
//
// The source context fed into the prompt is retrieved by similarity search
// and can include raw excerpts naming *other* entities — observed in
// practice to make the model, especially on a broad instruction like "give
// every character a Status", treat those excerpts as more entities to
// process rather than background material, and echo whole extra "# Name"
// entries into the response. Truncating at the next top-level heading
// guarantees only the first (the entity actually being edited) survives,
// regardless of how well the prompt's instructions were followed.
function sanitizeEntry(
  name: string,
  originalHeading: string,
  raw: string,
): string | null {
  const trimmed = raw.trim()
  const lines = trimmed.split("\n").map((l) => l.replace(/[ \t]+$/, ""))
  const headingIdx = lines.findIndex((l) => l.startsWith("# "))
  if (headingIdx === -1) {
    console.warn(
      `[command] response for "${name}" had no markdown heading, skipping`,
    )
    return null
  }
  const rest = lines.slice(headingIdx + 1)
  const nextHeadingIdx = rest.findIndex((l) => l.startsWith("# "))
  const body = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx)
  if (nextHeadingIdx !== -1) {
    console.warn(
      `[command] response for "${name}" contained more than one top-level heading — kept only the first, discarded the rest`,
    )
  }
  return [originalHeading, ...body].join("\n").trim()
}

function commandPrompt(
  entity: CatalogueEntity,
  currentContent: string,
  sourceContext: string,
  referenceDocs: Array<{ file: string; content: string }>,
  instruction: string,
): string {
  const referenceBlock = referenceDocs
    .map((d) => `### Reference document: ${d.file}\n${d.content}`)
    .join("\n\n")

  return `Here is the existing codex entry for "${entity.name}":

${currentContent}

Here is source material for grounding. It may mention other people, places,
or things besides "${entity.name}" — that's normal background, not a list of
more entries to write. Only ever use it to inform the ONE entry for
"${entity.name}" below; ignore everything in it that isn't about
"${entity.name}":
${sourceContext}
${referenceBlock ? `\n${referenceBlock}\n` : ""}
Instruction (this is being applied to one codex entry at a time by a script
that already loops over every entity in scope — even if the instruction
says "every" or "all", you are only ever editing this one entry, "${entity.name}"): ${instruction}

Apply the instruction to the entry for "${entity.name}" above. Preserve
every existing section, including the exact top-level "# " title line,
unless the instruction specifically changes its content. If the instruction
requires information not covered by an existing section, add a new
"## SectionName" heading after the existing ones. Do not invent details not
supported by the source material or reference document, and do not copy
raw excerpts from the source material verbatim. Respond with ONLY the full
updated entry for "${entity.name}" in markdown, containing exactly one
top-level "# " heading — never include a second entity, even if one
appears in the source material above — and no commentary before or after it.`
}

export async function runCommand(scope: Scope, instruction: string): Promise<void> {
  assertCleanCodexTree()
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `No ${MANIFEST_PATH} found — run "npm run catalogue" first.`,
    )
  }
  syncManifest()

  const entities: CatalogueEntity[] = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf8"),
  )
  const targets =
    scope === "all" ? entities : entities.filter((e) => e.category === scope)
  console.log(`[command] ${targets.length} entities in scope (${scope})`)

  const referenceFiles = findReferenceDocuments(instruction)
  if (referenceFiles.length > 0) {
    console.log(
      `[command] using reference document(s): ${referenceFiles.join(", ")}`,
    )
  }
  const referenceDocs = referenceFiles.map((file) => ({
    file,
    content: fs.readFileSync(file, "utf8"),
  }))

  let succeeded = 0
  for (const [i, entity] of targets.entries()) {
    const filePath = path.join(CODEX_DIR, entity.category, `${entity.slug}.md`)
    console.log(
      `[command] ${i + 1}/${targets.length}: ${entity.category}/${entity.slug}`,
    )
    try {
      const currentContent = fs.readFileSync(filePath, "utf8")
      const originalHeading = currentContent.split("\n")[0]
      const sourceContext = await buildContext(entity)
      const raw = await chat(
        commandPrompt(entity, currentContent, sourceContext, referenceDocs, instruction),
      )
      const updated = sanitizeEntry(entity.name, originalHeading, raw)
      if (!updated) continue
      fs.writeFileSync(filePath, updated + "\n")
      succeeded++
    } catch (err) {
      console.error(
        `[command] failed on ${entity.category}/${entity.slug}, skipping:`,
        err,
      )
    }
  }

  console.log(
    `[command] done: ${succeeded}/${targets.length} entries updated. Review with "git diff -- codex/", or "git checkout -- codex/" to undo.`,
  )
}

async function main() {
  const { scope, instruction } = parseArgs(process.argv.slice(2))
  await runCommand(scope, instruction)
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
