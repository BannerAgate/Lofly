/**
 * Lofly AI Worker — Claude Opus 4.8 response generation
 * POST /generate-response  { review_id }
 * POST /batch-generate     { org_id }  (generates for all pending reviews without AI response)
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

    try {
      if (url.pathname === '/generate-response' && request.method === 'POST') {
        return await handleGenerateResponse(request, env);
      }
      if (url.pathname === '/batch-generate' && request.method === 'POST') {
        return await handleBatchGenerate(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('AI Worker error:', err);
      return json({ error: err.message }, 500);
    }
  }
};

// ============================================================
// Generate response for a single review
// ============================================================
async function handleGenerateResponse(request, env) {
  const { review_id } = await request.json();
  if (!review_id) return json({ error: 'review_id required' }, 400);

  // Fetch review + org config from Supabase
  const reviewRes = await supabaseFetch(env, `/rest/v1/reviews?id=eq.${review_id}&select=*,organizations(*)`, 'GET');
  if (!reviewRes.ok) return json({ error: 'Review not found' }, 404);
  const reviews = await reviewRes.json();
  const review = reviews[0];
  if (!review) return json({ error: 'Review not found' }, 404);

  const org = review.organizations;
  if (!org?.claude_api_key) return json({ error: 'Claude API key niet geconfigureerd voor deze organisatie' }, 400);

  // Fetch response library examples for context
  const libRes = await supabaseFetch(env,
    `/rest/v1/response_library?organization_id=eq.${org.id}&star_rating=eq.${review.star_rating}&limit=3`,
    'GET'
  );
  const library = libRes.ok ? await libRes.json() : [];

  // Build Claude prompt
  const systemPrompt = org.claude_ai_prompt ||
    `Je bent een vriendelijke klantenservice medewerker van ${org.name}.
Schrijf een persoonlijke, warme reactie op een klantreview.
Houd het kort (2-4 zinnen), spreek de klant bij naam aan, en bedank hem/haar.
Schrijf in het Nederlands. Geen hashtags of marketing-taal.`;

  const examplesText = library.length > 0
    ? `\n\nVoorbeeldreacties uit de bibliotheek:\n${library.map((l, i) => `${i+1}. "${l.response_text}"`).join('\n')}`
    : '';

  const userMessage = `Review van: ${review.reviewer_name || 'klant'}
Beoordeling: ${review.star_rating}/5 sterren
Portal: ${review.source}
Datum: ${review.review_date}
Reviewtekst: "${review.review_text || '(geen tekst)'}"
${examplesText}

Schrijf een passende reactie op deze review.`;

  // Call Claude
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': org.claude_api_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return json({ error: 'Claude API fout: ' + errText }, 502);
  }

  const claudeData = await claudeRes.json();
  const aiResponse = claudeData.content[0]?.text || '';

  // Save AI response to Supabase
  await supabaseFetch(env,
    `/rest/v1/reviews?id=eq.${review_id}`,
    'PATCH',
    { ai_response: aiResponse, updated_at: new Date().toISOString() }
  );

  return json({ success: true, ai_response: aiResponse, review_id });
}

// ============================================================
// Batch generate for all pending reviews without AI response
// ============================================================
async function handleBatchGenerate(request, env) {
  const { org_id } = await request.json();
  if (!org_id) return json({ error: 'org_id required' }, 400);

  // Get all pending reviews without ai_response
  const res = await supabaseFetch(env,
    `/rest/v1/reviews?organization_id=eq.${org_id}&status=eq.pending&ai_response=is.null&select=id`,
    'GET'
  );

  if (!res.ok) return json({ error: 'Kon reviews niet ophalen' }, 502);
  const reviews = await res.json();

  let generated = 0;
  let errors = 0;

  for (const r of reviews) {
    try {
      const resp = await handleGenerateResponse(
        new Request('https://worker/generate-response', {
          method: 'POST',
          body: JSON.stringify({ review_id: r.id }),
          headers: { 'Content-Type': 'application/json' }
        }),
        env
      );
      const data = await resp.json();
      if (data.success) generated++;
      else errors++;
    } catch {
      errors++;
    }
  }

  return json({ success: true, generated, errors, total: reviews.length });
}

// ============================================================
// Helpers
// ============================================================
function supabaseFetch(env, path, method, body = null) {
  const opts = {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : '',
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
