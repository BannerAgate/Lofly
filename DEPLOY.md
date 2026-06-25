# Lofly — Deployment Instructies (dev/v1)

## Stap 1 — Supabase migratie toevoegen (google_refresh_token kolom)

Run dit in de Supabase SQL editor van project `abvxyvtglpjslqrocmwe`:

```sql
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS google_refresh_token text,
  ADD COLUMN IF NOT EXISTS google_client_id text,
  ADD COLUMN IF NOT EXISTS google_client_secret text;
```

---

## Stap 2 — GitHub repo aanmaken

```bash
cd C:\Users\nnieuwendaal\Claude\Projects\Lofly
git init
git add .
git commit -m "chore: initial Lofly dev/v1 frontend + workers"
git remote add origin https://github.com/JOUW_GITHUB/loflyapp.git
git push -u origin main
```

---

## Stap 3 — Cloudflare Pages instellen

1. Ga naar https://dash.cloudflare.com → Pages → Create project
2. Connect GitHub → selecteer repo `loflyapp`
3. Build settings:
   - Build command: *(leeg laten)*
   - Build output directory: `dev/v1`
4. Sla op. Je app is nu live op `https://loflyapp.pages.dev`

Voor custom domein `loflyapp.com`:
- Pages → je project → Custom domains → Add → `loflyapp.com`

---

## Stap 4 — Cloudflare Workers deployen

Zorg dat je Wrangler CLI hebt: `npm install -g wrangler`
Log in: `wrangler login`

### AI Worker
```bash
cd workers\ai-worker
wrangler secret put SUPABASE_SERVICE_KEY
# (plak de service role key uit Supabase → Settings → API)
wrangler deploy
```

### Review Ingestor
```bash
cd workers\review-ingestor
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler deploy
```

### Reply Poster
```bash
cd workers\reply-poster
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler deploy
```

---

## Stap 5 — Worker URLs invullen in frontend

Na deployen krijg je URLs als:
- `https://lofly-ai-worker.ACCOUNT.workers.dev`
- `https://lofly-reply-poster.ACCOUNT.workers.dev`

Update in `dev/v1/js/config.js`:
```js
const WORKERS_BASE_URL = 'https://lofly-reply-poster.ACCOUNT.workers.dev';
```

Commit en push → Cloudflare Pages herdeployt automatisch.

---

## Stap 6 — Eerste gebruiker aanmaken

Ga naar Supabase → Authentication → Users → Add user:
- E-mail: jouw e-mailadres
- Wachtwoord: stel in

De `handle_new_user` trigger maakt automatisch een profiel aan.
Daarna in SQL:
```sql
UPDATE profiles SET role = 'admin' WHERE id = '(user UUID)';
UPDATE profiles SET organization_id = '6bd5679a-52b0-4fe4-a84d-1aff96191536' WHERE id = '(user UUID)';
```

---

## Stap 7 — AI Worker URL in Settings

Login op de app → Instellingen → AI Instellingen → vul je Anthropic API key in.

---

## Supabase Service Role Key

Te vinden op: Supabase Dashboard → Project `abvxyvtglpjslqrocmwe` → Settings → API → service_role key
⚠️ Bewaar deze key geheim — nooit in de frontend gebruiken.

---

## KV Tenant ID achterhalen

De Klantenvertellen API geeft de `tenantId` terug in GET responses.
Run de ingestor eenmalig handmatig (`GET /run` op de review-ingestor worker) en check de Supabase logs of KV response om de tenantId te vinden.
Vul deze dan in via Settings → Integraties → Klantenvertellen.
