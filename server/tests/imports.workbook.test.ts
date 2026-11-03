/** End-to-end workbook import on a SYNTHETIC file with the real one's layout and defects. */
import ExcelJS from 'exceljs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { Commodity, GrowthStage, MaterialSource, Variety } from '../src/models/catalog.models.js'
import { Farm, Harvest, Planting, CropStand } from '../src/models/farm.models.js'
import { ImportJob, ImportRowLink, type ImportJobDoc } from '../src/models/import.models.js'
import { Barangay, Municipality } from '../src/models/location.models.js'
import { Association, AssociationMember, Farmer } from '../src/models/registry.models.js'
import { InventoryRecord, SurveyRound } from '../src/models/survey.models.js'
import { integrityProblems } from '../src/selectors/integrity.selectors.js'
import { seedCatalog } from '../src/services/catalog.service.js'
import { commitJob, createJob, runPreview } from '../src/services/imports/jobs.service.js'
import type { Reconciliation } from '../src/services/imports/workbookPlan.js'
import { readWorkbook, sumRanges } from '../src/services/imports/workbookReader.js'
import { seedMunicipalities } from '../src/services/location.service.js'
import { actorFor, userWithRole } from './support/factories.js'
import {
  buildWorkbook,
  CACAO_SHEETS,
  truthOf,
  type Sheet,
  type Truth,
} from './support/workbookFixture.js'

const STAGES = ['SEEDLING', 'VEGETATIVE', 'FLOWERING', 'FRUITING']
const TOWNS = ['Boac', 'Buenavista', 'Mogpog', 'Gasan', 'Santa Cruz', 'Torrijos']

let file: Buffer
let truth: Truth
let admin: Actor

beforeAll(async () => {
  file = await buildWorkbook()
  truth = truthOf(CACAO_SHEETS, 4)
  await Promise.all(
    [ImportRowLink, Farmer, Association, AssociationMember, SurveyRound, InventoryRecord].map(
      (model) => model.init(),
    ),
  )
})

async function clearAll() {
  await Promise.all(
    [
      ImportJob,
      ImportRowLink,
      Barangay,
      Municipality,
      Association,
      AssociationMember,
      Farmer,
      Farm,
      CropStand,
      Planting,
      Harvest,
      SurveyRound,
      InventoryRecord,
      Commodity,
      GrowthStage,
      Variety,
      MaterialSource,
    ].map((model) => model.collection.deleteMany({})),
  )
}

beforeEach(async () => {
  await clearAll()
  await seedMunicipalities()
  await seedCatalog()
  admin = await actorFor(await userWithRole(Role.SYSTEM_ADMIN))
})

async function previewed(content = file, actor = admin): Promise<ImportJobDoc> {
  const job = await createJob({
    actor,
    name: 'synthetic.xlsx',
    content,
    kind: 'legacy_cacao_2023',
  })
  const after = await runPreview(job._id)
  expect(after.errorMessage).toBe('')
  expect(after.status).toBe('ready')
  return after
}

function reconciliationOf(job: ImportJobDoc): Reconciliation {
  return job.summary.reconciliation as Reconciliation
}

function townRows(job: ImportJobDoc) {
  return Object.fromEntries(
    reconciliationOf(job).municipalities.map((row) => [row.municipality, row]),
  )
}

type Review = { kind: string; value: string }[]

