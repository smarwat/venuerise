'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'

interface Message {
  id: string
  role: 'lead' | 'ai' | 'human' | 'system'
  content: string
  created_at: string
  metadata?: { tokens_used?: number; latency_ms?: number } | null
}

interface Props {
  conversationId: string
  initialMessages: Message[]
  leadName: string
}

export default function ConversationThread({ conversationId, initialMessages, leadName }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === (payload.new as Message).id)) return prev
          return [...prev, payload.new as Message]
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [conversationId])

  const grouped: { timestamp: string; messages: Message[] }[] = []
  let lastBucket = ''
  messages.forEach((m) => {
    const bucket = format(new Date(m.created_at), 'MMM d, yyyy, h:mm a')
    if (bucket !== lastBucket) {
      grouped.push({ timestamp: bucket, messages: [m] })
      lastBucket = bucket
    } else {
      grouped[grouped.length - 1].messages.push(m)
    }
  })

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
      {messages.length === 0 && (
        <div className="text-center py-16">
          <p className="text-[13px] text-[#64748B]">No messages yet. The AI will reply once the lead sends something.</p>
        </div>
      )}

      {grouped.map((group, gi) => (
        <div key={gi} className="space-y-2">
          <p className="text-[11px] text-[#94A3B8] text-center font-medium">{group.timestamp}</p>
          {group.messages.map((msg) => {
            const isLead = msg.role === 'lead'
            const isAI = msg.role === 'ai' || msg.role === 'human'
            const isSystem = msg.role === 'system'

            if (isSystem) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="bg-[#F8FAFC] border border-[#E6E8EF] rounded-full px-3 py-1 text-[11px] text-[#64748B]">
                    {msg.content}
                  </div>
                </div>
              )
            }

            return (
              <div key={msg.id} className={cn('flex', isAI && 'justify-end')}>
                <div className={cn(
                  'max-w-[68%] rounded-[18px] px-4 py-2.5 text-[13px] leading-relaxed',
                  isLead && 'bg-white border border-[#E6E8EF] text-[#0F172A] rounded-tl-md shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
                  isAI && 'bg-[#0F172A] text-white rounded-tr-md shadow-[0_2px_8px_rgba(15,23,42,0.15)]',
                )}>
                  {msg.content}
                  {msg.metadata?.latency_ms && (
                    <span className="block mt-1 text-[10px] text-white/60">{msg.metadata.latency_ms}ms</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <div className="sr-only">Conversation with {leadName}</div>
      <div ref={bottomRef} />
    </div>
  )
}
