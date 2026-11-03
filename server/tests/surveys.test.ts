/** Every transition in brief §8, including refusals and audit entries. */
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { Role } from '../src/lib/roles.js'
import type { Actor } from '../src/lib/scoping.js'
import type { UserDoc } from '../src/models/account.models.js'
import { AuditLog } from '../src/models/auditLog.model.js'
import { Commodity, GrowthStage, type CommodityDoc } from '../src/models/catalog.models.js'
import { CropStand, Farm, type CropStandDoc } from '../src/models/farm.models.js'
import type { BarangayDoc, MunicipalityDoc } from '../src/models/location.models.js'
import {
  InventoryRecord,
  RECORD_STATUSES,
  SurveyRound,
  WorkflowComment,
  type RecordStatus,
} from '../src/models/survey.models.js'
import { deleteCropStand, updateFarm } from '../src/services/farm.service.js'
import * as services from '../src/services/survey.service.js'
import { allowedActions } from '../src/services/surveyWorkflow.js'
import { contractProblems, schemaProblems } from './support/contract.js'
import {
  actorFor,
  cacao,
  makeBarangay,
  makeFarm,
  makeMunicipality,
  makeProgram,
  makeRecord,
  makeRound,
  makeStand,
  signedIn,
  userWithRole,
} from './support/factories.js'

const app = createApp({ production: false })

type Person =
  | 'encoder'
  | 'validator'
  | 'otherValidator'
  | 'coordinator'
  | 'otherCoordinator'
  | 'head'
  | 'viewer'

const PEOPLE: Person[] = [
  'encoder',
  'validator',
  'otherValidator',
  'coordinator',
  'otherCoordinator',
  'head',
  'viewer',
]

let gasan: MunicipalityDoc
let boac: MunicipalityDoc
let brgy: BarangayDoc
let crop: CommodityDoc
let stand: CropStandDoc
const users = {} as Record<Person, UserDoc>
const actors = {} as Record<Person, Actor>

async function stageId(code: string): Promise<string> {
  const stage = await GrowthStage.findOne({ commodityId: crop._id, code }).lean()
  return stage?._id as string
}

async function newStand(): Promise<CropStandDoc> {
  return makeStand(await makeFarm(brgy))
}

async function statusOf(id: string): Promise<RecordStatus> {
  return (await InventoryRecord.findOne({ _id: id }).lean())?.status as RecordStatus
}

beforeAll(async () => {
  await Promise.all([InventoryRecord.init(), SurveyRound.init(), WorkflowComment.init()])
  gasan = await makeMunicipality('Gasan Surveys')
  boac = await makeMunicipality('Boac Surveys')
  brgy = await makeBarangay(gasan._id, 'Synthetic Gasan Survey')
  crop = await cacao()
  const rice = await makeProgram('RICE')
  users.encoder = await userWithRole(Role.PROVINCIAL_ENCODER)
  users.validator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: gasan._id })
  users.otherValidator = await userWithRole(Role.MAO_VALIDATOR, { municipalityId: boac._id })
  users.coordinator = await userWithRole(Role.PROGRAM_COORDINATOR, { programId: crop.programId })
  users.otherCoordinator = await userWithRole(Role.PROGRAM_COORDINATOR, { programId: rice._id })
  users.head = await userWithRole(Role.PROVINCIAL_HEAD)
  users.viewer = await userWithRole(Role.VIEWER)
  for (const person of PEOPLE) actors[person] = await actorFor(users[person])
})

beforeEach(async () => {
  stand = await newStand()
})