describe('the reader', () => {
  async function read() {
    const stages = await GrowthStage.find({ code: { $in: STAGES } }).lean()
    const aliases = new Map(stages.map((stage) => [stage.code, stage]))
    return readWorkbook(file, TOWNS, (label) => {
      const key = label.toUpperCase() === 'GROWING' ? 'SEEDLING' : label.toUpperCase()
      return aliases.get(key)
    })
  }

  it('reads every municipal sheet and the summary', async () => {
    const workbook = await read()
    expect(workbook.sheets.map((sheet) => sheet.municipality)).toEqual(TOWNS)
    expect(workbook.unknownSheets).toEqual([])
    const [boac] = workbook.sheets
    expect(boac?.headerRow).toBe(11)
    expect(boac?.stageColumns).toEqual({
      SEEDLING: 10,
      VEGETATIVE: 11,
      FLOWERING: 12,
      FRUITING: 13,
    })
    expect(boac?.title.startsWith('INITIAL CACAO POPULATION DATA')).toBe(true)
    expect(boac?.asOf).toBe('as of July, 2023')
    expect(boac?.issues).toEqual([])
  })

  it('splits rows at the total, and knows what each formula covers', async () => {
    const workbook = await read()
    const santaCruz = workbook.sheets.find((sheet) => sheet.municipality === 'Santa Cruz')
    const mogpog = workbook.sheets.find((sheet) => sheet.municipality === 'Mogpog')
    expect(santaCruz?.totalRow).toBe(19)
    expect(santaCruz?.rows.filter((row) => row.belowTotal).map((row) => row.values.name)).toEqual([
      'Late Sampleentry',
      'Prepared by: Sample Officer',
    ])
    expect(santaCruz?.totals.SEEDLING?.formula).toBe('=SUM(J13:J15)')
    expect(santaCruz?.totals.SEEDLING?.coveredRows).toEqual([13, 14, 15])
    expect(santaCruz?.totals.SEEDLING?.evaluated).toBe(truth.workbookTotals['Santa Cruz']?.[0])
    expect(santaCruz?.totals.FRUITING?.coveredRows).toEqual([13, 14, 15, 16, 17, 18])
    expect(mogpog?.totals.FLOWERING?.formula).toBe('=SUM(L13)')
    expect(mogpog?.totals.FLOWERING?.coveredRows).toEqual([13])
  })

  it('maps GROWING in the summary to the first stage', async () => {
    const { summary, summaryIssues } = await read()
    expect(summary['santa cruz']?.farmers).toBe(6)
    expect(summary['santa cruz']?.population.SEEDLING).toBe(truth.workbookTotals['Santa Cruz']?.[0])
    expect(summaryIssues).toEqual([])
  })

  it('reports a sheet with no header', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('GASAN').getCell('A1').value = 'nothing here'
    const content = Buffer.from(await workbook.xlsx.writeBuffer())
    const parsed = await readWorkbook(content, TOWNS, () => undefined)
    expect(parsed.sheets[0]?.issues).toEqual([
      "Header row with 'NAME OF FARMER' not found; sheet skipped.",
    ])
  })

  it.each<[string, [number, number, number, number][] | null]>([
    ['=SUM(J13:J48)', [[10, 13, 10, 48]]],
    ['=SUM(L28)', [[12, 28, 12, 28]]],
    [
      '=sum($J$13:$J$20, J22)',
      [
        [10, 13, 10, 20],
        [10, 22, 10, 22],
      ],
    ],
    ['=J13+J14', null],
    ['', null],
  ])('reads the formula %j', (formula, ranges) => {
    expect(sumRanges(formula)).toEqual(ranges)
  })
})

