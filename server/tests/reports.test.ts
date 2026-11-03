import { crc32, deflateSync } from 'node:zlib'

import ExcelJS from 'exceljs'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import { FULL_SCOPE, type Actor } from '../src/lib/scoping.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import {
  Commodity,
  type CommodityDoc,
  GrowthStage,
  Program,
  Variety,
  MaterialSource,
  Unit,
} from '../src/models/catalog.models.js'
import { CropStand, Farm, Planting } from '../src/models/farm.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../src/models/location.models.js'
import { Farmer } from '../src/models/registry.models.js'
import { ReportSettings, ReportSignoff, Signatory } from '../src/models/report.models.js'
import { InventoryRecord, SurveyRound, type SurveyRoundDoc } from '../src/models/survey.models.js'
import { getScope } from '../src/selectors/accounts.selectors.js'
import {
  contentHash,
  municipalListContent,
  reportLogo,
  summaryContent,
} from '../src/selectors/report.selectors.js'
import { signOffSummary, signoffStatus } from '../src/services/report.service.js'
import {
  municipalListPdf,
  municipalListXlsx,
  summaryPdf,
  summaryXlsx,
} from '../src/services/reportRender.js'
import { closeRound, reopen } from '../src/services/survey.service.js'
import { contractProblems, schemaProblems } from './support/contract.js'
import {
  actorFor,
  cacao,
  makeBarangay,
  makeFarm,
  makeFarmer,
  makeMunicipality,
  makeRecord,
  makeRound,
  makeStand,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

let gasanId: string
let boacId: string
let gasan: BarangayDoc
let boac: BarangayDoc
let crop: CommodityDoc
let round: SurveyRoundDoc
let coordinator: Actor

const standIn = async (barangay: BarangayDoc, farmerId?: string) =>
  makeStand(await makeFarm(barangay, farmerId ? { farmerId } : {}))

async function freshRound() {
  return (await SurveyRound.findOne({ _id: round._id }).lean()) as SurveyRoundDoc
}

async function close() {
  await closeRound({ actor: coordinator, roundId: round._id })
  round = await freshRound()
}

async function sheetFrom(data: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data as unknown as ArrayBuffer)
  return workbook.worksheets[0] as ExcelJS.Worksheet
}

function valuesOf(sheet: ExcelJS.Worksheet): unknown[] {
  const values: unknown[] = []
  sheet.eachRow((row) => {
    values.push(...(row.values as unknown[]))
  })
  return values
}

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => {
      done(null, Buffer.concat(chunks))
    })
  })

/** A valid one-pixel PNG, built here so the test holds no opaque binary. */
function onePixelPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 128, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

beforeEach(async () => {
  await Promise.all(
    [
      Municipality,
      Barangay,
      Program,
      Commodity,
      GrowthStage,
      Variety,
      MaterialSource,
      Unit,
      Farmer,
      Farm,
      CropStand,
      Planting,
      SurveyRound,
      InventoryRecord,
      ReportSignoff,
      ReportSettings,
      Signatory,
    ].map((model) => model.collection.deleteMany({})),
  )
  gasanId = (await makeMunicipality('Gasan'))._id
  boacId = (await makeMunicipality('Boac'))._id
  gasan = await makeBarangay(gasanId, 'Synthetic Gasan')
  boac = await makeBarangay(boacId, 'Synthetic Boac')
  crop = await cacao()
  coordinator = await actorFor(await userWithRole(Role.PROGRAM_COORDINATOR))
  round = await makeRound(crop, {
    name: 'Synthetic 2023',
    asOfDate: new Date('2023-07-31T00:00:00Z'),
  })
  const farmer = await makeFarmer(gasan, { firstName: 'Juana', lastName: 'Samplereport' })
  await makeRecord({
    stand: await standIn(gasan, farmer._id),
    round,
    counts: { SEEDLING: 100, FRUITING: 300 },
    status: 'approved',
  })
  // The same farmer's second farm: one farmer, not two.
  await makeRecord({
    stand: await standIn(gasan, farmer._id),
    round,
    counts: { FRUITING: 25 },
    status: 'approved',
  })
  // No counts at all: not a farmer "with trees".
  await makeRecord({ stand: await standIn(gasan), round, status: 'approved' })
  await makeRecord({
    stand: await standIn(boac),
    round,
    counts: { VEGETATIVE: 1250 },
    status: 'approved',
  })
  // Never in an official report.
  await makeRecord({
    stand: await standIn(boac),
    round,
    counts: { FRUITING: 9999 },
    status: 'draft',
  })
})

