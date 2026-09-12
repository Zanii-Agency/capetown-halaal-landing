// GET the owner's To Do (same loader as /admin/todo and the connector tool).
// Viewer-walled via loadTodo's underlying handlers. Lets the client refetch
// after an inline action so an item drops off the moment it is handled.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadTodo } from '@/lib/todo'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await loadTodo())
}
