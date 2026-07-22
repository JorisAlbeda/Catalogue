import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chat, chatJSON } from "./llm.js"
import { search } from "./search.js"

export const CATEGORIES = [
  "buildings",
  "characters",
  "events",
  "locations",
  "relics",
] as const
export type Category = (typeof CATEGORIES)[number]

export interface CatalogueEntity {
  name: string
  slug: string
  category: Category
  sources: string[]
}

const DOCUMENTS_DIR = "./documents"
const CODEX_DIR = "./codex"
const MANIFEST_PATH = path.join(CODEX_DIR, "manifest.json")
const ENTRY_CONTEXT_CHUNKS = 8

export function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (/\.(md|txt)$/i.test(entry.name)) files.push(full)
  }
  return files
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function extractionPrompt(text: string): string {
  return `You are cataloguing a fantasy campaign setting from source text.
Read the text below and extract every entity explicitly named in it that fits one of these categories:
- buildings: distinct constructed structures (temples, fortresses, houses, taverns, etc.)
- characters: named individual people or creatures
- events: named or clearly distinct occurrences (battles, ceremonies, journeys, etc.)
- locations: named places that are not buildings (regions, forests, roads, ruins, etc.)
- relics: named items, artifacts, or objects of significance

Only include entities that are explicitly named in the text. Do not invent anything, and do not include duplicates.
Respond with ONLY a JSON object in this exact shape, with no extra commentary:
{"buildings": string[], "characters": string[], "events": string[], "locations": string[], "relics": string[]}

TEXT:
${text}`
}

export async function extractCatalogue(
  files: string[],
): Promise<CatalogueEntity[]> {
  const entities = new Map<string, CatalogueEntity>()

  for (const [i, file] of files.entries()) {
    console.log(`[phase 1] extracting ${i + 1}/${files.length}: ${file}`)
    const text = fs.readFileSync(file, "utf8")
    const extracted = await chatJSON<Record<Category, string[]>>(
      extractionPrompt(text),
    )

    for (const category of CATEGORIES) {
      for (const rawName of extracted[category] ?? []) {
        const name = rawName.trim()
        if (!name) continue
        const slug = slugify(name)
        const key = `${category}:${slug}`
        const existing = entities.get(key)
        if (existing) {
          if (!existing.sources.includes(file)) existing.sources.push(file)
        } else {
          entities.set(key, { name, slug, category, sources: [file] })
        }
      }
    }
  }

  return [...entities.values()]
}

async function buildContext(entity: CatalogueEntity): Promise<string> {
  const matches = await search(entity.name, ENTRY_CONTEXT_CHUNKS)
  if (matches.length === 0) {
    console.warn(
      `[phase 2] no indexed chunks found for "${entity.name}" — is the RAG index built (npm run setup)?`,
    )
  }
  return matches
    .map((m) => `### Source: ${m.source}\n${m.content}`)
    .join("\n\n")
}

function entryPrompt(entity: CatalogueEntity, context: string): string {
  const kind = entity.category.slice(0, -1)
  return `Write a concise codex entry for the ${kind} "${entity.name}", using only the source text below.
Format it as markdown: a level-1 heading with the name, followed by a few short paragraphs covering what is known about it.
Do not invent details that aren't supported by the text.

SOURCE TEXT:
${context}`
}

export async function populateCodex(
  entities: CatalogueEntity[],
  codexDir: string = CODEX_DIR,
): Promise<void> {
  for (const [i, entity] of entities.entries()) {
    console.log(
      `[phase 2] writing ${i + 1}/${entities.length}: ${entity.category}/${entity.slug}`,
    )
    const context = await buildContext(entity)
    const content = await chat(entryPrompt(entity, context))
    const filePath = path.join(codexDir, entity.category, `${entity.slug}.md`)
    fs.writeFileSync(filePath, content.trim() + "\n")
  }
}

async function main() {
  // Phase 1: discover entities from the documents and set up the folder structure
  const files = walk(DOCUMENTS_DIR)
  console.log(`Found ${files.length} document(s) in ${DOCUMENTS_DIR}`)

  for (const category of CATEGORIES) {
    fs.mkdirSync(path.join(CODEX_DIR, category), { recursive: true })
  }

  const entities = await extractCatalogue(files)
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(entities, null, 2))
  console.log(`Catalogued ${entities.length} entities -> ${MANIFEST_PATH}`)

  // Phase 2: populate one file per entity
  await populateCodex(entities)
  console.log("Done.")
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
