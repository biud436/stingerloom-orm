import { BadRequestException } from "@nestjs/common";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF (Server-Side Request Forgery) guard for outbound webhook URLs.
 *
 * Endpoint URLs are user-supplied. Without validation a tenant could point an
 * endpoint at `http://169.254.169.254/latest/meta-data/` (cloud metadata),
 * `http://localhost:6379` (a co-located Redis), or any RFC1918 host and weaponise
 * our worker into a confused deputy. This module enforces, at BOTH write time
 * (create/update) and delivery time (fetch), that an endpoint:
 *
 *   1. uses an allowed scheme (https only by default),
 *   2. carries no embedded credentials (`https://user:pass@host`),
 *   3. resolves to a PUBLIC IP — every private / loopback / link-local /
 *      unique-local range is rejected.
 *
 * Re-validating at delivery time (not just at write time) closes the
 * DNS-rebinding hole: a hostname that resolved to a public IP at create time
 * could later resolve to `127.0.0.1`. We resolve again immediately before the
 * fetch and pin the connection to the validated IP.
 *
 * ── Local/dev escape hatch ──────────────────────────────────────────────────
 * `WEBHOOK_ALLOWED_HOSTS` (comma-separated hostnames, optionally `host:port`)
 * whitelists targets for e2e tests and local development that legitimately
 * deliver to `127.0.0.1` sinks. The production default is empty, so the guard
 * is fully strict unless an operator opts a host in. Setting
 * `WEBHOOK_ALLOW_HTTP=true` additionally permits the `http:` scheme (tests).
 */

/** Private / loopback / link-local / unique-local ranges that must be blocked. */
const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["255.255.255.255", 32], // broadcast
];

export interface SafeWebhookUrl {
  url: URL;
  /** The validated, resolved IP the connection should be pinned to. */
  ip: string;
  family: 4 | 6;
}

function parseAllowedHosts(): Set<string> {
  const raw = process.env.WEBHOOK_ALLOWED_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hostIsAllowlisted(url: URL): boolean {
  const allowed = parseAllowedHosts();
  if (allowed.size === 0) return false;
  const host = url.hostname.toLowerCase();
  const hostPort = `${host}:${url.port || defaultPort(url.protocol)}`;
  return allowed.has(host) || allowed.has(hostPort);
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function allowHttp(): boolean {
  return process.env.WEBHOOK_ALLOW_HTTP === "true";
}

/**
 * Validate the URL string structurally (scheme / credentials) and return the
 * parsed `URL`. Throws `BadRequestException` for anything malformed or unsafe
 * at the syntactic level — DNS resolution is a separate step.
 */
export function parseAndValidateScheme(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`Invalid webhook URL: ${rawUrl}`);
  }

  const httpsOk = url.protocol === "https:";
  const httpOk = url.protocol === "http:" && allowHttp();
  if (!httpsOk && !httpOk) {
    throw new BadRequestException(
      `Webhook URL must use https (got ${url.protocol.replace(":", "") || "?"})`,
    );
  }

  if (url.username || url.password) {
    throw new BadRequestException(
      "Webhook URL must not contain embedded credentials",
    );
  }

  if (!url.hostname) {
    throw new BadRequestException("Webhook URL must include a host");
  }

  return url;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inV4Cidr(ip: string, base: string, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** True when `ip` is loopback / private / link-local / ULA — i.e. NOT routable. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return BLOCKED_V4_CIDRS.some(([base, bits]) => inV4Cidr(ip, base, bits));
  }
  if (family === 6) {
    const norm = ip.toLowerCase();
    // IPv4-mapped (::ffff:127.0.0.1) → validate the embedded v4.
    const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (norm === "::1" || norm === "::") return true; // loopback / unspecified
    if (norm.startsWith("fe80")) return true; // link-local
    // Unique-local fc00::/7 — first byte 0xfc or 0xfd.
    const firstByte = parseInt(norm.split(":")[0].padStart(4, "0").slice(0, 2), 16);
    if ((firstByte & 0xfe) === 0xfc) return true;
    return false;
  }
  // Unparseable → treat as unsafe.
  return true;
}

/**
 * Full validation: scheme + credentials + DNS-resolved IP range. Returns the
 * resolved IP so the caller can pin the connection (DNS-rebind defense).
 *
 * Allowlisted hosts (`WEBHOOK_ALLOWED_HOSTS`) skip the private-range block but
 * still go through scheme/credential validation and DNS resolution.
 */
export async function assertSafeWebhookUrl(
  rawUrl: string,
): Promise<SafeWebhookUrl> {
  const url = parseAndValidateScheme(rawUrl);
  const allowlisted = hostIsAllowlisted(url);

  // If the host is already a literal IP, validate it directly.
  const literalFamily = isIP(url.hostname);
  if (literalFamily !== 0) {
    if (!allowlisted && isBlockedIp(url.hostname)) {
      throw new BadRequestException(
        `Webhook URL resolves to a blocked address: ${url.hostname}`,
      );
    }
    return { url, ip: url.hostname, family: literalFamily as 4 | 6 };
  }

  // Resolve the hostname and validate every returned address.
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookup(url.hostname, { all: true });
  } catch {
    throw new BadRequestException(
      `Webhook URL host could not be resolved: ${url.hostname}`,
    );
  }
  if (resolved.length === 0) {
    throw new BadRequestException(
      `Webhook URL host could not be resolved: ${url.hostname}`,
    );
  }

  if (!allowlisted) {
    for (const { address } of resolved) {
      if (isBlockedIp(address)) {
        throw new BadRequestException(
          `Webhook URL resolves to a blocked address: ${url.hostname} → ${address}`,
        );
      }
    }
  }

  const first = resolved[0];
  return {
    url,
    ip: first.address,
    family: (first.family === 6 ? 6 : 4) as 4 | 6,
  };
}
