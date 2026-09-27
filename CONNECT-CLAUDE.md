# Connect Claude to HelpAssistant — Step-by-Step Guide

This guide is for **anyone** — no coding required to follow it. It walks you through connecting
**Claude** (Claude Code, Claude Desktop, or claude.ai) to the HelpAssistant app, and optionally
installing the browser extension, so Claude can look at a web app for you and write user manuals
automatically.

---

## 1. What this actually does (in plain English)

HelpAssistant can act as a **helper that Claude plugs into**. Once connected:

- Claude can **open a web app**, take screenshots of each screen, and see the network/API calls it makes.
- Claude can **write step-by-step tutorials** for those screens and **publish them** straight into HelpAssistant.
- **No Anthropic API key is needed** — Claude runs on *your own plan/seat*. HelpAssistant just gives Claude a set of tools to use.

Think of it as giving Claude a remote control and a camera for a website, plus a notebook to write the manual in.

**The two pieces you'll set up:**

| Piece | What it's for | Required? |
| --- | --- | --- |
| **MCP connection** | Lets Claude call HelpAssistant's tools (capture screens, publish manuals). | ✅ Yes |
| **Browser extension** | Lets Claude use *your* real, already-logged-in browser tab for pixel-perfect capture. | ⬜ Optional |

---

## 2. Before you start (checklist)

You'll need **all** of these:

1. **HelpAssistant is running** and you can open the admin site (default: `http://localhost:4200/admin`).
   - If it isn't running yet, see **[Appendix A: Starting the app](#appendix-a--starting-the-app-for-developers)**.
2. **An admin login** for HelpAssistant (email + password).
3. **A Claude client** installed — pick one:
   - **Claude Code** (terminal tool) — *recommended, easiest, works with `localhost`.*
   - **Claude Desktop** (Mac/Windows app).
   - **claude.ai** (web) — only works if HelpAssistant is on a public HTTPS address **with an OAuth layer** in front of `/mcp` (see notes below).
4. **One-time server setup** so the "capture screens" tool has a browser to drive. In a terminal:

   ```bash
   cd backend
   npx playwright install chromium
   ```

---

## 3. Step 1 — Get your connection token

The **token** is like a password that lets Claude talk to HelpAssistant.

1. Log in to the admin site → open **Claude MCP Connect** in the left menu.
2. Under **Connection token**, click **Generate token**.
3. A token starting with **`hamcp_…`** appears. Click the **copy** icon and keep it safe.
   - You can **Reveal** it again later, **Rotate** it (make a new one), or **Revoke** it (cut off access instantly).
4. Make sure the status pill at the top says **Active**. If it says *Disabled*, flip the toggle on.

> **Keep this token private.** Anyone with it can use the tools. If it leaks, click **Rotate** or **Revoke**.

Also note the **Server URL** shown on that page — it looks like `http://localhost:3000/mcp`. You'll need it next.

---

## 4. Step 2 — Connect your Claude client

Pick the tab that matches the Claude client you use. The exact command/config with **your** token
is also shown on the **Claude MCP Connect** page (Step 2) — you can just copy it from there.

### Option A — Claude Code (recommended)

Open your terminal and run this, pasting in your real server URL and token:

```bash
claude mcp add --transport http helpassistant \
  http://localhost:3000/mcp \
  --header "Authorization: Bearer hamcp_YOUR_TOKEN_HERE"
```

That's it. Start a Claude Code session and the `helpassistant` tools are available.

### Option B — Claude Desktop

1. Open Claude Desktop's config file `claude_desktop_config.json`.
2. Add this under `mcpServers` (paste your real URL and token):

   ```json
   {
     "mcpServers": {
       "helpassistant": {
         "type": "http",
         "url": "http://localhost:3000/mcp",
         "headers": {
           "Authorization": "Bearer hamcp_YOUR_TOKEN_HERE"
         }
       }
     }
   }
   ```

3. **Restart Claude Desktop.**

> Note: Claude Desktop must run on the **same machine** as HelpAssistant if the URL is `localhost`, and remote-URL MCP support needs a recent Desktop build.