describe('summary content', () => {
  it('comes from official records only', async () => {
    const content = await summaryContent(round, FULL_SCOPE)
    const rows = Object.fromEntries(content.rows.map((row) => [row.municipality, row]))
    expect(rows.Gasan?.trees_total).toBe(425)
    expect(rows.Gasan?.farmers).toBe(1)
    expect(rows.Boac?.trees_total).toBe(1250)
    expect(rows.Boac?.area_total).toBe('2.000')
    expect(content.total.trees_total).toBe(1675)
    expect(content.total.farmers).toBe(2)
    expect(content.density_note).toBe('625 cacao trees/hectare with 4x4 planting distance')
    expect(content.final).toBe(false)
    expect(content.rows.map((row) => row.municipality)).toEqual(['Boac', 'Gasan'])
  })

  it('is scoped', async () => {
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: boacId })
    const content = await summaryContent(round, await getScope(validator))
    expect(content.rows.map((row) => row.municipality)).toEqual(['Boac'])
  })

  it('uses the configured letterhead and signatories', async () => {
    await ReportSettings.create({
      _id: 'current',
      letterhead: 'Line one\n\n  Line two  ',
      programLine: 'Sample program',
    })
    await Signatory.create([
      { reportKind: 'summary', order: 2, caption: 'Noted:', name: 'Sample Second', title: 'Head' },
      { reportKind: 'summary', order: 1, caption: 'Prepared by:', name: 'Sample First' },
      { reportKind: 'municipal_list', order: 1, caption: 'Other:', name: 'Sample Other' },
    ])
    const content = await summaryContent(round, FULL_SCOPE)
    expect(content.letterhead).toEqual(['Line one', 'Line two'])
    expect(content.program_line).toBe('Sample program')
    expect(content.signatories.map((row) => row.name)).toEqual(['Sample First', 'Sample Second'])
  })
})

describe('content hash', () => {
  it('is stable, and ignores draft or final state', async () => {
    const before = contentHash(await summaryContent(round, FULL_SCOPE))
    expect(contentHash(await summaryContent(round, FULL_SCOPE))).toBe(before)
    await close()
    const after = await summaryContent(round, FULL_SCOPE)
    expect(after.final).toBe(true)
    expect(contentHash(after)).toBe(before)
  })

  it('changes with the figures, and with the signatories', async () => {
    const before = contentHash(await summaryContent(round, FULL_SCOPE))
    await Signatory.create({ reportKind: 'summary', caption: 'Noted:', name: 'Sample Added' })
    const withSignatory = contentHash(await summaryContent(round, FULL_SCOPE))
    expect(withSignatory).not.toBe(before)
    await makeRecord({
      stand: await standIn(boac),
      round,
      counts: { FRUITING: 1 },
      status: 'approved',
    })
    expect(contentHash(await summaryContent(round, FULL_SCOPE))).not.toBe(withSignatory)
  })
})

