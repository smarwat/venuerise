import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getJobsRuntime } from '@/lib/jobs/queue'
import { emailConfigured } from '@/lib/integrations/email'
import { isOutboundEmailConfigured } from '@/lib/integrations/delivery/email'
import { isOutboundSmsConfigured } from '@/lib/integrations/delivery/sms'
import { isInboundSmsEnabled } from '@/lib/integrations/inbound/sms'
import { getRateLimitStatus, type RateLimitStatus } from '@/lib/rate-limit'
import { log } from '@/lib/log'
import { getOrCreateRequestId, withRequestIdHeader } from '@/lib/observability/request-id'
import { captureApiError } from '@/lib/observability/sentry'
import pkg from '../../../package.json'

/**
 * Health endpoint for uptime monitors.
 *
 * - Unauthenticated (so external pingers can hit it).
 * - Never leaks secrets — only coarse status strings.
 * - Never spends Anthropic tokens or Resend credits — provider checks are
 *   strictly configuration-presence, not live pings.
 * - Returns 200 unless Supabase is unreachable (then 503).
 */

type Status = 'ok' | 'configured' | 'missing' | 'down' | 'console-fallback'

interface HealthBody {
  ok: boolean
  version: string
  supabase: Status
  anthropic: Status
  email: Status
  resend_webhook: 'configured' | 'missing'
  jobs: 'inngest' | 'local-fallback'
  upstash: RateLimitStatus
  sentry: 'configured' | 'missing'
  admin: { mounted: true; endpoints: number }
  tenant_access: {
    venue_members: 'ok' | 'missing'
    rls_membership: 'ok' | 'missing'
  }
  onboarding: { api: 'mounted' }
  team: { invitations: 'mounted'; dashboard: 'mounted' }
  billing: {
    stripe: 'configured' | 'missing'
    webhook: 'configured' | 'missing'
    gate: 'enabled' | 'disabled'
    events_log: 'mounted'
    trial_reminder: 'mounted'
    replay: 'mounted'
    dunning: 'mounted'
    recovery_email: 'mounted'
    admin_clear_dunning: 'mounted'
    tour_auto_pause: 'mounted'
    tour_auto_resume: 'mounted'
    tour_auto_pause_rearm: 'mounted'
    bulk_cancel_notifications: 'mounted'
  }
  demo: {
    seed: 'mounted'
    realtime: 'mounted'
    tour_quick_schedule: 'mounted'
    tour_drawer: 'mounted'
    tour_edit: 'mounted'
    tour_reschedule_from_inbox: 'mounted'
    tour_pause_audit: 'mounted'
    tour_bulk_resume: 'mounted'
    tour_week_panel: 'mounted'
    tour_action_links: 'mounted'
    tour_action_audit: 'mounted'
    tour_status_audit: 'mounted'
    tour_audit_ui: 'mounted'
    tour_status_backfill: 'mounted'
    tour_status_filters: 'mounted'
    tour_status_csv: 'mounted'
    tour_status_realtime: 'mounted'
    tour_status_url_filters: 'mounted'
    tour_status_csv_pagination: 'mounted'
    tour_status_realtime_debounce: 'mounted'
    tour_audit_deeplink: 'mounted'
    tour_status_filter_persistence: 'mounted'
    tour_status_search: 'mounted'
    tour_status_streamed_csv: 'mounted'
    tour_status_metadata_search: 'mounted'
    operator_activity_digest: 'mounted'
    tour_status_metadata_search_index: 'mounted'
    operator_digest_html: 'mounted'
    operator_digest_unsubscribe: 'mounted'
    operator_digest_preferences: 'mounted'
    operator_digest_cadence: 'mounted'
    tour_status_short_search: 'mounted'
    operator_digest_per_user: 'mounted'
    operator_digest_weekly_day: 'mounted'
    tour_status_search_hint: 'mounted'
    operator_digest_preview: 'mounted'
    operator_digest_recipient_batching: 'mounted'
    member_digest_backfill: 'mounted'
    operator_digest_resubscribe: 'mounted'
    operator_digest_send_kind: 'mounted'
    operator_digest_preview_suppression_ux: 'mounted'
    operator_digest_footer_links: 'mounted'
    operator_digest_manual_send: 'mounted'
    operator_digest_send_kind_manual: 'mounted'
    operator_digest_member_picker: 'mounted'
    operator_digest_send_audit: 'mounted'
    operator_digest_respect_cadence_manual: 'mounted'
    operator_digest_send_pagination: 'mounted'
    operator_digest_send_realtime: 'mounted'
    operator_digest_suppression_triage: 'mounted'
    operator_digest_suppression_remove: 'mounted'
    operator_digest_send_search: 'mounted'
    operator_digest_suppression_realtime_refresh: 'mounted'
    operator_digest_retention: 'mounted'
    operator_digest_cron_health: 'mounted'
    operator_digest_bulk_suppression_remove: 'mounted'
    operator_digest_search_highlights: 'mounted'
    operator_digest_show_archived: 'mounted'
    operator_digest_cron_health_realtime: 'mounted'
    operator_digest_audit_events: 'mounted'
    operator_digest_retention_dry_run: 'mounted'
    operator_digest_audit_search: 'mounted'
    operator_digest_audit_pagination: 'mounted'
    operator_digest_audit_action_family: 'mounted'
    operator_digest_cron_send_audit: 'mounted'
    operator_digest_cron_fired_toast: 'mounted'
    operator_digest_audit_url_state: 'mounted'
    operator_digest_audit_metadata_search: 'mounted'
    operator_digest_preview_audit: 'mounted'
    operator_digest_audit_preview_family: 'mounted'
    operator_digest_audit_cursor_read: 'mounted'
    operator_digest_send_url_state: 'mounted'
    operator_digest_audit_drawer: 'mounted'
    operator_digest_cron_audit_dedupe: 'mounted'
    operator_lead_drawer_approve_send: 'mounted'
    operator_lead_drawer_reject_persist: 'mounted'
    operator_command_palette: 'mounted'
    operator_ai_draft_regenerate: 'mounted'
    operator_command_palette_quick_actions: 'mounted'
    operator_inbox_left_rail: 'mounted'
    operator_tours_calendar_polish: 'mounted'
    operator_analytics_retheme: 'mounted'
    operator_lead_drawer_realtime: 'mounted'
    operator_command_palette_search: 'mounted'
    operator_lead_drawer_draft_stale_guard: 'mounted'
    operator_ai_draft_variants: 'mounted'
    operator_command_palette_message_search: 'mounted'
    operator_lead_drawer_lead_reply_guard: 'mounted'
    operator_ai_draft_variant_memory: 'mounted'
    operator_variant_replay_drawer: 'mounted'
    operator_message_similarity_search: 'mounted'
    operator_ai_draft_audit_card: 'mounted'
    operator_inbox_message_search: 'mounted'
    operator_ai_draft_audit_realtime: 'mounted'
    operator_ai_draft_audit_pagination: 'mounted'
    operator_ai_draft_audit_csv: 'mounted'
    revenue_os_product_thesis: 'mounted'
    agentic_workflow_map: 'mounted'
    revenue_leakage_brief: 'mounted'
    revenue_os_settings: 'mounted'
    revenue_leakage_scoring: 'mounted'
    speed_to_lead_score: 'mounted'
    leakage_leads_filter: 'mounted'
    speed_to_lead_rollup: 'mounted'
    cold_lead_baseline_fix: 'mounted'
    kanban_speed_to_lead_chip: 'mounted'
    follow_up_recovery_queue: 'mounted'
    lead_recovery_explainer: 'mounted'
    recovery_suggested_actions: 'mounted'
    recovery_leads_filter: 'mounted'
    tour_booking_agent_surfaces: 'mounted'
    tour_readiness_panel: 'mounted'
    tour_confirmation_queue: 'mounted'
    tour_conversion_rollup: 'mounted'
    tour_booking_leads_filter: 'mounted'
    revenue_os_digest_summary: 'mounted'
    operator_digest_revenue_reframe: 'mounted'
    digest_speed_to_lead_section: 'mounted'
    digest_recovery_section: 'mounted'
    digest_tour_booking_section: 'mounted'
    brand_voice_confidence_score: 'mounted'
    brand_voice_escalation_gate: 'mounted'
    brand_voice_settings: 'mounted'
    ai_draft_audit_low_confidence: 'mounted'
    brand_voice_confidence_telemetry: 'mounted'
    brand_voice_calibration_summary: 'mounted'
    brand_voice_operator_outcomes: 'mounted'
    brand_voice_overconfidence_signal: 'mounted'
    brand_voice_autopilot_guardrails: 'mounted'
    draft_risk_detection: 'mounted'
    lead_drawer_autopilot_decision: 'mounted'
    draft_audit_autopilot_breakdown: 'mounted'
    autonomous_sending_still_disabled: 'mounted'
    autopilot_simulation_mode: 'mounted'
    autopilot_simulation_summary: 'mounted'
    autopilot_operator_alignment: 'mounted'
    autopilot_simulation_panel: 'mounted'
    autopilot_review_queue: 'mounted'
    autopilot_review_labels: 'mounted'
    autopilot_rule_signal_summary: 'mounted'
    autopilot_shadow_evaluation: 'mounted'
    autopilot_safety_scorecard: 'mounted'
    per_venue_autonomy_readiness_gate: 'mounted'
    autonomy_eligibility_signal: 'mounted'
    tour_slot_suggestions: 'mounted'
    venue_tour_duration_setting: 'mounted'
    venue_tour_buffer_setting: 'mounted'
    tour_blackout_dates: 'mounted'
    tour_suggestion_timezone_awareness: 'mounted'
    lost_reason_taxonomy: 'mounted'
    reactivation_queue: 'mounted'
    reactivation_leads_filter: 'mounted'
    reactivation_digest_section: 'mounted'
    enterprise_audit_log: 'mounted'
    enterprise_audit_events_card: 'mounted'
    rbac_documentation_pass: 'mounted'
    request_context_baseline: 'mounted'
    enterprise_audit_coverage_matrix: 'mounted'
    enterprise_rbac_matrix: 'mounted'
    enterprise_audit_coverage_check: 'mounted'
    enterprise_audit_detail_drawer: 'mounted'
    enterprise_audit_mirror: 'mounted'
    enterprise_audit_mirror_best_effort: 'mounted'
    enterprise_data_export: 'mounted'
    lead_pii_redaction: 'mounted'
    data_lifecycle_card: 'mounted'
    retention_posture_visible: 'mounted'
    security_headers_report_only: 'mounted'
    csp_report_endpoint: 'mounted'
    hsts_header: 'mounted'
    permissions_policy_header: 'mounted'
    secrets_rotation_runbook: 'mounted'
    rate_limit_catalog: 'mounted'
    rate_limit_coverage_check: 'mounted'
    abuse_monitoring: 'mounted'
    abuse_monitor_card: 'mounted'
    public_route_throttles: 'mounted'
    sso_readiness: 'mounted'
    sso_connections_table: 'mounted'
    sso_login_events: 'mounted'
    sso_admin_endpoints: 'mounted'
    sso_provider_abstraction: 'mounted'
    backup_posture: 'mounted'
    disaster_recovery_runbook: 'mounted'
    restore_intent_audit: 'mounted'
    backup_posture_card: 'mounted'
    backup_posture_check: 'mounted'
    security_evidence_center: 'mounted'
    evidence_report_api: 'mounted'
    evidence_pack_generator: 'mounted'
    soc2_evidence_map: 'mounted'
    evidence_packaging_check: 'mounted'
    security_questionnaire_generator: 'mounted'
    buyer_security_summary: 'mounted'
    demo_mode_foundation: 'mounted'
    enterprise_readiness_checklist: 'mounted'
    sales_readiness_exports: 'mounted'
    vendor_risk_registry: 'mounted'
    subprocessor_disclosure: 'mounted'
    vendor_risk_exports: 'mounted'
    vendor_risk_cards: 'mounted'
    vendor_risk_check: 'mounted'
    incident_response_records: 'mounted'
    incident_detection_candidates: 'mounted'
    incident_alert_routing: 'mounted'
    incident_response_card: 'mounted'
    incident_response_pack: 'mounted'
    privacy_data_inventory: 'mounted'
    privacy_retention_policy: 'mounted'
    dsr_request_tracking: 'mounted'
    dsr_non_destructive_reviews: 'mounted'
    privacy_readiness_pack: 'mounted'
    trust_center_public_summary: 'mounted'
    trust_center_gated_packets: 'mounted'
    trust_access_tracking: 'mounted'
    trust_center_admin_cards: 'mounted'
    trust_center_pack: 'mounted'
    compliance_calendar: 'mounted'
    compliance_freshness_tracking: 'mounted'
    compliance_review_workflow: 'mounted'
    compliance_calendar_card: 'mounted'
    compliance_ops_pack: 'mounted'
    contract_commitments_register: 'mounted'
    commitments_readiness: 'mounted'
    unsupported_commitment_warnings: 'mounted'
    commitments_pack: 'mounted'
    omnichannel_channel_registry: 'mounted'
    channel_connection_admin: 'mounted'
    external_conversation_mapping: 'mounted'
    inbound_channel_normalization: 'mounted'
    manual_required_reply_workflow: 'mounted'
    inbox_channel_badges: 'mounted'
    omnichannel_inbox_loader_channels: 'mounted'
    manual_reply_banner_mounted: 'mounted'
    manual_channel_reply_confirmation_ui: 'mounted'
    lead_forwarding_parser: 'mounted'
    the_knot_forwarding_parser: 'mounted'
    weddingwire_forwarding_parser: 'mounted'
    parse_confidence_review: 'mounted'
    lead_forwarding_test_parse: 'mounted'
    meta_webhook_signature_verification: 'mounted'
    instagram_inbound_connector: 'mounted'
    facebook_inbound_connector: 'mounted'
    meta_lead_ads_placeholder: 'mounted'
    meta_channel_connection_metadata: 'mounted'
    meta_outbound_still_manual: 'mounted'
    meta_webhook_test_parse: 'mounted'
    website_attribution_capture: 'mounted'
    lead_attribution_metadata: 'mounted'
    lead_drawer_attribution_panel: 'mounted'
    attribution_performance_card: 'mounted'
    analytics_attribution_breakdown: 'mounted'
    booked_revenue_attribution: 'mounted'
    attribution_revenue_helper: 'mounted'
    booked_revenue_attribution_card: 'mounted'
    analytics_booked_revenue_by_source: 'mounted'
    source_leakage_summary: 'mounted'
    source_leakage_overview_card: 'mounted'
    leads_source_filter: 'mounted'
    analytics_source_leakage_breakdown: 'mounted'
    payment_methods_card: 'mounted'
    stripe_billing_portal_access: 'mounted'
    billing_portal_audit_event: 'mounted'
    subscription_plan_catalog: 'mounted'
    subscription_plans_card: 'mounted'
    stripe_plan_checkout: 'mounted'
    billing_plan_gates_foundation: 'mounted'
    ui_interaction_audit: 'mounted'
    ui_interaction_scanner: 'mounted'
    dead_button_fix_pass: 'mounted'
    fetch_route_mismatch_check: 'mounted'
    knowledge_base_crud: 'mounted'
    knowledge_base_audit: 'mounted'
    knowledge_base_rate_limit: 'mounted'
    runtime_interaction_qa: 'mounted'
    playwright_core_workflows: 'mounted'
    knowledge_base_runtime_qa: 'mounted'
    availability_runtime_qa: 'mounted'
    revenue_recovery_demo_seed: 'mounted'
    demo_revenue_leak_dataset: 'mounted'
    demo_channel_attribution_dataset: 'mounted'
    demo_pipeline_recovery_dataset: 'mounted'
    gtm_revenue_recovery_positioning: 'mounted'
    marketing_revenue_os_homepage: 'mounted'
    demo_loop_cta: 'mounted'
    operator_control_messaging: 'mounted'
    revenue_recovery_load_seed: 'mounted'
    demo_load_250_leads: 'mounted'
    demo_load_source_distribution: 'mounted'
    demo_load_leakage_distribution: 'mounted'
    instant_lead_response: 'mounted'
    instant_lead_response_claude: 'mounted'
    instant_response_venue_voice_training: 'mounted'
    instant_response_safety_gate: 'mounted'
    instant_response_settings: 'mounted'
    instant_response_auto_send_scaffold: 'scaffold-only'
    meta_oauth_start: 'mounted'
    meta_oauth_callback: 'mounted'
    meta_oauth_token_storage: 'mounted'
    meta_outbound_sending: 'scaffold-only'
    ai_tour_availability_context: 'mounted'
    ai_scheduling_intent_detection: 'mounted'
    ai_available_slot_offering: 'mounted'
    ai_contact_info_no_repeat_guard: 'mounted'
    ai_tour_slot_selection_detection: 'mounted'
    tour_slot_selection_metadata: 'mounted'
    operator_create_tour_from_selected_slot: 'mounted'
    tour_selection_confirmation_guardrail: 'mounted'
    lead_side_tour_confirmation_links: 'mounted'
    tour_slot_confirmation_tokens: 'mounted'
    public_tour_slot_confirmation_page: 'mounted'
    tour_confirmation_slot_recheck: 'mounted'
    tour_confirmation_link_audit: 'mounted'
    // Phase 8BL-Hotfix — rollback flags. The 8BL infrastructure
    // remains mounted (DB, helpers, public route) but the AI no
    // longer pastes raw confirmation URLs into the chat bubble.
    // Operator-confirmed 8BK flow is the user-facing path.
    lead_side_confirmation_links_hidden_from_ai: 'mounted'
    ai_tour_links_hidden_from_chat: 'mounted'
    premium_tour_slot_message_format: 'mounted'
    inbox_message_overflow_guard: 'mounted'
    operator_tour_creation_flow_preserved: 'mounted'
    inbox_thread_scroll_container_fix: 'mounted'
    inbox_composer_bottom_anchor: 'mounted'
    inbox_blank_whitespace_regression_guard: 'mounted'
    dashboard_shell_viewport_lock: 'mounted'
    inbox_uses_parent_height_not_viewport_calc: 'mounted'
    inbox_body_scroll_eliminated: 'mounted'
    inbox_independent_scroll_regions: 'mounted'
    conversation_thread_phantom_height_fix: 'mounted'
    conversation_thread_container_scroll: 'mounted'
    inbox_message_count_no_body_growth: 'mounted'
    gtm_dashboard_buyer_clarity_pass: 'mounted'
    overview_revenue_command_center: 'mounted'
    today_priority_card: 'mounted'
    demo_billing_banner_neutralized: 'mounted'
    buyer_friendly_metric_copy: 'mounted'
    leads_revenue_pipeline_positioning: 'mounted'
    leads_needs_attention_summary: 'mounted'
    leads_next_action_cards: 'mounted'
    leads_value_framing: 'mounted'
    leads_attention_view: 'scaffold-only'
    tours_revenue_protection_positioning: 'mounted'
    tour_risk_summary: 'mounted'
    completed_tour_followup_queue: 'mounted'
    tour_next_action_rows: 'mounted'
    tour_value_framing: 'mounted'
    analytics_revenue_intelligence_positioning: 'mounted'
    analytics_key_insight_card: 'mounted'
    analytics_source_leakage_priority: 'mounted'
    analytics_buyer_friendly_kpis: 'mounted'
    analytics_funnel_dropoff_insight: 'mounted'
    settings_workspace_control_center: 'mounted'
    settings_ai_behavior_preview: 'mounted'
    settings_knowledge_base_empty_state: 'mounted'
    settings_ai_tour_availability_copy: 'mounted'
    settings_role_guide: 'mounted'
    overview_ai_activity_ticker: 'mounted'
    ai_actions_realtime_feed: 'mounted'
    ai_activity_buyer_friendly_copy: 'mounted'
    overview_live_ai_work_surface: 'mounted'
    inbox_operator_message_role_fix: 'mounted'
    inbox_human_messages_render_right: 'mounted'
    inbox_ai_trigger_lead_only_guard: 'mounted'
    inbox_composer_mode_semantics: 'mounted'
    inbox_reply_method_bar: 'mounted'
    inbox_reply_channel_awareness: 'mounted'
    inbox_manual_delivery_labeling: 'mounted'
    inbox_reply_method_metadata: 'mounted'
    // Phase 8BN — operator-composer direct email delivery
    outbound_email_delivery: 'mounted' | 'disabled'
    outbound_email_reply_method_direct: 'mounted'
    outbound_email_delivery_status_pills: 'mounted'
    outbound_email_failure_honesty: 'mounted'
    // Phase 8BO — inbound email reply capture
    inbound_email_capture: 'mounted' | 'disabled'
    inbound_email_header_matching: 'mounted'
    inbound_email_recent_recipient_fallback: 'mounted'
    inbound_email_no_auto_ai_trigger: 'mounted'
    // Phase 8BP — email delivery status + retry polish
    email_delivery_status_lifecycle: 'mounted'
    email_delivery_webhook_message_patch: 'mounted'
    email_delivery_retry: 'mounted'
    email_delivery_manual_fallback: 'mounted'
    email_delivery_honest_accepted_vs_delivered: 'mounted'
    // Phase 8BQ — unmatched inbound email queue
    inbound_email_orphan_queue: 'mounted'
    inbound_email_orphan_persistence: 'mounted'
    inbound_email_orphan_linking: 'mounted'
    inbound_email_orphan_dismissal: 'mounted'
    inbound_email_orphan_no_ai_guard: 'mounted'
    // Phase 8BR-alt — orphan conversation picker
    inbound_email_orphan_picker: 'mounted'
    inbound_email_orphan_search: 'client_local'
    inbound_email_orphan_manual_linking: 'mounted'
    inbound_email_orphan_picker_no_ai_guard: 'mounted'
    // Phase 8BR — outbound SMS delivery (Twilio)
    outbound_sms_delivery: 'mounted' | 'disabled'
    outbound_sms_reply_method_direct: 'mounted'
    outbound_sms_delivery_status_pills: 'mounted'
    outbound_sms_failure_honesty: 'mounted'
    outbound_sms_no_ai_autosend_guard: 'mounted'
    // Phase 8BS — inbound SMS capture (Twilio)
    inbound_sms_capture: 'mounted' | 'disabled'
    inbound_sms_twilio_signature_verification: 'mounted'
    inbound_sms_reply_matching: 'mounted'
    inbound_sms_dedupe: 'mounted'
    inbound_sms_no_ai_guard: 'mounted'
    // Phase 8BT — SMS orphan queue (shares the email orphan table)
    inbound_sms_orphan_queue: 'mounted'
    inbound_sms_orphan_persistence: 'mounted'
    inbound_sms_orphan_linking: 'mounted'
    inbound_sms_orphan_dismissal: 'mounted'
    inbound_sms_orphan_no_ai_guard: 'mounted'
    unmatched_replies_queue_multichannel: 'mounted'
    // Phase 8BU — SMS delivery status callback + retry
    sms_delivery_status_callback: 'mounted' | 'disabled'
    sms_delivery_status_signature_verification: 'mounted'
    sms_delivery_status_message_patch: 'mounted'
    sms_delivery_retry: 'mounted'
    sms_delivery_retry_ui: 'mounted'
    sms_delivery_honest_sent_vs_delivered: 'mounted'
    sms_delivery_no_ai_autosend_guard: 'mounted'
    // Phase 8BV — reply method switching UI
    reply_method_switching_ui: 'mounted'
    reply_method_switching_email_sms: 'mounted'
    reply_method_switching_metadata_integrity: 'mounted'
    reply_method_switching_ai_context: 'mounted'
    reply_method_switching_no_ai_autosend_guard: 'mounted'
    // Phase 8BW — inbox demo polish + operator workflow QA
    inbox_demo_polish: 'mounted'
    inbox_empty_states: 'mounted'
    inbox_delivery_pill_qa: 'mounted'
    inbox_reply_method_switcher_qa: 'mounted'
    inbox_ai_draft_honesty: 'mounted'
    inbox_unmatched_replies_polish: 'mounted'
    inbox_manual_channel_workflow_qa: 'mounted'
    inbox_operator_workflow_qa_doc: 'mounted'
  }
  uptime_ms: number
  ts: string
}

