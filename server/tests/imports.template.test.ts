import { existsSync } from 'node:fs'
import { join } from 'node:path'

import ExcelJS from 'exceljs'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { settleBackgroundTasks } from '../src/lib/background.js'
import { readPrivateFile } from '../src/lib/privateFiles.js'
import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import type { UserDoc } from '../src/models/account.models.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { type CommodityDoc } from '../src/models/catalog.models.js'
import { CropStand, Farm, Planting } from '../src/models/farm.models.js'
import { ImportJob, ImportRowLink, type ImportJobDoc } from '../src/models/import.models.js'
import { Barangay, Municipality, type BarangayDoc } from '../src/models/location.models.js'
import { Association, AssociationMember, Farmer } from '../src/models/registry.models.js'
import { InventoryRecord, SurveyRound } from '../src/models/survey.models.js'
import {
  commitJob,
  createJob,
  failInterruptedJobs,
  purgeOldFiles,
  runPreview,
} from '../src/services/imports/jobs.service.js'
import { columnsFor, generateTemplate, LISTS, SHEET } from '../src/services/imports/template.js'
import { issueTokens } from '../src/services/auth.service.js'
import { seedMunicipalities } from '../src/services/location.service.js'
import { contractProblems } from './support/contract.js'
import {
  actorFor,
  cacao,
  makeFarmer,
  makeRecord,
  makeRound,
  makeStand,
  makeFarm,
  signedIn,
  userWithRole,
} from './support/factories.js'
import { buildWorkbook } from './support/workbookFixture.js'

const app = createApp({ production: false })
const API = '/api/v1/imports'

let crop: CommodityDoc
let barangay: BarangayDoc
let encoderUser: UserDoc
let encoder: Actor
let admin: UserDoc

const GOOD = {
  municipality: 'Gasan',
  barangay: 'Synthetic Tpl (Gasan)',
  first_name: 'Juana',
  last_name: 'Sampletpl',
  consent: 'Y',
  contact_no: '09000000002',
  varieties: 'BR25, UF18',
  years: '2020',
  source: 'DA Regional Field Office',
  'stage:FRUITING': 40,
  associations: 'Sample Template FA',
}

async function filledTemplate(rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load((await generateTemplate(crop)) as unknown as ArrayBuffer)
  const sheet = workbook.getWorksheet(SHEET) as ExcelJS.Worksheet
  const columns = await columnsFor(crop)
  rows.forEach((values, index) => {
    for (const [key, value] of Object.entries(values)) {
      const column = columns.findIndex((item) => item.key === key)
      sheet.getCell(index + 2, column + 1).value = value as ExcelJS.CellValue
    }
  })
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

let sequence = 0
const unique = (extra: Record<string, unknown> = {}) => {
  sequence += 1
  return { ...GOOD, last_name: `Sampletpl${'x'.repeat(sequence)}`, ...extra }
}

async function preview(content: Buffer, actor = encoder, name = 'filled.xlsx') {
  const round = await makeRound(crop)
  const job = await createJob({
    actor,
    name,
    content,
    kind: 'template',
    roundId: round._id,
  })
  return runPreview(job._id)
}

beforeAll(async () => {
  await Promise.all([ImportRowLink.init(), Farmer.init(), InventoryRecord.init()])
  await seedMunicipalities()
  crop = await cacao()
  const gasan = await Municipality.findOne({ name: 'Gasan' }).lean()
  barangay = (
    await Barangay.create({
      name: 'Synthetic Tpl',
      municipalityId: gasan?._id,
    })
  ).toObject()
  encoderUser = await userWithRole(Role.PROVINCIAL_ENCODER)
  encoder = await actorFor(encoderUser)
  admin = await userWithRole(Role.SYSTEM_ADMIN)
})

describe('the generated template', () => {
  it('has headers, a hidden list sheet, dropdowns and the privacy notice', async () => {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await generateTemplate(crop)) as unknown as ArrayBuffer)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Instructions', SHEET, LISTS])
    expect(workbook.getWorksheet(LISTS)?.state).toBe('hidden')
    const sheet = workbook.getWorksheet(SHEET) as ExcelJS.Worksheet
    const headers = (sheet.getRow(1).values as string[]).filter(Boolean)
    expect(headers.slice(0, 3)).toEqual(['Municipality *', 'Home barangay *', 'First name *'])
    expect(headers).toEqual(
      expect.arrayContaining(['Seedling', 'Vegetative', 'Flowering', 'Fruiting']),
    )
    const { model } = (sheet as unknown as { dataValidations: { model: object } }).dataValidations
    expect(Object.keys(model).length).toBeGreaterThanOrEqual(5)
    const help = workbook.getWorksheet('Instructions') as ExcelJS.Worksheet
    const text = (help.getColumn(1).values as string[]).join(' ')
    expect(text).toContain('PRIVACY NOTICE')
    expect(text).toContain(crop.name)
  })
})