### Option C — claude.ai (web)

claude.ai **cannot** reach `localhost` and needs a **public HTTPS** address plus an **OAuth** login layer.
For local or quick setups, use **Claude Code** (Option A) instead. To use claude.ai you'd deploy HelpAssistant
behind HTTPS (or a tunnel like ngrok), add OAuth in front of `/mcp`, then add it under **Settings → Connectors**.

---

## 5. Step 3 — Try it

In your Claude session, just ask in plain language. Examples:

- *"Use the helpassistant tools to map `https://qa.twixor.digital` and draft user manuals for each screen."*
- *"List the tutorial pages that already exist so we don't make duplicates."*
- *"Capture the login and dashboard screens, then publish a tutorial for the login page."*

**How to confirm it's working:** go back to the **Claude MCP Connect** page. Under **Exposed tools & activity → Recent calls**,
you'll see each tool Claude runs (with a green check ✅ or red error).

**The tools Claude can use:**

| Tool | What it does |
| --- | --- |
| `list_pages` | Lists existing tutorial pages (so Claude avoids duplicates). |
| `capture_screens` | Opens a target app in a headless browser and screenshots each screen. |
| `get_screenshot` | Re-fetches one screenshot by its id. |
| `publish_tutorial` | Creates/updates a manual page with step-by-step instructions + API reference. |
| `list_connected_browsers` | Lists live browser-extension sessions (needs the extension — Step 4). |
| `capture_live_screen` | Screenshots *your* connected real browser tab + its API calls. |
| `drive_action` | Clicks / types / navigates in your connected browser to walk through a flow. |

---

## 6. Step 4 — Browser extension (optional)

Use this when you want Claude to capture a site **you're already logged into** — with pixel-perfect
screenshots and the real API calls — **without** copying any passwords or session tokens.

### Install it

1. On the **Claude MCP Connect** page (Step 4), click **Download extension (.zip)** and **unzip** it.
   *(Developers: the folder also lives at `backend/extension/`.)*
