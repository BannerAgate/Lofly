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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

  let invitationId: string | null = null
  try {
    const body = await req.json()
    invitationId = body.invitation_id ?? null
  } catch (_) {}

  if (!invitationId) {
    return new Response(JSON.stringify({ error: 'invitation_id is required' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const { data: inv, error: invError } = await supabase
    .from('invitations')
    .select('id, email, name, role, organization_id, invited_by')
    .eq('id', invitationId)
    .single()

  if (invError || !inv) {
    return new Response(JSON.stringify({ error: 'Uitnodiging niet gevonden' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', inv.organization_id)
    .single()

  const { data: inviter } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', inv.invited_by)
    .single()

  const { data: inviterUser } = await supabase.auth.admin.getUserById(inv.invited_by)

  const inviterName = inviter?.full_name || 'Iemand van het team'
  const inviterEmail = inviterUser?.user?.email || ''
  const orgName = org?.name || 'je organisatie'
  const firstName = inv.name?.split(' ')[0] || inv.name || 'daar'

  const roleLabels: Record<string, string> = {
    systeembeheerder: 'Systeembeheerder',
    admin: 'Beheerder',
    reviewer: 'Reviewer',
    readonly: 'Alleen lezen',
  }
  const roleLabel = roleLabels[inv.role] || inv.role

  const loginUrl = `https://loflyapp.com/register?email=${encodeURIComponent(inv.email)}&name=${encodeURIComponent(inv.name ?? '')}`

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Je bent uitgenodigd voor Lofly</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;max-width:520px;">
          <tr>
            <td style="background:#1a2335;padding:24px 32px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:28px;height:28px;background:#F97316;border-radius:50%;font-size:1px;">&nbsp;</td>
                  <td style="padding-left:10px;color:#ffffff;font-size:18px;font-weight:800;letter-spacing:-0.5px;">Lofly</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 24px;">
              <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">Hallo ${firstName},</p>
              <p style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111827;line-height:1.4;letter-spacing:-0.2px;">
                Je bent uitgenodigd voor Lofly door <span style="color:#F97316;">${orgName}</span>.
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#6b7280;line-height:1.65;">
                ${orgName} heeft je uitgenodigd als <strong style="color:#111827;font-weight:600;">${roleLabel}</strong> voor Lofly. Met Lofly heb je in één overzicht al jouw online reviews zichtbaar en helpt de Lofly-agent jou met jullie online reviewbeheer.
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#6b7280;line-height:1.65;">
                Klik op de knop hieronder om in te loggen en direct aan de slag te gaan!
              </p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:0 0 28px;">
                    <a href="${loginUrl}" style="display:inline-block;background:#F97316;color:#ffffff;font-size:14px;font-weight:700;padding:13px 36px;border-radius:8px;text-decoration:none;letter-spacing:-0.1px;">
                      Uitnodiging accepteren
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.65;">
                Verwachtte je deze mail niet? Dan kun je hem negeren.
              </p>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid #f3f4f6;padding:14px 32px;background:#f9fafb;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:11px;color:#9ca3af;">Lofly &mdash; loflyapp.com</td>
                  <td align="right" style="font-size:11px;color:#9ca3af;">noreply@loflyapp.com</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Lofly <noreply@loflyapp.com>',
      to: [inv.email],
      subject: `Je bent uitgenodigd voor Lofly door ${orgName}`,
      html,
    }),
  })

  if (!resendRes.ok) {
    const err = await resendRes.text()
    return new Response(JSON.stringify({ error: 'Resend fout', detail: err }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
})
