import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
  const userToken = authHeader.replace('Bearer ', '')

  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Verifieer de ingelogde gebruiker
  const { data: { user }, error: userError } = await serviceClient.auth.getUser(userToken)
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Ongeldig token' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Controleer of de caller admin of systeembeheerder is
  const { data: callerProfile } = await serviceClient
    .from('profiles')
    .select('role, organization_id')
    .eq('id', user.id)
    .single()

  if (!callerProfile || !['admin', 'systeembeheerder'].includes(callerProfile.role)) {
    return new Response(JSON.stringify({ error: 'Geen rechten' }), {
      status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({}))
  const { target_user_id } = body
  if (!target_user_id) {
    return new Response(JSON.stringify({ error: 'target_user_id ontbreekt' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Zelf-verwijdering blokkeren
  if (target_user_id === user.id) {
    return new Response(JSON.stringify({ error: 'Je kunt jezelf niet verwijderen' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Haal het profiel van de te verwijderen gebruiker op
  const { data: targetProfile } = await serviceClient
    .from('profiles')
    .select('role, organization_id')
    .eq('id', target_user_id)
    .single()

  if (!targetProfile) {
    return new Response(JSON.stringify({ error: 'Gebruiker niet gevonden' }), {
      status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Target moet in dezelfde organisatie zitten
  if (targetProfile.organization_id !== callerProfile.organization_id) {
    return new Response(JSON.stringify({ error: 'Geen rechten' }), {
      status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Admin mag geen admin of systeembeheerder verwijderen
  if (callerProfile.role === 'admin' && ['admin', 'systeembeheerder'].includes(targetProfile.role)) {
    return new Response(JSON.stringify({ error: 'Admin mag geen admin of systeembeheerder verwijderen' }), {
      status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  // Verwijder de auth user — cascade verwijdert ook het profiel
  const { error: deleteError } = await serviceClient.auth.admin.deleteUser(target_user_id)
  if (deleteError) {
    return new Response(JSON.stringify({ error: 'Verwijderen mislukt', detail: deleteError.message }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})
