import type { NextFunction, Request, Response } from 'express'
import multer, { MulterError } from 'multer'

import { DomainError } from '../lib/errors.js'
import { pageOf, pageRequest } from '../lib/pagination.js'
import { authOf } from '../middleware/auth.js'
import * as admin from '../selectors/admin.selectors.js'
import * as catalog from '../selectors/catalog.selectors.js'
import { createAssignment, createUser } from '../services/accounts.service.js'
import * as catalogAdmin from '../services/catalogAdmin.service.js'
import * as reportSettings from '../services/reportSettings.service.js'
import * as userAdmin from '../services/userAdmin.service.js'
import * as v from '../validators/admin.validators.js'
import { pathId } from './helpers.js'

function actorId(req: Request): string {
  return authOf(req).user._id
}

// --- Users

export async function listUsers(req: Request, res: Response): Promise<void> {
  const page = pageRequest(req)
  const { count, results } = await admin.listUsers(v.userQuery.parse(req.query), page)
  res.json(pageOf(req, page, count, results))
}

export async function getUser(req: Request, res: Response): Promise<void> {
  res.json(await admin.getUser(pathId(req)))
}

export async function createStaffUser(req: Request, res: Response): Promise<void> {
  const body = v.createUserBody.parse(req.body)
  const user = await createUser({
    email: body.email,
    password: body.password,
    firstName: body.first_name ?? '',
    lastName: body.last_name ?? '',
    actorId: actorId(req),
  })
  res.status(201).json(await admin.getUser(user._id))
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const body = v.updateUserBody.parse(req.body)
  const user = await userAdmin.updateUser({
    actorId: actorId(req),
    id: pathId(req),
    email: body.email,
    firstName: body.first_name,
    lastName: body.last_name,
    isActive: body.is_active,
  })
  res.json(await admin.getUser(user._id))
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { password } = v.passwordBody.parse(req.body)
  await userAdmin.resetPassword({ actorId: actorId(req), id: pathId(req), password })
  res.status(204).end()
}

export async function addAssignment(req: Request, res: Response): Promise<void> {
  const body = v.assignmentBody.parse(req.body)
  const id = pathId(req)
  await admin.getUser(id)
  await createAssignment({
    userId: id,
    role: body.role,
    municipalityId: body.municipality ?? null,
    programId: body.program ?? null,
    barangayIds: body.barangays ?? [],
    actorId: actorId(req),
  })
  res.status(201).json(await admin.getUser(id))
}

export async function removeAssignment(req: Request, res: Response): Promise<void> {
  await userAdmin.removeAssignment({
    actorId: actorId(req),
    userId: pathId(req),
    assignmentId: pathId(req, 'assignment_id'),
  })
  res.status(204).end()
}

// --- Catalog

export async function createProgram(req: Request, res: Response): Promise<void> {
  const body = v.createProgramBody.parse(req.body)
  const program = await catalogAdmin.createProgram({ actorId: actorId(req), ...body })
  res.status(201).json(await catalog.getProgram(program._id))
}

export async function updateProgram(req: Request, res: Response): Promise<void> {
  const body = v.updateProgramBody.parse(req.body)
  const program = await catalogAdmin.updateProgram({
    actorId: actorId(req),
    id: pathId(req),
    ...body,
  })
  res.json(await catalog.getProgram(program._id))
}

export async function createCommodity(req: Request, res: Response): Promise<void> {
  const body = v.createCommodityBody.parse(req.body)
  const id = await catalogAdmin.createCommodity({
    actorId: actorId(req),
    programId: body.program,
    code: body.code,
    name: body.name,
    measureType: body.measure_type,
    spacingM: body.spacing_m,
    plantsPerHa: body.plants_per_ha,
    outlierMultiplier: body.outlier_multiplier,
    attributesSchema: body.attributes_schema,
  })
  res.status(201).json(await catalog.getCommodity(id))
}

export async function updateCommodity(req: Request, res: Response): Promise<void> {
  const body = v.updateCommodityBody.parse(req.body)
  const id = pathId(req)
  await catalogAdmin.updateCommodity({
    actorId: actorId(req),
    id,
    programId: body.program,
    name: body.name,
    measureType: body.measure_type,
    spacingM: body.spacing_m,
    plantsPerHa: body.plants_per_ha,
    outlierMultiplier: body.outlier_multiplier,
    attributesSchema: body.attributes_schema,
  })
  res.json(await catalog.getCommodity(id))
}

export async function commodityUsage(req: Request, res: Response): Promise<void> {
  const id = pathId(req)
  await catalog.getCommodity(id)
  res.json(await catalogAdmin.commodityUsage(id))
}

export async function listStages(req: Request, res: Response): Promise<void> {
  res.json(await admin.listStages(pathId(req)))
}

export async function listVarieties(req: Request, res: Response): Promise<void> {
  res.json(await admin.listVarieties(v.varietyListQuery.parse(req.query).commodity))
}

export async function listSources(_req: Request, res: Response): Promise<void> {
  res.json(await admin.listSources())
}

