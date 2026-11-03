/**
 * Uploaded workbooks and error reports hold personal data, so they live outside anything served
 * publicly and are reached only through signed-in, scoped, audited routes (ADR-0009).
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const DEFAULT_DIR = join(import.meta.dirname, '..', '..', '..', 'private_files')

function root(): string {
  return resolve(process.env.PRIVATE_FILES_DIR ?? DEFAULT_DIR)
}

/** Refuses any stored path that would escape the private folder. */
function locate(relative: string): string {
  const base = root()
  const full = resolve(base, relative)
  if (!full.startsWith(base + sep)) throw new Error('Path is outside the private files folder.')
  return full
}

/** Saves under a generated name, so nothing from the upload's name reaches the file system. */
export async function savePrivateFile(
  folder: 'imports' | 'import-errors',
  suffix: '.xlsx' | '.csv',
  content: Buffer,
): Promise<string> {
  const now = new Date()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const relative = [folder, String(now.getUTCFullYear()), month, `${randomUUID()}${suffix}`].join(
    '/',
  )
  const full = locate(relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, { flag: 'wx' })
  return relative
}

export async function readPrivateFile(relative: string): Promise<Buffer> {
  return readFile(locate(relative))
}

export async function removePrivateFile(relative: string): Promise<void> {
  await rm(locate(relative), { force: true })
}
