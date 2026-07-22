import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chatJSON } from "./llm.js"
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
// An entity is "important" (gets longer description/history) once it's been
// found explicitly named in at least this many source documents.
const IMPORTANT_SOURCE_THRESHOLD = 3
// Locations are populated first so every other category can link to a real,
// already-written location entry rather than a name that doesn't exist yet.
const PROCESS_ORDER: Category[] = [
  "locations",
  "buildings",
  "characters",
  "events",
  "relics",
]

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

function extractionPrompt(
  text: string,
  known: Record<Category, string[]>,
): string {
  const knownBlock = CATEGORIES.map((category) => {
    const names = known[category]
    return `${category}: ${names.length > 0 ? names.join(", ") : "(none yet)"}`
  }).join("\n")

  return `You are cataloguing a fantasy campaign setting from source text.
Read the text below and extract every entity explicitly named in it that fits one of these categories:
- buildings: distinct constructed structures (temples, fortresses, houses, taverns, etc.)
- characters: named individual people or creatures
- events: named or clearly distinct occurrences (battles, ceremonies, journeys, etc.)
- locations: named places that are not buildings (regions, forests, roads, ruins, etc.)
- relics: named items, artifacts, or objects of significance

Entities already catalogued from other documents (by category):
${knownBlock}

If an entity in this text is the same as one already catalogued above — even if this text refers to it by a different name, nickname, alias, or description (for example "Sticky Fire" and "Verdflayme orb" naming the same relic) — reuse that exact existing name verbatim instead of inventing a new one. Only use a new name when the entity is not already catalogued above.

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
    const known = Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        [...entities.values()]
          .filter((e) => e.category === category)
          .map((e) => e.name),
      ]),
    ) as Record<Category, string[]>
    const extracted = await chatJSON<Record<Category, string[]>>(
      extractionPrompt(text, known),
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

interface EntityEntryContent {
  description: string
  history: string
  location: string
}

function entryPrompt(
  entity: CatalogueEntity,
  context: string,
  candidateLocations: string[],
  important: boolean,
): string {
  const kind = entity.category.slice(0, -1)
  const length = important ? "about six sentences" : "about three sentences"
  const locationKind = entity.category === "locations" ? "region" : "location"
  const locationRule =
    candidateLocations.length > 0
      ? `Choose exactly one name from this list, copied verbatim: ${candidateLocations.join(", ")}. If none of them clearly apply, use "Unknown".`
      : `No locations have been catalogued yet, so use "Unknown".`

  return `Write a codex entry for the ${kind} "${entity.name}", using only the source text below.
Do not invent details that aren't supported by the text.

Respond with ONLY a JSON object in this exact shape, with no extra commentary:
{"description": string, "history": string, "location": string}

- "description": ${length} describing what "${entity.name}" is.
- "history": ${length} covering its history, or how it came to be, as described in the text.
- "location": the ${locationKind} most associated with "${entity.name}". ${locationRule}

SOURCE TEXT:
${context}`
}

function normalizeLocation(raw: string, candidateLocations: string[]): string {
  const match = candidateLocations.find(
    (name) => name.toLowerCase() === raw.trim().toLowerCase(),
  )
  return match ?? "Unknown"
}

function formatEntry(name: string, content: EntityEntryContent): string {
  return `# ${name}

## Description
${content.description}

## History
${content.history}

## Location
${content.location}
`
}

export async function populateCodex(
  entities: CatalogueEntity[],
  codexDir: string = CODEX_DIR,
): Promise<void> {
  const locationNames = entities
    .filter((e) => e.category === "locations")
    .map((e) => e.name)

  const ordered = [...entities].sort(
    (a, b) =>
      PROCESS_ORDER.indexOf(a.category) - PROCESS_ORDER.indexOf(b.category),
  )

  for (const [i, entity] of ordered.entries()) {
    console.log(
      `[phase 2] writing ${i + 1}/${ordered.length}: ${entity.category}/${entity.slug}`,
    )
    const context = await buildContext(entity)
    const important = entity.sources.length >= IMPORTANT_SOURCE_THRESHOLD
    const candidateLocations = locationNames.filter(
      (name) => name !== entity.name,
    )
    const raw = await chatJSON<EntityEntryContent>(
      entryPrompt(entity, context, candidateLocations, important),
    )
    const content: EntityEntryContent = {
      ...raw,
      location: normalizeLocation(raw.location, candidateLocations),
    }
    const filePath = path.join(codexDir, entity.category, `${entity.slug}.md`)
    fs.writeFileSync(filePath, formatEntry(entity.name, content))
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
