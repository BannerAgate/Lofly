/**
 * Lofly Reply Poster — Cloudflare Worker
 *
 * POST /post-reply  { review_id }
 *
 * Posts the final_response of a review to the correct portal:
 * - Klantenvertellen: PUT https://www.klantenvertellen.nl/v1/publication/review/response
 * - Google Business Profile: PUT via My Business API (requires OAuth refresh token)
 *
 * After successful posting, marks the review as `posted` in Supabase.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/post-reply' && request.method === 'POST') {
      return await handlePostReply(request, env);
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok' });
    }

    return json({ error: 'Not found' }, 404);
  }
};

// ============================================================
// Main handler
// ============================================================
async function handlePostReply(request, env) {
  const { review_id } = await request.json();
  if (!review_id) return json({ error: 'review_id required' }, 400);

  // Load review + org
  const revRes = await supabaseFetch(env,
    `/rest/v1/reviews?id=eq.${review_id}&select=*,organizations(*)`,
    'GET'
  );

  if (!revRes.ok) return json({ error: 'Review niet gevonden' }, 404);
  const reviews = await revRes.json();
  const review = reviews[0];
  if (!review) return json({ error: 'Review niet gevonden' }, 404);

  if (!review.final_response) return json({ error: 'Geen definitieve reactie beschikbaar' }, 400);
  if (review.status === 'posted') return json({ success: true, message: 'Al geplaatst' });

  const org = review.organizations;
  let posted = false;

  if (review.source === 'klantenvertellen') {
    posted = await postKlantenvertellen(env, review, org);
  } else if (review.source === 'google') {
    posted = await postGoogle(env, review, org);
  } else {
    return json({ error: 'Onbekende portal: ' + review.source }, 400);
  }

  if (!posted) return json({ success: false, error: 'Plaatsen mislukt — controleer de API configuratie' }, 502);

  // Mark as posted in Supabase
  await supabaseFetch(env,
    `/rest/v1/reviews?id=eq.${review_id}`,
    'PATCH',
    { status: 'posted', posted_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  );

  // Add to response library
  await supabaseFetch(env, '/rest/v1/response_library', 'POST', {
    organization_id: org.id,
    review_id: review.id,
    response_type: 'manual',
    response_text: review.final_response,
    star_rating: review.star_rating,
    source: review.source,
  });

  return json({ success: true, review_id, source: review.source });
}

// ============================================================
// Klantenvertellen reply
// ============================================================
async function postKlantenvertellen(env, review, org) {
  if (!org.kv_api_token || !org.kv_location_id) {
    console.error('KV config missing');
    return false;
  }

  // tenantId is optioneel — wordt meegestuurd als ingevuld, anders weggelaten
  const tenantId = org.kv_tenant_id ? parseInt(org.kv_tenant_id) : null;

  const body = {
    locationId: String(org.kv_location_id),
    ...(tenantId && { tenantId }),
    reviewId: review.external_id,
    response: review.final_response,
    reviewResponseType: 'PUBLIC',
    responseEmail: false,
  };

  const res = await fetch('https://www.klantenvertellen.nl/v1/publication/review/response', {
    method: 'PUT',
    headers: {
      'X-Publication-Api-Token': org.kv_api_token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('KV reply error:', res.status, err);
    return false;
  }

  return true;
}

// ============================================================
// Google Business Profile reply
// ============================================================
async function postGoogle(env, review, org) {
  if (!org.google_refresh_token || !org.google_location_id) {
    console.error('Google config missing');
    return false;
  }

  let accessToken;
  try {
    accessToken = await getGoogleAccessToken(env, org);
  } catch (err) {
    console.error('Google token error:', err);
    return false;
  }

  // Google My Business reply API
  const apiUrl = `https://mybusiness.googleapis.com/v4/${org.google_location_id}/reviews/${review.external_id}/reply`;

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment: review.final_response })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Google reply error:', res.status, err);
    return false;
  }

  return true;
}

// ============================================================
// Google OAuth token refresh
// ============================================================
async function getGoogleAccessToken(env, org) {
  const clientId = env.GOOGLE_CLIENT_ID || org.google_client_id;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || org.google_client_secret;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: org.google_refresh_token,
    })
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ============================================================
// Supabase helpers
// ============================================================
function supabaseFetch(env, path, method, body = null) {
  const opts = {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    }
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${env.SUPABASE_URL}${path}`, opts);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}
