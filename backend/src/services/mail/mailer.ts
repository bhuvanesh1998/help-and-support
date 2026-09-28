/**
 * mailer.ts — Outgoing email via the SMTP server configured in the admin.
 * ─────────────────────────────────────────────────────────────────────
 * The transport is built per send from the saved SmtpConfig row (password is
 * decrypted just-in-time and never logged). All user-supplied content is
 * HTML-escaped before it reaches a template.
 */

import nodemailer from 'nodemailer';
import { open } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { getSiteSettings, getSmtpRow } from '../support/settings.js';

export class MailNotConfiguredError extends Error {
  constructor() {
    super('SMTP is not configured — set host and from address in Settings.');
    this.name = 'MailNotConfiguredError';
  }
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

async function buildTransport() {
  const row = await getSmtpRow();
  if (!row.host || !row.fromEmail) throw new MailNotConfiguredError();
  let pass: string | undefined;
  if (row.passwordCiphertext && row.passwordIv && row.passwordAuthTag) {
    pass = open({ ciphertext: row.passwordCiphertext, iv: row.passwordIv, authTag: row.passwordAuthTag });
  }
  const transport = nodemailer.createTransport({
    host: row.host,
    port: row.port,
    secure: row.secure,
    ...(row.username ? { auth: { user: row.username, pass: pass ?? '' } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const from = row.fromName ? { name: row.fromName, address: row.fromEmail } : row.fromEmail;
  return { transport, from };
}

/** Sends one message. Throws on failure — callers decide whether to swallow. */
export async function sendMail(msg: MailMessage): Promise<void> {
  const { transport, from } = await buildTransport();
  try {
    await transport.sendMail({ from, ...msg });
  } finally {
    transport.close();
  }
}

/** Sends and reports success; logs (never throws) on failure. */
export async function trySendMail(msg: MailMessage, context: string): Promise<boolean> {
  try {
    await sendMail(msg);
    return true;
  } catch (err) {
    logger.warn('mail send failed', {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Templates ──────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped, line breaks preserved. */
function para(s: string): string {
  return escapeHtml(s).replace(/\r?\n/g, '<br/>');
}

export function formatTicketNumber(n: number): string {
  return 'HA-' + String(n).padStart(6, '0');
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

function layout(brand: string, heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f7fa;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#16202b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d8dee6;border-radius:12px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #eef1f5;font-weight:700;font-size:18px;color:#2e6f6a">${escapeHtml(brand)}</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.55">
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid #eef1f5;font-size:12px;color:#5b6573">This is an automated message from ${escapeHtml(brand)} support.</td></tr>
</table></td></tr></table></body></html>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#5b6573;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${para(value)}</td></tr>`;
}

function quote(text: string): string {
  return `<div style="margin:8px 0 0;padding:12px 14px;background:#f5f7fa;border-left:3px solid #2e6f6a;border-radius:6px">${para(text)}</div>`;
}

export interface TicketMailInput {
  number: number;
  name: string;
  email: string;
  phone?: string | null;
  subject: string;
  categoryLabel: string;
  priority: string;
  message: string;
  status: string;
  sourceUrl?: string | null;
}

export async function ticketAckEmail(t: TicketMailInput, slaText: string): Promise<MailMessage> {
  const { brandName } = await getSiteSettings();
  const num = formatTicketNumber(t.number);
  const html = layout(
    brandName,
    `We received your request — ${num}`,
    `<p style="margin:0 0 12px">Hi ${escapeHtml(t.name)},</p>
<p style="margin:0 0 12px">Thanks for contacting us. Your ticket has been logged and our team will reply to this email address.</p>
${slaText ? `<p style="margin:0 0 16px;font-weight:600">${para(slaText)}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 12px">
${row('Ticket', num)}${row('Subject', t.subject)}${row('Category', t.categoryLabel)}${row('Priority', t.priority)}
</table>
<p style="margin:12px 0 0;color:#5b6573;font-size:13px">Your message</p>
${quote(t.message)}`,
  );
  const text = `Hi ${t.name},

Thanks for contacting us. Your ticket has been logged.
${slaText ? `\n${slaText}\n` : ''}
Ticket:   ${num}
Subject:  ${t.subject}
Category: ${t.categoryLabel}
Priority: ${t.priority}

Your message:
${t.message}
`;
  return { to: t.email, subject: `[${num}] We received your request: ${t.subject}`, html, text };
}

export async function ticketNotifyEmail(t: TicketMailInput, to: string): Promise<MailMessage> {
  const { brandName } = await getSiteSettings();
  const num = formatTicketNumber(t.number);
  const html = layout(
    brandName,
    `New support ticket ${num}`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 12px">
${row('From', `${t.name} <${t.email}>`)}${t.phone ? row('Phone', t.phone) : ''}${row('Subject', t.subject)}${row('Category', t.categoryLabel)}${row('Priority', t.priority)}${t.sourceUrl ? row('Page', t.sourceUrl) : ''}
</table>
${quote(t.message)}`,
  );
  const text = `New support ticket ${num}

From:     ${t.name} <${t.email}>${t.phone ? `\nPhone:    ${t.phone}` : ''}
Subject:  ${t.subject}
Category: ${t.categoryLabel}
Priority: ${t.priority}${t.sourceUrl ? `\nPage:     ${t.sourceUrl}` : ''}

${t.message}
`;
  return { to, subject: `[${num}] New ticket (${t.priority}): ${t.subject}`, html, text, replyTo: t.email };
}

export async function ticketReplyEmail(t: TicketMailInput, reply: string): Promise<MailMessage> {
  const { brandName } = await getSiteSettings();
  const num = formatTicketNumber(t.number);
  const status = STATUS_LABEL[t.status] ?? t.status;
  const html = layout(
    brandName,
    `Update on your ticket ${num}`,
    `<p style="margin:0 0 12px">Hi ${escapeHtml(t.name)},</p>
${quote(reply)}
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0 0">
${row('Ticket', num)}${row('Subject', t.subject)}${row('Status', status)}
</table>
<p style="margin:16px 0 0;color:#5b6573;font-size:13px">Reply to this email if you need anything else.</p>`,
  );
  const text = `Hi ${t.name},

${reply}

Ticket:  ${num}
Subject: ${t.subject}
Status:  ${status}
`;
  return { to: t.email, subject: `Re: [${num}] ${t.subject}`, html, text };
}

export async function testEmail(to: string): Promise<MailMessage> {
  const { brandName } = await getSiteSettings();
  const html = layout(
    brandName,
    'SMTP test succeeded',
    `<p style="margin:0">This test message confirms that ${escapeHtml(brandName)} can send email with the saved SMTP settings.</p>`,
  );
  const text = `This test message confirms that ${brandName} can send email with the saved SMTP settings.`;
  return { to, subject: `${brandName}: SMTP test email`, html, text };
}
