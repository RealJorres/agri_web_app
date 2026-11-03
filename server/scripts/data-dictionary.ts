/** Regenerates docs/data-dictionary.md from the models: npm run data-dictionary -w server */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import mongoose from 'mongoose'

import {
  buildDataDictionary,
  personalFields,
  type DictionaryModel,
} from '../src/lib/dataDictionary.js'
import { FARM_PERSONAL_FIELDS } from '../src/models/farm.models.js'
import '../src/models/index.js'
import { FARMER_PERSONAL_FIELDS } from '../src/models/registry.models.js'

const models = Object.values(mongoose.models) as unknown as DictionaryModel[]
const content = buildDataDictionary(
  models,
  personalFields(FARMER_PERSONAL_FIELDS, FARM_PERSONAL_FIELDS),
)
writeFileSync(join(import.meta.dirname, '..', '..', 'docs', 'data-dictionary.md'), content)
console.log(`Wrote the data dictionary: ${String(models.length)} collections.`)