export async function createStage(req: Request, res: Response): Promise<void> {
  const body = v.createStageBody.parse(req.body)
  const stage = await catalogAdmin.createStage({
    actorId: actorId(req),
    commodityId: pathId(req),
    code: body.code,
    label: body.label,
    sortOrder: body.sort_order,
    isBearing: body.is_bearing,
    aliases: body.aliases,
  })
  res.status(201).json(admin.adminStageView(stage))
}

export async function updateStage(req: Request, res: Response): Promise<void> {
  const body = v.updateStageBody.parse(req.body)
  const stage = await catalogAdmin.updateStage({
    actorId: actorId(req),
    id: pathId(req),
    label: body.label,
    sortOrder: body.sort_order,
    isBearing: body.is_bearing,
    aliases: body.aliases,
  })
  res.json(admin.adminStageView(stage))
}

export async function deleteStage(req: Request, res: Response): Promise<void> {
  await catalogAdmin.deleteStage({ actorId: actorId(req), id: pathId(req) })
  res.status(204).end()
}

export async function createVariety(req: Request, res: Response): Promise<void> {
  const body = v.createVarietyBody.parse(req.body)
  const variety = await catalogAdmin.createVariety({
    actorId: actorId(req),
    commodityId: body.commodity,
    code: body.code,
    name: body.name,
    aliases: body.aliases,
  })
  res.status(201).json(admin.adminVarietyView(variety))
}

export async function updateVariety(req: Request, res: Response): Promise<void> {
  const body = v.updateVarietyBody.parse(req.body)
  const variety = await catalogAdmin.updateVariety({
    actorId: actorId(req),
    id: pathId(req),
    name: body.name,
    aliases: body.aliases,
  })
  res.json(admin.adminVarietyView(variety))
}

export async function deleteVariety(req: Request, res: Response): Promise<void> {
  await catalogAdmin.deleteVariety({ actorId: actorId(req), id: pathId(req) })
  res.status(204).end()
}

export async function createSource(req: Request, res: Response): Promise<void> {
  const body = v.createSourceBody.parse(req.body)
  const source = await catalogAdmin.createSource({
    actorId: actorId(req),
    code: body.code,
    name: body.name,
    aliases: body.aliases,
  })
  res.status(201).json(admin.adminSourceView(source))
}

export async function updateSource(req: Request, res: Response): Promise<void> {
  const body = v.updateSourceBody.parse(req.body)
  const source = await catalogAdmin.updateSource({
    actorId: actorId(req),
    id: pathId(req),
    name: body.name,
    aliases: body.aliases,
  })
  res.json(admin.adminSourceView(source))
}

export async function deleteSource(req: Request, res: Response): Promise<void> {
  await catalogAdmin.deleteSource({ actorId: actorId(req), id: pathId(req) })
  res.status(204).end()
}

// --- Report settings

// One byte over the limit is kept, so an oversized file gets the same message however it arrives.
const parseLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: reportSettings.MAX_LOGO_BYTES + 1, files: 1 },
}).single('file')

export function receiveLogo(req: Request, res: Response, next: NextFunction): void {
  parseLogo(req, res, (error: unknown) => {
    if (error instanceof MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'The image is larger than 2 MB.'
          : 'The upload could not be read.'
      next(new DomainError('invalid_logo', message, { file: [message] }))
      return
    }
    next(error)
  })
}

export async function getReportSettings(_req: Request, res: Response): Promise<void> {
  res.json(await admin.reportSettingsView())
}

export async function updateReportSettings(req: Request, res: Response): Promise<void> {
  const body = v.updateReportSettingsBody.parse(req.body)
  await reportSettings.updateReportSettings({
    actorId: actorId(req),
    letterhead: body.letterhead,
    programLine: body.program_line,
  })
  res.json(await admin.reportSettingsView())
}

export async function uploadLogo(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    const message = 'Choose an image to upload.'
    throw new DomainError('invalid_logo', message, { file: [message] })
  }
  await reportSettings.setReportLogo({ actorId: actorId(req), content: req.file.buffer })
  res.json(await admin.reportSettingsView())
}

export async function removeLogo(req: Request, res: Response): Promise<void> {
  await reportSettings.removeReportLogo({ actorId: actorId(req) })
  res.json(await admin.reportSettingsView())
}

export async function listSignatories(_req: Request, res: Response): Promise<void> {
  res.json(await admin.listSignatories())
}

export async function createSignatory(req: Request, res: Response): Promise<void> {
  const body = v.createSignatoryBody.parse(req.body)
  const row = await reportSettings.createSignatory({
    actorId: actorId(req),
    reportKind: body.report_kind,
    order: body.order,
    caption: body.caption,
    name: body.name,
    title: body.title,
  })
  res.status(201).json(admin.signatoryView(row))
}

export async function updateSignatory(req: Request, res: Response): Promise<void> {
  const body = v.updateSignatoryBody.parse(req.body)
  const row = await reportSettings.updateSignatory({
    actorId: actorId(req),
    id: pathId(req),
    order: body.order,
    caption: body.caption,
    name: body.name,
    title: body.title,
  })
  res.json(admin.signatoryView(row))
}

export async function deleteSignatory(req: Request, res: Response): Promise<void> {
  await reportSettings.deleteSignatory({ actorId: actorId(req), id: pathId(req) })
  res.status(204).end()
}
