/**
 * Lofly Review Ingestor — Cloudflare Worker with Cron Trigger
 *
 * Runs every 15 minutes to pull new reviews from:
 * 1. Klantenvertellen API (token-based)
 * 2. Google Business Profile API (OAuth2 — requires refresh token)
 *
 * Secrets required:
 *   SUPABASE_SERVICE_KEY  — Supabase service role key
 *
 * Per-org config (stored in organizations table):
 *   kv_location_id, kv_api_token, kv_tenant_id
 *   google_account_id, google_location_id, google_refresh_token
 *   google_client_id, google_client_secret (set in org or env)
 */

export default {
  // HTTP handler (for manual trigger / healthcheck)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runIngestor(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Lofly Review Ingestor — GET /run to trigger manually');
  },

  // Cron handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngestor(env));
  }
};

// ============================================================
// Main ingestor loop
// ============================================================
async function runIngestor(env) {
  const results = { orgs: 0, kv_new: 0, google_new: 0, errors: [] };

  // Get all active organizations with API config
  const orgsRes = await supabaseFetch(env,
    '/rest/v1/organizations?select=*',
    'GET'
  );

  if (!orgsRes.ok) {
    results.errors.push('Failed to load organizations');
    return results;
  }

  const orgs = await orgsRes.json();
  results.orgs = orgs.length;

  for (const org of orgs) {
    // Klantenvertellen
    if (org.kv_location_id && org.kv_api_token) {
      try {
        const count = await ingestKlantenvertellen(env, org);
        results.kv_new += count;
      } catch (err) {
        results.errors.push(`KV [${org.slug}]: ${err.message}`);
      }
    }

    // Google Business Profile
    if (org.google_account_id && org.google_location_id && org.google_refresh_token) {
      try {
        const count = await ingestGoogle(env, org);
        results.google_new += count;
      } catch (err) {
        results.errors.push(`Google [${org.slug}]: ${err.message}`);
      }
    }
  }

  console.log('Ingestor result:', results);
  return results;
}

// ============================================================
// Klantenvertellen ingestor
// ============================================================
async function ingestKlantenvertellen(env, org) {
  const baseUrl = 'https://www.klantenvertellen.nl/v1/publication/review';
  const params = new URLSearchParams({
    locationId: org.kv_location_id,
    limit: '50',
    offset: '0'
  });

  const res = await fetch(`${baseUrl}?${params}`, {
    headers: {
      'X-Publication-Api-Token': org.kv_api_token,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) throw new Error(`KV API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const reviews = data.reviews || data.data || [];
  let inserted = 0;

  for (const r of reviews) {
    const externalId = String(r.id || r.reviewId || r.uuid);
    const alreadyExists = await reviewExists(env, org.id, 'klantenvertellen', externalId);
    if (alreadyExists) continue;

    await insertReview(env, {
      organization_id: org.id,
      source: 'klantenvertellen',
      external_id: externalId,
      location_slug: org.slug,
      reviewer_name: r.author || r.reviewerName || r.name || 'Anoniem',
      star_rating: Math.round(r.rating || r.stars || r.score || 3),
      review_text: r.text || r.reviewText || r.comment || null,
      review_date: r.date || r.createdAt || r.reviewDate || new Date().toISOString(),
    });
    inserted++;
  }

  return inserted;
}

// ============================================================
// Google Business Profile ingestor
// ============================================================
async function ingestGoogle(env, org) {
  // Get fresh access token using refresh token
  const accessToken = await getGoogleAccessToken(env, org);

  const apiUrl = `https://mybusiness.googleapis.com/v4/${org.google_location_id}/reviews?pageSize=50`;

  const res = await fetch(apiUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const reviews = data.reviews || [];
  let inserted = 0;

  for (const r of reviews) {
    const externalId = r.reviewId || r.name;
    const alreadyExists = await reviewExists(env, org.id, 'google', externalId);
    if (alreadyExists) continue;

    // Map Google star rating string to number
    const starMap = {
      'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5
    };
    const stars = starMap[r.starRating] || 3;

    await insertReview(env, {
      organization_id: org.id,
      source: 'google',
      external_id: externalId,
      location_slug: org.slug,
      reviewer_name: r.reviewer?.displayName || 'Anoniem',
      star_rating: stars,
      review_text: r.comment || null,
      review_date: r.createTime || new Date().toISOString(),
    });
    inserted++;
  }

  return inserted;
}

// ============================================================
// Google OAuth — exchange refresh token for access token
// ============================================================
async function getGoogleAccessToken(env, org) {
  const clientId = env.GOOGLE_CLIENT_ID || org.google_client_id;
  const clientSecret = env.GOOGLE_CLIENT_SECRET || org.google_client_secret;

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials niet geconfigureerd (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  }

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

  if (!res.ok) throw new Error(`Token refresh mislukt: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ============================================================
// Supabase helpers
// ============================================================
async function reviewExists(env, orgId, source, externalId) {
  const res = await supabaseFetch(env,
    `/rest/v1/reviews?organization_id=eq.${orgId}&source=eq.${source}&external_id=eq.${encodeURIComponent(externalId)}&select=id`,
    'GET'
  );
  if (!res.ok) return false;
  const data = await res.json();
  return data.length > 0;
}

async function insertReview(env, review) {
  const res = await supabaseFetch(env, '/rest/v1/reviews', 'POST', review);
  if (!res.ok) {
    const err = await res.text();
    // Ignore duplicate key errors (UNIQUE constraint)
    if (!err.includes('duplicate') && !err.includes('unique')) {
      throw new Error(`Insert failed: ${err}`);
    }
  }
}

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