describe('sign-off', () => {
  const headActor = async () => actorFor(await userWithRole(Role.PROVINCIAL_HEAD))

  it('cannot happen on an open round', async () => {
    await expect(
      signOffSummary({ actor: await headActor(), roundId: round._id }),
    ).rejects.toMatchObject({ code: 'round_open' })
  })

  it('regenerates with the same hash, until a reopen supersedes it', async () => {
    await close()
    const actor = await headActor()
    const signoff = await signOffSummary({ actor, roundId: round._id })
    expect(signoff.contentSha256).toHaveLength(64)
    const status = await signoffStatus(round)
    expect(status.state).toBe('signed')
    expect(status.currentSha256).toBe(signoff.contentSha256)
    expect(contentHash(await summaryContent(await freshRound(), FULL_SCOPE))).toBe(
      signoff.contentSha256,
    )
    expect(
      await AuditLog.exists({ action: 'report.sign_off', objectId: signoff._id }),
    ).not.toBeNull()
    await expect(signOffSummary({ actor, roundId: round._id })).rejects.toMatchObject({
      code: 'already_signed',
    })

    const record = await InventoryRecord.findOne({ municipalityId: boacId, status: 'locked' })
    await reopen({
      actor: coordinator,
      recordId: record?._id as string,
      comment: 'Synthetic correction',
    })
    expect((await signoffStatus(round)).state).toBe('superseded')
  })

  it('can be signed again after a correction', async () => {
    await close()
    const actor = await headActor()
    await signOffSummary({ actor, roundId: round._id })
    const record = await InventoryRecord.findOne({ municipalityId: boacId, status: 'locked' })
    await reopen({ actor: coordinator, recordId: record?._id as string, comment: 'Correction' })
    await signOffSummary({ actor, roundId: round._id })
    expect((await signoffStatus(round)).state).toBe('signed')
    expect(await ReportSignoff.countDocuments({ surveyRoundId: round._id })).toBe(2)
  })

  it('lets only one of two simultaneous signers through', async () => {
    await close()
    const actor = await headActor()
    const results = await Promise.allSettled([
      signOffSummary({ actor, roundId: round._id }),
      signOffSummary({ actor, roundId: round._id }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await ReportSignoff.countDocuments({ surveyRoundId: round._id })).toBe(1)
  })

  it.each([Role.PROGRAM_COORDINATOR, Role.VIEWER, Role.MAO_VALIDATOR])(
    'is refused to %s',
    async (role) => {
      await close()
      const user = await userWithRole(
        role,
        role === Role.MAO_VALIDATOR ? { municipalityId: boacId } : {},
      )
      const response = await signedIn(
        request(app).post(`/api/v1/reports/rounds/${round._id}/sign-off`),
        user,
      )
      expect(response.status).toBe(403)
      expect(await ReportSignoff.countDocuments()).toBe(0)
    },
  )

  it('works through the API, to the contract', async () => {
    await close()
    const head = await userWithRole(Role.PROVINCIAL_HEAD, {}, {})
    const url = `/api/v1/reports/rounds/${round._id}/sign-off`
    const before = await signedIn(request(app).get(url), head)
    expect((before.body as { state: string }).state).toBe('unsigned')
    expect(
      contractProblems('/api/v1/reports/rounds/{id}/sign-off', 'get', 200, before.body),
    ).toEqual([])
    const response = await signedIn(request(app).post(url), head)
    expect(response.status).toBe(201)
    expect(schemaProblems('_Signoff', response.body)).toEqual([])
    const body = response.body as { state: string; signed_by: string }
    expect(body.state).toBe('signed')
    expect(body.signed_by).toContain('Sample')
  })
})

describe('rendering', () => {
  it('writes the summary to Excel', async () => {
    const content = await summaryContent(round, FULL_SCOPE)
    const sheet = await sheetFrom(await summaryXlsx(content))
    const values = valuesOf(sheet)
    expect(values).toContain('TOTAL')
    expect(values).toContain(1675)
    expect(values).toContain('GASAN, MARINDUQUE')
    expect(values.join(' ')).toContain('DRAFT')
  })

  it('leaves the draft mark off a closed round', async () => {
    await close()
    const sheet = await sheetFrom(await summaryXlsx(await summaryContent(round, FULL_SCOPE)))
    expect(valuesOf(sheet).join(' ')).not.toContain('DRAFT')
  })

  it('writes PDFs', async () => {
    const summary = await summaryPdf(await summaryContent(round, FULL_SCOPE))
    expect(summary.subarray(0, 4).toString()).toBe('%PDF')
    const list = await municipalListPdf(await municipalListContent(round, FULL_SCOPE, gasanId))
    expect(list.subarray(0, 4).toString()).toBe('%PDF')
  })

  it('draws the uploaded logo', async () => {
    const png = onePixelPng()
    expect(await reportLogo()).toBeNull()
    await ReportSettings.create({ _id: 'current', logo: png })
    expect((await reportLogo())?.equals(png)).toBe(true)
    const content = await summaryContent(round, FULL_SCOPE)
    const plain = await summaryPdf(content)
    const withLogo = await summaryPdf(content, png)
    expect(withLogo.subarray(0, 4).toString()).toBe('%PDF')
    expect(withLogo.equals(plain)).toBe(false)
  })

  it('still produces the report when the logo file is damaged', async () => {
    const content = await summaryContent(round, FULL_SCOPE)
    const pdf = await summaryPdf(content, Buffer.from('not an image'))
    expect(pdf.equals(await summaryPdf(content))).toBe(true)
  })

  it('gives byte-identical PDFs for the same content', async () => {
    const content = await summaryContent(round, FULL_SCOPE)
    const first = await summaryPdf(content)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await summaryPdf(content)).equals(first)).toBe(true)
  })

  it('handles a long list across pages, and accented names', async () => {
    const content = await municipalListContent(round, FULL_SCOPE, gasanId)
    const row = content.rows[0]
    if (!row) throw new Error('no row')
    content.rows = Array.from({ length: 200 }, (_, index) => ({
      ...row,
      no: index + 1,
      name: `Niño Sampleñez ${String(index)}`,
    }))
    const pdf = await municipalListPdf(content)
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/gu) ?? []).length
    expect(pages).toBeGreaterThan(3)
    await municipalListXlsx(content)
  })
})