2. Open **`chrome://extensions`** (or `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** → select the unzipped folder.

### Connect a tab

1. Open the website you want to document and **log in as normal**.
2. Click the **HelpAssistant Connector** icon in your browser toolbar.
3. Paste:
   - **Backend URL** → where HelpAssistant runs, e.g. `http://localhost:3000` *(not the site you're capturing)*.
   - **Connector token** → the same `hamcp_…` token from Step 1.
4. Click **Connect this tab**.
   - Chrome will show a *"… is debugging this browser"* banner — that's normal and expected.
5. In Claude, run `list_connected_browsers` to confirm, then `capture_live_screen` / `drive_action`.
6. Click **Disconnect** (or close the tab) when you're done.

> ⚠ **Staging / operator use only.** While connected, the tab can be controlled remotely and its screens
> and API data are captured. Don't use it on real end-user sessions or sensitive personal data.
> Revoking the token (Step 1) cuts the extension off instantly.

---

## 7. Troubleshooting

| Problem | Fix |
| --- | --- |
| **"Invalid or missing MCP connector token"** | The token is wrong/rotated/revoked. Copy a fresh one from Step 1 and reconnect. |
| Connector status shows **Disabled** | Toggle it **Active** on the Claude MCP Connect page. |
| `capture_screens` fails to open a browser | Run the one-time setup: `cd backend && npx playwright install chromium`. |
| claude.ai can't connect | It needs public **HTTPS + OAuth** — use **Claude Code** for local setups instead. |
| Extension says **"No connected browser"** | Open the extension popup and click **Connect** on the tab; check the URL/token are correct. |
| Claude Desktop doesn't see the server | Confirm you edited the right config file, used a recent Desktop build, and **restarted** the app. |
| Tool calls don't appear in **Recent calls** | Claude isn't actually reaching the server — recheck the URL (`…/mcp`) and token. |

---

## 8. Security notes (read once)

- The **connector token is a bearer credential** — it's the only thing standing between the internet and these tools. Keep it secret; **rotate** or **revoke** it the moment it's exposed.
- Always use an **HTTPS** backend URL for anything that isn't `localhost`.
- The browser extension makes a tab **remotely controllable** — treat it as staging/operator-only.
- No Anthropic API key is stored here; inference runs on your own Claude plan.

---

## Appendix A — Starting the app (for developers)

If HelpAssistant isn't running yet:

**Backend (API — port 3000):**

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, SEED_SUPER_ADMIN_*, etc.
npm install
npm run prisma:generate
npm run prisma:migrate        # applies the committed migrations to your DB
npm run db:seed               # creates the first admin login
npm run dev                   # http://localhost:3000/api/health
npx playwright install chromium   # one-time, for capture_screens
```

**Frontend (admin site — port 4200):**

```bash
cd frontend
npm install
npm run start                 # http://localhost:4200
```

Then log in at `http://localhost:4200/admin/login` using the seeded admin credentials
(`SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` from `backend/.env`), and continue at **Step 1** above.


-------------------------------------------------------------

## Appendix B — Using the hosted (online) version

If someone has already deployed HelpAssistant for you online, **you skip all the setup above** —
nothing to install or run on your machine. You only need the two web addresses and an admin login.

**Your addresses:**

| What | Address |
| --- | --- |
| Admin site (log in here) | `https://help-ui.182.95.96.62.sslip.io/admin` |
| MCP server URL (for Claude) | `https://help-api.182.95.96.62.sslip.io/mcp` |

> These are this deployment's addresses. If yours differ, use whatever your administrator gave you —
> the **Claude MCP Connect** page always shows the correct Server URL for your instance.

### Step 1 — Log in and get your token

1. Open **`https://help-ui.182.95.96.62.sslip.io/admin`** and sign in with the admin email + password you were given.
2. Open **Claude MCP Connect** in the left menu → **Generate token** → **copy** the `hamcp_…` token.
3. Confirm the status shows **Active**.

### Step 2 — Connect Claude

Use the **HTTPS** server URL (not `localhost`). The **Claude MCP Connect** page already fills your real
token into these snippets — copy from there.

**Claude Code (recommended):**

```bash
claude mcp add --transport http helpassistant \
  https://help-api.182.95.96.62.sslip.io/mcp \
  --header "Authorization: Bearer hamcp_YOUR_TOKEN_HERE"
```

**Claude Desktop** — add to `claude_desktop_config.json`, then restart:

```json
{
  "mcpServers": {
    "helpassistant": {
      "type": "http",
      "url": "https://help-api.182.95.96.62.sslip.io/mcp",
      "headers": {
        "Authorization": "Bearer hamcp_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Because the server is now on **public HTTPS**, Claude Code and Claude Desktop work from **any machine** —
they no longer need to be on the same computer as HelpAssistant.

> **claude.ai (web):** even hosted, claude.ai still can't connect with just a token — its custom connectors
> require an **OAuth** layer in front of `/mcp`. Until that's added, use **Claude Code** or **Claude Desktop**.

### Step 3 — Use it

Same as **Section 5** above — ask Claude in plain language (e.g. *"Use the helpassistant tools to map
`https://qa.twixor.digital` and draft manuals for each screen"*), and watch the **Recent calls** list on the
Claude MCP Connect page to confirm it's working.

### Optional — browser extension (hosted)

Same install steps as **Section 6**, with one change: when you connect a tab, set the extension's
**Backend URL** to the hosted API — **`https://help-api.182.95.96.62.sslip.io`** — and paste the same token.

### Good to know about the hosted version

- **Nothing to run locally.** No `npm`, no database, no Playwright install — the server already has all of it.
- **Everyone shares one connector token.** Rotating or revoking it (on the Claude MCP Connect page) affects every connected client — coordinate before you rotate.
- **Use HTTPS everywhere** — never paste the token into a plain `http://` address.
- If a page won't load or login fails, contact whoever administers the deployment; you can't fix a hosted server from your own machine.