describe('the preview', () => {
  it('counts rows', async () => {
    const job = await previewed()
    const counts = job.summary.counts as Record<string, number>
    expect(counts.named_rows).toBe(truth.namedRows)
    expect(counts.rows_with_trees).toBe(truth.rowsWithTrees)
    expect(counts.below_total_rows).toBe(truth.belowWithBarangay)
    expect(counts.name_only_rows).toBe(truth.nameOnly)
    expect(job.summary.already_imported).toBe(false)
    expect(job.summary.municipalities).toEqual([...TOWNS].sort())
  })

  it('finds the Santa Cruz and Mogpog formula defects', async () => {
    const job = await previewed()
    const towns = townRows(job)
    const santaCruz = towns['Santa Cruz']
    const expectedDiff = (truth.trueTotals['Santa Cruz'] ?? []).map(
      (total, stage) => total - (truth.workbookTotals['Santa Cruz']?.[stage] ?? 0),
    )
    expect(STAGES.map((stage) => santaCruz?.stages[stage]?.diff_workbook)).toEqual(expectedDiff)
    expect(santaCruz?.diff_total).toBe(940)
    expect(santaCruz?.stages.SEEDLING?.skipped_rows).toEqual([16, 17, 18])
    expect(santaCruz?.stages.FRUITING?.skipped_rows).toEqual([])
    const flowering = towns.Mogpog?.stages.FLOWERING
    expect(flowering?.formula).toBe('=SUM(L13)')
    expect(flowering?.skipped_rows).toEqual([14, 15])
    expect(flowering?.uncovered_rows).toEqual([14, 15])
    const { differences, province } = reconciliationOf(job)
    expect(
      differences.some((line) => line.includes('Santa Cruz SEEDLING') && line.includes('16-18')),
    ).toBe(true)
    for (const [town, totals] of Object.entries(truth.trueTotals)) {
      expect(STAGES.map((stage) => towns[town]?.stages[stage]?.computed)).toEqual(totals)
    }
    expect(province.computed_total).toBe(truth.provinceTotal)
    expect(province.area_ha).toBe((truth.provinceTotal / 625).toFixed(2))
  })

  it('builds the review list', async () => {
    const job = await previewed()
    const review = job.summary.review as Review
    const kinds = new Set(review.map((item) => item.kind))
    for (const kind of [
      'unknown_variety',
      'unknown_source',
      'unparsed_year',
      'name_only_row',
      'same_name_twice',
      'possible_duplicate',
      'missing_barangay',
    ]) {
      expect(kinds).toContain(kind)
    }
    const values = (kind: string) =>
      review.filter((item) => item.kind === kind).map((item) => item.value)
    expect(values('unknown_variety')).toEqual(['K18'])
    expect(values('unknown_source')).toEqual(['PS'])
    expect(values('unparsed_year')).toEqual(['unknown'])
  })

  it('records normalization decisions', async () => {
    const job = await previewed()
    const decisions = job.summary.decisions as Record<
      string,
      { raw: string; result: string; decision: string }[]
    >
    const map = (kind: string, key: 'result' | 'decision' = 'result') =>
      Object.fromEntries((decisions[kind] ?? []).map((item) => [item.raw, item[key]]))
    expect(map('variety')).toMatchObject({
      'UF18 & BR25': 'UF18, BR25',
      CriolIo: 'CRIOLLO',
      'KI & K18': 'K1',
    })
    expect(map('source')).toMatchObject({
      'DA- RFO': 'DA_RFO',
      'DA/PCA/Own Produced': 'DA, PCA, OWN_PRODUCED',
    })
    expect(map('barangay')).toMatchObject({ 'Synthetic Beta, Boac': 'Synthetic Beta' })
    expect(map('associations', 'decision')).toMatchObject({
      'Mat Sample Gasan FA': 'same_as_file',
    })
  })

  it('writes nothing', async () => {
    await previewed()
    expect(await Farmer.countDocuments()).toBe(0)
    expect(await SurveyRound.countDocuments()).toBe(0)
  })

  it('fails with a clear message when no sheet matches a municipality', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Not a town').getCell('A1').value = 'x'
    const job = await createJob({
      actor: admin,
      name: 'wrong.xlsx',
      content: Buffer.from(await workbook.xlsx.writeBuffer()),
      kind: 'legacy_cacao_2023',
    })
    const after = await runPreview(job._id)
    expect(after.status).toBe('failed')
    expect(after.errorMessage).toContain('No municipal sheets')
  })
})

