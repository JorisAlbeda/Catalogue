import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chatJSON } from "./llm.js"
import { search, searchBySource } from "./search.js"

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
// Hard ceiling on total chunks fed into a single entry prompt, even after
// backfilling missing sources — past this, a small local model tends to
// lose the instruction entirely and free-write narrative instead of JSON.
const MAX_CONTEXT_CHUNKS = 12
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

function capitalizeFirst(name: string): string {
  return name.length > 0 ? name[0].toUpperCase() + name.slice(1) : name
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
        const name = capitalizeFirst(rawName.trim())
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

interface MergeGroup {
  canonical: string
  aliases: string[]
}

function reconciliationPrompt(
  category: Category,
  listing: string[],
): string {
  return `Below is a list of ${category} extracted independently from multiple documents describing a fantasy campaign setting. Some entries may refer to the exact same entity under different names, nicknames, or aliases (for example "Ring" / "The Ring" / "Signet Ring", "Perrin" / "Perrin Ashe", or a relic named once by its object type and once by its epithet). Each entry includes a short snippet of source text for context.

${listing.join("\n")}

Group entries that refer to the same real entity together. For each group, choose the most complete and specific name as canonical (e.g. prefer "Perrin Ashe" over "Perrin"). Do not group entries together just because they are similar, related, or appear near each other in the story — only group them if they are the same entity.

Respond with ONLY a JSON object in this exact shape, with no extra commentary:
{"groups": [{"canonical": string, "aliases": string[]}]}

Every input name must appear in exactly one group, either as the canonical name or in its aliases list.`
}

async function reconcileCategory(
  category: Category,
  entities: CatalogueEntity[],
): Promise<CatalogueEntity[]> {
  if (entities.length < 2) return entities

  const listing = await Promise.all(
    entities.map(async (entity) => {
      const [top] = await search(entity.name, 1)
      const snippet = top ? top.content.slice(0, 200).replace(/\s+/g, " ") : ""
      return `- "${entity.name}": ${snippet}`
    }),
  )

  const { groups } = await chatJSON<{ groups: MergeGroup[] }>(
    reconciliationPrompt(category, listing),
  )

  const byName = new Map(entities.map((e) => [e.name, e]))
  const merged: CatalogueEntity[] = []
  const consumed = new Set<string>()

  for (const group of groups ?? []) {
    const members = [group.canonical, ...(group.aliases ?? [])]
      .map((name) => byName.get(name))
      .filter((e): e is CatalogueEntity => Boolean(e))
    if (members.length === 0) continue
    for (const member of members) consumed.add(member.name)

    const canonicalName = byName.has(group.canonical)
      ? group.canonical
      : members[0].name
    merged.push({
      name: canonicalName,
      slug: slugify(canonicalName),
      category,
      sources: [...new Set(members.flatMap((m) => m.sources))],
    })
  }

  // Safety net: keep anything the model didn't place in a group rather than
  // silently dropping it.
  for (const entity of entities) {
    if (!consumed.has(entity.name)) merged.push(entity)
  }

  return merged
}

export async function reconcileCatalogue(
  entities: CatalogueEntity[],
): Promise<CatalogueEntity[]> {
  const result: CatalogueEntity[] = []
  for (const category of CATEGORIES) {
    const inCategory = entities.filter((e) => e.category === category)
    console.log(
      `[phase 1.5] reconciling ${inCategory.length} ${category} for duplicates`,
    )
    result.push(...(await reconcileCategory(category, inCategory)))
  }
  return result
}

async function buildContext(entity: CatalogueEntity): Promise<string> {
  const matches: Array<{ source: string; content: string }> = await search(
    entity.name,
    ENTRY_CONTEXT_CHUNKS,
  )
  if (matches.length === 0) {
    console.warn(
      `[phase 2] no indexed chunks found for "${entity.name}" — is the RAG index built (npm run setup)?`,
    )
  }

  // A similarity search ranks globally, so a source doc that was merged into
  // this entity (phase 1.5) can still be entirely absent from `matches` if a
  // more prolific doc crowds it out. Backfill any missing source directly so
  // every document the entity was found in gets at least some representation
  // — but a small local model loses the ability to follow instructions (and
  // starts free-writing narrative instead of the requested JSON) once context
  // grows into the tens of thousands of characters, so the total is capped
  // regardless of how many sources the entity has merged.
  const coveredSources = new Set(matches.map((m) => m.source))
  const missingSources = entity.sources.filter((s) => !coveredSources.has(s))
  for (const source of missingSources) {
    if (matches.length >= MAX_CONTEXT_CHUNKS) break
    matches.push(...searchBySource(source, 1))
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
Write the "description" and "history" entirely in past tense, even if the source text uses present tense.

Respond with ONLY a JSON object in this exact shape, with no extra commentary:
{"description": string, "history": string, "location": string}

- "description": ${length}, in past tense, describing what "${entity.name}" was.
- "history": ${length}, in past tense, covering its history, or how it came to be, as described in the text.
- "location": the ${locationKind} most associated with "${entity.name}". ${locationRule}

SOURCE TEXT:
${context}`
}

function normalizeLocation(
  raw: string | undefined,
  candidateLocations: string[],
): string {
  const match = candidateLocations.find(
    (name) => name.toLowerCase() === (raw ?? "").trim().toLowerCase(),
  )
  return match ?? "Unknown"
}

// Ollama's JSON mode guarantees syntactically valid JSON, not that the model
// actually included every requested key with the requested type — a
// "well-formed" response can still have a field missing, or e.g. an array of
// sentences instead of a string. Coerce whatever comes back to text.
function asText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(" ")
  if (value == null) return ""
  return String(value).trim()
}

function normalizeEntryContent(
  raw: Partial<EntityEntryContent> | null | undefined,
): EntityEntryContent {
  return {
    description: asText(raw?.description),
    history: asText(raw?.history),
    location: asText(raw?.location),
  }
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
  skipExisting = false,
): Promise<void> {
  const locationNames = entities
    .filter((e) => e.category === "locations")
    .map((e) => e.name)

  const ordered = [...entities].sort(
    (a, b) =>
      PROCESS_ORDER.indexOf(a.category) - PROCESS_ORDER.indexOf(b.category),
  )

  for (const [i, entity] of ordered.entries()) {
    const filePath = path.join(codexDir, entity.category, `${entity.slug}.md`)
    if (skipExisting && fs.existsSync(filePath)) {
      console.log(
        `[phase 2] skipping ${i + 1}/${ordered.length}: ${entity.category}/${entity.slug} (already written)`,
      )
      continue
    }

    console.log(
      `[phase 2] writing ${i + 1}/${ordered.length}: ${entity.category}/${entity.slug}`,
    )
    try {
      const context = await buildContext(entity)
      const important = entity.sources.length >= IMPORTANT_SOURCE_THRESHOLD
      const candidateLocations = locationNames.filter(
        (name) => name !== entity.name,
      )
      const raw = await chatJSON<Partial<EntityEntryContent>>(
        entryPrompt(entity, context, candidateLocations, important),
      )
      const content = normalizeEntryContent(raw)
      if (!content.description || !content.history) {
        console.warn(
          `[phase 2] model response for ${entity.category}/${entity.slug} was missing fields — writing what we got`,
        )
      }
      content.location = normalizeLocation(content.location, candidateLocations)
      fs.writeFileSync(filePath, formatEntry(entity.name, content))
    } catch (err) {
      console.error(
        `[phase 2] failed to write ${entity.category}/${entity.slug}, skipping:`,
        err,
      )
    }
  }
}

async function main() {
  const shouldContinue = process.argv.includes("--continue")

  let entities: CatalogueEntity[]
  if (shouldContinue) {
    console.log(`Resuming phase 2 from existing ${MANIFEST_PATH}`)
    entities = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
  } else {
    // Phase 1: discover entities from the documents and set up the folder structure
    const files = walk(DOCUMENTS_DIR)
    console.log(`Found ${files.length} document(s) in ${DOCUMENTS_DIR}`)

    const rawEntities = await extractCatalogue(files)
    console.log(`Extracted ${rawEntities.length} raw entities`)

    // Phase 1.5: merge remaining cross-document duplicates the model didn't
    // catch during extraction
    entities = await reconcileCatalogue(rawEntities)
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(entities, null, 2))
    console.log(`Catalogued ${entities.length} entities -> ${MANIFEST_PATH}`)
  }

  for (const category of CATEGORIES) {
    fs.mkdirSync(path.join(CODEX_DIR, category), { recursive: true })
  }

  // Phase 2: populate one file per entity. When resuming, skip entities that
  // already have a file on disk from before the interruption.
  await populateCodex(entities, CODEX_DIR, shouldContinue)
  console.log("Done.")
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