/**
 * Phase 5E admin surface. Bumped manually when /api/admin/* routes change.
 * Kept as a constant rather than a runtime filesystem probe so a monitor
 * checking this value will alert if a new admin endpoint isn't mounted
 * (e.g. accidentally excluded from a build).
 *
 * Changelog:
 *   - Phase 5E: 6 (ai-actions, anthropic-probe, outbound-messages,
 *               suppressions, test-send, workflow-status)
 *   - Phase 7G: 8 (added billing-events list + detail)
 *   - Phase 7I: 9 (added billing-events/[id]/replay)
 *   - Phase 7N: 10 (added billing-events/[id]/clear-dunning)
 *   - Phase 8A: 12 (added demo/seed + demo/reset)
 *   - Phase 8F: 13 (added tours/bulk-cancel)
 *   - Phase 8G: 14 (added tours/paused-venues)
 *   - Phase 8I: 16 (added tours/pause-history + tours/clear-pause)
 *   - Phase 8J: 17 (added tours/notification-stats)
 *   - Phase 8K: 18 (added tours/recent-token-actions)
 *   - Phase 8M: 19 (added tours/status-events; recent-token-actions
 *     stays mounted with Deprecation headers for one release cycle)
 *   - Phase 8T: 20 (added digest/preferences; GET + POST share the route)
 *   - Phase 8V: 21 (added digest/preview)
 *   - Phase 8X: 22 (added digest/send — operator-triggered manual send)
 *   - Phase 8Y: 24 (added digest/members + digest/sends)
 *   - Phase 8Z: 25 (added digest/suppressions)
 *   - Phase 8AA: 26 (added digest/suppressions/remove)
 *   - Phase 8AB: 28 (added digest/cron-health + digest/suppressions/remove-all)
 *   - Phase 8AC: 29 (added digest/audit-events)
 *   - Phase 8AO: 30 (added ai/draft-audit — AI Draft Activity card
 *     CSV + JSON pagination source)
 *   - Phase 8AQ: 31 (added revenue-os/settings — per-venue thresholds
 *     for Revenue Leakage Watch + Speed-to-Lead scoring)
 *   - Phase 8AY: 32 (added ai/autopilot-simulation — dedicated
 *     simulation roll-up for the AutopilotSimulationPanel)
 *   - Phase 8AZ: 34 (added ai/autopilot-reviews — queue + summary,
 *     and ai/autopilot-reviews/[aiActionId] — label upsert)
 *   - Phase 8BA: 35 (added ai/autopilot-readiness — per-venue
 *     read-only eligibility scorecard)
 *   - Phase 8BD: 36 (added leads/reactivation-queue — top-N
 *     reactivation candidate roll-up)
 *   - Phase 9A: 37 (added audit-events — enterprise audit log GET
 *     endpoint backing the EnterpriseAuditEventsCard)
 *   - Phase 9D: 39 (added data-export + leads/[leadId]/redact-pii —
 *     venue-scoped JSON export + soft PII redaction for individual
 *     leads while preserving operational + audit history)
 *   - Phase 9F: 40 (added security/abuse-events — admin read for
 *     rate-limit blocks per venue, backing the AbuseMonitorCard)
 *   - Phase 9G: 43 (added security/sso-connections,
 *     security/sso-connections/[id], security/sso-login-events —
 *     SSO connection management + login event feed; vendor adapter
 *     is a placeholder, no real auth exchange yet)
 *   - Phase 9H: 45 (added security/backup-posture +
 *     security/restore-intents — read-only DR posture card + audit-
 *     only restore intent recorder; product NEVER executes a
 *     restore)
 *   - Phase 9I: 46 (added security/evidence-report — consolidated
 *     SOC 2-style evidence report backing the SecurityEvidenceCenter
 *     card; JSON / markdown / CSV export; not a certification claim)
 *   - Phase 9J: 49 (added security/questionnaire-response,
 *     security/buyer-security-summary, security/demo-mode —
 *     sales-facing questionnaire generator + buyer security summary
 *     export + owner-only demo mode toggle; demo mode is a visual
 *     marker only, NOT data anonymization; questionnaire/summary
 *     are buyer-ready drafts that REQUIRE review before sending)
 *   - Phase 9K: 51 (added security/vendor-risk-report +
 *     security/subprocessor-disclosure — admin vendor risk
 *     registry export + buyer-safe subprocessor disclosure;
 *     DPA/SCC/SOC 2 status defaults to manual_review_required;
 *     buyer-facing disclosure is reviewed before sharing
 *     externally)
 *   - Phase 9L: 55 (added security/incidents [GET+POST],
 *     security/incidents/[id] [GET+PATCH],
 *     security/incidents/detect [POST],
 *     security/incidents/[id]/alert [POST] — first-class
 *     incident records + conservative operator-triggered
 *     detectors + env-gated alert routing to Slack / PagerDuty
 *     / Sentry. No autonomous remediation; no auto-resolve;
 *     customer notification requires legal/operator review.)
 *   - Phase 9M: 60 (added privacy/readiness [GET],
 *     privacy/dsr-requests [GET+POST],
 *     privacy/dsr-requests/[id] [GET+PATCH],
 *     privacy/dsr-requests/[id]/export-preview [POST],
 *     privacy/dsr-requests/[id]/deletion-review [POST] —
 *     static data inventory + retention policy + DSR workflow.
 *     Export preview is metadata-only; deletion review is
 *     non-destructive. We do NOT claim GDPR/CCPA compliance
 *     and DSRs are NEVER auto-fulfilled.)
 *   - Phase 9N: 64 (added security/trust-center/grants
 *     [GET+POST], security/trust-center/grants/[id] [PATCH],
 *     security/trust-center/access-events [GET],
 *     security/trust-center/packet [GET] — Trust Center
 *     foundation with bearer-token grants + access log. Public
 *     /trust page + /trust/access/[token] gated page are not
 *     counted in ADMIN_ENDPOINT_COUNT — those are public/gated
 *     routes outside /api/admin/*.)
 *   - Phase 9O: 67 (added security/compliance/calendar
 *     [GET+POST], security/compliance/calendar/[id] [PATCH],
 *     security/compliance/freshness [GET] — compliance
 *     operations calendar + evidence freshness tracking.
 *     Operator-controlled — does NOT prove continuous
 *     compliance; no autonomous rotation; no external
 *     alerting.)
 *   - Phase 9P: 70 (added security/commitments [GET+POST],
 *     security/commitments/[id] [GET+PATCH],
 *     security/commitments/readiness [GET] — operator-
 *     recorded customer-specific contractual commitments
 *     register + readiness summary with unsupported-risk
 *     warnings. NOT legal advice; NOT contractual proof; no
 *     autonomous contract parsing.)
 *   - Phase 8BE: 72 (added integrations/channels [GET+POST],
 *     integrations/channels/[id] [PATCH] — omnichannel inbox
 *     connector foundation. Channel posture + capability
 *     matrix only; NO real OAuth, NO Meta Send API call, NO
 *     autonomous sending. Manual-required channels keyed to
 *     the new /api/conversations/[id]/mark-sent-manually
 *     operator-confirm route — note that route lives outside
 *     /api/admin/* and is NOT counted here.)
 *   - Phase 8BG: 73 (added integrations/lead-forwarding/
 *     test-parse [POST] — admin QA endpoint that runs the
 *     deterministic forwarding parser without creating a
 *     lead. PII-light audit metadata; raw body never logged.
 *     The public lead-forwarding routes are unchanged in
 *     count and live outside /api/admin/*.)
 *   - Phase 8BF: 74 (added integrations/meta/test-parse
 *     [POST] — admin Meta webhook payload QA endpoint. Pure
 *     parser run, no DB write, no signature verification
 *     required. The public Meta webhook (GET+POST) is
 *     unchanged in count — it lives outside /api/admin/*.
 *     Signature verification + payload normalization replace
 *     the 8BE placeholder behaviour without adding routes.)
 */
const ADMIN_ENDPOINT_COUNT = 76

const startedAt = Date.now()

async function checkSupabase(): Promise<Status> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venues')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) {
      log.error({ route: '/api/health', errorMessage: error.message }, 'health.supabase.down')
      captureApiError(error, { route: '/api/health' })
      return 'down'
    }
    return 'ok'
  } catch (err) {
    log.error({ route: '/api/health', err }, 'health.supabase.threw')
    captureApiError(err, { route: '/api/health' })
    return 'down'
  }
}

/**
 * Cheap probe — does the venue_members table exist? Uses a HEAD-style
 * count so no row data is fetched (and no count is exposed in the
 * response — we report only ok/missing).
 */
async function checkTenantAccess(): Promise<'ok' | 'missing'> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venue_members')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    if (error) return 'missing'
    return 'ok'
  } catch {
    return 'missing'
  }
}

/**
 * Phase 6B probe — is the member-aware RLS in place?
 *
 * Calls the `is_venue_member` SECURITY DEFINER helper (migration 004) that
 * every new RLS policy in migration 005 references. If the function exists
 * and answers, the membership-aware policy graph is reachable. We pass
 * zero-UUIDs so the call is harmless (returns false) and never touches a
 * real tenant. A missing function or RPC error → 'missing'.
 */
async function checkRlsMembership(): Promise<'ok' | 'missing'> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.rpc('is_venue_member', {
      check_venue_id: '00000000-0000-0000-0000-000000000000',
      check_user_id: '00000000-0000-0000-0000-000000000000',
    })
    if (error) return 'missing'
    return 'ok'
  } catch {
    return 'missing'
  }
}

function checkAnthropic(): Status {
  return process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing'
}

function checkEmail(): Status {
  // emailConfigured() is true only when BOTH api key AND from-email exist.
  if (emailConfigured()) return 'configured'
  // If the API key is present but no from-email, that's a misconfigured prod
  // and a half-broken dev — surface as 'missing' so the operator notices.
  if (process.env.RESEND_API_KEY && !process.env.RESEND_FROM_EMAIL) return 'missing'
  if (process.env.NODE_ENV === 'development') return 'console-fallback'
  return 'missing'
}