describe('the happy path', () => {
  it('runs from draft to locked, with audit entries and comments', async () => {
    const round = await makeRound()
    const created = await services.createRecord({
      actor: actors.encoder,
      roundId: round._id,
      standId: stand._id,
      counts: [
        { growthStageId: await stageId('FRUITING'), count: 40 },
        { growthStageId: await stageId('SEEDLING'), count: 5 },
      ],
    })
    expect(created.status).toBe('draft')
    expect(created.encodedById).toBe(actors.encoder.id)
    const recordId = created._id

    const submitted = await services.submit({ actor: actors.encoder, recordId })
    expect(submitted.status).toBe('submitted')
    expect(submitted.submittedAt).not.toBeNull()

    const validated = await services.validate({
      actor: actors.validator,
      recordId,
      comment: 'Checked on site',
    })
    expect(validated.status).toBe('validated')
    expect(validated.validatedById).toBe(actors.validator.id)

    const approved = await services.approve({ actor: actors.coordinator, recordId })
    expect(approved.status).toBe('approved')
    expect(approved.approvedById).toBe(actors.coordinator.id)

    expect(await services.closeRound({ actor: actors.coordinator, roundId: round._id })).toBe(1)
    expect(await statusOf(recordId)).toBe('locked')
    expect((await SurveyRound.findOne({ _id: round._id }).lean())?.status).toBe('closed')

    const entries = await AuditLog.find({ objectId: recordId }).sort({ createdAt: 1 }).lean()
    expect(entries.map((entry) => entry.action)).toEqual([
      'inventory.create',
      'inventory.submit',
      'inventory.validate',
      'inventory.approve',
      'inventory.lock',
    ])
    const comments = await WorkflowComment.find({ inventoryRecordId: recordId }).lean()
    expect(comments.map((row) => [row.action, row.body])).toEqual([['validate', 'Checked on site']])
  })
})

// Who may perform each action on a record in the given status (a Gasan record, the crop's program).
// MAO validators may edit drafts but do not submit them: they validate what encoders submit.
const ALLOWED: Record<string, Person[]> = {
  'submit/draft': ['encoder'],
  'validate/submitted': ['validator'],
  'approve/validated': ['coordinator'],
  'return/submitted': ['validator'],
  'return/validated': ['coordinator'],
  'reopen/approved': ['coordinator'],
  'reopen/locked': ['coordinator'],
}

const ACTIONS = {
  submit: services.submit,
  validate: services.validate,
  approve: services.approve,
  return: services.returnRecord,
  reopen: services.reopen,
} as const

describe('the transition matrix', () => {
  const cases = (Object.keys(ACTIONS) as (keyof typeof ACTIONS)[]).flatMap((action) =>
    RECORD_STATUSES.flatMap((status) => PEOPLE.map((who) => [action, status, who] as const)),
  )

  it.each(cases)('%s on a %s record as %s', async (action, status, who) => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10 }, status })
    const allowed = ALLOWED[`${action}/${status}`]?.includes(who) ?? false
    const attempt = ACTIONS[action]({ actor: actors[who], recordId: record._id, comment: 'x' })

    if (allowed) {
      await attempt
      return
    }
    await expect(attempt).rejects.toSatisfy((error: { status: number }) =>
      [403, 404, 409].includes(error.status),
    )
    expect(await statusOf(record._id)).toBe(status)
    expect(await AuditLog.exists({ objectId: record._id })).toBeNull()
  })
})

describe('comments', () => {
  it.each([
    ['submitted', services.returnRecord, 'validator'],
    ['validated', services.returnRecord, 'coordinator'],
    ['approved', services.reopen, 'coordinator'],
    ['locked', services.reopen, 'coordinator'],
  ] as const)('are required to take back a %s record', async (status, run, who) => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10 }, status })
    await expect(
      run({ actor: actors[who], recordId: record._id, comment: '   ' }),
    ).rejects.toMatchObject({ code: 'comment_required' })
    expect(await statusOf(record._id)).toBe(status)
  })

  it('number up within a record', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10 }, status: 'submitted' })
    const recordId = record._id
    await services.returnRecord({ actor: actors.validator, recordId, comment: 'First' })
    await services.submit({ actor: actors.encoder, recordId, comment: 'Second' })
    const rows = await WorkflowComment.find({ inventoryRecordId: recordId })
      .sort({ number: 1 })
      .lean()
    expect(rows.map((row) => [row.number, row.body, row.action])).toEqual([
      [1, 'First', 'return'],
      [2, 'Second', 'submit'],
    ])
  })
})

describe('returning', () => {
  it('clears the review stamps', async () => {
    const record = await makeRecord({
      stand,
      counts: { FRUITING: 10 },
      status: 'validated',
      submittedAt: new Date(),
      validatedAt: new Date(),
      validatedById: actors.validator.id,
    })
    const after = await services.returnRecord({
      actor: actors.coordinator,
      recordId: record._id,
      comment: 'Please recount',
    })
    expect(after.status).toBe('draft')
    expect([after.submittedAt, after.validatedAt, after.validatedById]).toEqual([null, null, null])
    expect(after.version).toBe(1)
  })
})

