/** Upload safety checks (brief §12): .xlsx or .csv only, 10 MB, no macros, no zip bombs. */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

import { DomainError } from '../../lib/errors.js'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 100
const MAX_ZIP_MEMBERS = 2000

export type UploadSuffix = '.xlsx' | '.csv'

export function rejectUpload(message: string): DomainError {
  return new DomainError('invalid_upload', message, { file: [message] })
}

interface ZipMember {
  name: string
  compressedSize: number
  uncompressedSize: number
}

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const END_RECORD_SIZE = 22
const ENTRY_HEADER_SIZE = 46
const MAX_COMMENT = 0xffff
const ZIP64_MARKER = 0xffffffff

/** Reads the zip's table of contents without unpacking anything. Null when it is not a zip. */
function zipMembers(content: Buffer): ZipMember[] | null {
  const earliest = Math.max(0, content.length - END_RECORD_SIZE - MAX_COMMENT)
  let end = -1
  for (let i = content.length - END_RECORD_SIZE; i >= earliest; i -= 1) {
    if (content.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = content.readUInt16LE(end + 10)
  let offset = content.readUInt32LE(end + 16)
  const members: ZipMember[] = []
  for (let i = 0; i < count; i += 1) {
    if (offset + ENTRY_HEADER_SIZE > content.length) return null
    if (content.readUInt32LE(offset) !== DIRECTORY_ENTRY) return null
    const compressedSize = content.readUInt32LE(offset + 20)
    const uncompressedSize = content.readUInt32LE(offset + 24)
    const nameLength = content.readUInt16LE(offset + 28)
    const extraLength = content.readUInt16LE(offset + 30)
    const commentLength = content.readUInt16LE(offset + 32)
    // Sizes this large do not fit a 10 MB office workbook, so a zip64 entry is simply refused.
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) return null
    const nameStart = offset + ENTRY_HEADER_SIZE
    members.push({
      name: content.toString('utf8', nameStart, nameStart + nameLength),
      compressedSize,
      uncompressedSize,
    })
    offset = nameStart + nameLength + extraLength + commentLength
  }
  return members
}

function checkXlsx(content: Buffer): void {
  const members = content.length >= END_RECORD_SIZE ? zipMembers(content) : null
  if (!members) throw rejectUpload('This is not a valid .xlsx workbook.')
  if (members.length > MAX_ZIP_MEMBERS) throw rejectUpload('The workbook has too many parts.')
  const names = members.map((member) => member.name.toLowerCase())
  if (!names.includes('[content_types].xml') || !names.some((name) => name.startsWith('xl/'))) {
    throw rejectUpload('This is not a valid .xlsx workbook.')
  }
  if (names.some((name) => name.endsWith('vbaproject.bin'))) {
    throw rejectUpload('Workbooks with macros are not accepted. Save as .xlsx without macros.')
  }
  const total = members.reduce((sum, member) => sum + member.uncompressedSize, 0)
  const packed = members.reduce((sum, member) => sum + member.compressedSize, 0) || 1
  if (total > MAX_UNCOMPRESSED_BYTES || total / packed > MAX_COMPRESSION_RATIO) {
    throw rejectUpload('The workbook expands to an unsafe size.')
  }
}

/** Checks an upload and returns its SHA-256 with its suffix. */
export function checkUpload(
  name: string,
  content: Buffer,
  allowed: readonly UploadSuffix[] = ['.xlsx', '.csv'],
): { sha256: string; suffix: UploadSuffix } {
  const suffix = extname(name).toLowerCase() as UploadSuffix
  if (!allowed.includes(suffix)) {
    throw rejectUpload(`Only ${[...allowed].sort().join(', ')} files are accepted.`)
  }
  if (content.length > MAX_UPLOAD_BYTES) throw rejectUpload('The file is larger than 10 MB.')
  if (content.length === 0) throw rejectUpload('The file is empty.')
  if (suffix === '.xlsx') checkXlsx(content)
  return { sha256: createHash('sha256').update(content).digest('hex'), suffix }
}
