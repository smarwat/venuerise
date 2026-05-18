import { createClient } from '@supabase/supabase-js'

// Service role client — bypasses RLS. Use ONLY in server-side AI/widget routes.
// Never expose to the client or include SUPABASE_SERVICE_ROLE_KEY in NEXT_PUBLIC_ vars.
export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
