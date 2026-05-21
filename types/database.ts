export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type LeadStage =
  | 'new_inquiry'
  | 'qualified'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'negotiation'
  | 'booked'
  | 'lost'

export type TourStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export type MessageRole = 'lead' | 'ai' | 'human' | 'system'
export type Sentiment = 'positive' | 'neutral' | 'negative' | 'urgent'
export type Urgency = 'low' | 'medium' | 'high' | 'critical'

export interface Database {
  public: {
    Tables: {
      venues: {
        Row: {
          id: string
          owner_user_id: string
          name: string
          description: string | null
          capacity_min: number | null
          capacity_max: number | null
          base_price: number | null
          price_per_guest: number | null
          style_tags: string[]
          amenities: string[]
          timezone: string
          ai_persona_name: string
          ai_tone: string
          response_time_target: number
          is_active: boolean
          created_at: string
          updated_at: string
          // Phase 8AQ — Revenue OS settings live here (migration 023).
          // Defaults to '{}'::jsonb at the DB level so existing rows
          // don't need a backfill; readers go through
          // lib/revenue-os/settings.ts which clamps + falls back to
          // DEFAULT_REVENUE_OS_SETTINGS when missing/malformed.
          metadata: Json
        }
        Insert: Omit<Database['public']['Tables']['venues']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['venues']['Insert']>
      }
      leads: {
        Row: {
          id: string
          venue_id: string
          name: string
          email: string
          phone: string | null
          stage: LeadStage
          lead_score: number
          urgency: Urgency
          event_date: string | null
          guest_count: number | null
          budget: number | null
          source: string
          ai_active: boolean
          notes: string | null
          // Phase 8BD — opaque per-lead jsonb. The known sub-key
          // today is `metadata.lost_reason` (see
          // `lib/revenue-os/reactivation.ts`). Future phases may
          // add other namespaces under the same column.
          metadata: Json
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['leads']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['leads']['Insert']>
      }
      conversations: {
        Row: {
          id: string
          lead_id: string
          venue_id: string
          sentiment: Sentiment
          unread_count: number
          last_message_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['conversations']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['conversations']['Insert']>
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          lead_id: string
          venue_id: string
          role: MessageRole
          content: string
          metadata: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['messages']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['messages']['Insert']>
      }
      tours: {
        Row: {
          id: string
          lead_id: string
          venue_id: string
          scheduled_at: string
          duration_minutes: number
          status: TourStatus
          location_notes: string | null
          reminder_24h_sent: boolean
          reminder_2h_sent: boolean
          outcome: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['tours']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['tours']['Insert']>
      }
      follow_up_schedules: {
        Row: {
          id: string
          lead_id: string
          venue_id: string
          touch_number: number
          scheduled_at: string
          sent_at: string | null
          status: 'pending' | 'sent' | 'cancelled'
          subject: string | null
          body: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['follow_up_schedules']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['follow_up_schedules']['Insert']>
      }
      ai_actions: {
        Row: {
          id: string
          venue_id: string
          lead_id: string | null
          agent: string
          action: string
          input_summary: string | null
          output_summary: string | null
          latency_ms: number | null
          tokens_used: number | null
          success: boolean
          error_message: string | null
          created_at: string
          // Phase 8AJ — operator rejection markers (migration 020).
          // Nullable; populated by PATCH /api/ai/actions/[id]/reject
          // from the LeadDetailDrawer Reject button.
          rejected_at: string | null
          rejected_by: string | null
          // Phase 8AM — variant memory (migration 021). Defaults to
          // '{}'::jsonb at the DB level so existing rows don't need a
          // backfill. /api/ai/draft writes
          // { variant_count, variants_offered[], selected_by_default,
          //   instruction } here on successful regeneration.
          metadata: Json
        }
        Insert: Omit<Database['public']['Tables']['ai_actions']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['ai_actions']['Insert']>
      }
      knowledge_base: {
        Row: {
          id: string
          venue_id: string
          category: string
          title: string
          content: string
          priority: number
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['knowledge_base']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['knowledge_base']['Insert']>
      }
      audit_leads: {
        Row: {
          id: string
          name: string
          venue_name: string
          email: string
          website: string | null
          monthly_inquiry_volume: string | null
          source: string | null
          created_at: string
        }
        Insert: {
          name: string
          venue_name: string
          email: string
          website?: string | null
          monthly_inquiry_volume?: string | null
          source?: string | null
        }
        Update: {
          name?: string
          venue_name?: string
          email?: string
          website?: string | null
          monthly_inquiry_volume?: string | null
          source?: string | null
        }
      }
      tour_availability: {
        Row: {
          id: string
          venue_id: string
          day_of_week: number
          start_time: string
          end_time: string
          is_active: boolean
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['tour_availability']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['tour_availability']['Insert']>
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: {
      lead_stage: LeadStage
      tour_status: TourStatus
      message_role: MessageRole
      sentiment: Sentiment
      urgency: Urgency
    }
  }
}
