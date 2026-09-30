/**
 * url-guard.ts — SSRF protection for the AI pipeline's server-side browser.
 *
 * The pipeline drives a headless Chromium against an admin-supplied baseUrl,
 * so the target must not be allowed to point at loopback, private, link-local
 * or otherwise internal addresses (cloud metadata endpoints, the DB, etc.).
 *
 * Escape hatch: AI_PIPELINE_ALLOW_PRIVATE=true disables the checks for local
 * development targets. Read directly from process.env (not env.ts) so this
 * module stays self-contained.
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export function privateTargetsAllowed(): boolean {
  return process.env['AI_PIPELINE_ALLOW_PRIVATE'] === 'true';
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

/** True when the IP literal is loopback / private / link-local / CGNAT / unspecified. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => inV4Cidr(ip, base, bits));
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedIp(mapped[1]!);
    if (lower === '::1' || lower === '::') return true;
    const firstHextet = parseInt(lower.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

function normaliseHost(hostname: string): string {
  // URL.hostname keeps brackets around IPv6 literals.
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * Synchronous check on the hostname literal only (no DNS). Used by the
 * browser request guard, where every sub-request/redirect is inspected.
 */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = normaliseHost(hostname);
  return isLocalhostName(host) || isBlockedIp(host);
}

/**
 * Resolve the hostname and throw if it (or any resolved address) is internal.
 * No-op when AI_PIPELINE_ALLOW_PRIVATE=true.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (privateTargetsAllowed()) return;
  const host = normaliseHost(hostname);
  if (isBlockedHostLiteral(host)) {
    throw new Error('Target host resolves to a private or loopback address');
  }
  if (isIP(host)) return;

  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Target host could not be resolved');
  }
  if (!addrs.length) throw new Error('Target host could not be resolved');
  if (addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error('Target host resolves to a private or loopback address');
  }
}