describe('a template import', () => {
  it('previews errors, and submits valid rows through the regular services', async () => {
    const good = unique()
    const bad = unique({ consent: 'N', varieties: 'K19', 'stage:FRUITING': -5 })
    const job = await preview(await filledTemplate([good, bad]))
    expect(job.status).toBe('ready')
    expect(job.summary.counts).toEqual({
      rows: 2,
      valid_rows: 1,
      rows_with_errors: 1,
      existing_farmers: 0,
    })
    const errors = job.summary.errors as { row: number; messages: string[] }[]
    const messages = errors[0]?.messages.join(' ') ?? ''
    expect(errors[0]?.row).toBe(3)
    expect(messages).toContain("Consent must be 'Y'")
    expect(messages).toContain('Unknown variety: K19')
    expect(messages).toContain('negative')

    const report = new ExcelJS.Workbook()
    await report.xlsx.load((await readPrivateFile(job.errorReportPath)) as unknown as ArrayBuffer)
    expect(report.worksheets[0]?.getCell(2, 1).value).toBe(3)

    const done = await commitJob({ jobId: job._id, actor: encoder })
    expect(done.status).toBe('committed')
    expect(done.summary.commit).toMatchObject({
      records_submitted: 1,
      farmers_created: 1,
      rows_skipped_errors: 1,
    })

    const farmer = await Farmer.findOne({ lastName: good.last_name }).lean()
    expect(farmer?.consentById).toBe(encoder.id)
    expect(farmer?.contactNo).toBe('09000000002')
    const member = await AssociationMember.findOne({ farmerId: farmer?._id }).lean()
    const association = await Association.findOne({ _id: member?.associationId }).lean()
    expect(association?.name).toBe('Sample Template FA')
    const farm = await Farm.findOne({ farmerId: farmer?._id }).lean()
    const stand = await CropStand.findOne({ farmId: farm?._id }).lean()
    const record = await InventoryRecord.findOne({ cropStandId: stand?._id }).lean()
    expect(record?.status).toBe('submitted')
    const planting = await Planting.findOne({ cropStandId: stand?._id }).lean()
    expect(planting?.yearPlanted).toBe(2020)
    expect(planting?.varietyIds).toHaveLength(2)
    expect(await AuditLog.exists({ action: 'farmer.create', objectId: farmer?._id })).not.toBeNull()
    expect(
      await AuditLog.exists({ action: 'inventory.submit', objectId: record?._id }),
    ).not.toBeNull()
  })

  it('reads a CSV export', async () => {
    const columns = await columnsFor(crop)
    const row = unique()
    const lines = [
      columns.map((column) => column.header).join(','),
      columns
        .map(
          (column) =>
            `"${String((row as Record<string, string | number | undefined>)[column.key] ?? '')}"`,
        )
        .join(','),
    ]
    const job = await preview(Buffer.from(lines.join('\n')), encoder, 'rows.csv')
    expect(job.status).toBe('ready')
    expect((job.summary.counts as { valid_rows: number }).valid_rows).toBe(1)
  })

  it('flags the same farmer twice in one file', async () => {
    const row = unique()
    const job = await preview(await filledTemplate([row, row]))
    const errors = job.summary.errors as { messages: string[] }[]
    expect(errors[0]?.messages.join(' ')).toContain('Same farmer as row 2')
  })

  it('recognises an existing farmer by RSBSA, and a record already in the round', async () => {
    const existing = await makeFarmer(barangay, { rsbsaNo: 'RSBSA-TPL', consentAt: new Date() })
    const row = unique({ rsbsa_no: 'rsbsa-tpl' })
    const first = await preview(await filledTemplate([row]))
    expect((first.summary.counts as { existing_farmers: number }).existing_farmers).toBe(1)
    await commitJob({ jobId: first._id, actor: encoder })
    const farms = await Farm.find({ farmerId: existing._id }).lean()
    expect(farms).toHaveLength(1)

    const round = await SurveyRound.findOne({ _id: first.surveyRoundId }).lean()
    const content = await filledTemplate([row])
    const again = await createJob({
      actor: encoder,
      name: 'again.xlsx',
      content,
      kind: 'template',
      roundId: round?._id,
    })
    const second = await runPreview(again._id)
    const errors = second.summary.errors as { messages: string[] }[]
    expect(errors[0]?.messages.join(' ')).toContain('already has a record in the selected round')
  })

  it('needs an open round', async () => {
    const base = {
      actor: encoder,
      name: 'x.csv',
      content: Buffer.from('a\n'),
      kind: 'template' as const,
    }
    await expect(createJob(base)).rejects.toMatchObject({ code: 'round_required' })
    const closed = await makeRound(crop, { status: 'closed' })
    await expect(createJob({ ...base, roundId: closed._id })).rejects.toMatchObject({
      code: 'round_closed',
    })
  })

  it('fails its preview when the headers are wrong', async () => {
    const job = await preview(Buffer.from('Name,Town\nA,B\n'), encoder, 'x.csv')
    expect(job.status).toBe('failed')
    expect(job.errorMessage).toContain('Missing columns')
  })

  it('commits one row at a time: a failure keeps earlier rows, and a re-upload skips them', async () => {
    const rows = [unique(), unique(), unique()]
    const content = await filledTemplate(rows)
    const round = await makeRound(crop)
    const created = await createJob({
      actor: encoder,
      name: 'resume.xlsx',
      content,
      kind: 'template',
      roundId: round._id,
    })
    const job = await runPreview(created._id)

    // The third row's link write fails as a dropped connection would.
    const realCreate = ImportRowLink.create.bind(ImportRowLink)
    let calls = 0
    ImportRowLink.create = ((...args: unknown[]) => {
      calls += 1
      if (calls === 3) throw new Error('simulated connection failure')
      return (realCreate as (...a: unknown[]) => unknown)(...args)
    }) as never
    try {
      await expect(commitJob({ jobId: job._id, actor: encoder })).rejects.toThrow('simulated')
    } finally {
      ImportRowLink.create = realCreate
    }
    const failed = await ImportJob.findOne({ _id: job._id }).lean()
    expect(failed?.status).toBe('failed')
    expect(failed?.errorMessage).toContain('saving 2 rows')
    const third = await Farmer.exists({ lastName: rows[2]?.last_name })
    expect(third).toBeNull() // the failed row left nothing behind
    expect(await InventoryRecord.countDocuments({ surveyRoundId: round._id })).toBe(2)

    // The two saved farmers now have records, so a fresh preview flags nothing by name, and the
    // row links make their rows no-ops.
    const retry = await createJob({
      actor: encoder,
      name: 'resume.xlsx',
      content,
      kind: 'template',
      roundId: round._id,
    })
    const ready = await runPreview(retry._id)
    expect(ready.summary.already_imported).toBe(true)
    const done = await commitJob({ jobId: ready._id, actor: encoder })
    expect(done.summary.commit).toMatchObject({ rows_already_imported: 2, records_submitted: 1 })
    expect(await InventoryRecord.countDocuments({ surveyRoundId: round._id })).toBe(3)
  })

  it('lists a row a rule refuses, and carries on', async () => {
    const stand = await makeStand(await makeFarm(barangay))
    const round = await makeRound(crop)
    await makeRecord({ stand, round })
    const encoderLimited = await actorFor(
      await userWithRole(Role.MAO_VALIDATOR, {
        municipalityId: (await Municipality.findOne({ name: 'Boac' }).lean())?._id as string,
      }),
    )
    const content = await filledTemplate([unique()])
    const created = await createJob({
      actor: encoder,
      name: 'scoped.xlsx',
      content,
      kind: 'template',
      roundId: round._id,
    })
    const job = await runPreview(created._id)
    const done = await commitJob({ jobId: job._id, actor: encoderLimited, enforceScope: false })
    expect(done.summary.commit).toMatchObject({ records_submitted: 0, rows_refused: 1 })
  })
})

