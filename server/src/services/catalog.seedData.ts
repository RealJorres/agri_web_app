/**
 * Catalog seed for Phase 1 (cacao under HVCDP). Adding a crop means adding an entry here or on the
 * admin screens.
 *
 * Aliases are the raw spellings observed in the 2023 workbook (brief §3). Codes not listed here
 * (K18, K19, "PS") are deliberately left unknown, so the import sends them to review.
 */
import type { MeasureType, UnitKind } from '../models/catalog.models.js'

export const PROGRAMS = [{ code: 'HVCDP', name: 'High Value Crops Development Program' }]

export interface StageSeed {
  code: string
  label: string
  sortOrder: number
  isBearing?: boolean
  aliases?: string[]
}

export interface VarietySeed {
  code: string
  name: string
  aliases?: string[]
}

export interface CommoditySeed {
  program: string
  code: string
  name: string
  measureType: MeasureType
  spacingM: string
  plantsPerHa: number
  outlierMultiplier: string
  attributesSchema: Record<string, unknown>
  stages: StageSeed[]
  varieties: VarietySeed[]
}

export const COMMODITIES: CommoditySeed[] = [
  {
    program: 'HVCDP',
    code: 'CACAO',
    name: 'Cacao',
    measureType: 'trees',
    spacingM: '4.00',
    plantsPerHa: 625, // 4 m x 4 m planting distance
    outlierMultiplier: '5',
    attributesSchema: {
      type: 'object',
      properties: {
        intercropped_with: { type: 'string', maxLength: 200 },
        shade_trees: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    stages: [
      { code: 'SEEDLING', label: 'Seedling', sortOrder: 1, aliases: ['Growing'] },
      { code: 'VEGETATIVE', label: 'Vegetative', sortOrder: 2 },
      { code: 'FLOWERING', label: 'Flowering', sortOrder: 3 },
      { code: 'FRUITING', label: 'Fruiting', sortOrder: 4, isBearing: true },
    ],
    varieties: [
      { code: 'BR25', name: 'BR 25', aliases: ['BR 25', 'BR-25'] },
      { code: 'UF18', name: 'UF 18', aliases: ['UF 18', 'UF-18'] },
      { code: 'W10', name: 'W 10', aliases: ['W 10', 'W-10'] },
      // "KI" is read as a misspelling of K1 (letter I for digit 1). Confirm with the PAO.
      { code: 'K1', name: 'K 1', aliases: ['K 1', 'K-1', 'KI'] },
      { code: 'CRIOLLO', name: 'Criollo', aliases: ['CriolIo', 'Criolo', 'Creollo'] },
    ],
  },
]

export const MATERIAL_SOURCES = [
  {
    code: 'DA_RFO',
    name: 'DA Regional Field Office',
    aliases: ['DA-RFO', 'DA- RFO', 'DA -RFO', 'DA RFO', 'DARFO'],
  },
  { code: 'DA', name: 'Department of Agriculture', aliases: ['D.A.'] },
  { code: 'PCA', name: 'Philippine Coconut Authority', aliases: ['P.C.A.'] },
  {
    code: 'OWN_PRODUCED',
    name: 'Own produced',
    aliases: ['Own Produced', 'Own Produce', 'Own production', 'Own'],
  },
  { code: 'PURCHASED', name: 'Purchased', aliases: ['Bought'] },
]

export const UNITS: {
  code: string
  name: string
  kind: UnitKind
  toBase: string | null
  aliases: string[]
}[] = [
  {
    code: 'KG',
    name: 'Kilogram',
    kind: 'mass',
    toBase: '1',
    aliases: ['kg', 'kgs', 'kilo', 'kilos', 'kl', 'kls'],
  },
  {
    code: 'SACK',
    name: 'Sack',
    kind: 'container',
    toBase: null,
    aliases: ['sack', 'sacks', 'sako'],
  },
  {
    code: 'HA',
    name: 'Hectare',
    kind: 'area',
    toBase: '1',
    aliases: ['ha', 'hectare', 'hectares'],
  },
  { code: 'TREE', name: 'Tree', kind: 'count', toBase: '1', aliases: ['tree', 'trees'] },
]