describe('reopening', () => {
  it('bumps the version, clears stamps and keeps the comment', async () => {
    const record = await makeRecord({
      stand,
      counts: { FRUITING: 10 },
      status: 'locked',
      approvedById: actors.coordinator.id,
    })
    const after = await services.reopen({
      actor: actors.coordinator,
      recordId: record._id,
      comment: 'Recount needed',
    })
    expect([after.status, after.version, after.approvedById]).toEqual(['draft', 2, null])
    const comment = await WorkflowComment.findOne({ inventoryRecordId: record._id }).lean()
    expect(comment?.body).toBe('Recount needed')
    const entry = await AuditLog.findOne({
      action: 'inventory.reopen',
      objectId: record._id,
    }).lean()
    expect(entry?.before).toEqual({ status: 'locked', version: 1 })
    expect(entry?.after).toMatchObject({ status: 'draft', version: 2, comment: true })
  })

  it('allows a correction in a closed round, which locks on approval', async () => {
    const round = await makeRound(undefined, { status: 'closed' })
    const record = await makeRecord({ stand, round, counts: { FRUITING: 10 }, status: 'locked' })
    const recordId = record._id
    await services.reopen({ actor: actors.coordinator, recordId, comment: 'fix' })
    await services.updateRecord({
      actor: actors.encoder,
      recordId,
      counts: [{ growthStageId: await stageId('FRUITING'), count: 12 }],
    })
    await services.submit({ actor: actors.encoder, recordId })
    await services.validate({ actor: actors.validator, recordId })
    const after = await services.approve({ actor: actors.coordinator, recordId })
    expect(after.status).toBe('locked')
  })
})

