# HelpAssistant Connector (browser extension)

Bridges your **real, logged-in browser tab** to the HelpAssistant backend so Claude (via the MCP server) can capture pixel-perfect screenshots, record the screen's live API calls, and drive actions to map flows — **without copying session tokens** and with full fidelity. Works on any web app, no changes to the target app.

## Install (developer/unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.

## Use

1. In HelpAssistant admin → **MCP Connect**, generate the **connector token** (`hamcp_…`).
2. Open the target app and log in as normal.
3. Click the extension icon → paste the **Backend URL** (e.g. `http://localhost:3000`) and the **connector token** → **Connect this tab**.
   - Chrome shows a "… is debugging this browser" banner while connected — that's the CDP attach. Expected.
4. In Claude (connected to the same MCP server), use:
   - `list_connected_browsers` — confirm the session is live.
   - `capture_live_screen` — screenshot + URL + the screen's API calls.
   - `drive_action` — `navigate` / `click` / `type` to walk through flows.
   - `publish_tutorial` — save the captured screen + API endpoints as a user manual.
5. Click **Disconnect** when finished.

## How it works

```
popup → background SW ──register / long-poll──▶ /connector (token-gated)
        (chrome.debugger / CDP)               ◀──commands (Claude via MCP)
   • Page.captureScreenshot (pixel-perfect)   ──results / API events──▶ bridge
   • Network.* (real API calls + bodies)
   • Runtime.evaluate (click / type / navigate)
```

The extension only attaches and captures **while you are connected**; it detaches automatically when you disconnect or close the tab.

## Security (read before using on anything but staging)

- **Operator/staging use only.** A connected tab is remotely controllable and its screens + API payloads are captured. Do not use on production end-user sessions or with sensitive personal data.
- The connector **token** is the same bearer used by the MCP server — keep it secret; rotate it from MCP Connect if exposed (revoking it instantly cuts the extension off).
- Nothing runs in the background until you press **Connect**; **Disconnect** (or closing the tab) fully detaches.
- All transport is token-gated; use **HTTPS** for the backend URL in any non-local setup.
