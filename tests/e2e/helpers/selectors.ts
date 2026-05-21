/**
 * Phase 9T — Stable selector registry.
 *
 * Keep all `data-testid` strings here so a future testid rename
 * touches one file. Avoid coupling tests to CSS classes or
 * structural DOM queries — Tailwind classes change with theme
 * passes (9R was a big one) and structural queries break on
 * minor JSX refactors.
 *
 * If a new testid is required, add it to the source component
 * AND register it here with a one-line comment naming the
 * component it lives in. The check:ui-interactions scanner does
 * not enforce this — convention only.
 */

export const SEL = {
  // KanbanBoard.tsx
  ADD_LEAD_BUTTON: '[data-testid="add-lead-button"]',

  // AddLeadModal.tsx
  ADD_LEAD_MODAL: '[data-testid="add-lead-modal"]',
  LEAD_NAME_INPUT: '[data-testid="lead-name-input"]',
  LEAD_EMAIL_INPUT: '[data-testid="lead-email-input"]',
  LEAD_EVENT_DATE_INPUT: '[data-testid="lead-event-date-input"]',
  LEAD_GUEST_COUNT_INPUT: '[data-testid="lead-guest-count-input"]',
  LEAD_BUDGET_INPUT: '[data-testid="lead-budget-input"]',
  LEAD_NOTES_INPUT: '[data-testid="lead-notes-input"]',
  LEAD_SUBMIT_BUTTON: '[data-testid="lead-submit-button"]',
  LEAD_CANCEL_BUTTON: '[data-testid="lead-cancel-button"]',

  // KanbanCard.tsx
  KANBAN_CARD: '[data-testid="kanban-card"]',
  KANBAN_CARD_BY_EMAIL: (email: string) =>
    `[data-testid="kanban-card"][data-lead-email="${email}"]`,

  // LeadDetailDrawer.tsx
  LEAD_DETAIL_DRAWER: '[data-testid="lead-detail-drawer"]',
  LEAD_DRAWER_BACKDROP_CLOSE: '[data-testid="lead-drawer-backdrop-close"]',

  // SettingsTabs.tsx
  SETTINGS_TAB_PROFILE: '[data-testid="settings-tab-profile"]',
  SETTINGS_TAB_AI: '[data-testid="settings-tab-ai"]',
  SETTINGS_TAB_KB: '[data-testid="settings-tab-kb"]',
  SETTINGS_TAB_AVAILABILITY: '[data-testid="settings-tab-availability"]',
  SETTINGS_TAB_TEAM: '[data-testid="settings-tab-team"]',
  SETTINGS_TAB_BILLING: '[data-testid="settings-tab-billing"]',

  // KnowledgeBaseTab in SettingsTabs.tsx
  KB_ADD_BUTTON: '[data-testid="kb-add-button"]',
  KB_DRAFT_TITLE_INPUT: '[data-testid="kb-draft-title-input"]',
  KB_DRAFT_CONTENT_INPUT: '[data-testid="kb-draft-content-input"]',
  KB_DRAFT_SAVE_BUTTON: '[data-testid="kb-draft-save-button"]',
  KB_ROW: '[data-testid="kb-row"]',
  KB_ROW_BY_TITLE: (title: string) =>
    `[data-testid="kb-row"][data-kb-title="${title}"]`,
  KB_ROW_EDIT: '[data-testid="kb-row-edit-button"]',
  KB_ROW_TOGGLE: '[data-testid="kb-row-toggle-button"]',
  KB_ROW_DELETE: '[data-testid="kb-row-delete-button"]',
  KB_ROW_SAVE_EDIT: '[data-testid="kb-row-save-edit-button"]',
}

/** Test data prefixes — every E2E-created row gets one of these so
 *  cleanup helpers can locate (and operators can recognise) what was
 *  created by the suite. Never delete rows that don't carry one. */
export const E2E_PREFIX = {
  LEAD: 'E2E Lead',
  KB_TITLE: 'E2E Parking Policy',
  BLACKOUT_REASON: 'E2E private event',
} as const