describe('the municipal list', () => {
  it('holds official records only, sorted by name', async () => {
    const content = await municipalListContent(round, FULL_SCOPE, gasanId)
    expect(content.municipality).toBe('Gasan')
    expect(content.rows).toHaveLength(3)
    expect(content.rows.map((row) => row.no)).toEqual([1, 2, 3])
    const juana = content.rows.find((row) => row.name.includes('Samplereport'))
    expect(juana?.barangay).toBe('Synthetic Gasan')
    expect(content.totals).toEqual([100, 0, 0, 325])
  })

  it('needs the export capability', async () => {
    const url = `/api/v1/reports/rounds/${round._id}/municipal-list.xlsx?municipality=${gasanId}`
    const viewer = await userWithRole(Role.VIEWER)
    expect((await signedIn(request(app).get(url), viewer)).status).toBe(403)
    const validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: boacId })
    expect((await signedIn(request(app).get(url), validator)).status).toBe(403)
  })

  it("answers 404 outside the requester's assignment", async () => {
    const head = await userWithRole(Role.PROVINCIAL_HEAD, { municipalityId: boacId })
    const url = `/api/v1/reports/rounds/${round._id}/municipal-list.xlsx?municipality=${gasanId}`
    expect((await signedIn(request(app).get(url), head)).status).toBe(404)
  })

  it('is audited with counts, never names', async () => {
    const head = await userWithRole(Role.PROVINCIAL_HEAD)
    const url = `/api/v1/reports/rounds/${round._id}/municipal-list.xlsx?municipality=${gasanId}`
    const response = await signedIn(binary(request(app).get(url)), head)
    expect(response.status).toBe(200)
    const sheet = await sheetFrom(response.body as Buffer)
    expect(sheet.name).toBe('GASAN')
    const entry = await AuditLog.findOne({
      action: 'export.municipal_list',
      objectId: round._id,
    }).lean()
    expect(entry?.after).toEqual({ municipality: 'Gasan', format: 'xlsx', rows: 3 })
  })
})

describe('downloads', () => {
  it.each([
    ['xlsx', 'PK'],
    ['pdf', '%PDF'],
  ])('sends the summary as %s', async (fmt, magic) => {
    const viewer = await userWithRole(Role.VIEWER)
    const response = await signedIn(
      binary(request(app).get(`/api/v1/reports/rounds/${round._id}/summary.${fmt}`)),
      viewer,
    )
    expect(response.status).toBe(200)
    expect((response.body as Buffer).subarray(0, magic.length).toString()).toBe(magic)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="summary-synthetic-2023.${fmt}"`,
    )
  })

  it('refuses an unknown format, an unknown round, and a missing town', async () => {
    const head = await userWithRole(Role.PROVINCIAL_HEAD)
    const get = async (path: string) =>
      (await signedIn(request(app).get(`/api/v1/reports/rounds/${path}`), head)).status
    expect(await get(`${round._id}/summary.doc`)).toBe(404)
    expect(await get('00000000-0000-4000-8000-000000000000/summary.pdf')).toBe(404)
    expect(await get(`${round._id}/municipal-list.pdf`)).toBe(404)
  })
})