describe('job housekeeping', () => {
  it('marks a job interrupted by a restart as failed', async () => {
    const job = await preview(await filledTemplate([unique()]))
    await ImportJob.updateOne({ _id: job._id }, { status: 'committing' })
    expect(await failInterruptedJobs()).toBeGreaterThanOrEqual(1)
    const after = await ImportJob.findOne({ _id: job._id }).lean()
    expect(after?.status).toBe('failed')
    expect(after?.errorMessage).toContain('restarted')
  })

  it('purges stored files after the retention period, keeping the job', async () => {
    const job = await preview(await filledTemplate([unique({ consent: 'N' })]))
    await commitJob({ jobId: job._id, actor: encoder })
    const root = process.env.PRIVATE_FILES_DIR as string
    const stored = join(root, job.filePath)
    const report = join(root, job.errorReportPath)
    expect(existsSync(stored)).toBe(true)
    expect(existsSync(report)).toBe(true)

    await purgeOldFiles(new Date(Date.now() + 31 * 86_400_000))

    expect(existsSync(stored)).toBe(false)
    expect(existsSync(report)).toBe(false)
    const after = (await ImportJob.findOne({ _id: job._id }).lean()) as ImportJobDoc
    expect(after.filePath).toBe('')
    expect(after.filesPurgedAt).not.toBeNull()
  })

  it('refuses a bad file before storing anything', async () => {
    await expect(
      createJob({
        actor: encoder,
        name: 'x'.repeat(10) + '.xls',
        content: Buffer.from('x'),
        kind: 'template',
        roundId: (await makeRound(crop))._id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_upload' })
  })
})

describe('the API', () => {
  // Awaiting a request runs it, so the token is fetched first and the upload built afterwards.
  async function bearer(user: UserDoc): Promise<string> {
    return `Bearer ${(await issueTokens(user._id)).access}`
  }

  async function upload(
    user: UserDoc,
    content: Buffer,
    name: string,
    fields: Record<string, string>,
    target = app,
  ) {
    const token = await bearer(user)
    let built = request(target).post(API).set('Authorization', token).attach('file', content, name)
    for (const [key, value] of Object.entries(fields)) built = built.field(key, value)
    return built
  }

  it('uploads, previews in the background, then commits', async () => {
    const created = await upload(admin, await buildWorkbook(), 'synthetic.xlsx', {
      kind: 'legacy_workbook',
      commodity: crop._id,
      round_name: `Api ${String(Date.now())}`,
      as_of_date: '2025-01-01',
    })
    expect(created.status).toBe(201)
    expect(contractProblems(API, 'post', 201, created.body)).toEqual([])
    const { id } = created.body as { id: string }

    await settleBackgroundTasks()
    const detail = await signedIn(request(app).get(`${API}/${id}`), admin)
    expect(contractProblems(`${API}/{id}`, 'get', 200, detail.body)).toEqual([])
    const body = detail.body as {
      status: string
      summary: { reconciliation: { province: { computed_total: number } } }
    }
    expect(body.status).toBe('ready')
    expect(body.summary.reconciliation.province.computed_total).toBeGreaterThan(0)

    const accepted = await signedIn(request(app).post(`${API}/${id}/commit`).send({}), admin)
    expect(accepted.status).toBe(202)
    expect(contractProblems(`${API}/{id}/commit`, 'post', 202, accepted.body)).toEqual([])
    await settleBackgroundTasks()
    const after = await signedIn(request(app).get(`${API}/${id}`), admin)
    expect((after.body as { status: string }).status).toBe('committed')

    const list = await signedIn(request(app).get(API), admin)
    expect(contractProblems(API, 'get', 200, list.body)).toEqual([])
    const results = (list.body as { results: object[] }).results
    expect(results[0]).not.toHaveProperty('summary')
    const again = await signedIn(request(app).post(`${API}/${id}/commit`).send({}), admin)
    expect(again.status).toBe(409)
  })

  it("checks permissions, and hides other people's jobs", async () => {
    const job = await preview(await filledTemplate([unique()]))
    const viewer = await userWithRole(Role.VIEWER)
    const otherEncoder = await userWithRole(Role.PROVINCIAL_ENCODER)
    expect((await signedIn(request(app).get(API), viewer)).status).toBe(403)
    expect((await signedIn(request(app).get(`${API}/${job._id}`), otherEncoder)).status).toBe(404)
    expect((await signedIn(request(app).get(`${API}/${job._id}`), encoderUser)).status).toBe(200)
    expect((await signedIn(request(app).get(`${API}/${job._id}`), admin)).status).toBe(200)
  })

  it('refuses a bad file, a missing file and a bad kind', async () => {
    const bad = await upload(encoderUser, Buffer.from('x'), 'a.xls', { kind: 'legacy_cacao_2023' })
    expect(bad.status).toBe(400)
    expect((bad.body as { fields: object }).fields).toHaveProperty('file')

    const token = await bearer(encoderUser)
    const none = await request(app).post(API).set('Authorization', token).field('kind', 'template')
    expect(none.status).toBe(400)
    expect((none.body as { fields: object }).fields).toHaveProperty('file')

    const kind = await upload(encoderUser, Buffer.from('a'), 'a.csv', { kind: 'nonsense' })
    expect(kind.status).toBe(400)
  })

  it('refuses a file over the size limit', async () => {
    const response = await upload(encoderUser, Buffer.alloc(10 * 1024 * 1024 + 2), 'big.xlsx', {
      kind: 'legacy_cacao_2023',
    })
    expect(response.status).toBe(400)
    expect((response.body as { message: string }).message).toContain('10 MB')
  })

  it('checks commit rights before queueing', async () => {
    const encoderJob = await createJob({
      actor: encoder,
      name: 'w.xlsx',
      content: await buildWorkbook(),
      kind: 'legacy_cacao_2023',
    })
    await runPreview(encoderJob._id)
    const response = await signedIn(
      request(app).post(`${API}/${encoderJob._id}/commit`).send({}),
      encoderUser,
    )
    expect(response.status).toBe(403)
  })

  it('throttles uploads per user', async () => {
    const limited = createApp({ production: false })
    const user = await userWithRole(Role.PROVINCIAL_ENCODER)
    let last = 0
    for (let i = 0; i < 21; i += 1) {
      const response = await upload(
        user,
        Buffer.from('x'),
        'a.xls',
        { kind: 'legacy_cacao_2023' },
        limited,
      )
      last = response.status
    }
    expect(last).toBe(429)
  })

  it('downloads the template', async () => {
    const response = await signedIn(
      request(app).get(`${API}/template?commodity=${crop._id}`),
      encoderUser,
    )
    expect(response.status).toBe(200)
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${crop.code.toLowerCase()}-template.xlsx"`,
    )
    expect(response.headers['cache-control']).toBe('no-store')
    const missing = await signedIn(request(app).get(`${API}/template`), encoderUser)
    expect(missing.status).toBe(400)
  })

  it('audits an error report download', async () => {
    const job = await preview(await filledTemplate([unique({ consent: 'N' })]))
    const response = await signedIn(
      request(app).get(`${API}/${job._id}/error-report`).buffer(),
      encoderUser,
    )
    expect(response.status).toBe(200)
    expect(
      await AuditLog.exists({ action: 'import.download_error_report', objectId: job._id }),
    ).not.toBeNull()
    const clean = await preview(await filledTemplate([unique()]))
    const none = await signedIn(request(app).get(`${API}/${clean._id}/error-report`), encoderUser)
    expect(none.status).toBe(404)
  })
})

describe('personal-data exports', () => {
  async function workbookFrom(body: Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(body as unknown as ArrayBuffer)
    return workbook.worksheets[0] as ExcelJS.Worksheet
  }

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        done(null, Buffer.concat(chunks))
      })
    })

  it('need the capability, stay in scope, and are audited with the search term masked', async () => {
    await makeFarmer(barangay, { firstName: 'Zebulon', lastName: 'Xqexportonly' })
    const coordinator = await userWithRole(Role.PROGRAM_COORDINATOR)
    expect(
      (await signedIn(request(app).get('/api/v1/exports/farmers.xlsx'), encoderUser)).status,
    ).toBe(403)
    const response = await signedIn(
      binary(request(app).get('/api/v1/exports/farmers.xlsx?q=zebulon%20xqexportonly')),
      coordinator,
    )
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const sheet = await workbookFrom(response.body as Buffer)
    expect(sheet.getCell(2, 1).value).toBe('Xqexportonly')
    const entry = await AuditLog.findOne({ action: 'export.farmers' })
      .sort({ createdAt: -1 })
      .lean()
    expect(entry?.after).toEqual({ rows: 1, filters: { q: '[personal]' } })
    expect(JSON.stringify(entry)).not.toContain('xqexportonly')
  })

  it("leave out towns outside the requester's assignment", async () => {
    const boac = await Municipality.findOne({ name: 'Boac' }).lean()
    const head = await userWithRole(Role.PROVINCIAL_HEAD, { municipalityId: boac?._id as string })
    const response = await signedIn(
      binary(request(app).get('/api/v1/exports/farmers.xlsx?q=zebulon%20xqexportonly')),
      head,
    )
    const sheet = await workbookFrom(response.body as Buffer)
    expect(sheet.rowCount).toBe(1)
  })

  it('export inventory with stage columns from the catalog', async () => {
    const round = await makeRound(crop)
    const stand = await makeStand(await makeFarm(barangay))
    await makeRecord({
      stand,
      round,
      status: 'approved',
      counts: { SEEDLING: 1, VEGETATIVE: 2, FLOWERING: 3, FRUITING: 4 },
    })
    const head = await userWithRole(Role.PROVINCIAL_HEAD)
    const url = `/api/v1/exports/inventory.xlsx?status=approved&survey_round=${round._id}`
    const response = await signedIn(binary(request(app).get(url)), head)
    const sheet = await workbookFrom(response.body as Buffer)
    const headers = sheet.getRow(1).values as string[]
    expect(headers.slice(6, 10)).toEqual(['Seedling', 'Vegetative', 'Flowering', 'Fruiting'])
    expect(sheet.rowCount).toBe(2)
    const row = sheet.getRow(2).values as unknown[]
    expect(row.slice(6, 11)).toEqual([1, 2, 3, 4, 10])
    expect(await AuditLog.exists({ action: 'export.inventory' })).not.toBeNull()
  })
})
