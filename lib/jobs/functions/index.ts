import 'server-only'
import { qualifyLeadFn } from './qualify-lead'
import { processFollowUpsCronFn, processSingleFollowUpFn } from './process-follow-ups'
import { tourRemindersFn } from './tour-reminders'
import { billingTrialReminderFn } from './billing-trial-reminder'

/** Every Inngest function the app exposes. Single source of truth. */
export const allJobFunctions = [
  qualifyLeadFn,
  processFollowUpsCronFn,
  processSingleFollowUpFn,
  tourRemindersFn,
  billingTrialReminderFn,
]
