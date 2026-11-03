/**
 * PSGC loader tests use a synthetic file with obviously fake codes (region 99). Real PSGC codes are
 * only ever loaded from the PAO-supplied file (ADR-0005).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ExcelJS from 'exceljs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { DomainError } from '../src/lib/errors.js'
import { Barangay, Municipality, type MunicipalityDoc } from '../src/models/location.models.js'
import { municipalitiesWithoutPsgc } from '../src/selectors/location.selectors.js'
import {
  findPsgcFile,
  loadPsgc,
  parsePsgcRows,
  seedMunicipalities,
} from '../src/services/location.service.js'
import { runSeed } from '../src/services/seed.service.js'
import { makeBarangay } from './support/factories.js'

const HEADER = ['10-digit PSGC', 'Name', 'Correspondence Code', 'Geographic Level']
const ROWS = [
  ['9904000000', 'Marinduque', '', 'Prov'],
  ['9904001000', 'Boac (Capital)', '', 'Mun'],
  ['9904001001', 'Synthetic Alpha', '', 'Bgy'],
  ['9904001002', 'Synthetic Beta', '', 'Bgy'],
  ['9904002000', 'Gasan', '', 'Mun'],
  ['9904002001', 'Synthetic Gamma', '', 'Bgy'],
  ['9904099000', 'Not In Database', '', 'Mun'],
  ['9905000000', 'Other Province', '', 'Prov'],
  ['9905001000', 'Elsewhere', '', 'Mun'],
]

let folder: string
let xlsxPath: string
let csvPath: string

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'psgc-'))
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Notes').addRow(['Not the data sheet'])
  const sheet = workbook.addWorksheet('PSGC')
  sheet.addRow(['Philippine Standard Geographic Code (synthetic test file)'])
  sheet.addRow(HEADER)
  sheet.addRows(ROWS.map((row, index) => (index === 0 ? [Number(row[0]), ...row.slice(1)] : row)))
  xlsxPath = join(folder, 'psgc-synthetic.xlsx')
  await workbook.xlsx.writeFile(xlsxPath)
  csvPath = join(folder, 'psgc-synthetic.csv')
  await writeFile(csvPath, [HEADER, ...ROWS].map((row) => row.join(',')).join('\n'))
})

afterAll(async () => {
  await rm(folder, { recursive: true, force: true })
})

beforeEach(async () => {
  await Barangay.deleteMany({})
  await Municipality.deleteMany({})
})

async function town(name: string): Promise<MunicipalityDoc> {
  return (await Municipality.findOne({ name }).lean<MunicipalityDoc>()) as MunicipalityDoc
}

describe('seedMunicipalities', () => {
  it('is idempotent and invents no codes', async () => {
    expect(await seedMunicipalities()).toBe(6)
    expect(await seedMunicipalities()).toBe(0)
    const rows = await Municipality.find().sort({ name: 1 }).lean()
    expect(rows.map((row) => row.name)).toEqual([
      'Boac',
      'Buenavista',
      'Gasan',
      'Mogpog',
      'Santa Cruz',
      'Torrijos',
    ])
    expect(rows.every((row) => row.psgcCode === null)).toBe(true)
  })
})

describe('barangay names', () => {
  it('are unique per municipality after normalizing', async () => {
    await seedMunicipalities()
    const boac = await town('Boac')
    const gasan = await town('Gasan')
    await Promise.all([Barangay.init(), Municipality.init()])
    await makeBarangay(boac._id, 'Sta. Rosa')
    await makeBarangay(gasan._id, 'Sta. Rosa')
    await expect(makeBarangay(boac._id, 'sta rosa')).rejects.toThrow(/duplicate key/)
  })
})

describe('loadPsgc', () => {
  beforeEach(async () => {
    await seedMunicipalities()
  })

  it('codes towns, verifies matches, and reports what it could not match', async () => {
    const boac = await town('Boac')
    const gasan = await town('Gasan')
    const imported = await makeBarangay(boac._id, 'Synthetic Alpha')
    await makeBarangay(gasan._id, 'Typo Barangay')

    const report = await loadPsgc(xlsxPath, { province: 'Marinduque' })

    expect(report.municipalitiesCoded.sort()).toEqual(['Boac', 'Gasan'])
    expect(report.municipalitiesMissing).toEqual(['Not In Database'])
    expect(report.barangaysVerified).toBe(1)
    expect(report.barangaysCreated).toBe(2)
    expect(report.barangaysUnmatched).toEqual(['Typo Barangay, Gasan'])
    const after = await Barangay.findOne({ _id: imported._id }).lean()
    expect([after?.psgcCode, after?.isVerified]).toEqual(['9904001001', true])
    expect((await town('Boac')).psgcCode).toBe('9904001000')
    expect(await Barangay.exists({ name: 'Elsewhere' })).toBeNull()
  })

  it('changes nothing on a dry run', async () => {
    const report = await loadPsgc(xlsxPath, { province: 'Marinduque', dryRun: true })
    expect(report.barangaysCreated).toBe(3)
    expect(await Barangay.countDocuments()).toBe(0)
    expect((await town('Boac')).psgcCode).toBeNull()
  })

  it('reads a CSV export', async () => {
    const report = await loadPsgc(csvPath, { province: 'marinduque' })
    expect(report.barangaysCreated).toBe(3)
  })

  it('can run again without creating anything new', async () => {
    await loadPsgc(xlsxPath, { province: 'Marinduque' })
    const again = await loadPsgc(xlsxPath, { province: 'Marinduque' })
    expect(again.barangaysCreated).toBe(0)
    expect(again.barangaysVerified).toBe(3)
  })

  it('refuses an unknown province', async () => {
    const attempt = loadPsgc(xlsxPath, { province: 'Nowhere' })
    await expect(attempt).rejects.toMatchObject({ code: 'psgc_province' })
  })

  it('refuses a file without the header row', async () => {
    const path = join(folder, 'bad.csv')
    await writeFile(path, 'a,b,c\n1,2,3\n')
    await expect(loadPsgc(path, { province: 'Marinduque' })).rejects.toMatchObject({
      code: 'psgc_format',
    })
  })
})

describe('parsePsgcRows', () => {
  it('restores leading zeros, drops a float tail, and skips empty codes', () => {
    const rows = parsePsgcRows([
      ['PSGC', 'Name', 'Level'],
      ['140000000', 'Sample', 'Reg'],
      ['1704000000.0', 'Sample Two', 'Prov'],
      ['', 'No code', 'Mun'],
      ['0', 'Zero code', 'Mun'],
    ])
    expect(rows).toEqual([
      { code: '0140000000', name: 'Sample', level: 'reg' },
      { code: '1704000000', name: 'Sample Two', level: 'prov' },
    ])
  })

  it('raises a DomainError with no header', () => {
    expect(() => parsePsgcRows([['a', 'b']])).toThrow(DomainError)
  })
})

describe('the seed', () => {
  it('uses the reference file when there is one', async () => {
    const lines = await runSeed(folder)
    expect(lines.join('\n')).toContain('PSGC: 2 municipalities coded')
  })

  it('leaves codes empty and says so when there is none', async () => {
    const empty = join(folder, 'empty')
    const lines = await runSeed(empty)
    expect(lines.join('\n')).toContain('No PSGC file')
    expect(await Municipality.countDocuments()).toBe(6)
  })

  it('picks only PSGC spreadsheets', async () => {
    await writeFile(join(folder, 'notes.xlsx'), '')
    await writeFile(join(folder, 'psgc.txt'), '')
    expect(await findPsgcFile(folder)).toBe(xlsxPath)
  })
})

describe('municipalitiesWithoutPsgc', () => {
  it('names the towns until the file is loaded', async () => {
    await seedMunicipalities()
    expect(await municipalitiesWithoutPsgc()).toHaveLength(6)
    let code = 0
    for (const row of await Municipality.find()) {
      code += 1
      row.psgcCode = `99${String(code).padStart(8, '0')}`
      await row.save()
    }
    expect(await municipalitiesWithoutPsgc()).toEqual([])
  })
})
