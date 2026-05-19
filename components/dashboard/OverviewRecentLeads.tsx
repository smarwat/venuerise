'use client'

import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardSubtitle, CardContent } from './ui/Card'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import LeadDetailDrawer from './leads/LeadDetailDrawer'
import type { Database } from '@/types/database'

type Lead = Database['public']['Tables']['leads']['Row']

/**
 * Phase 8AH — clickable Overview "Recent leads" table.
 *
 * Owns the LeadDetailDrawer so a row click opens the same premium
 * drawer the Kanban board uses. Receives the server-fetched lead
 * rows as `initialLeads`; updates from the drawer (stage flip /
 * delete) re-render in place via local state.
 */

interface OverviewRecentLeadsProps {
  initialLeads: Lead[]
}

function scoreBadge(score: number) {
  if (score >= 80) return 'score_high' as const
  if (score >= 60) return 'score_mid' as const
  if (score >= 40) return 'score_low' as const
  return 'score_poor' as const
}

const STAGE_LABELS: Record<string, string> = {
  new_inquiry: 'New', qualified: 'Qualified', tour_scheduled: 'Tour Scheduled',
  tour_completed: 'Tour Done', negotiation: 'Negotiation', booked: 'Booked', lost: 'Lost',
}

export default function OverviewRecentLeads({ initialLeads }: OverviewRecentLeadsProps) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads)
  const [selected, setSelected] = useState<Lead | null>(null)

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Recent leads</CardTitle>
          <CardSubtitle>Latest inquiries across all sources</CardSubtitle>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/dashboard/leads">
            View all
            <ArrowRight className="w-3 h-3 ml-1" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {leads.length === 0 ? (
          <p className="text-sm text-[#475569] text-center py-8">No leads yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[11px] font-semibold text-[#94A3B8] uppercase tracking-wider">
                  <th className="text-left py-2.5 pl-2">Lead</th>
                  <th className="text-left py-2.5">Email</th>
                  <th className="text-left py-2.5">Guests</th>
                  <th className="text-left py-2.5">Score</th>
                  <th className="text-left py-2.5">Stage</th>
                  <th className="text-right py-2.5 pr-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => setSelected(lead)}
                    className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors cursor-pointer"
                    title={`Open ${lead.name}`}
                  >
                    <td className="py-3 pl-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1E293B] to-[#0F172A] flex items-center justify-center text-white text-[11px] font-bold">
                          {lead.name.charAt(0)}
                        </div>
                        <span className="text-sm font-medium text-[#0F172A]">{lead.name}</span>
                      </div>
                    </td>
                    <td className="py-3 text-sm text-[#475569]">{lead.email}</td>
                    <td className="py-3 text-sm text-[#475569]">{lead.guest_count ?? '—'}</td>
                    <td className="py-3">
                      <Badge variant={scoreBadge(lead.lead_score)}>{lead.lead_score}</Badge>
                    </td>
                    <td className="py-3">
                      <Badge variant={`stage_${lead.stage}` as Parameters<typeof Badge>[0]['variant']}>
                        {STAGE_LABELS[lead.stage] ?? lead.stage}
                      </Badge>
                    </td>
                    <td className="py-3 pr-2 text-right text-xs text-[#94A3B8]">
                      {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <LeadDetailDrawer
        lead={selected}
        onClose={() => setSelected(null)}
        onUpdate={(updated) => {
          setLeads((prev) => prev.map((l) => (l.id === updated.id ? updated : l)))
          setSelected(updated)
        }}
        onDelete={(leadId) => {
          setLeads((prev) => prev.filter((l) => l.id !== leadId))
        }}
      />
    </Card>
  )
}
