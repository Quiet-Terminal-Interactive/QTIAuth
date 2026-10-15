import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function expandIpv6(ip: string): number[] {
  let addr = ip;
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  let tail: number[] = [];
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const n = ipv4ToInt(maybeV4);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    addr = addr.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":").filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const r = rest !== undefined && rest ? rest.split(":").filter(Boolean).map((x) => parseInt(x, 16)) : [];
  const fill = addr.includes("::") ? new Array(8 - h.length - r.length).fill(0) : [];
  const groups = [...h, ...fill, ...r];
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) return ip.slice(7);
  return ip;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = normalizeIp(ip);
  const [range, bitsStr] = cidr.split("/") as [string, string | undefined];
  const v = isIP(addr);
  const rv = isIP(range);
  if (!v || v !== rv) return false;
  if (v === 4) {
    const bits = bitsStr === undefined ? 32 : Number(bitsStr);
    if (bits === 0) return true;
    const mask = (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(addr) & mask) === (ipv4ToInt(range) & mask);
  }
  const bits = bitsStr === undefined ? 128 : Number(bitsStr);
  const a = expandIpv6(addr);
  const b = expandIpv6(range);
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((a[i] ?? 0) & mask) !== ((b[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

export function ipSubnet(ip: string): string {
  const addr = normalizeIp(ip);
  const v = isIP(addr);
  if (v === 4) {
    const parts = addr.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (v === 6) {
    const g = expandIpv6(addr);
    return `${g.slice(0, 3).map((x) => x.toString(16)).join(":")}::/48`;
  }
  return addr;
}

const PRIVATE_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "64:ff9b::/96",
  "2001:db8::/32",
];

export function isPrivateIp(ip: string): boolean {
  const addr = normalizeIp(ip);
  return PRIVATE_RANGES.some((r) => ipInCidr(addr, r));
}

export async function assertPublicUrl(url: string, allowPrivate: boolean): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL must use http or https");
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("URL resolves to a private, loopback or link-local address");
  }
}

async function resolvePublicAddress(hostname: string, allowPrivate: boolean): Promise<string> {
  const addrs = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addrs.length) throw new Error("URL hostname did not resolve to any address");
  if (!allowPrivate) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error("URL resolves to a private, loopback or link-local address");
    }
  }
  return addrs[0]!.address;
}

export interface PinnedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  text(): Promise<string>;
}

export async function fetchPinned(url: string, allowPrivate: boolean, init: PinnedRequestInit = {}): Promise<PinnedResponse> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL must use http or https");
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const address = await resolvePublicAddress(hostname, allowPrivate);
  const doRequest = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        hostname: address,
        servername: hostname,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? "GET",
        headers: { ...init.headers, host: u.host },
        signal: init.signal,
      } as never,
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export function clientIp(peer: string | undefined, xff: string | undefined, trusted: string[]): string {
  const socketIp = normalizeIp(peer ?? "0.0.0.0");
  if (!trusted.length) return socketIp;
  const isTrusted = (ip: string) => trusted.some((c) => ipInCidr(ip, c));
  if (!isTrusted(socketIp)) return socketIp;
  const hops = (xff ?? "")
    .split(",")
    .map((h) => normalizeIp(h.trim()))
    .filter((h) => isIP(h));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!isTrusted(hop)) return hop;
  }
  return hops[0] ?? socketIp;
}

export function clientPort(peer: string | undefined, peerPort: number | undefined, header: string | null | undefined, trusted: string[]): number | null {
  const socketIp = normalizeIp(peer ?? "0.0.0.0");
  if (trusted.length && trusted.some((c) => ipInCidr(socketIp, c))) {
    const n = Number(header);
    return header && Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  }
  return peerPort && peerPort > 0 ? peerPort : null;
}

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (isIP(h) || !h.includes(".")) return h;
  const parts = h.split(".");
  const twoLevel = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "co.za", "com.mx", "co.in", "com.cn", "com.tr"]);
  const lastTwo = parts.slice(-2).join(".");
  if (twoLevel.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}