describe('the commit', () => {
  async function committed() {
    const job = await previewed()
    return commitJob({ jobId: job._id, actor: admin })
  }

  it('gives official totals equal to the farmer rows', async () => {
    const job = await committed()
    expect(job.status).toBe('committed')
    const result = job.summary.commit as {
      official_total: number
      official_by_municipality: Record<string, Record<string, number>>
    }
    expect(result.official_total).toBe(truth.provinceTotal)
    for (const [town, totals] of Object.entries(truth.trueTotals)) {
      const byStage = result.official_by_municipality[town] ?? {}
      expect(STAGES.map((stage) => byStage[stage] ?? 0)).toEqual(totals)
    }
  })

  it('creates the round and records', async () => {
    await committed()
    const [round, ...others] = await SurveyRound.find().lean()
    expect(others).toEqual([])
    expect([round?.name, round?.isHistorical, round?.status]).toEqual([
      'Cacao inventory - July 2023',
      true,
      'open',
    ])
    expect(await InventoryRecord.countDocuments({ status: 'approved' })).toBe(truth.namedRows)
    const draft = await InventoryRecord.findOne({ status: 'draft' }).lean()
    expect(draft?.flags.below_total).toBe(true)
    const stand = await CropStand.findOne({ _id: draft?.cropStandId }).lean()
    const farm = await Farm.findOne({ _id: stand?.farmId }).lean()
    expect((await Farmer.findOne({ _id: farm?.farmerId }).lean())?.status).toBe('needs_review')
    const first = await InventoryRecord.findOne({ 'flags.sheet': 'BOAC', 'flags.row': 13 }).lean()
    expect(first?.flags.source).toBe('legacy_import')
    expect(first?.approvedById).toBe(admin.id)
  })

  it('handles people, places and plantings', async () => {
    await committed()
    const rosa = await Farmer.findOne({ lastName: 'Sampleduo' }).lean()
    expect(await Farmer.countDocuments({ lastName: 'Sampleduo' })).toBe(1)
    const rosaFarms = await Farm.find({ farmerId: rosa?._id }).lean()
    const barangayName = async (id: string) => (await Barangay.findOne({ _id: id }).lean())?.name
    const rosaPlaces = await Promise.all(rosaFarms.map((farm) => barangayName(farm.barangayId)))
    expect(rosaPlaces.sort()).toEqual(['Synthetic Beta', 'Synthetic Gamma'])
    expect(await Farmer.countDocuments({ lastName: 'Samplecruz' })).toBe(2)
    expect(await Farmer.countDocuments({ consentAt: { $ne: null } })).toBe(0)

    const boac = await Municipality.findOne({ name: 'Boac' }).lean()
    const juan = await Farmer.findOne({
      lastName: 'Samplecruz',
      municipalityId: boac?._id,
    }).lean()
    expect([juan?.firstName, juan?.middleName]).toEqual(['Juan', 'A.'])
    expect(juan?.contactNo).toBe('09000000001')
    expect(juan?.normalizedName).toBe('juan a samplecruz')
    const juanFarm = await Farm.findOne({ farmerId: juan?._id }).lean()
    const juanStand = await CropStand.findOne({ farmId: juanFarm?._id }).lean()
    const plantings = await Planting.find({ cropStandId: juanStand?._id })
      .sort({ yearPlanted: 1 })
      .lean()
    expect(plantings.map((row) => row.yearPlanted)).toEqual([2016, 2018, 2021, 2022])
    const varieties = await Variety.find({ _id: { $in: plantings[0]?.varietyIds } }).lean()
    expect(varieties.map((row) => row.code).sort()).toEqual(['BR25', 'UF18'])
    const source = await MaterialSource.findOne({ _id: plantings[0]?.sourceId }).lean()
    expect(source?.code).toBe('DA_RFO')
    expect(plantings[0]?.notes).toContain('per-year breakdown unknown')

    const carlos = await Farmer.findOne({ firstName: 'Carlos' }).lean()
    const carlosFarm = await Farm.findOne({ farmerId: carlos?._id }).lean()
    expect(await barangayName(carlosFarm?.barangayId ?? '')).toBe('Synthetic Tabionan')
    expect(carlosFarm?.locationRaw).toBe('Pulong Parang/Masalukot')

    const nora = await Farmer.findOne({ lastName: 'Samplenobrgy' }).lean()
    const placeholder = await Barangay.findOne({ _id: nora?.homeBarangayId }).lean()
    expect([placeholder?.name, placeholder?.isVerified]).toEqual(['(Barangay not recorded)', false])
    const ben = await Farmer.findOne({ lastName: 'Samplefarmloc' }).lean()
    expect(await barangayName(ben?.homeBarangayId ?? '')).toBe('Synthetic Poctoy')

    const lito = await Farmer.findOne({ firstName: 'Lito' }).lean()
    const litoFarm = await Farm.findOne({ farmerId: lito?._id }).lean()
    const litoStand = await CropStand.findOne({ farmId: litoFarm?._id }).lean()
    const [litoPlanting] = await Planting.find({ cropStandId: litoStand?._id }).lean()
    expect(litoPlanting?.sourceId).toBeNull()
    expect(litoPlanting?.notes.startsWith('Sources: ')).toBe(true)

    expect(await Barangay.countDocuments({ isVerified: true })).toBe(0)
    expect(await Barangay.countDocuments({ name: 'Synthetic Beta' })).toBe(1)
  })

  it('handles associations and harvests', async () => {
    await committed()
    const town = async (name: string) => (await Municipality.findOne({ name }).lean())?._id
    expect(await Association.countDocuments({ municipalityId: await town('Gasan') })).toBe(1)
    expect(await Association.countDocuments({ municipalityId: await town('Buenavista') })).toBe(2)
    expect(await Harvest.countDocuments()).toBe(5)
    const dried = await Harvest.findOne({ productForm: 'dried_beans' }).lean()
    expect([dried?.quantity.toString(), dried?.unit, dried?.dateEstimated]).toEqual([
      '6',
      'kg',
      true,
    ])
    const elena = await Farmer.findOne({ firstName: 'Elena' }).lean()
    const farm = await Farm.findOne({ farmerId: elena?._id }).lean()
    const stand = await CropStand.findOne({ farmId: farm?._id }).lean()
    const record = await InventoryRecord.findOne({ cropStandId: stand?._id }).lean()
    expect(record?.remarks).toBe('325 trees died in May 2023, 80 now')
  })

  it('is audited, and leaves every key and link sound', async () => {
    const job = await committed()
    expect(await AuditLog.exists({ action: 'import.commit', objectId: job._id })).not.toBeNull()
    const entries = (action: string) =>
      AuditLog.countDocuments({ action, 'after.import_job': job._id })
    expect(await entries('farmer.import')).toBe(await Farmer.countDocuments())
    expect(await entries('inventory.import')).toBe(await InventoryRecord.countDocuments())
    expect(await integrityProblems()).toEqual([])
  })

  it('creates nothing when the same file is imported again', async () => {
    await committed()
    const count = async () => [
      await Farmer.countDocuments(),
      await InventoryRecord.countDocuments(),
      await Harvest.countDocuments(),
    ]
    const before = await count()
    const again = await previewed()
    expect(again.summary.already_imported).toBe(true)
    const done = await commitJob({ jobId: again._id, actor: admin })
    expect(await count()).toEqual(before)
    const result = done.summary.commit as { rows_already_imported: number }
    expect(result.rows_already_imported).toBe(await InventoryRecord.countDocuments())
  })

  it('refuses a second commit of the same job', async () => {
    const job = await committed()
    await expect(commitJob({ jobId: job._id, actor: admin })).rejects.toMatchObject({
      code: 'not_ready',
    })
  })

  it('lets only one of two simultaneous commits run', async () => {
    const job = await previewed()
    const results = await Promise.allSettled([
      commitJob({ jobId: job._id, actor: admin }),
      commitJob({ jobId: job._id, actor: admin }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await InventoryRecord.countDocuments()).toBe(truth.namedRows + 1)
  })

  it('saves nothing if the commit fails part-way', async () => {
    const job = await previewed()
    const before = await Barangay.countDocuments()
    // The row links are the last bulk write, so everything else has been sent by then.
    const original = ImportRowLink.insertMany.bind(ImportRowLink)
    ImportRowLink.insertMany = () => {
      throw new Error('simulated connection failure')
    }
    try {
      await expect(commitJob({ jobId: job._id, actor: admin })).rejects.toThrow('simulated')
    } finally {
      ImportRowLink.insertMany = original
    }
    expect(await Farmer.countDocuments()).toBe(0)
    expect(await InventoryRecord.countDocuments()).toBe(0)
    expect(await Barangay.countDocuments()).toBe(before)
    expect(await SurveyRound.countDocuments()).toBe(0)
    const failed = await ImportJob.findOne({ _id: job._id }).lean()
    expect(failed?.status).toBe('failed')
    expect(failed?.errorMessage).toContain('nothing was saved')
  })

  it('needs the approve capability, and leaves the job ready', async () => {
    const encoder = await actorFor(await userWithRole(Role.PROVINCIAL_ENCODER))
    const job = await previewed(file, encoder)
    await expect(commitJob({ jobId: job._id, actor: encoder })).rejects.toMatchObject({
      status: 403,
    })
    expect((await ImportJob.findOne({ _id: job._id }).lean())?.status).toBe('ready')
  })

  it('maps an association with an override', async () => {
    const buenavista = await Municipality.findOne({ name: 'Buenavista' }).lean()
    const existing = await Association.create({
      name: 'Sample BV Cooperative',
      municipalityId: buenavista?._id,
    })
    const job = await previewed()
    await commitJob({
      jobId: job._id,
      actor: admin,
      associationOverrides: { 'Sample BV Coop': existing._id },
    })
    const jose = await Farmer.findOne({ firstName: 'Jose' }).lean()
    expect(
      await AssociationMember.exists({ farmerId: jose?._id, associationId: existing._id }),
    ).not.toBeNull()
  })
})

describe('another crop, with no code change (ADR-0019)', () => {
  const COFFEE_SHEETS: Sheet[] = [
    {
      title: 'GASAN',
      town: 'Gasan',
      rows: [
        {
          name: 'Ana Samplecoffee',
          barangay: 'Synthetic Coffee One',
          counts: [50, 25, 10],
          variety: 'Robusta & EXC',
          source: 'Own Produced',
          datePlanted: 2020,
        },
        {
          name: 'Ben Samplecoffee',
          barangay: 'Synthetic Coffee One',
          counts: [5, 0, 45],
          variety: 'Liberica',
          remarks: '4 kilos dried',
        },
      ],
    },
    {
      title: 'BOAC',
      town: 'Boac',
      rows: [{ name: 'Cora Samplecoffee', barangay: 'Synthetic Coffee Two', counts: [0, 100, 0] }],
      totalOverrides: { 1: 'SUM(K13)' },
    },
  ]

  async function coffee() {
    const hvcdp = await Commodity.findOne({ code: 'CACAO' }).lean()
    const crop = await Commodity.create({
      programId: hvcdp?.programId,
      code: 'SAMPLECOFFEE',
      name: 'Sample coffee',
      measureType: 'trees',
      plantsPerHa: 1000,
    })
    await GrowthStage.create([
      {
        commodityId: crop._id,
        code: 'NURSERY',
        label: 'Nursery',
        sortOrder: 1,
        aliases: ['Seedbed'],
      },
      { commodityId: crop._id, code: 'YOUNG', label: 'Young', sortOrder: 2 },
      { commodityId: crop._id, code: 'BEARING', label: 'Bearing', sortOrder: 3, isBearing: true },
    ])
    await Variety.create([
      { commodityId: crop._id, code: 'ROBUSTA', name: 'Robusta' },
      { commodityId: crop._id, code: 'EXCELSA', name: 'Excelsa', aliases: ['EXC'] },
    ])
    return crop
  }

  it('imports with its own stages, varieties and density', async () => {
    const crop = await coffee()
    const content = await buildWorkbook(
      COFFEE_SHEETS,
      ['SEEDBED', 'YOUNG', 'BEARING'],
      ['NURSERY', 'YOUNG', 'BEARING'],
      'COFFEE',
    )
    const created = await createJob({
      actor: admin,
      name: 'coffee.xlsx',
      content,
      kind: 'legacy_workbook',
      commodityId: crop._id,
      roundName: 'Sample coffee inventory 2025',
      asOfDate: '2025-06-30',
    })
    const job = await runPreview(created._id)
    expect(job.errorMessage).toBe('')
    const rec = reconciliationOf(job)
    expect(rec.stages).toEqual(['NURSERY', 'YOUNG', 'BEARING'])
    expect(rec.province.computed).toEqual({ NURSERY: 55, YOUNG: 125, BEARING: 55 })
    expect(rec.province.area_ha).toBe('0.24')
    const counts = job.summary.counts as Record<string, number>
    expect(counts.named_rows).toBe(3)
    const review = job.summary.review as Review
    expect(review.filter((item) => item.kind === 'unknown_variety').map((i) => i.value)).toEqual([
      'Liberica',
    ])

    const done = await commitJob({ jobId: job._id, actor: admin })
    const result = done.summary.commit as { official_total: number }
    expect(result.official_total).toBe(235)
    const round = await SurveyRound.findOne({ commodityId: crop._id }).lean()
    expect(round?.name).toBe('Sample coffee inventory 2025')
    expect(round?.isHistorical).toBe(true)
    expect(round?.asOfDate.toISOString().slice(0, 10)).toBe('2025-06-30')
    expect(await CropStand.countDocuments({ commodityId: crop._id })).toBe(3)
    const stageIds = new Set(
      (await GrowthStage.find({ commodityId: crop._id }).lean()).map((s) => s._id),
    )
    const records = await InventoryRecord.find({ surveyRoundId: round?._id }).lean()
    expect(records.flatMap((r) => r.stageCounts).every((c) => stageIds.has(c.growthStageId))).toBe(
      true,
    )
    expect(await integrityProblems()).toEqual([])
  })

  it('needs a crop, a round name and a date', async () => {
    const crop = await coffee()
    const base = { actor: admin, name: 'x.xlsx', content: file, kind: 'legacy_workbook' as const }
    await expect(createJob(base)).rejects.toMatchObject({ code: 'commodity_required' })
    await expect(createJob({ ...base, commodityId: crop._id })).rejects.toMatchObject({
      code: 'round_details_required',
    })
  })

  it('refuses a crop measured by area', async () => {
    const hvcdp = await Commodity.findOne({ code: 'CACAO' }).lean()
    const rice = await Commodity.create({
      programId: hvcdp?.programId,
      code: 'SAMPLERICE',
      name: 'Sample rice',
      measureType: 'area',
    })
    await expect(
      createJob({
        actor: admin,
        name: 'x.xlsx',
        content: file,
        kind: 'legacy_workbook',
        commodityId: rice._id,
        roundName: 'R',
        asOfDate: '2025-01-01',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_measure' })
  })
})