export async function GET(request: Request) {
  const requestId = getOrCreateRequestId(request)
  // Run independent probes in parallel.
  const [supabase, venueMembers, rlsMembership] = await Promise.all([
    checkSupabase(),
    checkTenantAccess(),
    checkRlsMembership(),
  ])
  const anthropic = checkAnthropic()
  const email = checkEmail()
  const jobs = getJobsRuntime()
  const upstash = getRateLimitStatus()
  // Webhook health: env-presence only. We never call Resend's verifier here.
  const resend_webhook: 'configured' | 'missing' = process.env.RESEND_WEBHOOK_SECRET
    ? 'configured'
    : 'missing'
  // Sentry health: env-presence only. We never send a test event here.
  const sentry: 'configured' | 'missing' = process.env.SENTRY_DSN ? 'configured' : 'missing'

  const body: HealthBody = {
    ok: supabase !== 'down',
    version: (pkg as { version: string }).version,
    supabase,
    anthropic,
    email,
    resend_webhook,
    jobs,
    upstash,
    sentry,
    admin: { mounted: true, endpoints: ADMIN_ENDPOINT_COUNT },
    tenant_access: { venue_members: venueMembers, rls_membership: rlsMembership },
    // Phase 6C — bumped manually if the onboarding API surface changes.
    // Compile-time presence is the signal; we don't probe by HTTP-ing ourselves.
    onboarding: { api: 'mounted' },
    // Phase 6D + 6E — team API + dashboard surface presence signals.
    team: { invitations: 'mounted', dashboard: 'mounted' },
    // Phase 7C + 7D + 7F + 7H — billing surface. Env presence + compile-time
    // presence of the audit log / trial reminder code paths. Never pings Stripe.
    billing: {
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
      webhook: process.env.STRIPE_WEBHOOK_SECRET ? 'configured' : 'missing',
      gate: process.env.BILLING_GATE_ENABLED === '1' ? 'enabled' : 'disabled',
      events_log: 'mounted',
      // 7H — the Inngest cron is registered in allJobFunctions; we surface
      // it as a compile-time mounted flag here. Operators verify the
      // function appears in the Inngest dashboard's function list.
      trial_reminder: 'mounted',
      // 7I — admin replay endpoint /api/admin/billing-events/[id]/replay
      // is compile-time mounted; runtime availability requires Stripe
      // configuration (see `stripe`/`webhook` flags above).
      replay: 'mounted',
      // 7K — past-due dunning Inngest cron `billing-dunning` is
      // registered in allJobFunctions; runtime delivery requires Resend
      // + Stripe portal configuration. Operators verify in Inngest UI.
      dunning: 'mounted',
      // 7M — payment recovery email is a webhook-triggered side effect
      // (no cron). Runtime delivery requires Resend; the dispatcher only
      // fires it on past_due → active/trialing transitions.
      recovery_email: 'mounted',
      // 7N — operator escape hatch: POST /api/admin/billing-events/[id]/clear-dunning
      // wipes prefix-matched entries from subscriptions.metadata.dunning_sent.
      admin_clear_dunning: 'mounted',
      // 8F — past-due tour auto-pause cron `billing-tour-auto-pause` is
      // registered in allJobFunctions; runs daily at 6pm UTC. Cancels
      // future scheduled/confirmed tours for venues past_due > 7 days
      // and stamps subscriptions.metadata.tours_paused_at/reason/count.
      tour_auto_pause: 'mounted',
      // 8G — operational counterpart to tour_auto_pause. When the Stripe
      // dispatcher detects past_due → active/trialing, it stamps
      // subscriptions.metadata.tours_resumed_at + tours_resumed_reason
      // so the /dashboard/tours banner can flip off. Does NOT resurrect
      // any already-cancelled tour — that remains operator-controlled.
      tour_auto_resume: 'mounted',
      // 8H — window-aware re-arm on the auto-pause cron. When a venue
      // bounces past_due → active → past_due, the cron archives the
      // prior pause/resume pair into metadata.tour_pause_history and
      // stamps a fresh pause. Idempotent on repeated runs in the same
      // past-due window.
      tour_auto_pause_rearm: 'mounted',
      // 8H — POST /api/admin/tours/bulk-cancel now fans out best-effort
      // cancellation emails to affected leads at concurrency 5. Email
      // failures never turn a successful bulk-cancel into a 500; the
      // response includes a notification_summary block for telemetry.
      bulk_cancel_notifications: 'mounted',
    },
    // Phase 8A — demo seed + reset admin surface.
    // Phase 8B — realtime layers on /dashboard/leads + /dashboard/inbox.
    demo: {
      seed: 'mounted',
      realtime: 'mounted',
      // 8C — variant inquiries + quick-schedule-tour + tours realtime.
      tour_quick_schedule: 'mounted',
      // 8D — full ScheduleTourDrawer mounted on /dashboard/tours +
      // LeadDetailPanel. Always available regardless of NEXT_PUBLIC_DEMO_BUTTON.
      tour_drawer: 'mounted',
      // 8E — EditTourDrawer + click-to-edit + Mark-confirmed inline +
      // URL-based ?month=YYYY-MM navigation on /dashboard/tours. All
      // production UX, no demo flag required.
      tour_edit: 'mounted',
      // 8F — TourLifecycleStrip on /dashboard/inbox/[leadId] surfaces
      // the most relevant tour with a one-click schedule / edit /
      // reschedule action. Reuses the 8D/8E drawers verbatim.
      tour_reschedule_from_inbox: 'mounted',
      // 8I — operator audit surface for tour pause/resume. New admin
      // routes GET /api/admin/tours/pause-history + POST
      // /api/admin/tours/clear-pause; new PauseHistoryTable on
      // /dashboard/settings/billing (admins/owners only).
      tour_pause_audit: 'mounted',
      // 8I — "Re-schedule cancelled tour" shortcut on the inbox
      // TourLifecycleStrip when the most-recent tour was cancelled.
      // Opens ScheduleTourDrawer pre-filled with the cancelled slot.
      tour_bulk_resume: 'mounted',
      // 8J — "This week's tours" sidebar panel on /dashboard/inbox.
      // Server-rendered, click any row to jump to the conversation
      // thread. Reads the existing `tours` + `leads` tables only;
      // no new admin route, no new env vars.
      tour_week_panel: 'mounted',
      // 8K — public /tour/confirm + /tour/cancel routes plus signed
      // HMAC token in lead-facing tour emails. Runtime presence
      // requires TOUR_ACTION_SECRET (>= 16 chars); when absent the
      // email path silently sends without links and warns once per
      // process. Mounted flag here reflects code presence, NOT secret
      // configuration — operators check NEXT_PUBLIC_APP_URL +
      // TOUR_ACTION_SECRET separately.
      tour_action_links: 'mounted',
      // 8L — `tour_action_events` table + single-use claim on the
      // public action handler + audit-fed recent-token-actions admin
      // endpoint + HTML email templates. ADMIN_ENDPOINT_COUNT is
      // unchanged because recent-token-actions already existed (it was
      // rewritten in-place, not added).
      tour_action_audit: 'mounted',
      // 8M — `tour_status_events` table + `recordTourStatusEvent` writes
      // from all four tour status-change paths (lead token, operator
      // PATCH, bulk-cancel, auto-pause cron). Unified admin endpoint
      // GET /api/admin/tours/status-events with actor_kind / tour /
      // lead / action filters. The narrow Phase 8K/8L
      // recent-token-actions endpoint stays mounted with HTTP
      // Deprecation + Link/successor-version headers.
      tour_status_audit: 'mounted',
      // 8N — operator UI surfaces over the Phase 8M audit feed:
      //   - TourAuditDrawer (per-tour drawer mounted on /dashboard/tours
      //     + /dashboard/inbox/[leadId])
      //   - Inbox TourLifecycleStrip recent activity panel (silent for
      //     non-admins via 401/403/404 fall-through)
      //   - /dashboard/settings/billing TourStatusActivityFeed
      //     (server-rendered, admins/owners only)
      tour_audit_ui: 'mounted',
      // 8N — manual-trigger Inngest backfill job (`seed-tour-status-events`,
      // event `admin/tour-status-events.backfill`). Gated behind
      // `TOUR_STATUS_BACKFILL=1` AND requires a manual event send — no
      // cron. Inserts synthetic `actor_kind='system'` rows for legacy
      // tours that pre-date Phase 8M.
      tour_status_backfill: 'mounted',
      // 8O — interactive operator features over the unified audit feed:
      //   - billing-page TourStatusActivityFeedClient with actor_kind +
      //     action filter chips
      //   - GET /api/admin/tours/status-events?format=csv export
      //   - RealtimeTourStatusLayer subscribed to
      //     tour_status_events INSERTs (table added to the
      //     supabase_realtime publication out-of-band; see RUNBOOK §7)
      tour_status_filters: 'mounted',
      tour_status_csv: 'mounted',
      tour_status_realtime: 'mounted',
      // 8P — operator polish: URL-synced billing filters,
      // cursor-paginated CSV+JSON export (?occurred_before=ISO →
      // next_cursor/has_more body fields + X-Next-Cursor/X-Has-More
      // headers), realtime refresh debounce (~1s trailing, every
      // INSERT still toasts), and audit-drawer deep linking
      // (?audit_tour=<uuid> on /dashboard/tours preserves the
      // month=YYYY-MM Phase 8E query).
      tour_status_url_filters: 'mounted',
      tour_status_csv_pagination: 'mounted',
      tour_status_realtime_debounce: 'mounted',
      tour_audit_deeplink: 'mounted',
      // 8Q — operator depth: localStorage-backed filter persistence
      // (URL wins → localStorage fallback → defaults), server-side
      // `?q=…` search over scalar columns + client-side metadata
      // search over the loaded slice, and streamed CSV export
      // (`?format=csv&stream=1`) bounded by a 5000-row hard cap and
      // emitted via a ReadableStream so a wide export doesn't
      // materialize in memory.
      tour_status_filter_persistence: 'mounted',
      tour_status_search: 'mounted',
      tour_status_streamed_csv: 'mounted',
      // 8R — server-side metadata::text search via the
      // search_tour_status_events SECURITY DEFINER RPC (migration 014).
      // Active only when `?q=` is present; non-`q` path stays on the
      // PostgREST chain. RPC is GRANT EXECUTE to service_role only —
      // never callable from authenticated/anon contexts.
      tour_status_metadata_search: 'mounted',
      // 8R — manual-cron operator activity digest. Compile-time
      // mounted; runtime delivery requires OPERATOR_DIGEST_ENABLED=1
      // AND Resend configured. Daily 8am UTC; per-venue 24h summary
      // emailed to the venue owner.
      operator_activity_digest: 'mounted',
      // 8S — migration 015 adds pg_trgm + a generated `metadata_text`
      // column + a GIN trigram index, then re-issues the Phase 8R RPC
      // to query the indexed column. `?q=` searches over `metadata`
      // now use the index instead of a sequential ILIKE cast.
      tour_status_metadata_search_index: 'mounted',
      // 8S — operator digest now ships multipart with an Outlook-safe
      // HTML body (white card, slate background, brand-blue chip,
      // tables for counts) alongside the existing plaintext.
      operator_digest_html: 'mounted',
      // 8S — public unsubscribe surface at GET /api/digest/unsubscribe.
      // HMAC-signed token (DIGEST_UNSUBSCRIBE_SECRET, 30d TTL) flips
      // `subscriptions.metadata.digest_disabled = true` for the venue.
      // The cron checks this flag before sending. Without the secret,
      // emails ship without the link + a once-per-process warn fires.
      operator_digest_unsubscribe: 'mounted',
      // 8T — admin GET/POST /api/admin/digest/preferences for reading
      // and writing the per-venue digest cadence
      // (`subscriptions.metadata.digest_cadence` ∈ daily | weekly | off).
      // Surfaced as a card on /dashboard/settings/billing. Writer
      // keeps the legacy `digest_disabled` flag in sync.
      operator_digest_preferences: 'mounted',
      // 8T — digest cron now honors cadence. 'off' → skip
      // (operator_digest.skipped_disabled). 'weekly' on non-Monday →
      // skip (operator_digest.skipped_cadence). 'daily' always sends.
      operator_digest_cadence: 'mounted',
      // 8T — `?q=` short-query optimization on status-events: terms
      // shorter than 3 chars skip the metadata RPC and use a scalar
      // PostgREST .or() chain instead (avoiding a wasted trigram
      // bitmap probe). `qMode` log values: none | scalar_short |
      // metadata_rpc.
      tour_status_short_search: 'mounted',
      // 8U — migration 016 adds `venue_members.metadata` jsonb so each
      // admin/owner controls their own digest cadence + weekly day.
      // The Phase 8R cron fans out per recipient with per-recipient
      // idempotency. Member preference wins over venue subscription
      // fallback wins over the legacy `digest_disabled` flag wins
      // over the global default ('daily').
      operator_digest_per_user: 'mounted',
      // 8U — `weekly` cadence now supports a per-user day-of-week
      // (sun..sat, defaults to mon UTC). The digest body footer names
      // the recipient's chosen day.
      operator_digest_weekly_day: 'mounted',
      // 8U — billing-page activity feed surfaces a small amber pill
      // when the operator types a 1-2 char search term, explaining
      // that metadata isn't included until the term reaches 3 chars
      // (the Phase 8T short-circuit threshold).
      tour_status_search_hint: 'mounted',
      // 8V — admin POST /api/admin/digest/preview sends the caller a
      // sample digest immediately. Bypasses cadence + idempotency
      // checks; outbound row tagged with `tour_digest_preview=true`
      // so the next cron run's per-recipient idempotency probe
      // ignores it.
      operator_digest_preview: 'mounted',
      // 8V — `findDigestRecipients` switched from serial auth lookups
      // to bounded concurrency 5 via Promise.allSettled, with
      // per-failure isolation. True batch via auth.admin.listUsers
      // would scan every auth user; this is the safe middle ground
      // documented in BILLING-QA §7ab.
      operator_digest_recipient_batching: 'mounted',
      // 8V — manual-trigger Inngest backfill (env-gated by
      // SEED_MEMBER_DIGEST=1) writes explicit `digest_cadence='daily'`
      // onto every owner/admin venue_members row that doesn't already
      // have one. Idempotent; capped at 1000 rows per run.
      member_digest_backfill: 'mounted',
      // 8W — public GET /api/digest/resubscribe?venue_id&user_id&token.
      // HMAC-signed token (DIGEST_UNSUBSCRIBE_SECRET, 30d TTL, action
      // discriminator) writes `digest_cadence='daily'` onto the
      // matching owner/admin venue_members row. Per-user re-enable;
      // does NOT touch subscriptions.metadata. NOT counted in
      // ADMIN_ENDPOINT_COUNT (public route, no admin auth).
      operator_digest_resubscribe: 'mounted',
      // 8W — `outbound_messages.metadata.tour_digest_send_kind`
      // discriminator added to both the cron ('cron') and the preview
      // route ('preview'). The cron's per-recipient idempotency probe
      // now filters on send_kind='cron' so earlier-today previews
      // can't dedupe the day's real digest. Reserved value 'manual'
      // for future operator-initiated sends.
      operator_digest_send_kind: 'mounted',
      // 8W — DigestPreferencesCard friendlier UX for the 409
      // `suppressed` preview branch. Replaces the raw "Couldn't send
      // sample: suppressed" with a copy block explaining the Resend
      // suppression list + contact-support resolution path.
      operator_digest_preview_suppression_ux: 'mounted',
      // 8X — digest email body footers now include explicit "Manage
      // your digest preferences" + unsubscribe + resubscribe links.
      // Cron sends omit the resubscribe link (recipient cadence is
      // never 'off' on a successful cron send); preview + manual
      // sends include both so the operator can QA the full preference
      // loop in one click. All links omit when
      // DIGEST_UNSUBSCRIBE_SECRET is missing (once-per-process warn).
      operator_digest_footer_links: 'mounted',
      // 8X — POST /api/admin/digest/send. Operator-triggered manual
      // send to self or another admin/owner member of the venue.
      // Tags the outbound row with `tour_digest_send_kind='manual'`
      // so the cron's per-recipient idempotency probe ignores it.
      // Optional `respect_cadence` flag preserves cadence-skip
      // semantics for dry-run "would today's cron send to this
      // person?" verification. Cross-user sends omit `sent_to` to
      // prevent email enumeration.
      operator_digest_manual_send: 'mounted',
      // 8X — `tour_digest_send_kind` now formally supports the
      // 'manual' value alongside 'cron' (8W) and 'preview' (8W). The
      // cron probe filters strictly on 'cron'; manual rows are never
      // dedupe candidates.
      operator_digest_send_kind_manual: 'mounted',
      // 8Y — GET /api/admin/digest/members lists owner/admin members
      // of the venue + their resolved emails so the manual-send
      // picker can target another admin without typing a UUID.
      // Bounded-concurrency (5) auth lookups, capped at 10 members
      // per venue to match the cron's fan-out limit.
      operator_digest_member_picker: 'mounted',
      // 8Y — GET /api/admin/digest/sends — operator audit feed over
      // outbound_messages digest rows. JSON + CSV branches, send_kind
      // / recipient_user_id / since / limit filters. Recipient email
      // is masked (`y***@domain.com`) to defend against CSV
      // screenshots scattering raw addresses. Surfaced as
      // DigestAuditFeed card on /dashboard/settings/billing.
      operator_digest_send_audit: 'mounted',
      // 8Y — manual-send endpoint formalized the `respect_cadence`
      // body flag (defaults to false). When true, honors recipient's
      // effective cadence preference and returns
      // { sent: false, skipped: true, reason: 'off'|'weekly_wrong_day' }
      // so the card can render amber inline status. Useful for QAing
      // weekly-day scheduling without burning a real send.
      operator_digest_respect_cadence_manual: 'mounted',
      // 8Z — GET /api/admin/digest/sends now accepts
      // `?occurred_before=<ISO>` cursor. JSON response adds
      // { next_cursor, has_more }; CSV adds X-Has-More + X-Next-Cursor
      // headers. DigestAuditFeed gains a "Load older" button that
      // appends without replacing existing rows.
      operator_digest_send_pagination: 'mounted',
      // 8Z — RealtimeDigestSendsLayer subscribes to
      // outbound_messages INSERTs filtered by venue_id, narrows to
      // digest rows in the handler (related_table='tour_status_events'
      // AND metadata.tour_digest_send_kind present), toasts every
      // event, debounces router.refresh() by 1000ms. Requires
      // outbound_messages in the supabase_realtime publication
      // (NOT enabled by default; see RUNBOOK for the alter
      // publication recipe).
      operator_digest_send_realtime: 'mounted',
      // 8Z — GET /api/admin/digest/suppressions intersects venue
      // owner/admin members with the global email_suppressions
      // table. DigestSuppressionsCallout renders an amber banner on
      // /dashboard/settings/billing when ≥1 admin email is on the
      // list. PII posture: masked emails only, never raw.
      operator_digest_suppression_triage: 'mounted',
      // 8AA — POST /api/admin/digest/suppressions/remove. Inline
      // "Remove suppression" action on DigestSuppressionsCallout.
      // Server re-resolves the email from venue_members + Supabase
      // Auth admin (client never sends the address); deletes from
      // email_suppressions by resolved email. PII posture: response
      // returns masked email only; logs never include raw email.
      operator_digest_suppression_remove: 'mounted',
      // 8AA — GET /api/admin/digest/sends now accepts ?q=<string>.
      // 1-2 chars: scalar + send_kind allowlist (status, provider,
      // error, to_address, metadata->>tour_digest_send_kind). 3+
      // chars: widens to cadence, weekly_day, recipient_user_id,
      // manual_initiator_user_id. Search applies to both JSON and
      // CSV branches and composes with the Phase 8Z cursor.
      operator_digest_send_search: 'mounted',
      // 8AA — RealtimeDigestSendsLayer dispatches a browser
      // CustomEvent (`venuerise:digest-suppression-refresh`)
      // whenever a new outbound digest row arrives with
      // status='suppressed'. DigestSuppressionsCallout listens and
      // refetches without a page reload. No global store; one
      // event, one consumer.
      operator_digest_suppression_realtime_refresh: 'mounted',
      // 8AB — weekly Inngest cron `digest-audit-retention` soft-
      // archives outbound digest rows older than
      // DIGEST_AUDIT_RETENTION_DAYS (default 365). Idempotent;
      // capped at 500 rows/run. Env-gated by
      // DIGEST_AUDIT_RETENTION_ENABLED=1. Default sends feed
      // excludes archived rows; `?include_archived=true` surfaces
      // them with the new `archived` JSON field + CSV column.
      operator_digest_retention: 'mounted',
      // 8AB — GET /api/admin/digest/cron-health surfaces a
      // delivery-derived health indicator (ok / stale / no_data)
      // for the operator-activity-digest cron. NOT an Inngest
      // run-history probe — a zero-event venue can be 'no_data'
      // and that's fine. Mounted as DigestCronHealthCard on
      // /dashboard/settings/billing.
      operator_digest_cron_health: 'mounted',
      // 8AB — POST /api/admin/digest/suppressions/remove-all wipes
      // every suppression hit for owner/admin members of the venue
      // in one call. DigestSuppressionsCallout surfaces a single
      // "Remove all suppressions" button when items.length >= 3.
      operator_digest_bulk_suppression_remove: 'mounted',
      // 8AB — search highlights in DigestAuditFeed. Pure-React
      // <mark>-wrapped substrings; no dangerouslySetInnerHTML, no
      // regex injection (uses String.indexOf with lowercased
      // halves). Visible cells only — hidden metadata isn't
      // highlighted because it isn't rendered.
      operator_digest_search_highlights: 'mounted',
      // 8AC — DigestAuditFeed `Show archived` toggle. Persisted in
      // localStorage (key `venuerise:digest-audit-feed:include-archived:v1`);
      // threads ?include_archived=true into JSON / Load older / CSV
      // export URLs. Archived rows render with an additional slate
      // "Archived" tag beside the Kind badge.
      operator_digest_show_archived: 'mounted',
      // 8AC — DigestCronHealthCard listens for the
      // `venuerise:digest-cron-fired` CustomEvent dispatched by
      // RealtimeDigestSendsLayer on every cron INSERT. Refetches
      // its own snapshot without a full page reload, so the lag
      // counter + "last run" timestamp update live.
      operator_digest_cron_health_realtime: 'mounted',
      // 8AC — migration 017 introduces public.digest_audit_events.
      // Suppression remove + bulk remove + retention cron all
      // record one row per action via recordDigestAuditEvent.
      // GET /api/admin/digest/audit-events surfaces them; the
      // DigestAuditLogCard renders a compact table on the billing
      // page with All / Suppression / Retention chips and a CSV
      // export.
      operator_digest_audit_events: 'mounted',
      // 8AC — DIGEST_AUDIT_RETENTION_DRY_RUN=1 puts the retention
      // cron into preview mode. Selects candidates and returns
      // { dry_run: true, candidate_count, sample_ids, retention_days }
      // without mutating a single row. Skips the audit-event write
      // — dry-run is a diagnostic, not an operator action.
      operator_digest_retention_dry_run: 'mounted',
      // 8AD — GET /api/admin/digest/audit-events accepts `?q=`
      // (max 120, trimmed) for ILIKE search across action, reason,
      // target_email_masked. Composes with every other filter +
      // pagination cursor.
      operator_digest_audit_search: 'mounted',
      // 8AD — same endpoint accepts `?occurred_before=<ISO>` cursor
      // (strict `<`). JSON response carries { next_cursor, has_more };
      // CSV adds X-Has-More + X-Next-Cursor headers. DigestAuditLogCard
      // gains a Load older button that preserves search + family.
      operator_digest_audit_pagination: 'mounted',
      // 8AD — `?action_family=suppression|retention|cron|all` server-
      // side fan-out. Replaces the Phase 8AC client-side multi-fetch
      // — the card's chip click is now a single round-trip. `action`
      // exact filter wins when both are supplied.
      operator_digest_audit_action_family: 'mounted',
      // 8AD — DIGEST_AUDIT_LOG_CRON_SENDS=1 enables per-recipient
      // `digest_send_cron` audit events from the operator-activity-
      // digest cron. Default off (high row volume); operators flip
      // on per environment for forensic "who got the digest at 8:03
      // UTC?" coverage. Uses the existing recordDigestAuditEvent
      // helper; best-effort, never fails the cron.
      operator_digest_cron_send_audit: 'mounted',
      // 8AD — DigestCronHealthCard surfaces an auto-dismissing
      // inline "Digest cron just ran." notice on every
      // `venuerise:digest-cron-fired` CustomEvent (alongside the
      // existing Phase 8AC silent refetch). No global toast
      // dependency.
      operator_digest_cron_fired_toast: 'mounted',
      // 8AE — DigestAuditLogCard syncs family / q / cursor to the
      // URL via router.replace + localStorage fallback for family.
      // Operators can share a "stuck investigation" link with a
      // teammate and the chip + search restore on load. URL wins
      // over localStorage; q is URL-only (not persisted).
      operator_digest_audit_url_state: 'mounted',
      // 8AE — migration 018 adds pg_trgm + a generated stored
      // `metadata_text` column on digest_audit_events + a GIN
      // trigram index. The `?q=` route widens to include
      // `metadata_text ILIKE` for terms ≥ 3 chars; sub-3-char
      // terms stay scalar-only. Log field `qMode` ∈
      // none|scalar_short|metadata_indexed.
      operator_digest_audit_metadata_search: 'mounted',
      // 8AE — /api/admin/digest/preview writes a `digest_send_preview`
      // audit row on success when DIGEST_AUDIT_LOG_CRON_SENDS=1.
      // Best-effort; reuses recordDigestAuditEvent. Same env gate
      // as the Phase 8AD cron-send audit so operators flip one knob
      // to get per-recipient digest audit coverage.
      operator_digest_preview_audit: 'mounted',
      // 8AE — `?action_family=preview` server-side fan-out alongside
      // suppression / retention / cron / all. DigestAuditLogCard
      // chip strip adds a Preview button. Action exact filter still
      // wins.
      operator_digest_audit_preview_family: 'mounted',
      // 8AF — DigestAuditLogCard honors `?digest_audit_cursor=` on
      // initial mount: first fetch passes occurred_before=<cursor>
      // and an amber "Viewing an earlier audit page." banner +
      // Jump to latest button surface. Jump to latest clears the
      // cursor in URL + memory; chip/search/Reset also clear it.
      operator_digest_audit_cursor_read: 'mounted',
      // 8AF — DigestAuditFeed mirrors the URL-state pattern:
      // digest_send_kind / digest_send_recipient / digest_send_q /
      // digest_send_cursor / digest_send_archived. URL >
      // localStorage > defaults. localStorage keys:
      //   venuerise:digest-send-feed:kind:v1
      //   venuerise:digest-send-feed:recipient:v1
      //   venuerise:digest-send-feed:include-archived:v1
      // (legacy Phase 8AC archived key still honored for one
      // release cycle). q is URL-only. Cursor read on mount with
      // earlier-page banner; Reset clears URL + storage.
      operator_digest_send_url_state: 'mounted',
      // 8AF — DigestAuditEventDrawer: click any row in
      // DigestAuditLogCard → slide-in dialog with full payload,
      // pretty-printed metadata JSON, Copy audit ID + Copy
      // metadata buttons. When metadata.outbound_message_id is
      // present, a "View related digest send" button sets
      // ?digest_send_q=<id> so the sibling DigestAuditFeed
      // filters to the matching outbound row. Pure-React render;
      // no dangerouslySetInnerHTML.
      operator_digest_audit_drawer: 'mounted',
      // 8AF — migration 019 adds a partial unique index on
      // (venue_id, target_user_id, action,
      // (occurred_at at time zone 'utc')::date)
      // where action = 'digest_send_cron'. Helper detects 23505
      // unique-violation and returns { ok: false, error:
      // 'duplicate' } as an info-level log line; the cron
      // continues. Belt-and-suspenders against duplicate
      // digest_send_cron rows from cron retries.
      operator_digest_cron_audit_dedupe: 'mounted',
      // 8AJ — POST /api/conversations/[id]/messages.
      // LeadDetailDrawer "Approve & send" inserts an operator-
      // authored `human`-role message. SALES_ROLES gate + billing
      // gate + per-user-per-conversation rate-limit. NOT counted
      // in ADMIN_ENDPOINT_COUNT — route lives outside /api/admin/*.
      operator_lead_drawer_approve_send: 'mounted',
      // 8AJ — PATCH /api/ai/actions/[id]/reject. LeadDetailDrawer
      // Reject button persists via migration 020's
      // ai_actions.rejected_at + rejected_by columns. Idempotent;
      // SALES_ROLES gate; cross-tenant 403 → 404. NOT counted in
      // ADMIN_ENDPOINT_COUNT (also outside /api/admin/*).
      operator_lead_drawer_reject_persist: 'mounted',
      // 8AJ — Global ⌘K / Ctrl+K command palette. Opens from the
      // DashboardTopBar search pill click OR the keyboard
      // shortcut. Static command set today (Overview / Leads /
      // Inbox / Tours / Analytics / Settings / Billing + three
      // route-redirect quick actions). No backend search.
      operator_command_palette: 'mounted',
      // 8AK — POST /api/ai/draft. LeadDetailDrawer "Regenerate"
      // button rewrites the current draft via a narrow Anthropic
      // prompt with optional adjustment instruction (Warmer /
      // More concise / Add pricing / Mention dietary). Writes a
      // single `ai_actions` row (agent='venuerise',
      // action='draft_regenerate'); the returned id becomes the
      // new active draft so a subsequent Reject targets the right
      // row. Rate-limited per user + lead. Humanized error vocab:
      // unauthorized | forbidden | subscription_required |
      // lead_not_found | validation_failed | rate_limited |
      // generation_failed. NOT counted in ADMIN_ENDPOINT_COUNT —
      // the route lives outside /api/admin/*.
      operator_ai_draft_regenerate: 'mounted',
      // 8AK — CommandPalette quick actions now open real surfaces.
      // "New lead" → /dashboard/leads?new_lead=1 +
      // `venuerise:open-new-lead-modal` event (KanbanBoard
      // listens). "Schedule tour" → /dashboard/tours?schedule_tour=1
      // + `venuerise:open-schedule-tour` event
      // (TourSchedulingClient listens). "Send sample digest" →
      // /dashboard/settings/billing?digest_action=sample;
      // DigestPreferencesCard scrolls into view + applies a
      // short-lived highlight ring. Each consumer strips the query
      // param via history.replaceState after consuming so a
      // refresh doesn't re-trigger. None of the three auto-fires
      // a backend write — operators still confirm via the in-page
      // CTA.
      operator_command_palette_quick_actions: 'mounted',
      // 8AK — Inbox orientation flipped: ConversationList sits on
      // the LEFT on lg+, thread on center/right (matches mailbox
      // conventions). On mobile, the active thread takes the full
      // viewport and the list collapses; on the inbox index, the
      // list takes the viewport and the empty-state panel hides
      // until a conversation is picked. CSS/grid-only — no data
      // or route changes.
      operator_inbox_left_rail: 'mounted',
      // 8AK — Tours calendar polish. Weekday strip now has a
      // subtle bottom separator and an inline navy dot on today's
      // column header so the eye lands on the active column.
      // Calendar cells show "h:mma · FirstName" on the first row
      // even on single-tour days (previously the lead name only
      // appeared on multi-tour days).
      operator_tours_calendar_polish: 'mounted',
      // 8AK — Analytics chart re-theme.
      // `LeadsOverTimeChart`: navy primary line (#0F172A) with a
      // low-opacity navy gradient fill + slate #EEF2F7 grid +
      // calmer "Not enough data yet." empty-state copy.
      // `FunnelChart`: drops the amber `negotiation` color in
      // favor of slate-700; restricted to slate/blue/emerald only.
      // Both charts share the same empty-state shape.
      operator_analytics_retheme: 'mounted',
      // 8AK — LeadDetailDrawer subscribes to `messages` realtime
      // for the active conversation while the drawer is open.
      // INSERTs append to the local thread (deduped by id so the
      // optimistic Approve-and-send append doesn't end up
      // double-rendered when the realtime echo arrives). Cleans
      // up on unmount / conversation change.
      operator_lead_drawer_realtime: 'mounted',
      // 8AL — GET /api/dashboard/search. Backend search powering the
      // CommandPalette's LEADS / CONVERSATIONS / TOURS groups.
      // Auth + SALES_ROLES + venue resolution + rate-limit
      // (`dashboard-search:{userId}`). Per-table caps (8/5/5) +
      // hard cap 18. Sub-2-char queries short-circuit to empty.
      // Cross-tenant access collapses to empty items, not 403.
      // NOT counted in ADMIN_ENDPOINT_COUNT (non-admin route).
      operator_command_palette_search: 'mounted',
      // 8AL — LeadDetailDrawer staleness guard. When a teammate's
      // `human`-role message arrives via the messages realtime
      // subscription, the visible AI draft is flagged stale; Approve
      // & send is disabled; an amber inline notice surfaces. Save
      // edit softens the flag to 'edited_after_teammate' (Approve
      // re-enabled, soft notice persists). Regenerate clears the
      // flag entirely. Self-sends are deduped by id + a pending-self
      // bridge ref so the operator's own optimistic append never
      // triggers the guard against itself.
      operator_lead_drawer_draft_stale_guard: 'mounted',
      // 8AL — /api/ai/draft accepts `variant_count` (1-3, default 1)
      // and returns `drafts[]` alongside the primary `draft` (kept
      // for backward compat). Single Anthropic call asks for "---"-
      // separated variants; `parseVariants` strips "Variant N:"
      // labels defensively. One ai_actions row per call with a
      // compact multi-variant `output_summary`. Drawer renders a
      // pill selector (Option 1 / Option 2 / Option 3); picking a
      // pill swaps `draftBody` so Approve sends the chosen variant.
      operator_ai_draft_variants: 'mounted',
      // 8AM — message-body search in the CommandPalette MESSAGES
      // group. Backed by the pg_trgm GIN index on `messages.content`
      // (migration 021). Lead-joined for the title; snippet centered
      // on the query hit via `buildSnippet`, capped at 110 chars.
      // Deep-link href is /dashboard/inbox/<lead>?message=<id>;
      // ConversationThread scrolls the matching bubble into view +
      // flashes a pale blue ring for ~2.6s on arrival, then strips
      // the param via history.replaceState. Per-table cap 5; total
      // cap raised to 23.
      operator_command_palette_message_search: 'mounted',
      // 8AM — lead-reply stale guard in LeadDetailDrawer. When a
      // `role='lead'` message arrives via the messages realtime
      // subscription while an AI draft is visible, the drawer
      // transitions to draftStaleReason='lead_replied' (blue, not
      // amber): Approve & send STAYS enabled because the operator's
      // drafted reply is usually still valid, but a soft "lead
      // replied — Regenerate to include their latest message"
      // notice surfaces. Save edit transitions to
      // 'edited_after_lead'. The stronger 'teammate' guard
      // unconditionally trumps lead_replied (so a teammate send
      // after a lead reply re-blocks Approve).
      operator_lead_drawer_lead_reply_guard: 'mounted',
      // 8AM — variant audit memory. /api/ai/draft persists the full
      // variant set into `ai_actions.metadata` (jsonb column added
      // in migration 021) as
      // { variant_count, variants_offered[], selected_by_default,
      //   instruction }. Each stored variant capped at 2000 chars;
      // no raw lead PII or current_draft is stored. The drawer's
      // Approve & send POST includes an allowlisted metadata block
      // { source, ai_action_id, selected_variant_index,
      //   variant_count } that lands on the `messages.metadata`
      // column; the route's Zod schema uses `.strict()` so any
      // non-allowlisted client field is dropped on the floor.
      operator_ai_draft_variant_memory: 'mounted',
      // 8AN — Variant replay drawer. Sparkles affordance on
      // human-role message bubbles whose metadata carries
      // ai_action_id + selected_variant_index + variant_count.
      // Opens a right-side drawer that fetches the matching
      // ai_actions row via the browser client (RLS-scoped) and
      // renders: sent option, alternatives from
      // metadata.variants_offered, instruction, agent + latency,
      // copy-audit-summary button. Read-only.
      operator_variant_replay_drawer: 'mounted',
      // 8AN — Similarity-ranked message search via SECURITY DEFINER
      // RPC search_messages_for_dashboard (migration 022). Replaces
      // the Phase 8AM ILIKE-by-recency path on the messages branch
      // of /api/dashboard/search; leads/conversations/tours stay on
      // their PostgREST chains. Orders by similarity(content, q)
      // DESC, then created_at DESC. Function REVOKE'd from public
      // and GRANT'd only to service_role; the route invokes it via
      // the service client AFTER auth + SALES_ROLES + venue
      // resolution. p_q is bind-parameterized; hard WHERE on
      // p_venue_id provides defense-in-depth against route bypass.
      operator_message_similarity_search: 'mounted',
      // 8AN — Admin-only AI Draft Activity card on
      // /dashboard/settings/billing. Shows the last 25 ai_actions
      // rows where agent='venuerise' AND action='draft_regenerate'
      // with All/Successful/Failed filter chips + free-text search
      // over lead name / email / instruction. For each row, joins
      // messages.metadata.ai_action_id back to show whether the
      // operator accepted a variant and which index.
      operator_ai_draft_audit_card: 'mounted',
      // 8AO — Inbox left-rail ConversationList now surfaces
      // message-body hits under a "MESSAGES" eyebrow when the
      // operator types 2+ chars. Reuses the Phase 8AN similarity
      // RPC via /api/dashboard/search; clicking a result routes to
      // /dashboard/inbox/<lead>?message=<id> and the Phase 8AM
      // highlight kicks in.
      operator_inbox_message_search: 'mounted',
      // 8AO — RealtimeAIDraftAuditLayer (non-rendering) subscribes
      // to `ai_actions` INSERTs filtered by venue, narrows client-
      // side to agent='venuerise' AND action='draft_regenerate',
      // and dispatches `venuerise:ai-draft-audit-fired` on a 1s
      // trailing debounce. The AIDraftAuditCard listens and shows
      // an inline "New draft activity recorded" notice. Requires
      // `ai_actions` in the supabase_realtime publication:
      //   alter publication supabase_realtime add table public.ai_actions;
      // If the publication is missing, manual Refresh still works.
      operator_ai_draft_audit_realtime: 'mounted',
      // 8AO — AIDraftAuditCard "Load older" button paginates via
      // `?occurred_before=<created_at>` strict-less-than cursor.
      // Page size 25; rows append (deduped by id); current filter
      // chip + search persist across pages. Errors localize to the
      // button so the rest of the card stays usable.
      operator_ai_draft_audit_pagination: 'mounted',
      // 8AO — CSV export from the AIDraftAuditCard via
      // /api/admin/ai/draft-audit?format=csv. Allowlisted columns
      // only (id, venue_id, lead_id, lead_name, lead_email_masked,
      // success, instruction, variant_count,
      // accepted_variant_index, latency_ms, error, created_at).
      // Emails masked server-side BEFORE leaving the route; full
      // variant text never appears in CSV (replay stays inside
      // VariantReplayDrawer). UTF-8 BOM for Excel; content type
      // text/csv; Content-Disposition attachment with
      // ai-draft-audit-YYYY-MM-DD.csv.
      operator_ai_draft_audit_csv: 'mounted',
      // 8AP — Product thesis layer.
      //   - PRODUCT-THESIS.md positions VenueRise as an AI Revenue
      //     Operating System for wedding venues, not a generic CRM
      //     or AI chatbot. Defines the 5 core promises + the high-
      //     ticket justification (one extra booked wedding covers
      //     12+ months of SaaS).
      //   - AGENTIC-WORKFLOW-MAP.md defines 7 cooperating agents
      //     (Speed-to-Lead, Qualification, Tour Booking, Follow-Up
      //     Recovery, Revenue Leakage, Operator Accountability,
      //     Brand Voice). Future phases pick an agent first, code
      //     second.
      //   - RevenueLeakageBrief renders the live leakage card on
      //     /dashboard so the Overview tells the operator what's at
      //     RISK now, not just what's done.
      // None of the three adds a runtime dependency, an admin
      // route, or a migration. They steer phase planning.
      revenue_os_product_thesis: 'mounted',
      agentic_workflow_map: 'mounted',
      revenue_leakage_brief: 'mounted',
      // 8AQ — Per-venue Revenue OS settings: first-reply SLA, high-
      // fit threshold, stale high-fit window, cold-lead window.
      // Stored under venues.metadata.revenue_os (migration 023);
      // read/written via lib/revenue-os/settings.ts (clamped) and
      // GET/POST /api/admin/revenue-os/settings (admin-gated,
      // cross-tenant 403→404). Surfaced in the admin "Revenue OS
      // thresholds" card on /dashboard/settings/billing.
      revenue_os_settings: 'mounted',
      // 8AQ — Pure scoring helper at lib/revenue-os/leakage.ts.
      // `computeRevenueLeakage` powers the Overview brief AND the
      // leads-board filter; `computeLeadSpeedToLeadScores` powers
      // the per-lead chip. No Supabase client inside the helper —
      // each consumer fetches its own narrow input slice.
      revenue_leakage_scoring: 'mounted',
      // 8AQ — Per-lead Speed-to-Lead chip in LeadDetailDrawer.
      // Bands: 100 (met), 70 (within 2x SLA), 40 (missed), 60
      // (pending healthy), 20 (pending overdue), 0 (malformed).
      // Best-effort fetch; the chip silently stays hidden on any
      // probe failure.
      speed_to_lead_score: 'mounted',
      // 8AQ — KanbanBoard `?leakage=` filter. Recognized keys:
      // slow_first_reply | high_fit_idle | no_tour_booked |
      // cold_lead_recovery. Drag-and-drop suppressed while a filter
      // is active (mixing a partial view with stage DnD would let
      // operators drop into a hidden-row column without context).
      // Auxiliary tours/inbound fetches lazy-load only when the
      // matching filter is selected.
      leakage_leads_filter: 'mounted',
      // 8AR — Owner-facing Speed-to-Lead roll-up. Server-rendered
      // SpeedToLeadRollupCard on /dashboard/settings/billing reads
      // leads + outbound message activity for the last 7 days and
      // hands them to `computeSpeedToLeadRollup`
      // (`lib/revenue-os/sla-rollup.ts`). Median + p90 first-reply,
      // SLA met rate (decided leads only), overdue count, stacked
      // sparkline by created-day. No new tables, no cron — derived
      // each render. Pending leads excluded from the met-rate
      // denominator so the metric doesn't whiplash on new inquiries.
      speed_to_lead_rollup: 'mounted',
      // 8AR — Cold-lead baseline fix in
      // `computeRevenueLeakage`. Some intake paths create a lead
      // without an inbound `messages.role='lead'` row; the helper
      // now uses `lead.created_at` as the baseline when no inbound
      // exists, so the cold-lead tile no longer over-counts.
      // KanbanBoard `cold_lead_recovery` filter mirrors the same
      // baseline.
      cold_lead_baseline_fix: 'mounted',
      // 8AR — KanbanCard at-a-glance Speed-to-Lead chip on
      // `new_inquiry` leads. Pure age-vs-SLA approximation; no per-
      // card DB fetches. KanbanBoard threads the venue's
      // `firstReplySlaMinutes` down to each card; the drawer's
      // precise chip (Phase 8AQ) is the authoritative version.
      kanban_speed_to_lead_chip: 'mounted',
      // 8AS — RecoveryQueueCard on /dashboard + RecoveryRollupCard
      // on /dashboard/settings/billing. Both server-rendered, both
      // backed by `computeRecoverySignals`. Read-only — operator
      // stays in control of any actual send.
      follow_up_recovery_queue: 'mounted',
      // 8AS — LeadDetailDrawer "Why this lead is slipping" panel.
      // Renders inline beneath the badge row when the recovery
      // helper resolved a signal for the open lead; lists reason
      // chips + human-language helper + the suggested action.
      lead_recovery_explainer: 'mounted',
      // 8AS — "Use suggestion in draft" CTA. Clicking pre-fills the
      // regenerate instruction with the static suggested-action
      // string + switches to the Conversation tab. NEVER calls AI
      // automatically; the operator must click Regenerate +
      // Approve. The pending suggestion is consumed on a successful
      // regenerate (and is cleared on lead change).
      recovery_suggested_actions: 'mounted',
      // 8AS — KanbanBoard `?leakage=follow_up_recovery` filter.
      // Lazy-fetches the recovery input set + calls the helper;
      // pill displays "Recovery queue"; drag-and-drop suppressed
      // while active (consistent with the other leakage filters).
      recovery_leads_filter: 'mounted',
      // 8AT — Tour Booking Agent scoring layer.
      // `lib/revenue-os/tour-booking.ts` exports the five-signal
      // helper (`qualified_no_tour`,
      // `tour_scheduled_unconfirmed`, `tour_today`,
      // `tour_completed_no_next_step`,
      // `tour_no_show_recovery`) + a static suggested-action
      // catalog. Pure; reused by every Tour Booking surface so the
      // numbers agree across the dashboard.
      tour_booking_agent_surfaces: 'mounted',
      // 8AT — LeadDetailDrawer "Tour Booking Agent" panel.
      // Renders ABOVE the recovery explainer because tour booking
      // is the more revenue-proximate action. The Schedule CTA
      // reuses the existing ScheduleTourDrawer (no new drawer
      // surface); the Use-suggestion CTA pre-fills the regenerate
      // instruction (no AI call).
      tour_readiness_panel: 'mounted',
      // 8AT — TourConfirmationQueueCard on /dashboard. Server-
      // rendered; surfaces up to 5 future scheduled-unconfirmed
      // tours with lead context + a one-click "Open lead" deep-
      // link to the drawer.
      tour_confirmation_queue: 'mounted',
      // 8AT — TourConversionRollupCard on
      // /dashboard/settings/billing. Derived 30-day counts +
      // scheduled-rate + confirmed-rate. Includes `booked` in the
      // qualified-or-later denominator so fast converters aren't
      // penalized.
      tour_conversion_rollup: 'mounted',
      // 8AT — KanbanBoard `?leakage=tour_booking` filter. Lazy-
      // fetches tours + calls `computeTourBookingSignals`; pill
      // displays "Tour Booking queue"; drag-and-drop suppressed.
      tour_booking_leads_filter: 'mounted',
      // 8AU — Revenue OS digest summary composer at
      // `lib/revenue-os/digest-summary.ts`. Pure helper that runs
      // the speed-to-lead rollup, recovery signals, tour booking
      // signals, and revenue leakage helpers + returns one owner-
      // readable shape. Used by the cron + preview + manual send
      // routes so all three render the same content.
      revenue_os_digest_summary: 'mounted',
      // 8AU — operator-activity-digest reframe. Subject becomes
      // "Your VenueRise Revenue OS summary"; body LEADS with
      // leakage / speed-to-lead / recovery / tour booking and
      // demotes the raw tour_status_events log to a "log" section
      // lower in the email. Falls back to the legacy template when
      // the Revenue OS probe fails so a single bad fetch never
      // breaks the digest.
      operator_digest_revenue_reframe: 'mounted',
      // 8AU — explicit per-section flags so the readiness probe
      // can confirm each Revenue OS section is rendered.
      digest_speed_to_lead_section: 'mounted',
      digest_recovery_section: 'mounted',
      digest_tour_booking_section: 'mounted',
      // 8AV — Brand Voice confidence + escalation.
      //   - `brand_voice_confidence_score`: per-variant confidence
      //     persisted on every successful /api/ai/draft call.
      //     Originates from the model's CONFIDENCE: <0-100> line;
      //     falls back to a text heuristic when the model forgot
      //     the line.
      //   - `brand_voice_escalation_gate`: LeadDetailDrawer shows a
      //     "Low confidence" chip + amber/red status line + soft/
      //     hard-blocks Approve & send based on the venue's
      //     `brandVoiceEscalationMode` (`off`/`warn`/`block`).
      //   - `brand_voice_settings`: floor + mode admin-tunable on
      //     RevenueOsSettingsCard. Stored under
      //     `venues.metadata.revenue_os` (same shape as the other
      //     Phase 8AQ settings).
      //   - `ai_draft_audit_low_confidence`: AIDraftAuditCard
      //     surfaces a "Low confidence" filter chip + per-row
      //     badge. The admin /api/admin/ai/draft-audit route
      //     returns `min_confidence` + `low_confidence` per row +
      //     accepts `?low_confidence=true` to filter the slice.
      brand_voice_confidence_score: 'mounted',
      brand_voice_escalation_gate: 'mounted',
      brand_voice_settings: 'mounted',
      ai_draft_audit_low_confidence: 'mounted',
      // 8AW — Brand Voice calibration telemetry. Builds on the
      // 8AV confidence gate; ships before any autonomy so we can
      // measure whether the gate is trustworthy.
      //   - `brand_voice_confidence_telemetry`: /api/ai/draft now
      //     persists the raw model self-rating + heuristic score +
      //     adjustment delta + `confidence_source` alongside the
      //     existing `variant_confidences` array. Backward
      //     compatible (kept `variant_confidences` as the FINAL
      //     scores so 8AV readers don't need to change).
      //   - `brand_voice_calibration_summary`: the admin
      //     /api/admin/ai/draft-audit JSON branch now returns a
      //     `page_summary` block via
      //     `computeCalibrationPageSummary`. Powers the
      //     BrandVoiceCalibrationPanel tiles + signal cards on
      //     /dashboard/settings/billing.
      //   - `brand_voice_operator_outcomes`: messages POST stamps
      //     `operator_outcome`+`edit_distance_bucket` onto the
      //     source ai_actions row when an operator approves & sends;
      //     /api/ai/draft stamps `regenerated` on the prior row when
      //     the operator regenerates without sending. Best-effort,
      //     terminal-once.
      //   - `brand_voice_overconfidence_signal`: panel surfaces a
      //     low/medium/high signal derived from avg adjustment delta
      //     + regenerate rate. Operator-friendly copy
      //     ("Overconfidence signal: Watch") — no ML jargon.
      brand_voice_confidence_telemetry: 'mounted',
      brand_voice_calibration_summary: 'mounted',
      brand_voice_operator_outcomes: 'mounted',
      brand_voice_overconfidence_signal: 'mounted',
      // 8AX — Safe Autopilot Guardrails + Draft Approval Mode.
      // Builds on the 8AW calibration layer; ships BEFORE any
      // autonomous sending. The autonomy gate (8AY simulation
      // mode, 8AZ+ real autopilot) is still closed.
      //   - `brand_voice_autopilot_guardrails`: pure helper at
      //     lib/revenue-os/autopilot-guardrails.ts. Three modes
      //     (eligible / review_required / blocked), stable reason
      //     codes; every regenerate now persists a per-variant
      //     decision into ai_actions.metadata.autopilot_decisions.
      //   - `draft_risk_detection`: deterministic keyword scan
      //     for pricing / policy / availability surfaces. Hard-
      //     blocker tier in the decision helper.
      //   - `lead_drawer_autopilot_decision`: LeadDetailDrawer
      //     renders the decision pill + operator-readable helper
      //     under the existing confidence chip. The pill updates
      //     as the operator switches variants. NO auto-send
      //     button was added; Approve & send is still manual.
      //   - `draft_audit_autopilot_breakdown`: admin audit route
      //     returns autopilot_mode + risk_flags per row + an
      //     autopilot_breakdown over the page slice. The
      //     BrandVoiceCalibrationPanel renders the readiness
      //     breakdown; the AIDraftAuditCard appends the decision
      //     to the per-row detail line.
      //   - `autonomous_sending_still_disabled`: explicit flag so
      //     a monitor can assert the safety posture has NOT
      //     regressed. Will stay 'mounted' until Phase 8AY ships
      //     simulation mode + we know the system can be trusted.
      brand_voice_autopilot_guardrails: 'mounted',
      draft_risk_detection: 'mounted',
      lead_drawer_autopilot_decision: 'mounted',
      draft_audit_autopilot_breakdown: 'mounted',
      autonomous_sending_still_disabled: 'mounted',
      // 8AY — Autopilot Simulation Mode. Observation-only layer
      // that proves whether the 8AX guardrails are calibrated
      // well enough that future autonomy would be safe. NEVER
      // sends a message; the `autonomous_sending_still_disabled`
      // flag above is the explicit assertion that this posture
      // hasn't regressed.
      //   - `autopilot_simulation_mode`: per-row simulation
      //     projection (`would_send` / `would_require_review` /
      //     `would_block`) on the admin draft-audit route + a
      //     dedicated `/api/admin/ai/autopilot-simulation`
      //     endpoint over a 1–90 day window (default 30).
      //   - `autopilot_simulation_summary`: roll-up block
      //     emitted by both endpoints — counts, time-saved
      //     estimate, and a readiness signal
      //     (`not_ready` / `watch` / `promising`).
      //   - `autopilot_operator_alignment`: per-row alignment
      //     classification (aligned / operator_more_conservative
      //     / operator_less_conservative / unknown). Surfaces
      //     dangerous mismatches (operator overrode a Blocked
      //     decision by sending as-is) in red.
      //   - `autopilot_simulation_panel`: AutopilotSimulationPanel
      //     mounted between BrandVoiceCalibrationPanel and
      //     AIDraftAuditCard on /dashboard/settings/billing.
      //     Renders tiles, readiness card, bucket section, and
      //     up to 5 recent mismatches with lead deep-links.
      autopilot_simulation_mode: 'mounted',
      autopilot_simulation_summary: 'mounted',
      autopilot_operator_alignment: 'mounted',
      autopilot_simulation_panel: 'mounted',
      // 8AZ — Autopilot Shadow Evaluation + False Positive
      // Review Queue. Builds on the 8AY simulation; adds an
      // operator-labelled disagreement queue + per-rule false-
      // positive signals. Still observation only — the
      // `autonomous_sending_still_disabled` flag (set in 8AX,
      // carried through 8AY, carried through 8AZ) remains the
      // explicit assertion that no autonomy was introduced.
      //   - `autopilot_review_queue`: GET /api/admin/ai/
      //     autopilot-reviews returns the disagreement queue
      //     (operator_more_conservative + operator_less_
      //     conservative rows) joined with ai_action_reviews,
      //     plus a summary block + rule_signals.
      //   - `autopilot_review_labels`: POST /api/admin/ai/
      //     autopilot-reviews/[aiActionId] upserts the
      //     operator's verdict (confirmed_guardrail_too_strict
      //     / confirmed_guardrail_correct /
      //     confirmed_operator_error / deferred). Unique on
      //     ai_action_id (migration 024) — relabeling updates,
      //     never duplicates.
      //   - `autopilot_rule_signal_summary`: simulation +
      //     review queue endpoints surface a `rule_signals`
      //     array (per-rule reviewed counts, confirmed-too-
      //     strict counts, false-positive rate). Powers the
      //     RuleSignalsCard on AutopilotSimulationPanel.
      //   - `autopilot_shadow_evaluation`: AutopilotReviewQueue
      //     UI mounted on /dashboard/settings/billing between
      //     the simulation panel and the audit card. Labels are
      //     calibration evidence; they DO NOT auto-tune any
      //     guardrail, DO NOT block any operator, DO NOT enable
      //     autonomy.
      autopilot_review_queue: 'mounted',
      autopilot_review_labels: 'mounted',
      autopilot_rule_signal_summary: 'mounted',
      autopilot_shadow_evaluation: 'mounted',
      // 8BA — Autopilot Safety Scorecard + Per-Venue Autonomy
      // Readiness Gate. The final read-only safety surface
      // before any opt-in autonomy phase. Closes the loop on
      // the 8AV–8AZ telemetry stack by producing a single
      // verdict (`not_eligible` / `watch` / `eligible`) per
      // venue. The `autonomous_sending_still_disabled` flag
      // (set in 8AX, carried through 8AY/8AZ/8BA) remains
      // explicit so monitors can assert that the safety
      // posture hasn't regressed.
      //   - `autopilot_safety_scorecard`: GET /api/admin/ai/
      //     autopilot-readiness returns the verdict + gate
      //     list + raw inputs over a 1–90 day window
      //     (default 30). Pure helper at lib/revenue-os/
      //     autopilot-readiness.ts. No draft body / variants
      //     / lead emails / message content exposed.
      //   - `per_venue_autonomy_readiness_gate`: six gates
      //     (simulation_readiness_promising, min_scored_rows,
      //     min_reviewed_disagreements_pct,
      //     max_false_positive_rate_per_rule,
      //     zero_operator_less_conservative_unreviewed,
      //     min_window_days_with_data) — four blocking, two
      //     warning. Verdict requires every blocker passing.
      //   - `autonomy_eligibility_signal`:
      //     AutopilotReadinessScorecard mounted ABOVE the
      //     simulation panel on /dashboard/settings/billing.
      //     Verdict banner, gate checklist with current value
      //     + threshold + next-step copy, eligible-state
      //     emerald caveat reinforcing "autonomy is still
      //     disabled." NO toggle. NO action button.
      autopilot_safety_scorecard: 'mounted',
      per_venue_autonomy_readiness_gate: 'mounted',
      autonomy_eligibility_signal: 'mounted',
      // 8BB — Tour Slot Suggestions from Availability. The
      // TourReadinessPanel on the lead detail drawer renders
      // up to 2 clickable chips derived from the venue's saved
      // `tour_availability` windows + existing tour calendar.
      // Clicking a chip pre-fills the existing
      // ScheduleTourDrawer (via the Phase 8I
      // `defaultScheduledAt` prop). NO autonomous scheduling
      // — the operator still confirms inside the drawer.
      tour_slot_suggestions: 'mounted',
      // 8BC — Venue Availability Intelligence. Per-venue tour
      // duration + buffer settings (RevenueOsSettings extension),
      // operator-managed blackout dates (migration 025 +
      // /api/venues/[id]/tour-blackouts routes), and timezone-
      // aware slot suggestion labels (`venue.timezone` threaded
      // into `suggestTourSlots`). Still operator-confirmed —
      // chips pre-fill the existing ScheduleTourDrawer; no
      // autonomous scheduling.
      venue_tour_duration_setting: 'mounted',
      venue_tour_buffer_setting: 'mounted',
      tour_blackout_dates: 'mounted',
      tour_suggestion_timezone_awareness: 'mounted',
      // 8BD — Reactivation Outreach Cadence + Won/Lost Reason
      // Library. Operator-supplied lost reasons + the
      // reactivation helper turn lost leads into actionable
      // candidates without any autonomous outreach. Migration
      // 026 added `leads.metadata`; the lost-reason taxonomy
      // lives at `metadata.lost_reason`. The
      // `autonomous_sending_still_disabled` flag stays mounted
      // — every reactivation draft still flows through the
      // existing 8AV–8BA brand voice / autopilot safety stack
      // and the operator clicks Approve & send.
      lost_reason_taxonomy: 'mounted',
      reactivation_queue: 'mounted',
      reactivation_leads_filter: 'mounted',
      reactivation_digest_section: 'mounted',
      // 9A — Enterprise Audit Log + RBAC Sweep + Observability
      // Baseline. Migration 027 added `public.audit_events` with
      // RLS gated to owner/admin via `has_venue_role`. The helper
      // `lib/enterprise/audit-events.ts` writes through service-
      // role best-effort (never throws, never blocks the original
      // business action). High-risk routes — leads PATCH/DELETE,
      // tours create/update/bulk-cancel, settings, venues,
      // availability, blackouts, AI safety review/reject,
      // operator message send, digest preferences/manual send,
      // digest suppression remove/remove-all, tours clear-pause —
      // emit one audit row per write with sanitized snapshots.
      // The `autonomous_sending_still_disabled` flag from 8AX
      // stays mounted: this phase ONLY adds observability; no
      // autonomous sending, no autopilot toggle, no decision
      // logic change.
      enterprise_audit_log: 'mounted',
      enterprise_audit_events_card: 'mounted',
      rbac_documentation_pass: 'mounted',
      request_context_baseline: 'mounted',
      // 9B — Audit Coverage Completion + RBAC Hardening Matrix.
      // Completed the audit instrumentation pass started in 9A
      // (billing, team RBAC, leads create, onboarding, demo,
      // test-send, digest preview); added `lib/enterprise/audit-actions.ts`
      // string constants; documented the per-route coverage and
      // RBAC posture in docs/AUDIT-COVERAGE.md +
      // docs/RBAC-MATRIX.md; added the
      // `scripts/check-audit-coverage.mjs` regression guard wired
      // into `npm run verify`; polished the
      // EnterpriseAuditEventsCard drawer (collapsed JSON, copy
      // buttons for audit id + request id + actor user + target
      // id). No autonomous sending, no autopilot toggle.
      enterprise_audit_coverage_matrix: 'mounted',
      enterprise_rbac_matrix: 'mounted',
      enterprise_audit_coverage_check: 'mounted',
      enterprise_audit_detail_drawer: 'mounted',
      // 9C — Audit immutability mirror + cross-tenant probe.
      // Migration 028 added `public.audit_event_mirror` with
      // owner-only SELECT and NO write policies; all inserts go
      // through `lib/enterprise/audit-mirror.ts#mirrorAuditEvent`
      // via service role. `recordAuditEvent` fires the mirror
      // best-effort after the primary insert succeeds — failures
      // are logged + Sentry-captured but never block the business
      // action. Gated by `AUDIT_MIRROR_ENABLED=1` (default OFF;
      // code path is always mounted). The
      // `scripts/check-cross-tenant-rbac.mjs` smoke harness
      // probes a representative set of admin + resource routes
      // for the 403→404 collapse posture; documented in
      // docs/RUNBOOK.md and runs via `npm run check:cross-tenant-rbac`.
      // No autonomous sending, no autopilot toggle.
      enterprise_audit_mirror: 'mounted',
      enterprise_audit_mirror_best_effort: 'mounted',
      // 9D — Data export, PII redaction, retention controls.
      // `/api/admin/data-export` returns a venue-scoped JSON
      // snapshot (cap MAX_EXPORT_BYTES=8 MB, 413 with pointer to
      // future async path when exceeded);
      // `/api/admin/leads/[leadId]/redact-pii` soft-redacts a
      // single lead's name/email/phone/notes + PII metadata while
      // preserving conversations / tours / ai_actions /
      // audit_events. Both routes emit `audit_events` rows
      // (`data_export_requested`, `lead_pii_redacted`); audit
      // metadata records counts + reasons, NEVER the full export
      // payload. DataLifecycleCard on /dashboard/settings/billing
      // surfaces export + redaction info + a retention posture
      // summary (audit mirror state, digest retention, audit log
      // retention, PII redaction availability). The
      // `autonomous_sending_still_disabled` flag stays mounted.
      enterprise_data_export: 'mounted',
      lead_pii_redaction: 'mounted',
      data_lifecycle_card: 'mounted',
      retention_posture_visible: 'mounted',
      // 9E — Security headers, CSP report-only telemetry, secrets
      // rotation runbook. next.config.js ships HSTS (prod-only),
      // X-Content-Type-Options, Referrer-Policy, Permissions-Policy
      // (powerful APIs disabled including bluetooth), X-Frame-Options
      // SAMEORIGIN with /widget/* exception, an ENFORCED
      // Content-Security-Policy with frame-ancestors only, and a
      // SEPARATE Content-Security-Policy-Report-Only with the fuller
      // aspirational directive set pointing at /api/security/csp-report.
      // The report endpoint is anonymous + per-IP rate-limited
      // (rateLimitCspReport, 60/min). Secrets rotation cadence +
      // blast radius documented in docs/RUNBOOK.md (the
      // `secrets_rotation_runbook` flag is doc-presence only). No
      // autonomous sending, no agent prompt changes, no Stripe
      // webhook changes, no widget-intake changes. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      security_headers_report_only: 'mounted',
      csp_report_endpoint: 'mounted',
      hsts_header: 'mounted',
      permissions_policy_header: 'mounted',
      secrets_rotation_runbook: 'mounted',
      // 9F — Rate-limit normalization + abuse monitoring.
      // `lib/rate-limit-catalog.ts` is the typed source of truth for
      // every limiter key prefix. `scripts/check-rate-limit-coverage.mjs`
      // scans app/api for routes lacking a rateLimit*/RATE_LIMIT_EXEMPT/
      // public route/webhook route marker (65 routes currently clean).
      // Every rate-limit wrapper accepts an optional abuseContext arg;
      // on block it fires a fire-and-forget `recordAbuseEvent`
      // (lib/enterprise/abuse-events.ts) into `public.abuse_events`
      // (migration 029). The AbuseMonitorCard on
      // /dashboard/settings/billing reads
      // `/api/admin/security/abuse-events` (admin/owner only,
      // venue-scoped) and surfaces top routes/reasons/limiter keys +
      // a recent-rows table. Public-route blocks (widget, CSP) are
      // stored with venue_id NULL and intentionally NOT surfaced
      // through the venue card — operators inspect via SQL editor.
      // The `autonomous_sending_still_disabled` flag stays mounted.
      rate_limit_catalog: 'mounted',
      rate_limit_coverage_check: 'mounted',
      abuse_monitoring: 'mounted',
      abuse_monitor_card: 'mounted',
      public_route_throttles: 'mounted',
      // 9G — Enterprise SSO readiness. Migration 030 added
      // `public.sso_connections` (owner-only mutations, admin
      // SELECT) and `public.sso_login_events` (service-role
      // insert via lib/enterprise/sso/audit.ts;
      // owner/admin SELECT scoped to venue). The vendor adapter
      // resolves to the `notConfiguredAdapter` placeholder for
      // every provider — initiate + callback return structured
      // SSO_* error codes without performing any real handshake.
      // Public auth routes (/api/auth/sso/{initiate,callback})
      // are rate-limited via the new `vr:sso` Upstash prefix
      // (10/min/IP+domain on initiate, 10/min/IP on callback).
      // Admin connection management lives at
      // /api/admin/security/sso-connections{,/[id]} (owner-only
      // for POST/PATCH/DELETE) + /api/admin/security/sso-login-events
      // (admin/owner GET). The SsoConnectionsCard +
      // SsoLoginEventsCard on /dashboard/settings/billing surface
      // the operator-facing view. No real SAML/OIDC exchange, no
      // SCIM, no JIT user creation, no secrets stored. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      sso_readiness: 'mounted',
      sso_connections_table: 'mounted',
      sso_login_events: 'mounted',
      sso_admin_endpoints: 'mounted',
      sso_provider_abstraction: 'mounted',
      // 9H — Backup posture + disaster recovery readiness.
      // `lib/enterprise/disaster-recovery/*` provides the typed
      // policy (RTO 4h, RPO 24h, retention 7d floor, quarterly
      // dry-runs), the server-only Management API smoke probe
      // (degrades to status='unknown' when env is unset), and
      // the restore-intent audit helper that routes through
      // `recordAuditEvent`. The
      // `/api/admin/security/backup-posture` endpoint is
      // read-only; `/api/admin/security/restore-intents` is
      // owner-only + audit-only — the product NEVER executes a
      // restore. Real restores happen via the Supabase
      // dashboard / support runbook per
      // docs/DISASTER-RECOVERY.md. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      backup_posture: 'mounted',
      disaster_recovery_runbook: 'mounted',
      restore_intent_audit: 'mounted',
      backup_posture_card: 'mounted',
      backup_posture_check: 'mounted',
      // 9I — SOC 2 / enterprise evidence packaging.
      // `lib/enterprise/evidence/*` consolidates the existing
      // platform controls into a single typed catalog +
      // markdown/CSV renderers. `/api/admin/security/evidence-report`
      // surfaces the live report (admin/owner; JSON refresh +
      // markdown/CSV download). The SecurityEvidenceCenter card
      // on /dashboard/settings/billing surfaces it in-product.
      // `scripts/build-evidence-pack.mjs` produces a static pack
      // at `artifacts/evidence/` without any Supabase creds.
      // `docs/SOC2-EVIDENCE-MAP.md` carries the TSC mapping +
      // certification disclaimer + known gaps. THIS IS NOT a SOC 2
      // attestation; formal SOC 2 requires an auditor +
      // observation period. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      security_evidence_center: 'mounted',
      evidence_report_api: 'mounted',
      evidence_pack_generator: 'mounted',
      soc2_evidence_map: 'mounted',
      evidence_packaging_check: 'mounted',
      // 9J — Enterprise sales readiness + questionnaire automation.
      // `lib/enterprise/evidence/questionnaire-{types,map,report}.ts`
      // generates buyer-ready security questionnaire responses
      // (generic / CAIQ-Lite / SIG-Lite / VSAQ-Lite) by cross-
      // referencing each answer to the Phase 9I EVIDENCE_CONTROLS
      // map. `lib/enterprise/evidence/security-summary.ts` produces
      // the buyer-facing security summary with explicit known
      // limitations + planned improvements.
      // `lib/enterprise/evidence/readiness-checklist.ts` is a
      // server-only internal scoreboard surfaced on
      // /dashboard/settings/billing. Three admin routes back the
      // new cards: `/api/admin/security/questionnaire-response`,
      // `/api/admin/security/buyer-security-summary`, and
      // `/api/admin/security/demo-mode` (PATCH is owner-only).
      // `DemoModeBanner` is a VISUAL marker only — NOT data
      // anonymization. Every buyer-facing output carries the
      // "REVIEW BEFORE SENDING" disclaimer. We continue to NOT
      // claim SOC 2 certification and NOT claim real SAML/OIDC or
      // SCIM is live. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      security_questionnaire_generator: 'mounted',
      buyer_security_summary: 'mounted',
      demo_mode_foundation: 'mounted',
      enterprise_readiness_checklist: 'mounted',
      sales_readiness_exports: 'mounted',
      // 9K — Vendor risk + subprocessor disclosure pack.
      // `lib/enterprise/vendor-risk/vendor-registry.ts` is the
      // single source of truth for every third-party processor.
      // `/api/admin/security/vendor-risk-report` (admin/owner;
      // JSON / markdown / CSV) renders the full admin view;
      // `/api/admin/security/subprocessor-disclosure` (admin/owner;
      // JSON / markdown / CSV) renders the buyer-safe filtered
      // view (only vendors with disclosureStatus === 'public';
      // evidence references stripped). VendorRiskCard +
      // SubprocessorDisclosureCard surface them in-product on
      // /dashboard/settings/billing. Markdown + CSV exports
      // audit (vendor_risk_report_exported /
      // subprocessor_disclosure_exported); JSON refreshes don't.
      // `scripts/build-vendor-risk-pack.mjs` produces a static
      // pack at `artifacts/evidence/vendor-risk/` without any
      // Supabase creds. `scripts/check-vendor-risk.mjs` asserts
      // the scaffolding stays in place + cross-checks the
      // registry against known production packages.
      // `docs/VENDOR-RISK.md` documents the registry process,
      // DPA/SCC/SOC 2 review workflow, and what NOT to claim.
      // Phase 9K does NOT claim DPA / SCC / SOC 2 verification
      // for any vendor; every row defaults to
      // assuranceStatus="manual_review_required" until evidence
      // is confirmed by legal. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      vendor_risk_registry: 'mounted',
      subprocessor_disclosure: 'mounted',
      vendor_risk_exports: 'mounted',
      vendor_risk_cards: 'mounted',
      vendor_risk_check: 'mounted',
      // 9L — Incident response automation + alert routing.
      // `lib/enterprise/incidents/*` ships first-class incident
      // records (public.incidents + public.incident_timeline_events
      // + public.incident_alert_deliveries — migration 032),
      // conservative operator-triggered detectors over
      // abuse_events / sso_login_events / backup_posture /
      // health_check, and env-gated alert routing helpers for
      // Slack / PagerDuty / Sentry. Four admin routes back the
      // surface: GET+POST /api/admin/security/incidents,
      // GET+PATCH /api/admin/security/incidents/[id], POST
      // /api/admin/security/incidents/detect, POST
      // /api/admin/security/incidents/[id]/alert (all
      // admin/owner). IncidentResponseCard surfaces them
      // in-product. `scripts/build-incident-response-pack.mjs`
      // produces a static runbook + PIR template + severity CSV
      // for off-line review. Alert routing is env-gated
      // (INCIDENT_ALERTS_ENABLED + INCIDENT_SLACK_WEBHOOK_URL +
      // INCIDENT_PAGERDUTY_ROUTING_KEY); helpers return
      // skipped_disabled / skipped_unconfigured when absent and
      // never throw. Webhook URLs + routing keys NEVER appear in
      // logs, responses, or audit metadata. NO autonomous
      // remediation; NO auto-resolve; customer notification
      // requires legal/operator review. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      incident_response_records: 'mounted',
      incident_detection_candidates: 'mounted',
      incident_alert_routing: 'mounted',
      incident_response_card: 'mounted',
      incident_response_pack: 'mounted',
      // 9M — Data privacy + DSR readiness. lib/enterprise/privacy/*
      // ships a static data inventory (15 categories) + retention
      // policy + a first-class DSR workflow (public.dsr_requests +
      // public.dsr_timeline_events — migration 033). Five admin
      // routes back the surface (readiness GET, dsr-requests
      // GET+POST, dsr-requests/[id] GET+PATCH,
      // dsr-requests/[id]/export-preview POST,
      // dsr-requests/[id]/deletion-review POST — all admin/owner;
      // mutating routes additionally require requireVenueRole
      // ['owner','admin']). PrivacyReadinessCard +
      // DsrRequestsCard surface the layer in-product.
      // Export preview is metadata-only; deletion review is
      // non-destructive — real exports and deletions are
      // operator + legal reviewed. We do NOT claim GDPR / CCPA /
      // LGPD compliance and DSRs are NEVER auto-fulfilled. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      privacy_data_inventory: 'mounted',
      privacy_retention_policy: 'mounted',
      dsr_request_tracking: 'mounted',
      dsr_non_destructive_reviews: 'mounted',
      privacy_readiness_pack: 'mounted',
      // 9N — Trust Center foundation. lib/enterprise/trust-center/*
      // ships a public buyer-facing /trust page (curated copy +
      // public subprocessor list) + gated bearer-token grants for
      // packets at three scopes (summary_only / standard_packet /
      // full_packet). Migration 034 adds public.trust_access_grants
      // (token stored as salted-SHA-256 hash) + public.trust_access_events
      // (every grant_created / revoked / accessed / artifact_downloaded
      // / expired / access_denied logged with fingerprinted IP +
      // user-agent). Four admin routes (grants GET+POST,
      // grants/[id] PATCH, access-events GET, packet GET) +
      // public+gated pages + gated artifact route. TrustCenterCard
      // + TrustAccessGrantsCard mount on billing page. Internal-only
      // artifacts NEVER emit even on full_packet. Bearer tokens are
      // short-lived (default 14d, max 90d) and revocable.
      // `scripts/build-trust-center-pack.mjs` produces a static
      // pack for offline review. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      trust_center_public_summary: 'mounted',
      trust_center_gated_packets: 'mounted',
      trust_access_tracking: 'mounted',
      trust_center_admin_cards: 'mounted',
      trust_center_pack: 'mounted',
      // 9O — Compliance operations calendar + evidence freshness.
      // lib/enterprise/compliance-ops/{types,policy,calendar,freshness}.ts
      // back a 17-row static policy spanning every readiness area
      // shipped in 9I-9N. Migration 035 adds public.compliance_review_events
      // (CHECK on area/cadence/status/source, partial unique index on
      // active (venue,policy,due_at), owner/admin RLS). Three admin
      // routes (calendar GET+POST, calendar/[id] PATCH, freshness
      // GET) all admin/owner-gated; mutating routes additionally
      // require requireVenueRole(['owner','admin']). Typed audit
      // actions cover every lifecycle step (seeded / created /
      // completed / waived / updated / exported).
      // ComplianceCalendarCard surfaces it inline with seed +
      // custom + complete + waive + CSV/MD exports.
      // build-compliance-ops-pack ships a static policy + cadence
      // CSV + freshness template for offline review.
      // The calendar tracks OPERATOR-INITIATED reviews — does NOT
      // prove continuous compliance, does NOT auto-rotate secrets,
      // does NOT send external alerts. The
      // `autonomous_sending_still_disabled` flag stays mounted.
      compliance_calendar: 'mounted',
      compliance_freshness_tracking: 'mounted',
      compliance_review_workflow: 'mounted',
      compliance_calendar_card: 'mounted',
      compliance_ops_pack: 'mounted',
      // 9P — Contract commitments register. lib/enterprise/commitments/*
      // ships an operator-recorded register for customer-specific
      // contractual / security / privacy commitments. Migration
      // 036 adds public.contract_commitments + contract_commitment_events
      // with CHECK on source_type / area / status / risk_level /
      // event_type, owner/admin RLS. Three admin routes
      // (commitments GET+POST, commitments/[id] GET+PATCH,
      // commitments/readiness GET) all admin/owner-gated;
      // mutating routes additionally require requireVenueRole.
      // Typed audit actions per lifecycle step (created /
      // updated / status_changed / fulfilled / reviewed /
      // exported / readiness_exported). CommitmentsRegisterCard
      // + CommitmentsReadinessCard surface them inline. The
      // unsupported-risk detector flags commitments referencing
      // capabilities the product does not fully support today
      // (SCIM, real SSO, 24/7 monitoring, automated DSR
      // fulfilment, AI-vendor training-use claims). Operators
      // are NOT blocked from recording — the warning exists so
      // the gap can be rectified with the buyer.
      // build-commitments-pack ships a static support-posture
      // pack for offline review.
      // This is a tracking / readiness workflow ONLY — NOT
      // legal advice, NOT contractual compliance proof, NO
      // autonomous contract parsing, NO auto-promise generation.
      // autonomous_sending_still_disabled flag stays mounted.
      contract_commitments_register: 'mounted',
      commitments_readiness: 'mounted',
      unsupported_commitment_warnings: 'mounted',
      commitments_pack: 'mounted',
      // Phase 8BE — Omnichannel inbox connector foundation.
      //   - omnichannel_channel_registry: capability matrix +
      //     CHANNEL_TYPES vocabulary (lib/integrations/channels/*).
      //   - channel_connection_admin: GET/POST/PATCH admin routes
      //     under /api/admin/integrations/channels.
      //   - external_conversation_mapping: external_conversations
      //     + external_messages tables (migration 037) hold the
      //     external thread → internal lead/conversation/message
      //     mapping + idempotency.
      //   - inbound_channel_normalization: public inbound routes
      //     (/api/integrations/website/message,
      //     /api/integrations/lead-forwarding/the-knot,
      //     /api/integrations/lead-forwarding/weddingwire,
      //     /api/integrations/meta/webhook PLACEHOLDER) all funnel
      //     through normalizeInboundChannelMessage.
      //   - manual_required_reply_workflow:
      //     POST /api/conversations/[id]/mark-sent-manually +
      //     ManualChannelReplyBanner component. Records human
      //     message + external_messages 'marked_sent_manually'
      //     status — operator confirms after sending out-of-band.
      //   - inbox_channel_badges: ChannelSourceBadge rendered in
      //     ConversationList + ConversationThread message bubbles.
      //   - Honesty: NO real Meta / Gmail / WeddingWire / The Knot
      //     OAuth or Send API. NO autonomous sending. Manual-
      //     required channels surface an explicit copy + mark
      //     workflow. autonomous_sending_still_disabled stays
      //     mounted under the demo block above.
      omnichannel_channel_registry: 'mounted',
      channel_connection_admin: 'mounted',
      external_conversation_mapping: 'mounted',
      inbound_channel_normalization: 'mounted',
      manual_required_reply_workflow: 'mounted',
      inbox_channel_badges: 'mounted',
      // Phase 8BE-2 — Omnichannel inbox activation patch.
      //   - omnichannel_inbox_loader_channels: inbox + lead pages
      //     now join external_conversations (with messages.metadata
      //     fallback) via lib/integrations/channels/inbox-channels.ts
      //     so ConversationList rows light up the channel source
      //     badge for normalized conversations.
      //   - manual_reply_banner_mounted: ManualChannelReplyBanner is
      //     mounted in the LeadDetailDrawer draft footer when the
      //     resolved conversation channel reports
      //     manualReplyRequired=true. The Approve & send button is
      //     gated on those channels so VenueRise never claims to
      //     have delivered the reply.
      //   - manual_channel_reply_confirmation_ui: Copy reply + Mark
      //     sent manually controls call /api/conversations/[id]/
      //     mark-sent-manually, which writes a `human` message +
      //     stamps external_messages with `marked_sent_manually`.
      //     `manual_reply_marked_by` lands in messages.metadata so
      //     ConversationThread can render the "Sent manually" pill.
      omnichannel_inbox_loader_channels: 'mounted',
      manual_reply_banner_mounted: 'mounted',
      manual_channel_reply_confirmation_ui: 'mounted',
      // Phase 8BG — WeddingWire / The Knot lead-forwarding parser.
      //   - lead_forwarding_parser: deterministic regex-first
      //     parser in lib/integrations/channels/lead-forwarding-parser.ts.
      //     Accepts structured JSON payloads OR raw forwarded
      //     bodies; returns confidence + needs-review flag.
      //   - the_knot_forwarding_parser / weddingwire_forwarding_parser:
      //     the public lead-forwarding routes funnel through the
      //     parser before normalization. Outbound stays
      //     manual-required.
      //   - parse_confidence_review: ParseReviewBadge in
      //     ConversationThread + ConversationList warning dot +
      //     "Source parse review" panel in LeadDetailDrawer.
      //   - lead_forwarding_test_parse: admin-only QA endpoint
      //     POST /api/admin/integrations/lead-forwarding/test-parse.
      //     Pure parse — no DB write.
      //   - Honesty: NO model parser. NO raw body logging. NO
      //     real outbound API to The Knot or WeddingWire.
      lead_forwarding_parser: 'mounted',
      the_knot_forwarding_parser: 'mounted',
      weddingwire_forwarding_parser: 'mounted',
      parse_confidence_review: 'mounted',
      lead_forwarding_test_parse: 'mounted',
      // Phase 8BF — Meta / Instagram / Facebook connector +
      // verified webhook. Replaces the 8BE placeholder.
      //   - meta_webhook_signature_verification: HMAC-SHA256
      //     verification via lib/integrations/channels/meta-signature.ts.
      //     Requires META_APP_SECRET; missing-env returns 503.
      //   - instagram_inbound_connector / facebook_inbound_connector:
      //     parsed messaging events route through
      //     normalizeInboundChannelMessage when a venue
      //     connection matches on instagram_business_account_id
      //     or meta_page_id.
      //   - meta_lead_ads_placeholder: leadgen events create a
      //     placeholder message with
      //     requires_graph_hydration=true and
      //     parse_needs_review=true. NO Graph API call.
      //   - meta_channel_connection_metadata: Meta-family
      //     channels accept the allowlisted identifier keys
      //     (page id / IG business / ad account / app id) only.
      //     Token / secret keys are rejected server-side.
      //   - meta_outbound_still_manual: capability matrix keeps
      //     outbound: false. Approve & send stays gated by the
      //     manual-required banner.
      //   - meta_webhook_test_parse: POST /api/admin/integrations/
      //     meta/test-parse runs the parser without normalizing.
      //   - Honesty: NO Meta OAuth, NO Send API, NO Graph
      //     hydration, NO token storage. autonomous_sending_
      //     still_disabled stays mounted.
      meta_webhook_signature_verification: 'mounted',
      instagram_inbound_connector: 'mounted',
      facebook_inbound_connector: 'mounted',
      meta_lead_ads_placeholder: 'mounted',
      meta_channel_connection_metadata: 'mounted',
      meta_outbound_still_manual: 'mounted',
      meta_webhook_test_parse: 'mounted',
      // Phase 8BH — Website + ads attribution pipeline.
      //   - website_attribution_capture: widget.js captures
      //     UTM params + click ids + referrer + landing page
      //     from the parent page and forwards via iframe
      //     query params; the embedded widget page passes
      //     them to /api/widget alongside the lead intake.
      //   - lead_attribution_metadata: every new lead
      //     (widget + omnichannel) lands with
      //     `metadata.attribution` parsed via
      //     parseLeadAttribution. Legacy leads stay safe.
      //   - lead_drawer_attribution_panel: LeadDetailDrawer
      //     renders source label, campaign, landing page,
      //     referrer, and click-id presence badges when
      //     metadata.attribution is set.
      //   - attribution_performance_card: Overview groups
      //     leads + tours by SourceLabel; estimated pipeline
      //     is summed from `leads.budget` and clearly NOT
      //     ROAS — ad spend is not connected.
      //   - analytics_attribution_breakdown: analytics page
      //     renders the same summary as a simple table.
      //   - Honesty: no pixel, no ad-platform API, no token
      //     storage, no multi-touch.
      website_attribution_capture: 'mounted',
      lead_attribution_metadata: 'mounted',
      lead_drawer_attribution_panel: 'mounted',
      attribution_performance_card: 'mounted',
      analytics_attribution_breakdown: 'mounted',
      // Phase 8BI — Booked revenue attribution + ROI proxy.
      //   - booked_revenue_attribution: per-source rollup of
      //     leads / tours / booked / estimated pipeline /
      //     estimated booked value via
      //     lib/enterprise/attribution/revenue.ts.
      //   - attribution_revenue_helper: pure helper. No DB
      //     access. Never throws.
      //   - booked_revenue_attribution_card: Overview card
      //     below AttributionPerformanceCard. Honest empty
      //     state when no booked leads exist yet.
      //   - analytics_booked_revenue_by_source: analytics
      //     page section with leads / tours / booked /
      //     estimated pipeline / estimated booked / L→Tour
      //     / L→Booked rates.
      //   - Honesty: NOT ROAS. Ad spend not connected. Booked
      //     value estimated from `leads.budget`.
      booked_revenue_attribution: 'mounted',
      attribution_revenue_helper: 'mounted',
      booked_revenue_attribution_card: 'mounted',
      analytics_booked_revenue_by_source: 'mounted',
      // Phase 8BJ — Source-level revenue leakage drilldowns.
      //   - source_leakage_summary: pure helper at
      //     lib/enterprise/attribution/leakage.ts. Composes the
      //     existing Revenue OS signals (slow first reply, no
      //     tour, recovery, tour booking, reactivation, lost)
      //     and groups every signal by the lead's attribution
      //     source label. No DB access, never throws.
      //   - source_leakage_overview_card: Overview card
      //     `SourceRevenueLeakageCard` renders the top 5
      //     sources by at-risk lead count + a CTA into the
      //     leads board pre-filtered to that source + leakage.
      //   - leads_source_filter: `KanbanBoard` reads `?source=`
      //     and composes on top of `?leakage=` so the same URL
      //     produces a deterministic slice.
      //   - analytics_source_leakage_breakdown: analytics page
      //     table with Slow reply / No tour / Recovery /
      //     Reactivation / Top leak / At-risk per source.
      //   - Honesty: NOT ROAS. No ad-platform API calls. Ad
      //     spend not connected. Booked / pipeline values are
      //     estimated from `leads.budget`. Attribution is the
      //     intake-time signal — multi-touch not supported.
      //     Source leakage is an operator prioritization lens,
      //     not an accounting report.
      source_leakage_summary: 'mounted',
      source_leakage_overview_card: 'mounted',
      leads_source_filter: 'mounted',
      analytics_source_leakage_breakdown: 'mounted',
      // Phase 9Q — Payment methods + Stripe Billing Portal access.
      //   - payment_methods_card: PaymentMethodsCard mounted on
      //     /dashboard/settings/billing for all roles; non-admins
      //     see disabled CTAs + inline notice (no 403 round-trip).
      //   - stripe_billing_portal_access: POST /api/billing/portal
      //     remains the only path to manage cards. ADMIN_ROLES
      //     gated, user-scoped rate-limit, returns Stripe-hosted
      //     URL only. VenueRise never renders a card form.
      //   - billing_portal_audit_event: every portal session
      //     creation writes BILLING_PORTAL_SESSION_CREATE to
      //     `public.audit_events` with `source`,
      //     `subscription_status`, and a boolean
      //     `stripe_customer_present` — no card number, no
      //     payment method id, no Stripe raw payload.
      //   - Honesty: we DO NOT claim PCI compliance / Stripe
      //     certification / "fully secure". Copy says "processed
      //     by Stripe" + "full card details are not stored in
      //     VenueRise" + "billing actions are audited" only.
      payment_methods_card: 'mounted',
      stripe_billing_portal_access: 'mounted',
      billing_portal_audit_event: 'mounted',
      // Phase 9R — Subscription plans + pricing tiers.
      //   - subscription_plan_catalog: pure catalog at
      //     lib/billing/plans.ts. 4 tiers (Starter, Growth, Elite,
      //     Enterprise). Stripe price ids resolve from env vars,
      //     never inlined. Enterprise is contact-sales (no price).
      //   - subscription_plans_card: SubscriptionPlansCard mounted
      //     on /dashboard/settings/billing for all roles;
      //     non-admins see disabled CTAs + inline notice.
      //   - stripe_plan_checkout: POST /api/billing/checkout
      //     accepts `{ plan_id, interval, source }` in addition to
      //     the legacy `{ price_id }`. Plan id wins over price id.
      //     Enterprise returns 400 `enterprise_contact_required`;
      //     missing env var returns 422 `stripe_price_not_configured`.
      //   - billing_plan_gates_foundation: lib/billing/plan-gates.ts
      //     exports canUseFeature / getUpgradeTargetForFeature /
      //     getFeatureGateCopy + FEATURE_LABEL. Used by the card
      //     only — NOT wired as hard enforcement anywhere; existing
      //     users keep their current access.
      //   - Honesty: plan limits are product controls, not legal /
      //     compliance guarantees. We DO NOT claim SOC 2, GDPR,
      //     HIPAA, PCI, real SSO, SCIM, or 24/7 monitoring.
      subscription_plan_catalog: 'mounted',
      subscription_plans_card: 'mounted',
      stripe_plan_checkout: 'mounted',
      billing_plan_gates_foundation: 'mounted',
      // Phase 9S — Full UI interaction audit + dead-button fix
      // pass.
      //   - ui_interaction_audit: docs/UI-INTERACTION-AUDIT.md
      //     is the per-surface inventory + verification table.
      //   - ui_interaction_scanner: scripts/check-ui-interactions
      //     .mjs catches placeholder hrefs, empty onClick, alert /
      //     confirm outside admin destructive flows, browser-side
      //     `console` calls in client code, and JSX placeholder
      //     text. Exemptions via // UI_INTERACTION_EXEMPT: <reason>.
      //   - dead_button_fix_pass: P0 / P1 dead buttons removed or
      //     honestly disabled. See AUDIT doc for the full list.
      //   - fetch_route_mismatch_check: scripts/check-fetch-routes
      //     .mjs walks client fetch() calls and verifies the URL
      //     resolves to an on-disk app/api/.../route.ts.
      //   - Honesty: plan limits, SSO, restore intent, trust packet,
      //     payment methods, autopilot copy is verified by 9S to
      //     match shipped posture; no compliance / autonomy
      //     overclaims.
      ui_interaction_audit: 'mounted',
      ui_interaction_scanner: 'mounted',
      dead_button_fix_pass: 'mounted',
      fetch_route_mismatch_check: 'mounted',
      // Phase 9T-alt — Knowledge Base CRUD foundation.
      //   - knowledge_base_crud: GET/POST at
      //     /api/venues/[id]/knowledge + PATCH/DELETE at
      //     /api/venues/[id]/knowledge/[knowledgeId]. SALES_ROLES
      //     gate on writes; any venue member can read. Cross-tenant
      //     forbidden collapses to 404. Zod validation: title 1–160,
      //     content 1–8000, category ≤80, priority 0–100.
      //   - knowledge_base_audit: every mutation writes one of
      //     KNOWLEDGE_ENTRY_CREATED / _UPDATED / _DELETED /
      //     _TOGGLED. Audit metadata captures title / category /
      //     priority / is_active / content_length — full content
      //     is NOT mirrored to the audit feed.
      //   - knowledge_base_rate_limit: user-scoped buckets at
      //     `venues:knowledge:{list|create|update|delete}:<userId>`.
      //   - Honesty: knowledge entries influence AI replies via the
      //     existing orchestrator KB read; no agent prompt changes.
      //     Operators are warned via UI copy to keep secrets out of
      //     entries.
      knowledge_base_crud: 'mounted',
      knowledge_base_audit: 'mounted',
      knowledge_base_rate_limit: 'mounted',
      // Phase 9T — Playwright runtime QA suite.
      //   - runtime_interaction_qa: tests/e2e/ contains specs
      //     covering core operator workflows; runs in browser via
      //     `npm run test:e2e`. Static UI scan from 9S still
      //     ships — runtime adds the load/error/redirect coverage
      //     scanners can't see.
      //   - playwright_core_workflows: lead create + drawer +
      //     command palette covered in core-dashboard.spec.ts.
      //   - knowledge_base_runtime_qa: full CRUD (add / edit /
      //     toggle / delete) covered in settings-knowledge.spec.ts.
      //   - availability_runtime_qa: tab render + blackout add /
      //     delete covered in settings-availability.spec.ts.
      //   - Honesty: tests assume a manually-generated storageState
      //     at `.auth/admin.json`; we did NOT add a test-auth API
      //     route to production. Stripe checkout is gated behind
      //     `E2E_ALLOW_STRIPE=1` and skipped by default.
      runtime_interaction_qa: 'mounted',
      playwright_core_workflows: 'mounted',
      knowledge_base_runtime_qa: 'mounted',
      availability_runtime_qa: 'mounted',
      // GTM-0A — Revenue Recovery Demo seed (sales / pilot setup).
      //   - revenue_recovery_demo_seed: POST /api/admin/demo/
      //     revenue-recovery-seed mounted. ADMIN_ROLES gated;
      //     audit row `revenue_recovery_demo_seeded` per call;
      //     `metadata.demo_seed=true` lets reset clean only its
      //     own rows. ADMIN_ENDPOINT_COUNT bumped 74 → 75.
      //   - demo_revenue_leak_dataset: 24-lead fixture spans
      //     every Revenue OS leakage signal at least once (slow
      //     first reply, qualified no tour, unconfirmed tour,
      //     stale negotiation, cold ghost, reactivation).
      //   - demo_channel_attribution_dataset: leads carry
      //     `metadata.attribution` with source_label across
      //     Google Ads / Meta Ads / Instagram / The Knot /
      //     WeddingWire / Website / Referral / Unknown.
      //   - demo_pipeline_recovery_dataset: lost rows with
      //     `lost_reason.reason` covering ghosted / priced_out /
      //     picked_competitor so Reactivation surfaces light up.
      //   - Honesty: no external API calls, no autonomous
      //     sending, no production-data deletion. Reset only
      //     touches `metadata->>demo_seed = 'true'`.
      revenue_recovery_demo_seed: 'mounted',
      demo_revenue_leak_dataset: 'mounted',
      demo_channel_attribution_dataset: 'mounted',
      demo_pipeline_recovery_dataset: 'mounted',
      // GTM-0B — Public marketing reposition + demo loop.
      //   - gtm_revenue_recovery_positioning: homepage rewritten
      //     around "Stop losing weddings in the follow-up gap"
      //     wedge. Anti-positioning vs CRMs / generic AI SaaS /
      //     autonomous agents codified on the public page.
      //   - marketing_revenue_os_homepage: new section order
      //     (Hero → Leaks → How → Demo preview → Operator
      //     control → Pilot → FAQ → Apply). Old SocialProof
      //     "Trusted by top venues nationwide", Solution generic
      //     6-feature grid, and Trust shield-icon section are
      //     no longer mounted; copy that overclaimed autonomy
      //     ("24/7 sales coordinator", "responds in under 60
      //     seconds") removed.
      //   - demo_loop_cta: /demo route mounted. Reuses the
      //     existing AuditForm (already writes to audit_leads
      //     on submit). Navbar + Footer + Hero CTAs all point
      //     at real anchors or /demo; no #audit dead links.
      //   - operator_control_messaging: dedicated Operator
      //     Control section ("AI helps your team move faster.
      //     It does not replace their judgment.") + microcopy
      //     under hero ("AI drafts. Your team approves. No
      //     autonomous sending."). FAQ "Does AI send
      //     automatically?" answers the same question for
      //     skim-readers.
      //   - Honesty: no SOC 2 / GDPR / PCI claims; no
      //     guaranteed revenue; no fake testimonials or partner
      //     logos. Pilot pricing deliberately stays behind a
      //     conversation.
      //   - ADMIN_ENDPOINT_COUNT unchanged — no new admin
      //     routes; only marketing pages.
      gtm_revenue_recovery_positioning: 'mounted',
      marketing_revenue_os_homepage: 'mounted',
      demo_loop_cta: 'mounted',
      operator_control_messaging: 'mounted',
      // GTM-0A.2 — Revenue Recovery LOAD / Stress Demo seed.
      //   - revenue_recovery_load_seed: POST /api/admin/demo/
      //     revenue-recovery-load-seed mounted. ADMIN_ROLES gated;
      //     audit row `revenue_recovery_load_demo_seeded` per call;
      //     reset matches BOTH `demo_seed_type = 'load'` AND
      //     `demo_seed_version = 'gtm_0a_2'` so it never touches
      //     the GTM-0A hand-crafted 24-lead demo dataset. Rate
      //     limit catalog key `adminDemo.revenueRecoveryLoadSeed`.
      //     ADMIN_ENDPOINT_COUNT bumped 75 → 76.
      //   - demo_load_250_leads: default profile generates 250
      //     leads + 60-75% with conversation threads + tour rows
      //     for stage-eligible leads. Clamp bounds [25, 1000].
      //     Four profiles: balanced / high_volume / messy_channels
      //     / sales_demo.
      //   - demo_load_source_distribution: leads carry
      //     `metadata.attribution.source_label` spanning Google Ads
      //     / Meta Ads / Instagram / The Knot / WeddingWire /
      //     Website / Referral / Unknown per profile distribution.
      //   - demo_load_leakage_distribution: stage + signal mix is
      //     tuned per profile so RevenueLeakageBrief / Recovery /
      //     TourConfirmation / Reactivation / Attribution cards
      //     all light up at 250-lead scale.
      //   - Honesty: no external API calls, no autonomous sending,
      //     no real-customer-data deletion. `demo_seed_type='load'`
      //     isolates this seed from the GTM-0A hand-crafted demo.
      revenue_recovery_load_seed: 'mounted',
      demo_load_250_leads: 'mounted',
      demo_load_source_distribution: 'mounted',
      demo_load_leakage_distribution: 'mounted',
      // Phase GTM-ILR — Instant Lead Response + Venue Voice Training.
      //   - instant_lead_response: new `lib/ai/instant-lead-response.ts`
      //     helper produces a structured Claude draft on every new
      //     lead inside `handleNewLead`. Reuses brand-voice-calibration
      //     + autopilot-guardrails for safety math.
      //   - instant_lead_response_claude: model call routed through the
      //     existing `withAnthropicRetry` wrapper. Failure path returns
      //     a deterministic warm fallback so lead intake never fails.
      //   - instant_response_venue_voice_training: per-venue training
      //     profile (tone, formality, preferred greeting/CTA, phrases,
      //     sample replies, safety notes) persisted under
      //     `venues.metadata.revenue_os.instant_response`.
      //   - instant_response_safety_gate: structured JSON output now
      //     carries `needs_human_review`, `unsupported_claims`,
      //     `detected_questions`, `suggested_next_step`. Auto-send
      //     defaults OFF — even when ON the helper records only
      //     `auto_send_eligible: true` on the audit row and never
      //     actually sends in this phase.
      //   - instant_response_settings: InstantResponseTrainingCard
      //     mounted on /dashboard/settings/billing (admin-only). Uses
      //     the existing /api/admin/revenue-os/settings endpoint.
      //   - instant_response_auto_send_scaffold: scaffold-only —
      //     no outbound integration is wired in this phase.
      //   - ADMIN_ENDPOINT_COUNT unchanged — no new admin routes.
      instant_lead_response: 'mounted',
      instant_lead_response_claude: 'mounted',
      instant_response_venue_voice_training: 'mounted',
      instant_response_safety_gate: 'mounted',
      instant_response_settings: 'mounted',
      instant_response_auto_send_scaffold: 'scaffold-only',
      // Phase GTM-Meta-OAuth — Meta Messenger OAuth scaffold.
      //   - meta_oauth_start: GET /api/integrations/meta/oauth/start
      //     mounted. ADMIN_ROLES gated; generates CSRF state in
      //     httpOnly cookie; 302 to Facebook OAuth dialog. Returns
      //     503 meta_oauth_not_configured when META_APP_ID /
      //     META_APP_SECRET / NEXT_PUBLIC_APP_URL are unset.
      //   - meta_oauth_callback: GET /api/integrations/meta/oauth/
      //     callback mounted. Validates state cookie in constant-
      //     time; exchanges code → short-lived → long-lived user
      //     token → Page tokens; writes venue_channel_connections
      //     + meta_oauth_tokens; subscribes each Page to webhook
      //     fields; redirects to /dashboard/settings/billing on
      //     success or error.
      //   - meta_oauth_token_storage: meta_oauth_tokens table
      //     created (migration 038) with deny-all RLS so only the
      //     service-role client can read tokens. Sanitizer on
      //     venue_channel_connections.metadata explicitly rejects
      //     token-shaped keys, so this dedicated table is the only
      //     legitimate token home.
      //   - meta_outbound_sending: SCAFFOLD-ONLY. The
      //     `sendMetaMessage` helper is dual-gated on
      //     `META_OUTBOUND_SENDING_ENABLED=true` env AND the caller
      //     passing `confirmedAllowedToSend: true` — without BOTH it
      //     throws MetaSendDisabledError. No code path wires it into
      //     auto-send today. Enable only after Meta App Review.
      //   - Routes live under /api/integrations/meta/oauth/*, NOT
      //     under /api/admin/*, so ADMIN_ENDPOINT_COUNT is unchanged.
      meta_oauth_start: 'mounted',
      meta_oauth_callback: 'mounted',
      meta_oauth_token_storage: 'mounted',
      meta_outbound_sending: 'scaffold-only',
      // Phase 8BJ — Inbox AI tour availability awareness + contact
      // info no-repeat guard. Fixes the "I don't have access to the
      // calendar" bug where the conversation agent claimed no
      // calendar access even when the venue had availability rows
      // saved.
      //   - ai_tour_availability_context: handleIncomingMessage
      //     builds a TOUR_AVAILABILITY_CONTEXT block from
      //     tour_availability + tours + tour_blackouts + venue
      //     metadata settings and injects it into the conversation
      //     prompt.
      //   - ai_scheduling_intent_detection: deterministic helper
      //     (lib/revenue-os/scheduling-intent.ts) classifies the
      //     lead message for tour/availability intent before any
      //     DB cost is incurred.
      //   - ai_available_slot_offering: when slots exist, the
      //     prompt instructs the model to offer them directly
      //     ("I have these tour openings available…") and never
      //     to claim missing calendar access.
      //   - ai_contact_info_no_repeat_guard: KNOWN_CONTACT block
      //     tells the model whether email/phone are already known
      //     (from the lead row OR from the latest message OR from
      //     the recent transcript). Missing fields can still be
      //     asked for; present fields never get re-asked. Lead row
      //     is also patched with newly-extracted email/phone when
      //     those columns were null.
      //   - Honesty: nothing here books tours autonomously. The AI
      //     offers slots; the operator still confirms via
      //     ScheduleTourDrawer. ADMIN_ENDPOINT_COUNT unchanged.
      ai_tour_availability_context: 'mounted',
      ai_scheduling_intent_detection: 'mounted',
      ai_available_slot_offering: 'mounted',
      ai_contact_info_no_repeat_guard: 'mounted',
      // Phase 8BK — Tour slot selection detection + operator
      // one-click tour creation. Closes the loop on "AI offered
      // slots → lead picked one → tour exists" without adding
      // autonomous booking or a public confirmation link.
      //   - ai_tour_slot_selection_detection: deterministic helper
      //     (lib/revenue-os/tour-slot-selection.ts) matches lead
      //     replies against the prior AI message's
      //     `offered_tour_slots`. Supports ordinals, weekday+time,
      //     time-only, weekday-only, and bare-affirmative-with-
      //     one-slot patterns. Confidence: high / medium / low.
      //   - tour_slot_selection_metadata: lead message metadata
      //     stamps `tour_slot_selection` when detected; AI message
      //     metadata stamps `offered_tour_slots` when slots are
      //     surfaced so the next inbound reply can match against
      //     them.
      //   - operator_create_tour_from_selected_slot: LeadDetailDrawer
      //     renders a "Tour time selected — Create tour" panel that
      //     opens the existing ScheduleTourDrawer prefilled with
      //     `defaultScheduledAt = starts_at`. Operator still confirms;
      //     no tour row is created until the drawer's save runs.
      //   - tour_selection_confirmation_guardrail: prompt rule
      //     forbids the AI from saying the tour is "confirmed" or
      //     "booked" or "scheduled." The right phrasing is
      //     "prepared for confirmation." Panel hides itself when an
      //     existing tour signal already fires for the lead.
      //   - Honesty: no autonomous booking, no public confirmation
      //     link, no external calendar integration.
      //     ADMIN_ENDPOINT_COUNT unchanged.
      ai_tour_slot_selection_detection: 'mounted',
      tour_slot_selection_metadata: 'mounted',
      operator_create_tour_from_selected_slot: 'mounted',
      tour_selection_confirmation_guardrail: 'mounted',
      // Phase 8BL — Lead-side tour confirmation links. The AI
      // includes one signed, expiring, single-use URL per offered
      // slot in its reply. The lead clicks; a public POST route
      // validates the token, re-checks slot availability, and
      // creates the tours row only after the click succeeds.
      //   - lead_side_tour_confirmation_links: orchestrator wires
      //     token issuance into handleIncomingMessage when slots
      //     are offered. Prior active tokens for the same lead are
      //     revoked first so the latest offer wins.
      //   - tour_slot_confirmation_tokens: migration 039 added
      //     `tour_slot_confirmation_tokens` with deny-all RLS,
      //     unique token_hash (SHA-256 of the raw URL token),
      //     7-day default expiry, single-use status enum.
      //   - public_tour_slot_confirmation_page: GET
      //     /tour/confirm-slot/[token] renders a neutral confirm
      //     button surface. We deliberately do NOT create the
      //     tour on page load — that would let a link previewer
      //     book by accident. POST /api/tour/confirm-slot/[token]
      //     is the actual mutating route.
      //   - tour_confirmation_slot_recheck: before creating the
      //     tour, the POST route re-runs blackout + conflict +
      //     availability-window checks via
      //     lib/revenue-os/tour-slot-availability-check.ts. A slot
      //     that was offered minutes/hours/days ago but is now
      //     unavailable returns 409 slot_unavailable with no tour
      //     row created.
      //   - tour_confirmation_link_audit: every redemption (success
      //     OR post-claim failure) writes audit_events.action =
      //     'tour_confirmed_by_public_link' AND tour_status_events
      //     (actor_kind = 'lead_token', action = 'confirm'). A
      //     system message also lands in the conversation so the
      //     operator sees the lead's confirmation in the inbox
      //     thread.
      //   - Honesty: NO autonomous outbound messaging — the lead
      //     clicks, the system creates a tour, the operator still
      //     decides every other outbound reply. NO Google
      //     Calendar / Calendly / external sync. NO raw PII or
      //     raw tokens in DB. ADMIN_ENDPOINT_COUNT unchanged — the
      //     POST route is public, not admin.
      lead_side_tour_confirmation_links: 'mounted',
      tour_slot_confirmation_tokens: 'mounted',
      public_tour_slot_confirmation_page: 'mounted',
      tour_confirmation_slot_recheck: 'mounted',
      tour_confirmation_link_audit: 'mounted',
      // Phase 8BL-Hotfix — link injection rolled back. The 8BL
      // infrastructure (DB table, helper, public page, POST route)
      // stays mounted but is no longer reached from the AI inbox
      // path:
      //   - lead_side_confirmation_links_hidden_from_ai +
      //     ai_tour_links_hidden_from_chat: orchestrator's
      //     LEAD_SIDE_CONFIRMATION_LINKS_ENABLED constant is
      //     false; no tokens minted; no URLs in prompt.
      //   - premium_tour_slot_message_format: AI offers slots as
      //     plain bullets ("• Saturday, May 23 at 9:00 AM") and
      //     asks the lead to pick. Conversation prompt explicitly
      //     forbids any URL paste.
      //   - inbox_message_overflow_guard: ConversationThread
      //     bubble adds `break-words whitespace-pre-wrap
      //     overflow-hidden min-w-0` so long historical URLs from
      //     pre-hotfix messages wrap instead of pushing the
      //     thread horizontally.
      //   - operator_tour_creation_flow_preserved: 8BK detector,
      //     drawer panel, and ScheduleTourDrawer prefill all
      //     unchanged. Lead picks a slot → operator clicks Create
      //     tour → tour exists.
      //   - Honesty: AI still never claims confirmed/booked/
      //     scheduled. Public confirmation route stays dormant —
      //     no AI message advertises it. A future phase may
      //     re-enable links with a premium embedded card UX.
      lead_side_confirmation_links_hidden_from_ai: 'mounted',
      ai_tour_links_hidden_from_chat: 'mounted',
      premium_tour_slot_message_format: 'mounted',
      inbox_message_overflow_guard: 'mounted',
      operator_tour_creation_flow_preserved: 'mounted',
      // Phase 8BL-Hotfix-2 — inbox scroll container fix. The
      // dashboard layout's banner stack (BillingBanner +
      // DemoModeBanner) sits between the sticky topbar and main,
      // which broke the inbox's `h-[calc(100vh-60px)]` assumption
      // (only 60px of overhead). Symptom: big blank whitespace
      // below the thread + the composer floating mid-page.
      //   - inbox_thread_scroll_container_fix: inbox root now uses
      //     `h-[calc(100dvh-60px)] min-h-0 overflow-hidden`; the
      //     `<main>` element in the dashboard layout gained
      //     `min-h-0` so flex children can constrain themselves.
      //   - inbox_composer_bottom_anchor: MessageComposer +
      //     TourLifecycleStrip + lead header all gain `shrink-0`;
      //     ConversationThread's scroll area gains `min-h-0
      //     overflow-x-hidden`. Composer is pinned to the bottom
      //     of the inbox column for thread page only (the
      //     composer is a sibling of ConversationThread inside the
      //     same flex column, so it stays in the same flex flow).
      //   - inbox_blank_whitespace_regression_guard: removed
      //     `min-h-[640px]` which forced the inbox taller than
      //     the available viewport on smaller laptops. Layout-only
      //     change; message fetching, manual-channel logic, tour
      //     scheduling, and AI prompt all untouched.
      inbox_thread_scroll_container_fix: 'mounted',
      inbox_composer_bottom_anchor: 'mounted',
      inbox_blank_whitespace_regression_guard: 'mounted',
      // Phase 8BL-Hotfix-3 — dashboard shell viewport lock. The
      // dashboard route group now OWNS the viewport
      // (`h-dvh overflow-hidden`), the content column inside is
      // `h-full min-h-0 flex-col overflow-hidden`, topbar +
      // BillingBanner + DemoModeBanner are `shrink-0` wrappers,
      // and `<main>` is `flex-1 min-h-0 overflow-y-auto`. Non-
      // inbox pages (overview, leads, tours, analytics, settings)
      // scroll INSIDE `<main>` instead of the body — body scroll
      // is eliminated on every dashboard route. Inbox pages claim
      // `h-full overflow-hidden` and own their internal scroll
      // regions (conversation list + thread). No more viewport
      // math (`100dvh - 60px`) inside any page — height inherits
      // from the shell.
      //   - dashboard_shell_viewport_lock: layout claims the
      //     viewport via h-dvh + overflow-hidden.
      //   - inbox_uses_parent_height_not_viewport_calc: inbox
      //     roots are h-full, not h-[calc(100dvh-60px)].
      //   - inbox_body_scroll_eliminated: body never scrolls on
      //     inbox pages; only the message list + conversation
      //     list scroll internally.
      //   - inbox_independent_scroll_regions: ConversationList
      //     gains h-full min-h-0 with internal flex-1 min-h-0
      //     overflow-y-auto so the list scrolls independently of
      //     the thread.
      dashboard_shell_viewport_lock: 'mounted',
      inbox_uses_parent_height_not_viewport_calc: 'mounted',
      inbox_body_scroll_eliminated: 'mounted',
      inbox_independent_scroll_regions: 'mounted',
      // Phase 8BL-Hotfix-4 — ConversationThread phantom height fix.
      // Hotfix-3 made `<main>` `overflow-y-auto` so non-inbox pages
      // could scroll inside main. That introduced a regression in
      // the inbox: `bottomRef.scrollIntoView()` walked the ancestor
      // chain and scrolled `<main>` too. The body scroll scaled with
      // message count because more messages → more distance to
      // scroll → main got scrolled further. Visible symptom: large
      // blank whitespace below the thread on long conversations,
      // none on empty conversations.
      //   - conversation_thread_phantom_height_fix: ConversationThread
      //     restructured into a strict three-layer flex column
      //     (outer flex container → scroll region → padding wrapper).
      //     VariantReplayDrawer moved outside the scroll region.
      //   - conversation_thread_container_scroll: both auto-scroll-
      //     to-bottom and deep-link scroll now call
      //     `scrollContainerRef.current.scrollTo` directly — ancestor
      //     scroll is impossible. Container has `position: relative`
      //     so message-row `offsetTop` math anchors to the container.
      //   - inbox_message_count_no_body_growth: document.body
      //     scrollHeight equals clientHeight on every inbox load
      //     regardless of message count. Only the internal
      //     ConversationThread scroll region grows with message
      //     count. TourLifecycleStrip's second sibling (recent-
      //     activity panel) gained `shrink-0` so it never steals
      //     flex space from the thread.
      conversation_thread_phantom_height_fix: 'mounted',
      conversation_thread_container_scroll: 'mounted',
      inbox_message_count_no_body_growth: 'mounted',
      // GTM-0D — Dashboard buyer clarity pass. Replaced the AIBriefCard
      // "0 packets sent / 0h time returned" zero-state with an
      // ExecutiveHero that leads with "X revenue opportunities need
      // attention today" + 4 honest tiles (zero-value tiles hidden).
      // Added a TodayPriorityCard with numbered "do these first"
      // workflow. Reframed RevenueLeakageBrief as the central revenue
      // thesis. Renamed Recovery / Tour / Reactivation cards to
      // owner-friendly language. Updated Attribution column headers
      // ("Est. inquiry value", "Est. booked value", "Lead → booked").
      // Neutralized the BillingBanner: when the billing gate is off
      // (pilot/demo workspaces), the loud "Start your subscription"
      // CTA collapses to a quiet champagne "Pilot workspace active"
      // pill with no CTA — preserves demo credibility. ADMIN endpoint
      // count unchanged. All link wiring + scanners + audit/rate-limit
      // catalogs unchanged.
      gtm_dashboard_buyer_clarity_pass: 'mounted',
      overview_revenue_command_center: 'mounted',
      today_priority_card: 'mounted',
      demo_billing_banner_neutralized: 'mounted',
      buyer_friendly_metric_copy: 'mounted',
      // GTM-0E — Leads page revenue pipeline clarity pass.
      // Header reframed "Leads" → "Revenue pipeline" with the subtitle
      // "Prioritize overdue replies, hot leads without tours, scheduled
      // visits, and recovery opportunities across every source."
      //   - leads_revenue_pipeline_positioning: PageHeader updated +
      //     KanbanBoard's "X of Y leads shown" line reframed.
      //   - leads_needs_attention_summary: new LeadsPipelineSummary
      //     server component renders "N tracked · N need action ·
      //     $X open pipeline" + 5 action buckets (Reply overdue,
      //     Hot leads idle, No tour booked, Tours to confirm,
      //     Recoverable lost) that deep-link into the existing
      //     leakage filters via /dashboard/leads?leakage=<key>.
      //   - leads_next_action_cards: KanbanCard gains a NextActionPill
      //     pinned to the bottom-left of every card. Tone shifts
      //     by urgency (urgent amber for "Reply now", blue for
      //     forward-motion, green for "Protect relationship",
      //     mute for "Reactivate softly").
      //   - leads_value_framing: card dollar figure relabeled from
      //     "Budget" → "Est. value" / "Est. booked" / "Est. lost"
      //     so the operator reads pipeline impact, not customer
      //     wallet share.
      //   - leads_attention_view: scaffold-only. The 5-bucket
      //     summary deep-links into the existing leakage filters,
      //     which gives operators the "needs attention" experience
      //     without a full parallel Kanban view. A future phase can
      //     promote this to a full bucket-Kanban toggle.
      leads_revenue_pipeline_positioning: 'mounted',
      leads_needs_attention_summary: 'mounted',
      leads_next_action_cards: 'mounted',
      leads_value_framing: 'mounted',
      leads_attention_view: 'scaffold-only',
      // GTM-0F — Tours page revenue protection polish.
      // Header reframed "Tours" → "Tour pipeline" with the subtitle
      // "Confirm upcoming tours, prevent no-shows, and turn completed
      // visits into booked weddings."
      //   - tours_revenue_protection_positioning: PageHeader updated;
      //     calendar gets a small legend underneath; existing 4
      //     status cards reduced to secondary "by-status" reference
      //     numbers with owner-friendly helper copy.
      //   - tour_risk_summary: new TourProtectionSummary server
      //     component renders 5 tiles (Tours to confirm /
      //     Tours this week / Needs follow-up / Upcoming tour value /
      //     No-shows this month) above the calendar. Tiles hide when
      //     their value isn't meaningful — never shows "0" risks.
      //   - completed_tour_followup_queue: new
      //     CompletedTourFollowupList surfaces the previously missing
      //     "toured but not booked yet" workflow. Top 5 most recent
      //     completed tours where the linked lead stage is not booked
      //     and not lost.
      //   - tour_next_action_rows: TourInteractionClient's "Upcoming
      //     Tours" card renamed "Tours needing protection" with
      //     subtitle "Upcoming visits that need confirmation,
      //     reminders, or a clean handoff." Existing per-row actions
      //     (Mark confirmed, Audit, Open lead) preserved.
      //   - tour_value_framing: CompletedTourFollowupList rows show
      //     "Est. value $42k" champagne pill when budget is known.
      //     The protection summary's "Upcoming tour value" tile sums
      //     budgets across upcoming scheduled+confirmed tours.
      // Pure UI/copy polish. No backend route changes, no DB
      // migrations, no AI prompt changes, no autonomous sends, no
      // auto-confirming tours.
      tours_revenue_protection_positioning: 'mounted',
      tour_risk_summary: 'mounted',
      completed_tour_followup_queue: 'mounted',
      tour_next_action_rows: 'mounted',
      tour_value_framing: 'mounted',
      // GTM-0G — Analytics page revenue intelligence polish.
      // Header reframed "Analytics" → "Revenue intelligence" with the
      // subtitle "See which sources create booked weddings and where
      // revenue leaks from the funnel." KPI cards rebuilt around
      // revenue-owner metrics (New inquiries 30d / Tours completed /
      // Booked weddings / Lead → booked / Open pipeline / Est. booked
      // value). Internal metrics (Avg score / AI latency) removed from
      // the headline row.
      //   - analytics_revenue_intelligence_positioning: PageHeader
      //     updated; section titles + column headers reworded across
      //     attribution / booked revenue / source leakage cards.
      //   - analytics_key_insight_card: new champagne-accented hero
      //     card surfaces a deterministic one-line insight from the
      //     leakage + attribution helpers ("Website created the most
      //     pipeline, but Meta Ads has 19 at-risk leads — prioritize
      //     follow-up recovery there first."). No model call, no fake
      //     certainty — sparse data falls back to a safe "connect
      //     more inquiries to unlock source intelligence" line.
      //   - analytics_source_leakage_priority: source-leakage table
      //     gets a "Recover leads" champagne CTA in the right column
      //     to surface it as the central VenueRise thesis surface.
      //   - analytics_buyer_friendly_kpis: KPI tiles drop internal
      //     metrics; money tiles render an honest "Estimated from
      //     couple budgets" / "From booked leads with entered
      //     budgets" helper line.
      //   - analytics_funnel_dropoff_insight: deterministic biggest-
      //     drop computation under the funnel chart ("Tour Scheduled
      //     → Tour Completed loses 42% of the pipeline. Confirmation
      //     reminders matter here."). Hides on sparse venues with a
      //     "More data is needed" fallback. Inquiry-volume chart
      //     gets a peak-day annotation. AI Performance Insight card
      //     copy fixed (the wrong "tips and repeat work" line is gone;
      //     the vague Run Analysis button is replaced with a deep-link
      //     into the slow-first-reply filter).
      // No backend route changes, no DB migrations, no AI prompt
      // changes, no autonomous sends. Attribution disclaimers
      // preserved verbatim ("not ROAS — ad spend is not connected").
      analytics_revenue_intelligence_positioning: 'mounted',
      analytics_key_insight_card: 'mounted',
      analytics_source_leakage_priority: 'mounted',
      analytics_buyer_friendly_kpis: 'mounted',
      analytics_funnel_dropoff_insight: 'mounted',
      // GTM-0H — Settings page workspace control center polish.
      // Header reframed "Settings" → "Workspace settings" with a
      // champagne explanation card teaching that each tab maps to a
      // real revenue surface.
      //   - settings_workspace_control_center: PageHeader updated +
      //     champagne explanation card mounted above the tabs.
      //   - settings_ai_behavior_preview: AI Config tab gains a
      //     dynamic "How your AI will behave" preview that renders
      //     the owner's persona + tone choices in a one-sentence
      //     summary, plus an AI reply rules block listing the
      //     orchestrator's actual guardrails (no autonomous send,
      //     no final pricing without KB support, etc).
      //   - settings_knowledge_base_empty_state: KB empty state
      //     reframed as "your AI does not have venue knowledge yet"
      //     with 5 example first-entry prompts so the operator has a
      //     starting point. No fake entries seeded.
      //   - settings_ai_tour_availability_copy: Availability tab
      //     reframed as "AI tour availability" with explanation card
      //     ("when a couple asks 'what times are available?'...") +
      //     active days / blackout count summary derived from
      //     existing data. Blackout copy says "block holidays,
      //     private events, or unavailable days."
      //   - settings_role_guide: Team page gains a role guide card
      //     above the Members table (Owner / Admin / Coordinator /
      //     Viewer one-line definitions). Members subtitle grammar
      //     fixed: "1 person has access" vs "N people have access."
      // Billing card relabeled "Billing & plans" + Stripe honesty
      // line. UI/copy only — no backend routes, no RBAC changes,
      // no Stripe pricing changes, no migrations.
      settings_workspace_control_center: 'mounted',
      settings_ai_behavior_preview: 'mounted',
      settings_knowledge_base_empty_state: 'mounted',
      settings_ai_tour_availability_copy: 'mounted',
      settings_role_guide: 'mounted',
      // GTM-0I — Real-time AI activity ticker on /dashboard.
      // Server-renders the latest 8 ai_actions rows; the client
      // component subscribes to postgres_changes for live INSERTs.
      // Sits between ExecutiveHero and TodayPriorityCard.
      //   - overview_ai_activity_ticker: AIActivityTicker mounted
      //     on the Overview page with initialActions hydrated
      //     server-side.
      //   - ai_actions_realtime_feed: client subscribes to
      //     `ai_actions:venue:<id>` filtered by venue_id.
      //     RLS-scoped — only rows the user can SELECT come
      //     through Realtime.
      //   - ai_activity_buyer_friendly_copy: describeAction maps
      //     internal action strings (handle_new_lead, instant_lead
      //     _response.generated, draft_regenerate, etc) into safe
      //     buyer copy ("Drafted an instant reply for Sarah",
      //     "Qualified a new website inquiry", "Suggested tour
      //     times for a lead"). Never claims sent/booked/recovered
      //     when the underlying record doesn't prove it.
      //   - overview_live_ai_work_surface: visual "Live" dot in
      //     the header — solid emerald when the Realtime channel
      //     reports SUBSCRIBED, mutes to slate on close/error.
      //     Cosmetic; no fallback polling.
      // No new tables, no new API routes, no backend activity
      // endpoint. Uses existing ai_actions writes from the
      // orchestrator + qualifier + draft routes.
      overview_ai_activity_ticker: 'mounted',
      ai_actions_realtime_feed: 'mounted',
      ai_activity_buyer_friendly_copy: 'mounted',
      overview_live_ai_work_surface: 'mounted',
      // P0 — Inbox sender-role fix. Composer was POSTing to
      // /api/ai/chat regardless of mode, which routed every typed
      // message through handleIncomingMessage — saving operator
      // text as role:'lead' AND triggering an AI reply as if the
      // lead had spoken. Two bugs in one. Fixed:
      //   - inbox_operator_message_role_fix: composer 'you' mode
      //     now POSTs /api/conversations/[id]/messages with
      //     sender_type:'operator', metadata.source:
      //     'operator_composer'. Inserts role:'human'. No AI
      //     auto-response.
      //   - inbox_human_messages_render_right: confirmed
      //     ConversationThread renders role:'human' on the right
      //     (groups with role:'ai' as `isAI = role === 'ai' ||
      //     role === 'human'`). No render change needed once the
      //     send path was fixed.
      //   - inbox_ai_trigger_lead_only_guard: handleIncomingMessage
      //     gained a doc-block INVARIANT clarifying the function
      //     only processes inbound lead messages. /api/ai/chat
      //     gained a "do NOT call from operator composer" warning.
      //     handleIncomingMessage's existing semantics (inserts
      //     role:'lead' by definition) ARE the guard — the broken
      //     caller is now fixed.
      //   - inbox_composer_mode_semantics: 'ai' mode now actually
      //     does something. Generates an AI draft via /api/ai/draft
      //     (regenerate path) using the operator's typed text as
      //     the seed. Surfaces the draft inline with "Use this
      //     draft" / "Dismiss" controls. Never auto-sends; never
      //     saves operator text as 'lead'.
      // No DB schema changes. No new routes. No AI prompt changes.
      // /api/ai/chat semantics unchanged for legitimate inbound
      // lead-message callers (widget, channel webhooks).
      inbox_operator_message_role_fix: 'mounted',
      inbox_human_messages_render_right: 'mounted',
      inbox_ai_trigger_lead_only_guard: 'mounted',
      inbox_composer_mode_semantics: 'mounted',
      // Phase 8BM — Reply channel awareness + composer delivery
      // method bar. UI/labeling-only phase — no new external
      // delivery integrations.
      //   - inbox_reply_method_bar: compact pill row above the
      //     composer textarea. Source channel badge + reply
      //     method + delivery-mode pill + helper line. Wired into
      //     MessageComposer via a new optional `replyMethod` prop;
      //     server-resolved in the inbox thread page.
      //   - inbox_reply_channel_awareness: pure resolver in
      //     lib/integrations/channels/reply-method.ts. Maps
      //     (channelType, leadEmail, leadPhone, capabilities) into
      //     { method, methodLabel, destinationLabel, deliveryMode,
      //     warning, helperText, switchOptions }. Honors the
      //     existing CHANNEL_CAPABILITIES matrix — only flips to
      //     'direct' when external sending is genuinely wired.
      //   - inbox_manual_delivery_labeling: every non-website
      //     channel resolves to `'manual'` or `'internal_only'`
      //     today. Helper copy says exactly what the operator
      //     needs to do ("Copy this response into The Knot",
      //     "SMS on file — direct sending is not connected",
      //     "Saved in VenueRise only").
      //   - inbox_reply_method_metadata: operator messages POSTed
      //     via the composer now stamp reply_method,
      //     reply_delivery_mode, channel_type, and
      //     reply_destination into messages.metadata. The
      //     /api/conversations/[id]/messages allowlist accepts
      //     those keys via the ApproveMetadataSchema extension.
      //     Records operator INTENT — never claims external
      //     delivery.
      // No DB schema changes. No new routes. No AI prompt
      // changes. /api/ai/chat semantics unchanged.
      inbox_reply_method_bar: 'mounted',
      inbox_reply_channel_awareness: 'mounted',
      inbox_manual_delivery_labeling: 'mounted',
      inbox_reply_method_metadata: 'mounted',
      // Phase 8BN — Real outbound email delivery for the
      // operator composer. Reuses the existing
      // lib/integrations/email.ts (`sendEmail`) Resend helper
      // under a new wrapper at lib/integrations/delivery/email.ts
      // gated by OUTBOUND_EMAIL_DELIVERY_ENABLED.
      //   - outbound_email_delivery: reports `'mounted'` when the
      //     kill switch is on AND Resend is fully configured;
      //     `'disabled'` otherwise. When disabled the resolver
      //     keeps email-bearing leads on `internal_only` and the
      //     composer pill shows "Saved in VenueRise only".
      //   - outbound_email_reply_method_direct: resolver flips
      //     email-bearing conversations to `deliveryMode: 'direct'`
      //     when isOutboundEmailConfigured() returns true.
      //   - outbound_email_delivery_status_pills: ConversationThread
      //     renders DeliveryStatusPill on `role:'human'` messages
      //     (Sent via Email / Sending… / Email failed / Saved in
      //     VenueRise / Manual reply required).
      //   - outbound_email_failure_honesty: provider failures save
      //     the operator's message with `delivery_status:'failed'`
      //     and a safe error; we never claim "Sent via Email"
      //     unless Resend accepted the message and returned an id.
      outbound_email_delivery: isOutboundEmailConfigured()
        ? 'mounted'
        : 'disabled',
      outbound_email_reply_method_direct: 'mounted',
      outbound_email_delivery_status_pills: 'mounted',
      outbound_email_failure_honesty: 'mounted',
      // Phase 8BO — Inbound email reply capture. Provider-
      // agnostic HMAC-authenticated webhook at /api/inbound/email
      // (see docs/INBOUND-EMAIL-CAPTURE.md). Closes the email
      // loop opened in 8BN: lead replies land back in the
      // conversation thread as `role:'lead'` instead of falling
      // into the configured Reply-To inbox.
      //   - inbound_email_capture: 'mounted' when both
      //     INBOUND_EMAIL_ENABLED is on AND
      //     INBOUND_EMAIL_WEBHOOK_SECRET is set; 'disabled'
      //     otherwise. Disabled state returns 503 to the
      //     provider so misconfiguration is loud, not silent.
      //   - inbound_email_header_matching: high-confidence match
      //     via In-Reply-To / References → outbound_messages
      //     .provider_message_id. Confidence 95.
      //   - inbound_email_recent_recipient_fallback: medium-
      //     confidence match via "From address received an
      //     outbound from us in the last 30 days". Confidence 70.
      //   - inbound_email_no_auto_ai_trigger: captured replies
      //     do NOT auto-fire the AI orchestrator. The operator
      //     must respond manually. (Revisit in 8BP.)
      inbound_email_capture:
        process.env.INBOUND_EMAIL_ENABLED &&
        !['', '0', 'false', 'no', 'off'].includes(
          (process.env.INBOUND_EMAIL_ENABLED ?? '').trim().toLowerCase()
        ) &&
        !!process.env.INBOUND_EMAIL_WEBHOOK_SECRET
          ? 'mounted'
          : 'disabled',
      inbound_email_header_matching: 'mounted',
      inbound_email_recent_recipient_fallback: 'mounted',
      inbound_email_no_auto_ai_trigger: 'mounted',
      // Phase 8BP — Email delivery status + retry polish. See
      // docs/EMAIL-DELIVERY-STATUS-AND-RETRY.md.
      //   - email_delivery_status_lifecycle: canonical status
      //     model in lib/integrations/delivery/email-status.ts
      //     (pending → accepted → delivered, or bounced /
      //     complained / failed / skipped / manual_fallback).
      //   - email_delivery_webhook_message_patch: Resend webhook
      //     now patches messages.metadata on composer sends
      //     (related_table='messages'), not just outbound_messages
      //     .status. Digest / tour-notification rows still flow
      //     to outbound_messages only.
      //   - email_delivery_retry: POST /api/messages/[id]/retry-email
      //     re-attempts delivery against the same recipient
      //     without creating a duplicate bubble.
      //   - email_delivery_manual_fallback: POST /api/messages/[id]
      //     /mark-fallback flips delivery_status to
      //     'manual_fallback' for failed/bounced/skipped
      //     composer sends.
      //   - email_delivery_honest_accepted_vs_delivered: the
      //     UI says "Accepted by Email" for provider-accepted
      //     sends and only escalates to "Delivered" after the
      //     `email.delivered` webhook fires.
      email_delivery_status_lifecycle: 'mounted',
      email_delivery_webhook_message_patch: 'mounted',
      email_delivery_retry: 'mounted',
      email_delivery_manual_fallback: 'mounted',
      email_delivery_honest_accepted_vs_delivered: 'mounted',
      // Phase 8BQ — Unmatched inbound email queue. Migration 040
      // creates inbound_email_orphans. The 8BO webhook now
      // persists orphan replies via createInboundEmailOrphan
      // instead of silently dropping them. Three routes expose
      // the queue:
      //   - GET  /api/inbound-email-orphans
      //   - POST /api/inbound-email-orphans/[id]/link
      //   - POST /api/inbound-email-orphans/[id]/dismiss
      // UnmatchedEmailQueueCard mounts on the inbox index page
      // and is hidden when unresolved_count is 0.
      //
      // Strict no-AI guard: linking inserts as role:'lead' but
      // does NOT trigger the orchestrator. Operators must
      // manually compose any response.
      //
      // See docs/UNMATCHED-INBOUND-EMAIL-QUEUE.md.
      inbound_email_orphan_queue: 'mounted',
      inbound_email_orphan_persistence: 'mounted',
      inbound_email_orphan_linking: 'mounted',
      inbound_email_orphan_dismissal: 'mounted',
      inbound_email_orphan_no_ai_guard: 'mounted',
      // Phase 8BR-alt — orphan conversation picker. Makes the
      // 8BQ queue operationally complete: even when no
      // suggestion was pre-computed, the operator can search
      // the inbox's already-loaded conversation list and link
      // the orphan to the correct conversation. No new API
      // route — local filter over the conversations the inbox
      // server page already loaded (search flag reflects that
      // as `'client_local'`).
      //
      //   - inbound_email_orphan_picker: UnmatchedEmailQueueCard
      //     now renders a search input + result list per orphan
      //     row with progressive disclosure.
      //   - inbound_email_orphan_search: 'client_local' —
      //     filtering happens in-browser over the
      //     venueConversations prop. No new search API surface.
      //   - inbound_email_orphan_manual_linking: operator can
      //     pick any conversation in the venue and POST it to
      //     the existing /api/inbound-email-orphans/[id]/link
      //     route; server re-validates ownership.
      //   - inbound_email_orphan_picker_no_ai_guard: linking
      //     from the picker still inserts as role:'lead' only;
      //     no AI orchestrator call, identical to 8BQ behavior.
      inbound_email_orphan_picker: 'mounted',
      inbound_email_orphan_search: 'client_local',
      inbound_email_orphan_manual_linking: 'mounted',
      inbound_email_orphan_picker_no_ai_guard: 'mounted',
      // Phase 8BR — Outbound SMS delivery (Twilio). Mirrors the
      // 8BN email pipeline. See docs/OUTBOUND-SMS-DELIVERY.md.
      //   - outbound_sms_delivery: 'mounted' when the kill
      //     switch is on AND Twilio SID/token/from are set;
      //     'disabled' otherwise. Disabled keeps the composer
      //     pill on "Saved in VenueRise only" for phone-bearing
      //     leads.
      //   - outbound_sms_reply_method_direct: resolver flips
      //     phone-bearing conversations to delivery_mode='direct'
      //     when isOutboundSmsConfigured() is true.
      //   - outbound_sms_delivery_status_pills: DeliveryStatusPill
      //     now reads the SMS dictionary
      //     (sms-status.ts) when reply_method='sms'. Shows
      //     "Accepted by SMS" / "SMS sent" / "SMS failed" / etc.
      //   - outbound_sms_failure_honesty: provider failures save
      //     the operator's message with delivery_status='failed'
      //     and a safe error code; we never claim "SMS sent"
      //     unless Twilio returned a 2xx + Message SID.
      //   - outbound_sms_no_ai_autosend_guard: SMS sends only
      //     fire from an explicit operator click in the composer.
      //     AI mode generates drafts only; the orchestrator
      //     never calls sendOutboundSms.
      outbound_sms_delivery: isOutboundSmsConfigured()
        ? 'mounted'
        : 'disabled',
      outbound_sms_reply_method_direct: 'mounted',
      outbound_sms_delivery_status_pills: 'mounted',
      outbound_sms_failure_honesty: 'mounted',
      outbound_sms_no_ai_autosend_guard: 'mounted',
      // Phase 8BS — Inbound SMS capture (Twilio). Webhook at
      // /api/inbound/sms with Twilio HMAC-SHA1 signature
      // verification. Lead replies to OUTBOUND_SMS_FROM get
      // matched (recent outbound SMS or lead phone) and
      // inserted as role:'lead'. NO AI auto-fire. NO orphan
      // queue this phase. See docs/INBOUND-SMS-CAPTURE.md.
      //   - inbound_sms_capture: 'mounted' when
      //     INBOUND_SMS_ENABLED=1 AND TWILIO_AUTH_TOKEN is set.
      //   - inbound_sms_twilio_signature_verification: HMAC-SHA1
      //     over the public URL + sorted POST params, dev-only
      //     bypass gated by INBOUND_SMS_DEV_BYPASS_TOKEN.
      //   - inbound_sms_reply_matching: 90-day outbound-SMS
      //     match (HIGH) → lead-phone single-conversation
      //     (MEDIUM) → ignore low/none.
      //   - inbound_sms_dedupe: provider_message_id (Twilio
      //     MessageSid) on messages.metadata.
      //   - inbound_sms_no_ai_guard: captured rows never
      //     trigger the AI orchestrator.
      inbound_sms_capture: isInboundSmsEnabled() ? 'mounted' : 'disabled',
      inbound_sms_twilio_signature_verification: 'mounted',
      inbound_sms_reply_matching: 'mounted',
      inbound_sms_dedupe: 'mounted',
      inbound_sms_no_ai_guard: 'mounted',
      // Phase 8BT — SMS orphan queue. Reuses the email orphan
      // table via the migration-041 `channel` column. Webhook
      // persists no/low-match inbound SMS as orphans; existing
      // /api/inbound-email-orphans routes serve both channels
      // (channel filter optional). UI labels render
      // channel-aware (Mail vs MessageSquare). See
      // docs/SMS-ORPHAN-QUEUE.md.
      //   - inbound_sms_orphan_queue: shared with email queue;
      //     UnmatchedEmailQueueCard renders both.
      //   - inbound_sms_orphan_persistence: webhook switches
      //     from "ignore" to "persist orphan" when match
      //     is none / low / needsReview.
      //   - inbound_sms_orphan_linking: link route branches on
      //     orphan.channel — SMS orphans insert role:'lead'
      //     with channel_type:'sms' metadata.
      //   - inbound_sms_orphan_dismissal: dismiss route works
      //     for both channels; audit row carries `channel`.
      //   - inbound_sms_orphan_no_ai_guard: NEVER triggers AI
      //     on persist, link, or dismiss.
      //   - unmatched_replies_queue_multichannel: the queue UI
      //     surfaces email + SMS together as one operator
      //     surface.
      inbound_sms_orphan_queue: 'mounted',
      inbound_sms_orphan_persistence: 'mounted',
      inbound_sms_orphan_linking: 'mounted',
      inbound_sms_orphan_dismissal: 'mounted',
      inbound_sms_orphan_no_ai_guard: 'mounted',
      unmatched_replies_queue_multichannel: 'mounted',
      // Phase 8BU — SMS delivery callback + retry. Closes the
      // last outbound-SMS gap from 8BR.
      //   - sms_delivery_status_callback: 'mounted' when
      //     TWILIO_SMS_STATUS_CALLBACK_ENABLED=1 + auth token
      //     present. When 'disabled', sends omit the
      //     StatusCallback param and the bubble pill never
      //     escalates past "Accepted by SMS"/"SMS sent".
      //   - sms_delivery_status_signature_verification:
      //     callback route reuses the inbound-SMS HMAC-SHA1
      //     verifier (8BS).
      //   - sms_delivery_status_message_patch: callback patches
      //     messages.metadata by MessageSid + reply_method='sms'
      //     + delivery_provider='twilio'. Honors
      //     shouldOverwriteSmsStatus so late events can't
      //     downgrade delivered → sent.
      //   - sms_delivery_retry: POST /api/messages/[id]/retry-sms
      //     re-attempts via sendOutboundSms without creating a
      //     duplicate bubble. 5-retry cap; rate-limited
      //     per-user-per-message.
      //   - sms_delivery_retry_ui: DeliveryStatusPill now
      //     surfaces the Retry button for SMS failed /
      //     undelivered / skipped (was: email-only).
      //   - sms_delivery_honest_sent_vs_delivered: pill says
      //     "Accepted by SMS" / "SMS sent" until the callback
      //     fires `delivered`; never claims Delivered without
      //     provider confirmation.
      //   - sms_delivery_no_ai_autosend_guard: SMS retries +
      //     callback patches never trigger AI.
      sms_delivery_status_callback:
        process.env.TWILIO_SMS_STATUS_CALLBACK_ENABLED &&
        !['', '0', 'false', 'no', 'off'].includes(
          (process.env.TWILIO_SMS_STATUS_CALLBACK_ENABLED ?? '').trim().toLowerCase()
        ) &&
        !!process.env.TWILIO_AUTH_TOKEN
          ? 'mounted'
          : 'disabled',
      sms_delivery_status_signature_verification: 'mounted',
      sms_delivery_status_message_patch: 'mounted',
      sms_delivery_retry: 'mounted',
      sms_delivery_retry_ui: 'mounted',
      sms_delivery_honest_sent_vs_delivered: 'mounted',
      sms_delivery_no_ai_autosend_guard: 'mounted',
      // ── Phase 8BV — Reply Method Switching UI ─────────────────
      // The composer now hosts a Radix DropdownMenu that lets the
      // operator pick between any reply-method option the
      // resolver returned (commonly Email vs SMS for leads with
      // both contact methods). Pure UI / state wiring — no new
      // backend routes, no new DB tables, no env vars.
      //
      //   - reply_method_switching_ui: ReplyMethodBar renders a
      //     dropdown when switchOptions.length > 1; falls back
      //     to the static 8BM bar otherwise. Per-conversation
      //     session state — resets on conversation navigation.
      //   - reply_method_switching_email_sms: leads with both
      //     email + phone surface a clean Email/SMS picker;
      //     selecting flips both the bar's delivery-mode pill
      //     and the outgoing message metadata immediately.
      //   - reply_method_switching_metadata_integrity: the
      //     composer stamps reply_method / reply_delivery_mode /
      //     reply_destination / channel_type from the SELECTED
      //     option (not the resolver's default) on every send.
      //     The server route still re-verifies whether the
      //     chosen channel is actually wired before any external
      //     send (downgrades to internal_only honestly when not).
      //   - reply_method_switching_ai_context: /api/ai/draft now
      //     accepts an optional reply_method hint. When the
      //     operator switched to SMS, the system prompt enforces
      //     1–2 sentence, plain-text drafts; email keeps its
      //     normal 2–4 sentence shape. No safety changes; no
      //     auto-send.
      //   - reply_method_switching_no_ai_autosend_guard: AI
      //     drafts remain draft-only; switching to SMS does NOT
      //     fire an automatic SMS reply. Operator still clicks
      //     Send.
      reply_method_switching_ui: 'mounted',
      reply_method_switching_email_sms: 'mounted',
      reply_method_switching_metadata_integrity: 'mounted',
      reply_method_switching_ai_context: 'mounted',
      reply_method_switching_no_ai_autosend_guard: 'mounted',
      // ── Phase 8BW — Inbox Demo Polish + Operator Workflow QA ─
      // Pure UI / copy / docs phase. No new API routes, no DB
      // changes, no new env vars. Focused on demo-readiness and
      // operator clarity now that email + SMS are both two-way.
      //
      //   - inbox_demo_polish: rolling marker that this polish
      //     phase shipped. Bump if a later phase rebuilds
      //     anything covered by the operator QA doc.
      //   - inbox_empty_states: inbox index now branches between
      //     "no conversations yet" (true empty venue) and "select
      //     a conversation" (active venue). Per-lead empty
      //     conversation shows a channel-neutral "no messages
      //     yet" card instead of the prior AI-auto-initiate
      //     promise.
      //   - inbox_delivery_pill_qa: Retry button title + ARIA
      //     label are channel-aware ("Retry SMS delivery" for
      //     SMS rows). Accepted / Sent / Delivered helper copy
      //     polished to spec wording; "Delivered" never claimed
      //     before the provider event fires.
      //   - inbox_reply_method_switcher_qa: ReplyMethodBar
      //     dropdown trigger + items now carry channel icons
      //     (Mail / MessageSquare / Instagram / Facebook / etc.)
      //     for at-a-glance recognition.
      //   - inbox_ai_draft_honesty: composer footer copy is now
      //     mode + method aware. "You + email direct" says "sent
      //     via email"; "You + SMS direct" says "sent via SMS";
      //     internal/manual says "saved in VenueRise only"; AI
      //     mode always says drafts are not auto-sent.
      //   - inbox_unmatched_replies_polish: queue card footer is
      //     channel-neutral; expanded-empty state surfaces
      //     "no unmatched replies"; channel-aware row rendering
      //     (Mail vs MessageSquare) preserved.
      //   - inbox_manual_channel_workflow_qa: stale "autonomous
      //     sending is disabled platform-wide" footer line on
      //     ManualChannelReplyBanner replaced with accurate copy
      //     that points to the email/SMS escape hatch.
      //   - inbox_operator_workflow_qa_doc: docs/INBOX-OPERATOR-
      //     WORKFLOW-QA.md consolidates the entire operator
      //     surface for pilot QA + demo presenters.
      inbox_demo_polish: 'mounted',
      inbox_empty_states: 'mounted',
      inbox_delivery_pill_qa: 'mounted',
      inbox_reply_method_switcher_qa: 'mounted',
      inbox_ai_draft_honesty: 'mounted',
      inbox_unmatched_replies_polish: 'mounted',
      inbox_manual_channel_workflow_qa: 'mounted',
      inbox_operator_workflow_qa_doc: 'mounted',
    },
    uptime_ms: Date.now() - startedAt,
    ts: new Date().toISOString(),
  }

  const response = NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
  return withRequestIdHeader(response, requestId)
}
