// ============================================================
// Lofly App — Supabase Configuration
// ============================================================
const SUPABASE_URL = 'https://abvxyvtglpjslqrocmwe.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFidnh5dnRnbHBqc2xxcm9jbXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNzA5MjksImV4cCI6MjA5Nzk0NjkyOX0._9_FXRM7w7Z6qxOiBFmAMHWtAZDclZIobBBtrmMBgP8';

// Workers endpoint (update after deploying Cloudflare Workers)
const WORKERS_BASE_URL = 'https://lofly-workers.YOUR_ACCOUNT.workers.dev';

// App config
const APP_VERSION = '1.0.0';

// Initialize Supabase client (loaded from CDN in each HTML file)
let _supabase = null;
let _supabaseReady = null;

function getSupabase() {
  if (!_supabase) {
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { skipAutoInitialize: true }
    });
    _supabaseReady = _supabase.auth.initialize();
  }
  return _supabase;
}

// ============================================================
// Auth helpers
// ============================================================
async function getCurrentUser() {
  getSupabase();
  await _supabaseReady;
  const { data: { session } } = await getSupabase().auth.getSession();
  return session?.user ?? null;
}

async function getCurrentProfile() {
  const user = await getCurrentUser();
  if (!user) return null;

  // Fetch profile first (no join — avoids potential RLS recursion)
  const { data: profile, error: profileError } = await getSupabase()
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    console.error('getCurrentProfile: profile fetch failed', profileError);
    return null;
  }

  // Fetch org separately
  const { data: org } = await getSupabase()
    .from('organizations')
    .select('*')
    .eq('id', profile.organization_id)
    .single();

  return { ...profile, organizations: org || null };
}

async function requireAuth(redirectTo = '/dev/v1/index.html') {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = redirectTo;
    return null;
  }
  return user;
}

async function signOut() {
  await getSupabase().auth.signOut();
  window.location.href = '/dev/v1/index.html';
}

// ============================================================
// Shared UI helpers
// ============================================================
function showToast(message, type = 'success') {
  const existing = document.getElementById('lofly-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'lofly-toast';
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
    <span>${message}</span>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderStars(rating) {
  const n = parseInt(rating) || 0;
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="star ${i < n ? 'star-filled' : 'star-empty'}">★</span>`
  ).join('');
}

function getSourceBadge(source) {
  if (source === 'google') return '<span class="badge badge-google">Google</span>';
  if (source === 'klantenvertellen') return '<span class="badge badge-kv">Klantenvertellen</span>';
  return `<span class="badge">${source}</span>`;
}

function getStatusBadge(status) {
  const map = {
    pending: ['badge-pending', 'Te behandelen'],
    approved: ['badge-approved', 'Goedgekeurd'],
    posted: ['badge-posted', 'Geplaatst'],
    rejected: ['badge-rejected', 'Afgewezen']
  };
  const [cls, label] = map[status] || ['badge', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ============================================================
// Navigation renderer
// ============================================================
function renderNav(activePage) {
  const pages = [
    { id: 'reviews', label: 'Reviews', icon: '⭐', href: 'reviews.html' },
    { id: 'dashboard', label: 'Dashboard', icon: '📊', href: 'dashboard.html' },
    { id: 'employees', label: 'Medewerkers', icon: '👤', href: 'employees.html' },
  ];

  const navItems = pages.map(p => `
    <a href="${p.href}" class="nav-item ${activePage === p.id ? 'active' : ''}">
      <span class="nav-icon">${p.icon}</span>
      <span class="nav-label">${p.label}</span>
    </a>
  `).join('');

  return `
    <nav class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-mark"></div>
        <span class="logo-text">Lofly</span>
      </div>
      <div class="nav-items">${navItems}</div>
      <div class="nav-bottom">
        <a href="settings.html" class="nav-item ${activePage === 'settings' ? 'active' : ''}">
          <span class="nav-icon">⚙️</span>
          <span class="nav-label">Instellingen</span>
        </a>
        <button class="nav-item nav-signout" onclick="signOut()">
          <span class="nav-icon">↩</span>
          <span class="nav-label">Uitloggen</span>
        </button>
      </div>
    </nav>
  `;
}
