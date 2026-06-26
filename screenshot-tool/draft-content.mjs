/**
 * draft-content.mjs — Phase 2: AI Content Generation
 * ────────────────────────────────────────────────────
 * For each screen group in screen_map.json:
 *   - Sends screenshots + DOM context to an AI model (Claude / GPT-4o)
 *   - Receives structured tutorial content (title, description, steps)
 *   - Supports multiple API keys per provider with round-robin for rate limits
 *   - Saves output to output/content_draft.json
 *
 * Run standalone: node draft-content.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync }          from 'node:fs';
import { join, dirname }       from 'node:path';
import { fileURLToPath }       from 'node:url';
import config                  from './scrape.config.mjs';

const __dir       = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR  = join(__dir, 'output');
const SCREEN_MAP  = join(OUTPUT_DIR, 'screen_map.json');
const DRAFT_FILE  = join(OUTPUT_DIR, 'content_draft.json');

// ── AI client with round-robin key rotation ───────────────────────────────────

class AIClient {
  constructor() {
    this.anthropicKeys = config.ai.anthropicKeys ?? [];
    this.openaiKeys    = config.ai.openaiKeys    ?? [];
    this.anthropicIdx  = 0;
    this.openaiIdx     = 0;

    if (this.anthropicKeys.length === 0 && this.openaiKeys.length === 0) {
      throw new Error(
        'No AI keys configured.\n' +
        'Set ANTHROPIC_API_KEY or OPENAI_API_KEY env vars, or fill ai.anthropicKeys / ai.openaiKeys in scrape.config.mjs'
      );
    }
  }

  async draft(screenshotBase64, dom, context) {
    const prompt = buildPrompt(dom, context);

    // Try Anthropic first
    if (this.anthropicKeys.length > 0) {
      const key = this.anthropicKeys[this.anthropicIdx % this.anthropicKeys.length];
      this.anthropicIdx++;
      try {
        return await this._callAnthropic(key, screenshotBase64, prompt);
      } catch (err) {
        console.warn(`  ⚠  Anthropic key ${this.anthropicIdx} failed: ${err.message}`);
      }
    }

    // Fallback: OpenAI
    if (this.openaiKeys.length > 0) {
      const key = this.openaiKeys[this.openaiIdx % this.openaiKeys.length];
      this.openaiIdx++;
      return await this._callOpenAI(key, screenshotBase64, prompt);
    }

    throw new Error('All AI keys exhausted');
  }

  async draftGroup(screenshots, doms, groupContext) {
    const prompt = buildGroupPrompt(doms, groupContext);

    // For multi-image group drafts, send all screenshots to one call
    if (this.anthropicKeys.length > 0) {
      const key = this.anthropicKeys[this.anthropicIdx % this.anthropicKeys.length];
      this.anthropicIdx++;
      try {
        return await this._callAnthropicMulti(key, screenshots, prompt);
      } catch (err) {
        console.warn(`  ⚠  Anthropic group draft failed: ${err.message}`);
      }
    }
    if (this.openaiKeys.length > 0) {
      const key = this.openaiKeys[this.openaiIdx % this.openaiKeys.length];
      this.openaiIdx++;
      return await this._callOpenAIMulti(key, screenshots, prompt);
    }
    throw new Error('All AI keys exhausted');
  }

  async _callAnthropic(key, imageBase64, prompt) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      config.ai.anthropicModel || 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role:    'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
            { type: 'text',  text: prompt },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return parseAIResponse(data.content[0].text);
  }

  async _callAnthropicMulti(key, images, prompt) {
    const content = [];
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } });
    }
    content.push({ type: 'text', text: prompt });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      config.ai.anthropicModel || 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return parseAIResponse(data.content[0].text);
  }

  async _callOpenAI(key, imageBase64, prompt) {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model:           config.ai.openaiModel || 'gpt-4o',
        max_tokens:      4096,
        response_format: { type: 'json_object' },
        messages: [{
          role:    'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            { type: 'text',      text: prompt },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return parseAIResponse(data.choices[0].message.content);
  }

  async _callOpenAIMulti(key, images, prompt) {
    const content = images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${img}` },
    }));
    content.push({ type: 'text', text: prompt });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model:           config.ai.openaiModel || 'gpt-4o',
        max_tokens:      6000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }],
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return parseAIResponse(data.choices[0].message.content);
  }
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildGroupPrompt(doms, ctx) {
  const domSummary = doms.map((d, i) => `
Screen ${i + 1}: "${ctx.screenNames[i]}"
URL: ${d.url}
Heading: ${d.heading}
Inputs: ${d.inputs.map(f => `${f.label || f.placeholder || f.id} (${f.type})`).join(', ') || 'none'}
Buttons: ${d.buttons.map(b => b.text).join(', ') || 'none'}
Body excerpt: ${d.bodyText.slice(0, 200)}
`).join('\n');

  return `You are a senior technical documentation writer creating user guides for ${ctx.appName}.

I am showing you ${doms.length} sequential screenshots from the "${ctx.groupName}" flow.

DOM context for each screen:
${domSummary}

Your task: Write a complete tutorial page covering all these screens as sequential steps.

Output ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "page": {
    "title": "Action-oriented tutorial title (e.g., 'How to Log In to ${ctx.appName}')",
    "description": "1-2 sentences describing what this tutorial covers and who it helps.",
    "routePath": "${ctx.routePath}"
  },
  "steps": [
    {
      "stepNumber": 1,
      "title": "Verb-first step title (e.g., 'Enter your Email Address')",
      "instructionsMd": "## Step Title\\n\\nMarkdown with **bold UI labels**, numbered sub-actions. 3-6 sentences.",
      "screenshotId": "${ctx.screenIds[0]}"
    }
  ]
}

Rules:
- Every screenshot must become exactly 1 step
- Use **bold** for every UI element name (button, field, link, tab)
- Be specific: mention exact label text, button colors, placement (left/right/top)
- screenshotId must be the exact ID from the input list: ${ctx.screenIds.join(', ')}
- Do not hallucinate features not visible in the screenshots
- instructionsMd must start with "## " + the step title`;
}

function buildPrompt(dom, ctx) {
  return buildGroupPrompt([dom], {
    ...ctx,
    screenNames: [ctx.screenName],
    doms: [dom],
  });
}

function parseAIResponse(text) {
  // Strip markdown code fences if present
  const clean = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Try to extract JSON from the response
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`AI returned unparseable response:\n${clean.slice(0, 300)}`);
  }
}

// ── Read screenshot as base64 ─────────────────────────────────────────────────

async function toBase64(path) {
  const buf = await readFile(path);
  return buf.toString('base64');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runDrafter(screenMapInput) {
  console.log('\n════════════════════════════════════════');
  console.log(' Phase 2 — AI Content Generation        ');
  console.log('════════════════════════════════════════');

  const screenMap = screenMapInput ?? JSON.parse(await readFile(SCREEN_MAP, 'utf8'));
  const ai        = new AIClient();
  const tutorials = [];

  for (const group of screenMap.groups) {
    console.log(`\n── Group: ${group.name} (${group.screenIds.length} screens) ──`);

    const groupScreens = group.screenIds
      .map(id => screenMap.screens.find(s => s.id === id))
      .filter(Boolean);

    if (groupScreens.length === 0) {
      console.log('  ⚠  No screens found for this group — skipping');
      continue;
    }

    try {
      // Load all screenshots as base64
      const screenshots = await Promise.all(
        groupScreens.map(s => toBase64(s.screenshotPath))
      );
      const doms        = groupScreens.map(s => s.dom);

      const ctx = {
        appName:     screenMap.appName,
        groupName:   group.name,
        routePath:   group.routePath ?? '/',
        screenIds:   group.screenIds,
        screenNames: groupScreens.map(s => s.name),
      };

      console.log(`  → Calling AI for ${groupScreens.length} screens…`);
      const draft = await ai.draftGroup(screenshots, doms, ctx);

      // Attach screenshot IDs to each step
      draft.steps = (draft.steps ?? []).map((step, i) => ({
        ...step,
        stepNumber:   i + 1,
        screenshotId: step.screenshotId ?? groupScreens[i]?.id ?? '',
      }));

      tutorials.push({
        groupId:   group.id,
        groupName: group.name,
        ...draft,
      });

      console.log(`  ✓ Drafted "${draft.page?.title}" with ${draft.steps?.length ?? 0} steps`);
    } catch (err) {
      console.error(`  ✗ ${group.name}: ${err.message}`);
    }
  }

  const output = {
    appName:     screenMap.appName,
    generatedAt: new Date().toISOString(),
    totalTutorials: tutorials.length,
    tutorials,
    // Keep screen map reference for Phase 3
    screens: screenMap.screens,
  };

  await writeFile(DRAFT_FILE, JSON.stringify(output, null, 2));

  console.log('\n════════════════════════════════════════');
  console.log(` Phase 2 complete — ${tutorials.length} tutorials drafted`);
  console.log(` Saved → output/content_draft.json`);
  console.log('════════════════════════════════════════');

  return output;
}

// ── Standalone entry ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDrafter().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
