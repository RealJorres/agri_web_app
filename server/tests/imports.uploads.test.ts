import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { buildWorkbook } from './support/workbookFixture.js'
import { checkUpload, MAX_UPLOAD_BYTES } from '../src/services/imports/uploads.js'

/** A minimal zip, so a test controls exactly which parts a "workbook" has. */
function zipOf(parts: Record<string, Buffer | string>): Buffer {
  const locals: Buffer[] = []
  const entries: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(parts)) {
    const raw = Buffer.from(data)
    const packed = deflateRawSync(raw)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    entries.push(entry, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const directory = Buffer.concat(entries)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const VALID = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' }

function messageOf(attempt: () => unknown): string {
  try {
    attempt()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('checkUpload', () => {
  it('accepts a real workbook and returns its digest', async () => {
    const { sha256, suffix } = checkUpload('ok.xlsx', await buildWorkbook())
    expect(sha256).toHaveLength(64)
    expect(suffix).toBe('.xlsx')
  })

  it('accepts a minimal valid workbook', () => {
    expect(checkUpload('ok.xlsx', zipOf(VALID)).sha256).toHaveLength(64)
  })

  it.each<[string, Buffer, string]>([
    ['book.xls', Buffer.from('x'), 'Only'],
    ['book.xlsm', zipOf(VALID), 'Only'],
    ['book.exe', Buffer.from('x'), 'Only'],
    ['empty.xlsx', Buffer.alloc(0), 'empty'],
    ['fake.xlsx', Buffer.from('not a zip at all, but long enough to scan'), 'not a valid'],
    ['tiny.xlsx', Buffer.from('x'), 'not a valid'],
    ['macro.xlsx', zipOf({ ...VALID, 'xl/vbaProject.bin': Buffer.alloc(10) }), 'macros'],
    ['bomb.xlsx', zipOf({ ...VALID, 'xl/big.xml': Buffer.alloc(5 * 1024 * 1024) }), 'unsafe size'],
    ['odd.xlsx', zipOf({ 'hello.txt': 'hi' }), 'not a valid'],
  ])('refuses %s', (name, content, message) => {
    expect(messageOf(() => checkUpload(name, content))).toContain(message)
  })

  it('names the file field in its error', () => {
    let fields: unknown
    try {
      checkUpload('book.xls', Buffer.from('x'))
    } catch (error) {
      fields = (error as { fields: unknown }).fields
    }
    expect(fields).toHaveProperty('file')
  })

  it('enforces the size limit', () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1)
    expect(messageOf(() => checkUpload('big.xlsx', big))).toContain('10 MB')
  })

  it('allows a CSV only where permitted', () => {
    const csv = Buffer.from('a,b\n1,2\n')
    expect(checkUpload('rows.csv', csv).suffix).toBe('.csv')
    expect(messageOf(() => checkUpload('rows.csv', csv, ['.xlsx']))).toContain('Only')
  })
})
