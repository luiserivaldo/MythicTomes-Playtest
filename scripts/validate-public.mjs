#!/usr/bin/env node

import { lstat, readFile, readdir, stat } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import YAML from "yaml"

const MAX_ASSET_BYTES = 25 * 1024 * 1024
const SAFE_ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp", ".pdf"])
const SAFE_ROOT_FILES = new Set(["index.md", "licensing.md", "changelog.md"])
const SAFE_ROOT_DIRECTORIES = new Set(["playtests", "catalogues", "authors", "assets"])
const UNSAFE_MARKERS = [
  /<script\b/i,
  /<iframe\b/i,
  /javascript:/i,
  /\bon(?:error|click|load)\s*=/i,
  /file:/i,
  /\/mnt\//i,
]

function fail(message) {
  throw new Error(message)
}

function parseFrontmatter(markdown, file) {
  if (!markdown.startsWith("---\n")) return {}
  const end = markdown.indexOf("\n---\n", 4)
  if (end === -1) fail(`Public Markdown has unclosed frontmatter: ${file}`)
  return YAML.parse(markdown.slice(4, end)) ?? {}
}

async function walk(directory) {
  const output = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name)
    if (item.isSymbolicLink()) fail(`Symbolic links are forbidden in public content: ${absolute}`)
    if (item.isDirectory()) output.push(...(await walk(absolute)))
    else if (item.isFile()) output.push(absolute)
    else fail(`Unsupported filesystem entry in public content: ${absolute}`)
  }
  return output
}

function assertTrackedFilesAreSafe(repositoryRoot) {
  const trackedFiles = execFileSync("git", ["-C", repositoryRoot, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
  const forbidden = [".obsidian", ".trash", "AGENTS.md", "AGENTS.override.md", "HANDOFF.md"]
  for (const name of forbidden) {
    if (trackedFiles.some((file) => file === name || file.startsWith(`${name}/`))) {
      fail(`Private or local-only repository file is forbidden: ${name}`)
    }
  }
}

export async function validatePublic({ repositoryRoot } = {}) {
  repositoryRoot ??= path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
  const contentRoot = path.join(repositoryRoot, "content")
  assertTrackedFilesAreSafe(repositoryRoot)

  for (const item of await readdir(contentRoot, { withFileTypes: true })) {
    if (item.isFile() && item.name !== ".gitkeep" && !SAFE_ROOT_FILES.has(item.name))
      fail(`Unexpected file at content root: ${item.name}`)
    if (item.isDirectory() && !SAFE_ROOT_DIRECTORIES.has(item.name))
      fail(`Unexpected directory at content root: ${item.name}`)
  }

  const authorTitles = new Map()
  const files = await walk(contentRoot)
  for (const file of files) {
    const relative = path.relative(contentRoot, file).replaceAll(path.sep, "/")
    if (path.basename(relative) === ".gitkeep") continue
    if ((await lstat(file)).isSymbolicLink()) fail(`Symbolic links are forbidden: ${relative}`)
    const extension = path.extname(file).toLowerCase()

    if (extension === ".md") {
      const markdown = await readFile(file, "utf8")
      const data = parseFrontmatter(markdown, relative)
      if (UNSAFE_MARKERS.some((marker) => marker.test(markdown)))
        fail(`Unsafe content found in ${relative}`)
      if (
        relative.startsWith("playtests/") &&
        relative !== "playtests/index.md" &&
        data.author &&
        data.title
      ) {
        const key = `${String(data.author).trim().toLowerCase()}\u0000${String(data.title).trim().toLowerCase()}`
        const existing = authorTitles.get(key)
        if (existing) fail(`Duplicate title for author ${data.author}: ${existing} and ${relative}`)
        authorTitles.set(key, relative)
      }
      continue
    }

    if (!SAFE_ASSET_EXTENSIONS.has(extension)) fail(`Unsupported public asset type: ${relative}`)
    if ((await stat(file)).size > MAX_ASSET_BYTES) fail(`Public asset exceeds 25 MiB: ${relative}`)
  }

  console.log(
    `Validated ${authorTitles.size} uniquely identified work(s) and ${files.length} public content file(s)`,
  )
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validatePublic().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
