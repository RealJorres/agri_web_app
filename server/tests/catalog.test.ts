import { beforeAll, describe, expect, it } from 'vitest'

import { DomainError } from '../src/lib/errors.js'
import {
  Commodity,
  GrowthStage,
  MaterialSource,
  Program,
  Unit,
  Variety,
  type CommodityDoc,
} from '../src/models/catalog.models.js'
import {
  AliasConflictError,
  AliasIndex,
  plantsPerHa,
  sourceIndex,
  stageIndex,
  varietyIndex,
} from '../src/selectors/catalog.selectors.js'
import {
  checkAttributesSchema,
  seedCatalog,
  validateAttributes,
} from '../src/services/catalog.service.js'
import { makeCommodity, makeProgram } from './support/factories.js'

let cacao: CommodityDoc

beforeAll(async () => {
  await seedCatalog()
  cacao = (await Commodity.findOne({ code: 'CACAO' }).lean<CommodityDoc>()) as CommodityDoc
})

function fieldsOf(attempt: () => void): Record<string, string[]> {
  try {
    attempt()
  } catch (error) {
    if (error instanceof DomainError) return error.fields
    throw error
  }
  throw new Error('Expected a DomainError')
}

// Every single-token spelling from brief §3. Multi-value cells ("UF18 & BR25") are split by the
// import normalizers before they reach the index.
describe('aliases', () => {
  it.each([
    ['BR25', 'BR25'],
    ['BR 25', 'BR25'],
    ['BR25 ', 'BR25'],
    ['UF18', 'UF18'],
    ['W10', 'W10'],
    ['  W10', 'W10'],
    ['Criollo', 'CRIOLLO'],
    ['CriolIo', 'CRIOLLO'],
    ['KI', 'K1'],
    ['K1', 'K1'],
    ['K18', undefined],
    ['K19', undefined],
    ['', undefined],
    [null, undefined],
  ])('variety %j -> %s', async (raw, code) => {
    expect((await varietyIndex(cacao._id)).resolve(raw)?.code).toBe(code)
  })

  it.each([
    ['DA-RFO', 'DA_RFO'],
    ['DA- RFO', 'DA_RFO'],
    ['DA', 'DA'],
    ['PCA', 'PCA'],
    ['Own Produced', 'OWN_PRODUCED'],
    ['Own Produce', 'OWN_PRODUCED'],
    ['own produced ', 'OWN_PRODUCED'],
    ['Purchased', 'PURCHASED'],
    ['PS', undefined],
  ])('source %j -> %s', async (raw, code) => {
    expect((await sourceIndex()).resolve(raw)?.code).toBe(code)
  })

  it.each([
    ['SEEDLING', 'SEEDLING'],
    ['GROWING', 'SEEDLING'],
    ['Vegetative', 'VEGETATIVE'],
    ['FLOWERING', 'FLOWERING'],
    ['FRUITING', 'FRUITING'],
  ])('stage %j -> %s', async (raw, code) => {
    expect((await stageIndex(cacao._id)).resolve(raw)?.code).toBe(code)
  })

  it('detects a conflict', () => {
    const rows = [
      { code: 'A', aliases: ['X'], name: 'Alpha' },
      { code: 'B', aliases: ['x '], name: 'Beta' },
    ]
    expect(() => new AliasIndex(rows)).toThrow(AliasConflictError)
  })

  it('counts each distinct key', () => {
    expect(new AliasIndex([{ code: 'A', aliases: ['A1'], name: 'Alpha' }]).size).toBe(3)
  })
})

describe('the cacao configuration', () => {
  it('has its stages in order, with only fruiting bearing', async () => {
    const stages = await GrowthStage.find({ commodityId: cacao._id }).sort({ sortOrder: 1 }).lean()
    expect(stages.map((stage) => [stage.code, stage.isBearing])).toEqual([
      ['SEEDLING', false],
      ['VEGETATIVE', false],
      ['FLOWERING', false],
      ['FRUITING', true],
    ])
    expect(cacao.measureType).toBe('trees')
    expect(cacao.plantsPerHa).toBe(625)
  })

  it('gives 130.74 ha for the province total (brief §3, ADR-0004)', () => {
    expect((81_712 / (plantsPerHa(cacao) as number)).toFixed(2)).toBe('130.74')
    expect(plantsPerHa(cacao, 4)).toBe(625)
    expect(plantsPerHa(cacao, 3)).toBeCloseTo(1111.11, 2)
  })

  it('has no density when none is configured', () => {
    expect(plantsPerHa({ plantsPerHa: null })).toBeNull()
  })
})