describe('editing', () => {
  it('audits a change to a draft', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10 } })
    await services.updateRecord({
      actor: actors.encoder,
      recordId: record._id,
      counts: [
        { growthStageId: await stageId('VEGETATIVE'), count: 3 },
        { growthStageId: await stageId('FRUITING'), count: 15 },
      ],
      remarks: ' New remark ',
    })
    const entry = await AuditLog.findOne({
      action: 'inventory.update',
      objectId: record._id,
    }).lean()
    expect(entry?.before).toEqual({ counts: { FRUITING: 10 }, remarks: '' })
    expect(entry?.after).toEqual({
      counts: { VEGETATIVE: 3, FRUITING: 15 },
      remarks: 'New remark',
    })
  })

  it('writes no audit entry when nothing changed, whatever the order sent', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10, SEEDLING: 2 } })
    await services.updateRecord({
      actor: actors.encoder,
      recordId: record._id,
      counts: [
        { growthStageId: await stageId('FRUITING'), count: 10 },
        { growthStageId: await stageId('SEEDLING'), count: 2 },
      ],
    })
    expect(await AuditLog.exists({ action: 'inventory.update', objectId: record._id })).toBeNull()
  })

  it('lets a validator correct a submitted record, but not the encoder', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 10 }, status: 'submitted' })
    const recordId = record._id
    await services.updateRecord({ actor: actors.validator, recordId, remarks: 'corrected' })
    await expect(
      services.updateRecord({ actor: actors.encoder, recordId, remarks: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_editable', status: 409 })
  })

  it.each(['validated', 'approved', 'locked'] as const)(
    'is refused to everyone on a %s record',
    async (status) => {
      const record = await makeRecord({ stand, counts: { FRUITING: 10 }, status })
      for (const who of ['encoder', 'validator', 'coordinator'] as const) {
        await expect(
          services.updateRecord({ actor: actors[who], recordId: record._id, remarks: 'x' }),
        ).rejects.toMatchObject({ code: 'not_editable' })
      }
    },
  )

  it('is refused on an original draft once the round has closed', async () => {
    const round = await makeRound(undefined, { status: 'closed' })
    const record = await makeRecord({ stand, round, counts: { FRUITING: 1 } })
    await expect(
      services.updateRecord({ actor: actors.encoder, recordId: record._id, remarks: 'x' }),
    ).rejects.toMatchObject({ code: 'not_editable' })
  })

  it('checks that counts belong to the crop and appear once', async () => {
    const record = await makeRecord({ stand })
    const other = await Commodity.create({
      programId: crop.programId,
      code: `OTHER${record._id.slice(0, 6)}`,
      name: 'Sample other crop',
      measureType: 'trees',
    })
    const foreign = await GrowthStage.create({
      commodityId: other._id,
      code: 'X',
      label: 'X',
      sortOrder: 1,
    })
    const fruiting = await stageId('FRUITING')
    const update = (counts: services.CountInput[]) =>
      services.updateRecord({ actor: actors.encoder, recordId: record._id, counts })

    await expect(update([{ growthStageId: foreign._id, count: 1 }])).rejects.toMatchObject({
      code: 'stage_mismatch',
    })
    await expect(
      update([
        { growthStageId: fruiting, count: 1 },
        { growthStageId: fruiting, count: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate_stage' })
    await expect(update([{ growthStageId: fruiting, count: -1 }])).rejects.toMatchObject({
      code: 'negative_count',
    })
  })

  it('allows deleting only drafts', async () => {
    const draft = await makeRecord({ stand })
    await services.deleteRecord({ actor: actors.encoder, recordId: draft._id })
    expect(await InventoryRecord.exists({ _id: draft._id })).toBeNull()
    expect(
      await AuditLog.exists({ action: 'inventory.delete', objectId: draft._id }),
    ).not.toBeNull()

    const submitted = await makeRecord({ stand, counts: { FRUITING: 1 }, status: 'submitted' })
    await expect(
      services.deleteRecord({ actor: actors.validator, recordId: submitted._id }),
    ).rejects.toMatchObject({ code: 'not_editable' })
  })
})

describe('creating a record', () => {
  async function coffee(): Promise<CommodityDoc> {
    const row = await Commodity.create({
      programId: crop.programId,
      code: `COFFEE${stand._id.slice(0, 6)}`,
      name: 'Sample coffee',
      measureType: 'trees',
    })
    return row.toObject()
  }

  it('needs an open round', async () => {
    const round = await makeRound(undefined, { status: 'closed' })
    await expect(
      services.createRecord({ actor: actors.encoder, roundId: round._id, standId: stand._id }),
    ).rejects.toMatchObject({ code: 'round_closed' })
  })

  it('needs the round to be for the same crop', async () => {
    const round = await makeRound(await coffee())
    await expect(
      services.createRecord({ actor: actors.encoder, roundId: round._id, standId: stand._id }),
    ).rejects.toMatchObject({ code: 'commodity_mismatch' })
  })

  it('allows one record per crop stand per round', async () => {
    const round = await makeRound()
    const input = { actor: actors.encoder, roundId: round._id, standId: stand._id }
    await services.createRecord(input)
    await expect(services.createRecord(input)).rejects.toMatchObject({
      code: 'duplicate_record',
      status: 409,
    })
  })

  it('respects scope', async () => {
    const round = await makeRound()
    await expect(
      services.createRecord({
        actor: actors.otherValidator,
        roundId: round._id,
        standId: stand._id,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('refuses an unknown round', async () => {
    await expect(
      services.createRecord({
        actor: actors.encoder,
        roundId: '00000000-0000-4000-8000-000000000000',
        standId: stand._id,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('submit rules', () => {
  it('blocks an empty record, leaving it a draft', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 0 } })
    const attempt = services.submit({ actor: actors.encoder, recordId: record._id })
    await expect(attempt).rejects.toMatchObject({ code: 'validation_failed' })
    await expect(attempt).rejects.toHaveProperty('fields.counts')
    expect(await statusOf(record._id)).toBe('draft')
  })

  it('accepts zero counts with an explanation', async () => {
    const record = await makeRecord({ stand, remarks: 'All trees lost to typhoon' })
    const after = await services.submit({ actor: actors.encoder, recordId: record._id })
    expect(after.status).toBe('submitted')
  })

  it('keeps warnings in the flags, and still submits', async () => {
    const town = await makeBarangay((await makeMunicipality('Outlier Town'))._id)
    const round = await makeRound()
    for (let i = 0; i < 5; i += 1) {
      await makeRecord({
        stand: await makeStand(await makeFarm(town)),
        round,
        counts: { FRUITING: 100 },
        status: 'approved',
      })
    }
    const big = await makeRecord({
      stand: await makeStand(await makeFarm(town)),
      round,
      counts: { VEGETATIVE: 10_500 },
    })
    const after = await services.submit({ actor: actors.encoder, recordId: big._id })
    const warnings = after.flags.warnings as { code: string; message: string; data: object }[]
    expect(warnings.map((warning) => warning.code)).toEqual(['outlier'])
    expect(warnings[0]?.data).toEqual({ total: '10500', median: '100', sample: 5 })
    expect(warnings[0]?.message).toContain('10,500')
    expect(after.flags.checked_at).toBeTruthy()
  })

  it('needs at least five peers before calling anything an outlier', async () => {
    const town = await makeBarangay((await makeMunicipality('Small Sample Town'))._id)
    const round = await makeRound()
    for (let i = 0; i < 4; i += 1) {
      await makeRecord({
        stand: await makeStand(await makeFarm(town)),
        round,
        counts: { FRUITING: 10 },
        status: 'approved',
      })
    }
    const big = await makeRecord({
      stand: await makeStand(await makeFarm(town)),
      round,
      counts: { FRUITING: 10_000 },
    })
    const after = await services.submit({ actor: actors.encoder, recordId: big._id })
    expect(after.flags.warnings).toEqual([])
  })

  it('warns of a likely duplicate farmer with ids, not names', async () => {
    const town = await makeBarangay((await makeMunicipality('Duplicate Town'))._id)
    const { makeFarmer } = await import('./support/factories.js')
    const name = { firstName: 'Rosa', lastName: 'Sampleduplicate' }
    const other = await makeFarmer(town, name)
    const farmer = await makeFarmer(town, name)
    const own = await makeStand(await makeFarm(town, { farmerId: farmer._id }))
    const record = await makeRecord({ stand: own, counts: { FRUITING: 1 } })

    const after = await services.submit({ actor: actors.encoder, recordId: record._id })

    const warnings = after.flags.warnings as { code: string; data: { candidates: object[] } }[]
    expect(warnings.map((warning) => warning.code)).toEqual(['possible_duplicate_farmer'])
    expect(warnings[0]?.data.candidates).toEqual([{ id: other._id, similarity: 1, reason: 'name' }])
    expect(JSON.stringify(after.flags)).not.toContain('Rosa')
  })

  it('blocks submitting an original draft once the round has closed', async () => {
    const round = await makeRound(undefined, { status: 'closed' })
    const record = await makeRecord({ stand, round, counts: { FRUITING: 1 } })
    await expect(
      services.submit({ actor: actors.encoder, recordId: record._id }),
    ).rejects.toMatchObject({ code: 'round_closed' })
  })
})

describe('rounds', () => {
  it('open only for a manager of the program, and refuse a repeated name', async () => {
    const input = { commodityId: crop._id, asOfDate: '2025-01-01' }
    const name = `Cacao ${stand._id}`
    await expect(
      services.openRound({ actor: actors.otherCoordinator, ...input, name: 'X' }),
    ).rejects.toMatchObject({ status: 403 })
    const round = await services.openRound({
      actor: actors.coordinator,
      ...input,
      name: ` ${name} `,
    })
    expect(round.name).toBe(name)
    expect(round.programId).toBe(crop.programId)
    await expect(
      services.openRound({ actor: actors.coordinator, ...input, name }),
    ).rejects.toMatchObject({ code: 'duplicate_round', status: 409 })
    const entry = await AuditLog.findOne({ action: 'round.open', objectId: round._id }).lean()
    expect(entry?.after).toMatchObject({ name, commodity: crop.code, as_of: '2025-01-01' })
  })

  it.each(['submitted', 'validated'] as const)(
    'refuse to close with a %s record, changing nothing',
    async (status) => {
      const round = await makeRound()
      await makeRecord({ stand, round, counts: { FRUITING: 1 }, status })
      await expect(
        services.closeRound({ actor: actors.coordinator, roundId: round._id }),
      ).rejects.toMatchObject({ code: 'pending_records', status: 409 })
      expect((await SurveyRound.findOne({ _id: round._id }).lean())?.status).toBe('open')
    },
  )

  it('refuse to close twice', async () => {
    const round = await makeRound()
    await services.closeRound({ actor: actors.coordinator, roundId: round._id })
    await expect(
      services.closeRound({ actor: actors.coordinator, roundId: round._id }),
    ).rejects.toMatchObject({ code: 'round_closed' })
  })

  it('leave drafts unlocked when closing', async () => {
    const round = await makeRound()
    const draft = await makeRecord({ stand, round })
    expect(await services.closeRound({ actor: actors.coordinator, roundId: round._id })).toBe(0)
    expect(await statusOf(draft._id)).toBe('draft')
  })

  it('never let a record slip in as the round closes', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const round = await makeRound()
      const record = await makeRecord({
        stand: await newStand(),
        round,
        counts: { FRUITING: 1 },
      })
      await Promise.allSettled([
        services.submit({ actor: actors.encoder, recordId: record._id }),
        services.closeRound({ actor: actors.coordinator, roundId: round._id }),
      ])
      const closed = (await SurveyRound.findOne({ _id: round._id }).lean())?.status === 'closed'
      const status = await statusOf(record._id)
      // A closed round never has a record awaiting review.
      expect(closed && status === 'submitted').toBe(false)
    }
  })
})

describe('allowedActions', () => {
  it.each<[RecordStatus, Person, string[]]>([
    ['draft', 'encoder', ['edit', 'submit']],
    ['draft', 'validator', ['edit']],
    ['submitted', 'validator', ['edit', 'validate', 'return']],
    ['submitted', 'encoder', []],
    ['validated', 'coordinator', ['approve', 'return']],
    ['approved', 'coordinator', ['reopen']],
    ['locked', 'viewer', []],
  ])('on a %s record as %s', (status, who, expected) => {
    const record = {
      status,
      version: 1,
      barangayId: brgy._id,
      municipalityId: gasan._id,
      programId: crop.programId,
    }
    expect(allowedActions(actors[who].scope, record, 'open')).toEqual(expected)
  })

  it('leaves out submit when the round has closed', () => {
    const record = {
      status: 'draft' as const,
      version: 1,
      barangayId: brgy._id,
      municipalityId: gasan._id,
      programId: crop.programId,
    }
    expect(allowedActions(actors.encoder.scope, record, 'closed')).toEqual([])
    expect(allowedActions(actors.encoder.scope, { ...record, version: 2 }, 'closed')).toEqual([
      'edit',
      'submit',
    ])
  })
})

describe('links to farms', () => {
  it('blocks deleting a crop stand that has records', async () => {
    await makeRecord({ stand, counts: { FRUITING: 1 } })
    await expect(
      deleteCropStand({ actor: actors.encoder, standId: stand._id }),
    ).rejects.toMatchObject({ code: 'has_inventory', status: 409 })
  })

  it('moves a record with its farm', async () => {
    const elsewhere = await makeBarangay(boac._id)
    const record = await makeRecord({ stand, counts: { FRUITING: 1 } })
    await updateFarm({
      actor: actors.encoder,
      farmId: stand.farmId,
      data: { barangay: elsewhere._id },
    })
    const after = await InventoryRecord.findOne({ _id: record._id }).lean()
    expect([after?.barangayId, after?.municipalityId]).toEqual([elsewhere._id, boac._id])
  })

  it('never leaves a record on a deleted crop stand', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const own = await newStand()
      const round = await makeRound()
      await Promise.allSettled([
        deleteCropStand({ actor: actors.encoder, standId: own._id }),
        services.createRecord({ actor: actors.encoder, roundId: round._id, standId: own._id }),
      ])
      const alive = await CropStand.exists({ _id: own._id })
      const records = await InventoryRecord.countDocuments({ cropStandId: own._id })
      expect(Boolean(alive)).toBe(records === 1)
    }
  })
})

describe('the API', () => {
  const API = '/api/v1/inventory-records'

  it('walks a record through the workflow to the contract', async () => {
    const round = await makeRound()
    const created = await signedIn(
      request(app)
        .post(API)
        .send({
          survey_round: round._id,
          crop_stand: stand._id,
          counts: [{ growth_stage: await stageId('FRUITING'), count: 40 }],
          remarks: 'Synthetic',
        }),
      users.encoder,
    )
    expect(created.status).toBe(201)
    expect(contractProblems(API, 'post', 201, created.body)).toEqual([])
    const body = created.body as { id: string; total: number; allowed_actions: string[] }
    expect(body.total).toBe(40)
    expect(body.allowed_actions).toEqual(['edit', 'submit'])
    const url = `${API}/${body.id}`
    const path = `${API}/{id}`

    const patched = await signedIn(
      request(app)
        .patch(url)
        .send({ counts: [{ growth_stage: await stageId('FRUITING'), count: 41 }] }),
      users.encoder,
    )
    expect(contractProblems(path, 'patch', 200, patched.body)).toEqual([])

    const steps: [string, Person, object][] = [
      ['submit', 'encoder', {}],
      ['return', 'validator', { comment: 'Please recount' }],
      ['submit', 'encoder', {}],
      ['validate', 'validator', {}],
      ['approve', 'coordinator', {}],
      ['reopen', 'coordinator', { comment: 'Late correction' }],
    ]
    for (const [action, who, sent] of steps) {
      const response = await signedIn(request(app).post(`${url}/${action}`).send(sent), users[who])
      expect(response.status).toBe(200)
      expect(contractProblems(`${path}/${action}`, 'post', 200, response.body)).toEqual([])
    }

    const comments = await signedIn(request(app).get(`${url}/comments`), users.head)
    expect(contractProblems(`${path}/comments`, 'get', 200, comments.body)).toEqual([])
    expect(comments.body).toHaveLength(2)

    const audit = await signedIn(request(app).get(`${url}/audit`), users.head)
    expect(contractProblems(`${path}/audit`, 'get', 200, audit.body)).toEqual([])

    const detail = await signedIn(request(app).get(url), users.head)
    expect(contractProblems(path, 'get', 200, detail.body)).toEqual([])
    expect((detail.body as { version: number }).version).toBe(2)

    const list = await signedIn(request(app).get(`${API}?survey_round=${round._id}`), users.head)
    expect(contractProblems(API, 'get', 200, list.body)).toEqual([])
    expect((list.body as { count: number }).count).toBe(1)

    expect((await signedIn(request(app).delete(url), users.encoder)).status).toBe(204)
  })

  it('accepts a workflow action with no body at all', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 1 } })
    const response = await signedIn(request(app).post(`${API}/${record._id}/submit`), users.encoder)
    expect(response.status).toBe(200)
  })

  it('never takes a status from a generic edit', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 1 } })
    await signedIn(
      request(app).patch(`${API}/${record._id}`).send({ status: 'approved', version: 9 }),
      users.encoder,
    )
    const after = await InventoryRecord.findOne({ _id: record._id }).lean()
    expect([after?.status, after?.version]).toEqual(['draft', 1])
  })

  it('filters by repeated status, round, town and farmer, and sorts', async () => {
    const round = await makeRound()
    const first = await makeRecord({ stand, round, counts: { FRUITING: 1 }, status: 'submitted' })
    const second = await makeRecord({
      stand: await newStand(),
      round,
      counts: { FRUITING: 1 },
      status: 'validated',
    })
    await makeRecord({ stand: await newStand(), round, status: 'draft' })
    const ids = async (query: string) => {
      const { body } = (await signedIn(
        request(app).get(`${API}?survey_round=${round._id}&${query}`),
        users.head,
      )) as unknown as { body: { results: { id: string }[] } }
      return body.results.map((row) => row.id).sort()
    }
    expect(await ids('status=submitted&status=validated')).toEqual([first._id, second._id].sort())
    expect(await ids('status=submitted')).toEqual([first._id])
    expect(await ids(`crop_stand=${stand._id}`)).toEqual([first._id])
    expect(await ids(`municipality=${boac._id}`)).toEqual([])
    const farm = await Farm.findOne({ _id: stand.farmId }).lean()
    expect(await ids(`farmer=${farm?.farmerId ?? ''}`)).toEqual([first._id])
    const unrelated = (await makeFarm(brgy)).farmerId
    expect(await ids(`farmer=${unrelated}`)).toEqual([])
    const refused = await signedIn(request(app).get(`${API}?status=nonsense`), users.head)
    expect(refused.status).toBe(400)
  })

  it('validates what it is sent', async () => {
    const round = await makeRound()
    const fruiting = await stageId('FRUITING')
    const post = (body: object) => signedIn(request(app).post(API).send(body), users.encoder)
    const base = { survey_round: round._id, crop_stand: stand._id }
    for (const bad of [
      { crop_stand: stand._id },
      { ...base, counts: [{ growth_stage: fruiting, count: -1 }] },
      { ...base, counts: [{ growth_stage: fruiting, count: 1.5 }] },
      { ...base, counts: [{ growth_stage: 'abc', count: 1 }] },
      { ...base, counts: [{ growth_stage: '00000000-0000-4000-8000-000000000000', count: 1 }] },
      { ...base, remarks: 'x'.repeat(2001) },
    ]) {
      expect((await post(bad)).status).toBe(400)
    }
  })

  it('answers 403 to a role without the capability, and 404 out of scope', async () => {
    const record = await makeRecord({ stand, counts: { FRUITING: 1 }, status: 'submitted' })
    const url = `${API}/${record._id}`
    const post = async (action: string, who: Person) =>
      (await signedIn(request(app).post(`${url}/${action}`).send({ comment: 'x' }), users[who]))
        .status
    expect(await post('validate', 'encoder')).toBe(403)
    expect(await post('validate', 'otherValidator')).toBe(404)
    expect(await post('approve', 'validator')).toBe(403)
    expect(await post('return', 'viewer')).toBe(403)
    expect(await post('return', 'encoder')).toBe(403)
  })

  describe('rounds', () => {
    const ROUNDS = '/api/v1/survey-rounds'

    it('work to the contract', async () => {
      const created = await signedIn(
        request(app)
          .post(ROUNDS)
          .send({
            commodity: crop._id,
            name: `Api round ${stand._id}`,
            as_of_date: '2025-06-30',
            deadline: '2025-07-31',
          }),
        users.coordinator,
      )
      expect(created.status).toBe(201)
      expect(contractProblems(ROUNDS, 'post', 201, created.body)).toEqual([])
      const { id } = created.body as { id: string }
      expect(created.body).toMatchObject({
        as_of_date: '2025-06-30',
        deadline: '2025-07-31',
        status: 'open',
        is_historical: false,
      })

      for (const [suffix, path] of [
        ['', `${ROUNDS}/{id}`],
        ['/progress', `${ROUNDS}/{id}/progress`],
        ['/totals', `${ROUNDS}/{id}/totals`],
      ] as const) {
        const response = await signedIn(request(app).get(`${ROUNDS}/${id}${suffix}`), users.viewer)
        expect(response.status).toBe(200)
        expect(contractProblems(path, 'get', 200, response.body)).toEqual([])
      }

      const list = await signedIn(
        request(app).get(`${ROUNDS}?commodity=${crop._id}&status=open`),
        users.viewer,
      )
      expect(contractProblems(ROUNDS, 'get', 200, list.body)).toEqual([])

      const closed = await signedIn(request(app).post(`${ROUNDS}/${id}/close`), users.coordinator)
      expect(closed.status).toBe(200)
      expect(schemaProblems('CloseResult', closed.body)).toEqual([])
    })

    it('are limited to the role that manages them, and to the program', async () => {
      const round = await makeRound()
      const url = `${ROUNDS}/${round._id}`
      expect((await signedIn(request(app).post(`${url}/close`), users.encoder)).status).toBe(403)
      expect((await signedIn(request(app).get(url), users.otherCoordinator)).status).toBe(404)
      const refused = await signedIn(
        request(app)
          .post(ROUNDS)
          .send({ commodity: crop._id, name: 'X', as_of_date: '2025-01-01' }),
        users.head,
      )
      expect(refused.status).toBe(403)
      const blank = await signedIn(
        request(app)
          .post(ROUNDS)
          .send({ commodity: crop._id, name: ' ', as_of_date: '2025-01-01' }),
        users.coordinator,
      )
      expect(blank.status).toBe(400)
    })
  })
})
