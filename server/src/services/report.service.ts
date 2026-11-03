import type { ClientSession } from 'mongoose'

import { DomainError } from '../lib/errors.js'
import { Cap } from '../lib/roles.js'
import { FULL_SCOPE, requireReach, type Actor } from '../lib/scoping.js'
import { inTransaction } from '../lib/transaction.js'
import { lockForWrite } from '../models/base.js'
import { ReportSignoff, type ReportSignoffDoc } from '../models/report.models.js'
import { SurveyRound, type SurveyRoundDoc } from '../models/survey.models.js'
import { contentHash, summaryContent } from '../selectors/report.selectors.js'
import { recordAudit } from './audit.service.js'

export interface SignoffStatus {
  signoff: ReportSignoffDoc | null
  currentSha256: string
  /** Superseded means the figures changed after signing, for example through a reopen. */
  state: 'unsigned' | 'signed' | 'superseded'
}

/** The province-wide summary is what gets signed, whatever the viewer's own scope. */
export async function signoffStatus(
  round: SurveyRoundDoc,
  session?: ClientSession,
): Promise<SignoffStatus> {
  const currentSha256 = contentHash(await summaryContent(round, FULL_SCOPE, session))
  const signoff = await ReportSignoff.findOne({ surveyRoundId: round._id, reportKind: 'summary' })
    .sort({ signedAt: -1 })
    .session(session ?? null)
    .lean<ReportSignoffDoc>()
  if (!signoff) return { signoff: null, currentSha256, state: 'unsigned' }
  const state = signoff.contentSha256 === currentSha256 ? 'signed' : 'superseded'
  return { signoff, currentSha256, state }
}

export async function signOffSummary({
  actor,
  roundId,
}: {
  actor: Actor
  roundId: string
}): Promise<ReportSignoffDoc> {
  return inTransaction(async (session) => {
    // Two people signing at once conflict here, and the second then sees the first's sign-off.
    await lockForWrite(SurveyRound, roundId, session)
    const round = await SurveyRound.findOne({ _id: roundId })
      .session(session)
      .lean<SurveyRoundDoc>()
    if (!round) throw new DomainError('not_found', 'Not found.', {}, 404)
    requireReach(actor.scope, Cap.SIGN_REPORTS, { programId: round.programId }, 'survey_round')
    if (round.status !== 'closed') {
      throw new DomainError('round_open', 'Close the round before signing its report.', {}, 409)
    }
    const status = await signoffStatus(round, session)
    if (status.state === 'signed') {
      throw new DomainError('already_signed', 'This report is already signed.', {}, 409)
    }
    const signoff = new ReportSignoff({
      surveyRoundId: round._id,
      reportKind: 'summary',
      contentSha256: status.currentSha256,
      signedById: actor.id,
      signedAt: new Date(),
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    await signoff.save({ session })
    await recordAudit({
      actorId: actor.id,
      action: 'report.sign_off',
      objectType: 'report_signoff',
      objectId: signoff._id,
      after: { round: round._id, sha256: signoff.contentSha256 },
      session,
    })
    return signoff.toObject()
  })
}
