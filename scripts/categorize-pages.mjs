#!/usr/bin/env node
/**
 * categorize-pages.mjs — create the help-center categories and assign every
 * manual page to one, via the admin API.
 *
 *   node scripts/categorize-pages.mjs [--dry] [--api https://doc-api.medicore.cc]
 *
 * Prompts for admin email + password (password hidden). Idempotent: existing
 * categories are reused, pages already in the right category are skipped.
 */
import readline from 'node:readline';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const apiIdx = args.indexOf('--api');
const API = ((apiIdx >= 0 && args[apiIdx + 1]) || process.env.HELP_API_URL || 'https://doc-api.medicore.cc')
  .replace(/\/$/, '');

// Ordered categories → route paths they contain.
const CATEGORIES = [
  { name: 'Getting Started', icon: 'rocket_launch', description: 'Sign in, set up, and find your way around.',
    routes: ['/login', '/recovery', '/first-run-setup', '/dashboard', '/my-day', '/profile'] },
  { name: 'Patients & OPD', icon: 'groups', description: 'Registration, appointments, queue and consultations.',
    routes: ['/patients', '/patients/:id', '/appointments', '/queue', '/consultation/:appointmentId',
      '/doctor-registry', '/telemedicine', '/referrals', '/consents'] },
  { name: 'Diagnostics', icon: 'biotech', description: 'Laboratory and radiology.',
    routes: ['/laboratory', '/radiology'] },
  { name: 'Inpatient & Specialty Care', icon: 'local_hospital', description: 'IPD, OT, emergency and support services.',
    routes: ['/ipd', '/ot', '/emergency', '/blood-bank', '/mortuary', '/nutrition', '/kitchen', '/opticare'] },
  { name: 'Pharmacy & Inventory', icon: 'medication', description: 'Dispensing, stock, purchasing and master data.',
    routes: ['/pharmacy', '/inventory', '/vendors', '/master-data', '/verify/rx/:id'] },
  { name: 'Billing & Finance', icon: 'receipt_long', description: 'Invoices, payments, insurance and subscription.',
    routes: ['/billing', '/insurance', '/pos-terminals', '/account-billing'] },
  { name: 'Marketing & Growth', icon: 'campaign', description: 'Campaigns, promotions, referrals and public page.',
    routes: ['/marketing', '/refer-earn', '/public-page'] },
  { name: 'Reports & Analytics', icon: 'insights', description: 'Operational reports and forecasts.',
    routes: ['/reports', '/analytics'] },
  { name: 'HR & Staff', icon: 'badge', description: 'Employees, payroll, users and roles.',
    routes: ['/hrm', '/roles'] },
  { name: 'Administration', icon: 'settings', description: 'Hospital settings, branches, domains and integrations.',
    routes: ['/settings', '/branches', '/config', '/storage', '/domains', '/verification', '/versions', '/abdm-setup'] },
];

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// Raw-mode read so the password is never echoed (readline's output hooks leak it on Windows).
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('Run this in an interactive terminal (password prompt needs a TTY).'));
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u0008' || ch === '\u007f') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message || json.message || (typeof json.error === 'string' ? json.error : JSON.stringify(json));
    throw new Error(`${method} ${path} → ${res.status} ${msg}`);
  }
  return json;
}

async function main() {
  const email = process.env.HELP_ADMIN_EMAIL || await ask('Admin email: ');
  const password = await askHidden('Password (hidden): ');
  const login = await api('POST', '/api/admin/auth/login', null, { email, password });
  const token = login.accessToken || login.tokens?.accessToken || login.data?.accessToken;
  if (!token) throw new Error('Login succeeded but no accessToken in response');

  const { data: existingCats = [] } = await api('GET', '/api/admin/categories', token);
  // The list endpoint caps limit at 100, so walk every page of results.
  const pages = [];
  for (let n = 1; ; n++) {
    const { data = [], meta } = await api('GET', `/api/admin/pages?limit=100&page=${n}`, token);
    pages.push(...data);
    if (!meta || n >= meta.pages) break;
  }
  const byRoute = new Map(pages.map((p) => [p.routePath, p]));

  let created = 0, moved = 0, skipped = 0;
  const assigned = new Set();

  for (const [i, cat] of CATEGORIES.entries()) {
    const order = (i + 1) * 10;
    const existing = existingCats.find((c) => c.name.toLowerCase() === cat.name.toLowerCase());
    if (!existing) {
      console.log(`+ category  ${cat.name}`);
      if (!DRY) await api('POST', '/api/admin/categories', token,
        { name: cat.name, order, icon: cat.icon, description: cat.description });
      created++;
    } else if (existing.order !== order && !DRY) {
      await api('PATCH', `/api/admin/categories/${existing.id}`, token, { order });
    }

    for (const route of cat.routes) {
      assigned.add(route);
      const page = byRoute.get(route);
      if (!page) { console.log(`  ? missing page ${route}`); continue; }
      if (page.category === cat.name && page.categoryOrder === order) { skipped++; continue; }
      console.log(`  → ${route}  ${page.category || '(none)'} ⇒ ${cat.name}`);
      if (!DRY) await api('PATCH', `/api/admin/pages/${page.id}`, token, { category: cat.name, categoryOrder: order });
      moved++;
    }
  }

  const unmapped = pages.filter((p) => !assigned.has(p.routePath));
  if (unmapped.length) {
    console.log('\nPages not in the mapping (left as-is):');
    for (const p of unmapped) console.log(`  ${p.routePath}  [${p.category || 'uncategorised'}]`);
  }
  console.log(`\n${DRY ? '[dry] ' : ''}categories created: ${created}, pages moved: ${moved}, already correct: ${skipped}`);
}

// Report failures as one line and exit normally: letting the error escape
// crashes Node on Windows (UV_HANDLE_CLOSING assertion) and hides the message.
try {
  await main();
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  if (/401/.test(err.message)) console.error("Use your doc.medicore.cc admin account, not the qa.medicore.cc hospital login.");
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