describe('seeding', () => {
  it('is idempotent and keeps aliases added by an administrator', async () => {
    const before = await Variety.findOne({ commodityId: cacao._id, code: 'BR25' })
    if (!before) throw new Error('BR25 was not seeded')
    before.aliases.push('BR-25 clone')
    await before.save()

    const report = await seedCatalog()

    expect(report.created).toEqual({})
    expect(await Commodity.countDocuments({ code: 'CACAO' })).toBe(1)
    expect(await GrowthStage.countDocuments({ commodityId: cacao._id })).toBe(4)
    expect(await MaterialSource.countDocuments()).toBe(5)
    expect(await Unit.countDocuments()).toBe(4)
    const after = await Variety.findOne({ commodityId: cacao._id, code: 'BR25' }).lean()
    expect(after?.aliases).toContain('BR-25 clone')
    expect(after?.aliases.filter((alias) => alias === 'BR 25')).toHaveLength(1)
  })

  it('rolls everything back when an alias is ambiguous', async () => {
    // The seed writes programs first and checks source aliases later, so a surviving seed value
    // here would mean the earlier write was not rolled back.
    await Program.updateOne({ code: 'HVCDP' }, { name: 'Changed by hand' })
    const extra = await MaterialSource.create({
      code: 'SYNTHETIC',
      name: 'Synthetic source',
      aliases: ['PCA'],
    })

    await expect(seedCatalog()).rejects.toThrow(AliasConflictError)

    expect((await Program.findOne({ code: 'HVCDP' }).lean())?.name).toBe('Changed by hand')
    await MaterialSource.deleteOne({ _id: extra._id })
    await seedCatalog()
    expect((await Program.findOne({ code: 'HVCDP' }).lean())?.name).not.toBe('Changed by hand')
  })

  it('brings back a soft-deleted seed row as a new row', async () => {
    await MaterialSource.updateOne(
      { code: 'PURCHASED' },
      { isDeleted: true, deletedAt: new Date() },
    )

    await seedCatalog()

    expect(await MaterialSource.countDocuments({ code: 'PURCHASED' })).toBe(1)
    expect(await MaterialSource.countDocuments({ code: 'PURCHASED', isDeleted: true })).toBe(1)
  })
})

describe('attributes schema', () => {
  it('rejects a schema that is not valid JSON Schema', () => {
    let code = ''
    try {
      checkAttributesSchema({ type: 'not-a-type' })
    } catch (error) {
      code = (error as DomainError).code
    }
    expect(code).toBe('invalid_schema')
  })

  it('allows an empty schema', () => {
    expect(() => {
      checkAttributesSchema({})
    }).not.toThrow()
  })

  it('accepts valid attributes', () => {
    expect(() => {
      validateAttributes(cacao, { shade_trees: true })
    }).not.toThrow()
  })

  it('reports invalid attributes by path', () => {
    const fields = fieldsOf(() => {
      validateAttributes(cacao, { shade_trees: 'yes', colour: 'brown' })
    })
    expect(Object.keys(fields).sort()).toEqual(['attributes', 'attributes.shade_trees'])
    expect(fields.attributes?.[0]).toContain('colour')
  })

  it('reports nested paths', () => {
    const schema = {
      type: 'object',
      properties: { soil: { type: 'object', properties: { ph: { type: 'number' } } } },
    }
    const fields = fieldsOf(() => {
      validateAttributes({ attributesSchema: schema }, { soil: { ph: 'low' } })
    })
    expect(Object.keys(fields)).toEqual(['attributes.soil.ph'])
  })

  it('accepts anything when the commodity has no schema', () => {
    expect(() => {
      validateAttributes({ attributesSchema: {} }, { anything: 1 })
    }).not.toThrow()
  })

  it('stores a schema using $ keywords and dotted names unchanged', async () => {
    const attributesSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { size: { type: 'number' } },
      properties: { 'a.b': { $ref: '#/$defs/size' } },
    }
    const program = await makeProgram()
    const made = await makeCommodity(program._id, { attributesSchema })

    const stored = await Commodity.findOne({ _id: made._id }).lean<CommodityDoc>()

    expect(stored?.attributesSchema).toEqual(attributesSchema)
    expect(() => {
      validateAttributes({ attributesSchema }, { 'a.b': 2 })
    }).not.toThrow()
  })

  it('keeps an empty schema instead of dropping the field', async () => {
    const program = await makeProgram()
    const made = await makeCommodity(program._id, { attributesSchema: {} })
    const stored = await Commodity.findOne({ _id: made._id }).lean<CommodityDoc>()
    expect(stored?.attributesSchema).toEqual({})
  })
})
