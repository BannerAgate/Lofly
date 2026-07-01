import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // Haal de user token op uit de Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
  const userToken = authHeader.replace('Bearer ', '')

  // Service role client — bypast alle RLS
  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Haal de user op via het token
  const { data: { user }, error: userError } = await serviceClient.auth.getUser(userToken)
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Ongeldig token' }), {
      status: 401,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Zoek openstaande uitnodiging op basis van e-mailadres
  const { data: inv, error: invError } = await serviceClient
    .from('invitations')
    .select('id, organization_id, role')
    .ilike('email', user.email!)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (invError) {
    return new Response(JSON.stringify({ error: 'Database fout', detail: invError.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  if (!inv) {
    // Geen uitnodiging — profiel blijft met org=null en role=readonly
    return new Response(JSON.stringify({ ok: true, note: 'Geen uitnodiging gevonden' }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Update profiel met de juiste org en rol
  const { error: profileError } = await serviceClient
    .from('profiles')
    .update({
      organization_id: inv.organization_id,
      role: inv.role,
    })
    .eq('id', user.id)

  if (profileError) {
    return new Response(JSON.stringify({ error: 'Profiel update mislukt', detail: profileError.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Zet uitnodiging op geaccepteerd
  await serviceClient
    .from('invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', inv.id)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})
