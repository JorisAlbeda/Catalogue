import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { indexFile } from "./db.js"
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
  seed: CatalogueEntity[] = [],
): Promise<CatalogueEntity[]> {
  const entities = new Map<string, CatalogueEntity>()
  for (const entity of seed) {
    entities.set(`${entity.category}:${entity.slug}`, {
      ...entity,
      sources: [...entity.sources],
    })
  }

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Names like "Perrin" / "Perrin Ashe" are common in this material (a
// character introduced casually, then given their full name later) and
// don't need semantic judgement to catch — a whole-word substring check is
// cheap and exact where the LLM reconciliation pass below (one call asked to
// group an entire category's worth of names at once) is probabilistic and,
// in practice, misses obvious cases. This runs first so it also shrinks the
// list the model has to reason about. It deliberately does NOT catch
// non-lexical aliases (e.g. "Sticky Fire" / "Verdflayme orb") — those still
// rely on the LLM pass.
function mergeNameSubstrings(entities: CatalogueEntity[]): CatalogueEntity[] {
  const byLength = [...entities].sort((a, b) => b.name.length - a.name.length)
  const merged: CatalogueEntity[] = []

  for (const entity of byLength) {
    const target = merged.find((m) =>
      new RegExp(`\\b${escapeRegExp(entity.name)}\\b`, "i").test(m.name),
    )
    if (target) {
      target.sources = [...new Set([...target.sources, ...entity.sources])]
    } else {
      merged.push({ ...entity, sources: [...entity.sources] })
    }
  }

  return merged
}

async function reconcileCategory(
  category: Category,
  entitiesIn: CatalogueEntity[],
): Promise<CatalogueEntity[]> {
  const entities = mergeNameSubstrings(entitiesIn)
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
    const requestedNames = [group.canonical, ...(group.aliases ?? [])]
    const members = requestedNames
      .map((name) => byName.get(name))
      .filter((e): e is CatalogueEntity => Boolean(e))
    if (members.length === 0) {
      // The model's canonical/alias strings didn't match any input name
      // verbatim (paraphrase, typo, invented name) — nothing to merge, but
      // logged so a silently-ignored group is visible rather than invisible.
      console.warn(
        `[phase 1.5] ${category}: reconciliation group [${requestedNames.join(", ")}] matched no known name, ignoring`,
      )
      continue
    }
    for (const member of members) consumed.add(member.name)

    const canonicalName = byName.has(group.canonical)
      ? group.canonical
      : members[0].name
    if (members.length > 1) {
      console.log(
        `[phase 1.5] ${category}: merged [${members.map((m) => m.name).join(", ")}] -> "${canonicalName}"`,
      )
    }
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

// "buildings" and "locations" overlap conceptually (a temple is both a
// constructed structure and a place), so the same entity can legitimately
// get extracted into both category buckets across documents.
// reconcileCategory only ever compares entities within one category, so a
// same-named entry in two categories is never even considered for merging
// there — this catches that case with a plain case-insensitive name match.
// Ties prefer "locations": every entity's own "location" field is chosen
// from the locations list only, so a same-named "buildings" entry is
// otherwise invisible to the rest of the codex either way.
const CATEGORY_MERGE_PRIORITY: Category[] = [
  "locations",
  "buildings",
  "characters",
  "events",
  "relics",
]

function mergeCrossCategoryDuplicates(
  entities: CatalogueEntity[],
): CatalogueEntity[] {
  const byLowerName = new Map<string, CatalogueEntity[]>()
  for (const entity of entities) {
    const key = entity.name.toLowerCase()
    const group = byLowerName.get(key) ?? []
    group.push(entity)
    byLowerName.set(key, group)
  }

  const drop = new Set<CatalogueEntity>()
  for (const group of byLowerName.values()) {
    if (group.length < 2) continue
    group.sort(
      (a, b) =>
        CATEGORY_MERGE_PRIORITY.indexOf(a.category) -
        CATEGORY_MERGE_PRIORITY.indexOf(b.category),
    )
    const [canonical, ...rest] = group
    for (const dup of rest) {
      canonical.sources = [...new Set([...canonical.sources, ...dup.sources])]
      drop.add(dup)
      console.log(
        `[phase 1.5] merging cross-category duplicate ${dup.category}/${dup.slug} -> ${canonical.category}/${canonical.slug}`,
      )
    }
  }

  return entities.filter((e) => !drop.has(e))
}

export async function reconcileCatalogue(
  entities: CatalogueEntity[],
  categoriesToReconcile: readonly Category[] = CATEGORIES,
): Promise<CatalogueEntity[]> {
  const result: CatalogueEntity[] = []
  for (const category of CATEGORIES) {
    const inCategory = entities.filter((e) => e.category === category)
    if (!categoriesToReconcile.includes(category)) {
      result.push(...inCategory)
      continue
    }
    console.log(
      `[phase 1.5] reconciling ${inCategory.length} ${category} for duplicates`,
    )
    result.push(...(await reconcileCategory(category, inCategory)))
  }
  return mergeCrossCategoryDuplicates(result)
}

export async function buildContext(entity: CatalogueEntity): Promise<string> {
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
  allEntities: CatalogueEntity[] = entities,
): Promise<void> {
  const locationNames = allEntities
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

function titleCaseFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => capitalizeFirst(word))
    .join(" ")
}

export interface SyncResult {
  added: number
  removed: number
  renamed: number
}

// Reconciles manifest.json against whatever's actually on disk under
// codex/<category>/*.md — needed because the manifest is the only place
// `sources` history lives, and both updateCodex and command.ts trust it to
// know what exists. Files can drift out of sync with it via direct manual
// edits (rename/delete) in codex/. When codex/ is git-tracked, git's own
// rename detection (`git diff --name-status -M`) lets a rename carry its
// `sources` forward instead of resetting to empty, same as a plain add.
export function syncManifest(): SyncResult {
  const existing: CatalogueEntity[] = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : []
  const byKey = new Map(existing.map((e) => [`${e.category}:${e.slug}`, e]))

  const onDisk = new Set<string>()
  for (const category of CATEGORIES) {
    const dir = path.join(CODEX_DIR, category)
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      onDisk.add(`${category}:${file.slice(0, -3)}`)
    }
  }

  const keyFromPath = (p: string): string | null => {
    const match = p
      .replace(/\\/g, "/")
      .match(/codex\/([^/]+)\/([^/]+)\.md$/)
    if (!match) return null
    const [, category, slug] = match
    return (CATEGORIES as readonly string[]).includes(category)
      ? `${category}:${slug}`
      : null
  }

  const renames = new Map<string, string>()
  try {
    // `HEAD` here matters: a plain `git diff` only shows unstaged changes,
    // so a rename already staged (e.g. via `git mv`, or an IDE that stages
    // automatically) would be invisible to it. Diffing against HEAD catches
    // a rename regardless of whether it's staged yet.
    const diff = execSync("git diff --name-status -M HEAD -- codex/", {
      encoding: "utf8",
    })
    for (const line of diff.split("\n")) {
      const match = line.match(/^R\d*\t(.+?)\t(.+)$/)
      if (!match) continue
      const oldKey = keyFromPath(match[1])
      const newKey = keyFromPath(match[2])
      if (oldKey && newKey) renames.set(oldKey, newKey)
    }
  } catch {
    // git not available, or codex/ isn't tracked yet — no rename info,
    // everything just falls through to plain add/remove below.
  }

  let added = 0
  let removed = 0
  let renamed = 0
  const result: CatalogueEntity[] = []
  const handledDiskKeys = new Set<string>()

  for (const [oldKey, entity] of byKey) {
    if (onDisk.has(oldKey)) {
      result.push(entity)
      handledDiskKeys.add(oldKey)
      continue
    }
    const newKey = renames.get(oldKey)
    if (newKey && onDisk.has(newKey) && !handledDiskKeys.has(newKey)) {
      const [category, slug] = newKey.split(":") as [Category, string]
      result.push({ ...entity, category, slug, name: titleCaseFromSlug(slug) })
      handledDiskKeys.add(newKey)
      renamed++
      console.log(`[sync] renamed ${oldKey} -> ${newKey}, sources preserved`)
      continue
    }
    removed++
    console.log(`[sync] removed ${oldKey} (file no longer exists)`)
  }

  for (const key of onDisk) {
    if (handledDiskKeys.has(key)) continue
    const [category, slug] = key.split(":") as [Category, string]
    result.push({ name: titleCaseFromSlug(slug), slug, category, sources: [] })
    added++
    console.log(`[sync] added ${key} (new file, no source history)`)
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(result, null, 2))
  console.log(`[sync] ${added} added, ${removed} removed, ${renamed} renamed`)
  return { added, removed, renamed }
}

// Refuses to proceed if codex/ has uncommitted changes, so a command's
// resulting diff is cleanly attributable to that run alone (and a bad run
// is a plain `git checkout -- codex/` away from being undone).
export function assertCleanCodexTree(): void {
  let status: string
  try {
    status = execSync("git status --porcelain -- codex/", { encoding: "utf8" })
  } catch {
    return // git not available — nothing to check against
  }
  if (status.trim().length > 0) {
    throw new Error(
      "codex/ has uncommitted changes — commit or stash them first so this run's changes are cleanly diffable.",
    )
  }
}

// Indexes a second folder of documents and folds any entities found in it
// into the existing manifest: new entities get their own codex entry, and
// existing entities that gained a new source get their entry fully
// regenerated from their complete (old + new) context. Categories untouched
// by this batch are left alone, including on disk.
export async function updateCodex(newDocsDir: string): Promise<void> {
  assertCleanCodexTree()
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `No ${MANIFEST_PATH} found — run "npm run catalogue" first.`,
    )
  }
  syncManifest()
  const existingEntities: CatalogueEntity[] = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf8"),
  )
  const originalByKey = new Map(
    existingEntities.map((e) => [`${e.category}:${e.slug}`, e]),
  )

  const newFiles = walk(newDocsDir)
  console.log(`Found ${newFiles.length} document(s) in ${newDocsDir}`)
  for (const [i, file] of newFiles.entries()) {
    console.log(`[update] indexing ${i + 1}/${newFiles.length}: ${file}`)
    await indexFile(file)
  }

  const merged = await extractCatalogue(newFiles, existingEntities)

  // An entity is "changed" if it's under a brand-new key (a new entity, or
  // the canonical result of a reconciliation merge/rename) or if it kept its
  // key but picked up a new source document.
  const isChanged = (e: CatalogueEntity): boolean => {
    const original = originalByKey.get(`${e.category}:${e.slug}`)
    return !original || original.sources.length !== e.sources.length
  }

  // Reconciliation only needs to run where a genuinely new *name* entered a
  // category — that's the only thing it dedupes against. An existing entity
  // merely picking up another source doesn't introduce anything new to
  // reconcile, and re-running the (probabilistic) LLM reconciliation pass
  // over a category needlessly risks reshuffling canonical names for
  // entities this update never touched. A single hallucinated extraction
  // (the small local model occasionally echoes an unrelated known name back)
  // should cost at most one spurious entity rewrite, not a whole category's
  // worth of renames.
  const isNewKey = (e: CatalogueEntity): boolean =>
    !originalByKey.has(`${e.category}:${e.slug}`)

  const touchedCategories = CATEGORIES.filter((category) =>
    merged.some((e) => e.category === category && isNewKey(e)),
  )
  console.log(
    `[update] touched categories: ${touchedCategories.join(", ") || "(none)"}`,
  )

  const reconciled = await reconcileCatalogue(merged, touchedCategories)

  // Reconciliation can rename or merge an existing entity into a new
  // canonical key, orphaning its old codex file — clean those up.
  const finalKeys = new Set(reconciled.map((e) => `${e.category}:${e.slug}`))
  for (const [oldKey, oldEntity] of originalByKey) {
    if (finalKeys.has(oldKey)) continue
    const stalePath = path.join(
      CODEX_DIR,
      oldEntity.category,
      `${oldEntity.slug}.md`,
    )
    if (fs.existsSync(stalePath)) {
      fs.unlinkSync(stalePath)
      console.log(
        `[update] removed stale ${oldEntity.category}/${oldEntity.slug} (merged/renamed)`,
      )
    }
  }

  const dirty = reconciled.filter(isChanged)
  console.log(`[update] ${dirty.length} entities need (re)writing`)

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(reconciled, null, 2))
  for (const category of CATEGORIES) {
    fs.mkdirSync(path.join(CODEX_DIR, category), { recursive: true })
  }

  await populateCodex(dirty, CODEX_DIR, false, reconciled)
  console.log("Update done.")
}

async function main() {
  if (process.argv.includes("--sync")) {
    syncManifest()
    return
  }

  const updateIdx = process.argv.indexOf("--update")
  if (updateIdx !== -1) {
    const newDocsDir = process.argv[updateIdx + 1]
    if (!newDocsDir) {
      throw new Error("Usage: npm run catalogue:update -- <folder>")
    }
    await updateCodex(newDocsDir)
    return
  }

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
