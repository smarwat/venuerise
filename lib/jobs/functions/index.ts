import 'server-only'
import { qualifyLeadFn } from './qualify-lead'
import { processFollowUpsCronFn, processSingleFollowUpFn } from './process-follow-ups'
import { tourRemindersFn } from './tour-reminders'
import { billingTrialReminderFn } from './billing-trial-reminder'
import { billingDunningFn } from './billing-dunning'
import { billingTourAutoPauseFn } from './billing-tour-auto-pause'
import { seedTourStatusEventsFn } from './seed-tour-status-events'
import { operatorActivityDigestFn } from './operator-activity-digest'
import { seedMemberDigestPreferencesFn } from './seed-member-digest-preferences'
import { digestAuditRetentionFn } from './digest-audit-retention'

/** Every Inngest function the app exposes. Single source of truth. */
export const allJobFunctions = [
  qualifyLeadFn,
  processFollowUpsCronFn,
  processSingleFollowUpFn,
  tourRemindersFn,
  billingTrialReminderFn,
  billingDunningFn,
  billingTourAutoPauseFn,
  seedTourStatusEventsFn,
  operatorActivityDigestFn,
  seedMemberDigestPreferencesFn,
  digestAuditRetentionFn,
]
