/**
 * scrape.config.mjs
 * ──────────────────
 * Fill in the TARGET credentials (demo login for the app you want to document).
 * AI keys can be set here or via environment variables.
 *
 * Run the full pipeline:   node run-pipeline.mjs
 * Run only scrape phase:   node scraper.mjs
 * Run only draft phase:    node draft-content.mjs
 * Run only publish phase:  node publish.mjs
 */

export default {
  // ── Target app ───────────────────────────────────────────────────────────────
  target: {
    baseUrl:  'https://qa.twixor.digital',
    appName:  'Twixor',
    /** Demo login — provide credentials that can reach ALL sections of the app */
    email:    process.env.TARGET_EMAIL    || '',
    password: process.env.TARGET_PASSWORD || '',
  },

  // ── HelpAssistant admin API ───────────────────────────────────────────────────
  ha: {
    apiBase:  'http://localhost:3000',
    email:    'admin@twixor.com',
    password: 'Admin@Twixor2026!',
  },

  // ── AI keys — supports multiple keys per provider (round-robin) ───────────────
  ai: {
    /** Anthropic Claude — primary (vision + structured JSON output) */
    anthropicKeys: [
      process.env.ANTHROPIC_API_KEY   || '',
      process.env.ANTHROPIC_API_KEY_2 || '',
    ].filter(Boolean),

    /** OpenAI GPT-4o — fallback */
    openaiKeys: [
      process.env.OPENAI_API_KEY   || '',
      process.env.OPENAI_API_KEY_2 || '',
    ].filter(Boolean),

    /** Which model to use for Anthropic (must support vision) */
    anthropicModel: 'claude-sonnet-4-6',
    /** Which model to use for OpenAI (must support vision) */
    openaiModel: 'gpt-4o',
  },

  // ── Scraper behaviour ─────────────────────────────────────────────────────────
  scraper: {
    /** Browser viewport */
    viewport:         { width: 1440, height: 900 },
    deviceScaleFactor: 2,     // 2× for retina-quality screenshots
    /** Max depth to follow nav links post-login (0 = home only, 2 = home + 1 level deep) */
    navDepth:         2,
    /** Milliseconds to wait after navigation before screenshot */
    settleMs:         1500,
    /** Known pre-auth paths to attempt even before login */
    preAuthPaths: ['/login', '/signup', '/register', '/forgot-password', '/reset-password'],
  },

  // ── Content grouping — how screens are assembled into tutorial pages ──────────
  // Leave as null to let the pipeline auto-group by URL path prefix.
  // Or define custom groups:
  //   groups: [
  //     { id: 'auth', name: 'Authentication', matchPaths: ['/login', '/signup', '/forgot'] },
  //     { id: 'dashboard', name: 'Dashboard',   matchPaths: ['/dashboard', '/home'] },
  //   ]
  groups: null,
};
