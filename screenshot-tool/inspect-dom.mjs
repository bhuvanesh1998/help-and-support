/**
 * inspect-dom.mjs — dumps interactive element selectors from qa.twixor.digital/login
 * Run: node inspect-dom.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx     = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page    = await ctx.newPage();

await page.goto('https://qa.twixor.digital/login', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

const elements = await page.evaluate(() => {
  const result = [];

  document.querySelectorAll('input, button, a, [role="button"], [tabindex]').forEach(el => {
    const tag   = el.tagName.toLowerCase();
    const type  = el.getAttribute('type') || '';
    const id    = el.id || '';
    const name  = el.getAttribute('name') || '';
    const ph    = el.getAttribute('placeholder') || '';
    const cls   = [...el.classList].join(' ').slice(0, 60);
    const text  = el.textContent.trim().slice(0, 60);
    const href  = el.getAttribute('href') || '';
    const role  = el.getAttribute('role') || '';

    result.push({ tag, type, id, name, placeholder: ph, class: cls, text, href, role });
  });

  return result;
});

console.log('\n── Interactive elements on /login ──────────────────────────\n');
for (const el of elements) {
  const attrs = [
    el.type     && `type="${el.type}"`,
    el.id       && `id="${el.id}"`,
    el.name     && `name="${el.name}"`,
    el.placeholder && `placeholder="${el.placeholder}"`,
    el.href     && `href="${el.href}"`,
    el.role     && `role="${el.role}"`,
  ].filter(Boolean).join(' ');

  console.log(`<${el.tag} ${attrs}>`);
  if (el.text) console.log(`   text: "${el.text}"`);
  if (el.class) console.log(`   class: "${el.class}"`);
  console.log();
}

await browser.close();
