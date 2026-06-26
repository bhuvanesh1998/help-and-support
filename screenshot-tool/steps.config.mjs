// ── Config ───────────────────────────────────────────────────────────────────
export const API_BASE      = 'http://localhost:3000';
export const PAGE_ID       = 'f9634f83-aa4f-465e-9d9b-a5d1462fe9a5';
export const ADMIN_EMAIL   = 'admin@twixor.com';
export const ADMIN_PASSWORD = 'Admin@Twixor2026!';

/**
 * Each step defines:
 *   url        — page to navigate to
 *   waitFor    — CSS selector to wait for before screenshotting
 *   actions    — steps to run before highlights:
 *                  fill | click | waitForNavigation | wait | simulatePasswordScreen
 *   highlights — elements to annotate (selectors tried in order, label, hex color)
 *
 * Selectors confirmed via live DOM inspection of qa.twixor.digital/login:
 *   Email field : input#email  (type="text", placeholder="Email")
 *   Proceed btn : button#proceed-btn
 *   Sign Up     : span.signin-text  (NOT an <a> tag)
 */
export const STEPS = [
  // ── Step 1 — Enter Email Id ─────────────────────────────────────────────
  {
    stepNumber: 1,
    id: 'd6526757-459a-489b-82f3-9c618228f4a2',
    slug: 'email-id',
    url: 'https://qa.twixor.digital/login',
    waitFor: 'input#email',
    actions: [],
    highlights: [
      {
        id: 'email-field',
        selectors: ['input#email', 'input[placeholder="Email"]', 'input[type="text"]'],
        label: 'Email Id — enter your email address',
        color: '#ef4444',
      },
    ],
  },

  // ── Step 2 — Click Proceed ──────────────────────────────────────────────
  {
    stepNumber: 2,
    id: 'fc6a3e4f-b547-45b5-b9c5-d42fb98b180a',
    slug: 'proceed-button',
    url: 'https://qa.twixor.digital/login',
    waitFor: 'input#email',
    actions: [],
    highlights: [
      {
        id: 'email-for-proceed',
        selectors: ['input#email', 'input[placeholder="Email"]'],
        label: '① Enter Email Id',
        color: '#3b82f6',
      },
      {
        id: 'proceed-btn',
        selectors: ['button#proceed-btn', 'button:has-text("Proceed")'],
        label: '② Click Proceed',
        color: '#16a34a',
      },
    ],
  },

  // ── Step 3 — Enter Password (simulated password screen) ─────────────────
  // The real password screen requires a valid qa.twixor.digital account.
  // We inject a simulated DOM state so the screenshot still shows the right UI.
  {
    stepNumber: 3,
    id: '81dffa1b-fab2-491f-979d-6c0c1bd36ba4',
    slug: 'password',
    url: 'https://qa.twixor.digital/login',
    waitFor: 'input#email',
    actions: [
      { type: 'simulatePasswordScreen' },
    ],
    highlights: [
      {
        id: 'password-field',
        selectors: ['input#email', 'input[type="password"]'],
        label: 'Password — enter your password',
        color: '#ef4444',
      },
      {
        id: 'signin-btn',
        selectors: ['button#proceed-btn'],
        label: 'Click Sign In',
        color: '#16a34a',
      },
    ],
  },

  // ── Step 4 — Forgot Password link (simulated password screen) ───────────
  {
    stepNumber: 4,
    id: '22a9cd0a-a442-489a-8340-d838d435956b',
    slug: 'reset-password',
    url: 'https://qa.twixor.digital/login',
    waitFor: 'input#email',
    actions: [
      { type: 'simulatePasswordScreen' },
    ],
    highlights: [
      {
        id: 'forgot-link',
        selectors: ['#simulated-forgot-link'],
        label: 'Forgot password? — click to reset',
        color: '#f59e0b',
      },
    ],
  },

  // ── Step 5 — Sign Up link ────────────────────────────────────────────────
  // DOM inspection confirmed it is a <span class="signin-text">, NOT an <a>
  {
    stepNumber: 5,
    id: '902a12e3-56ab-4b13-ae0f-64f5ef9ab62d',
    slug: 'signup',
    url: 'https://qa.twixor.digital/login',
    waitFor: 'input#email',
    actions: [],
    highlights: [
      {
        id: 'signup-link',
        selectors: ['span.signin-text', 'span:has-text("Sign Up")'],
        label: "Don't have an account? Sign Up",
        color: '#8b5cf6',
      },
    ],
  },
];
