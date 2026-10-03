import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The hosted MCP server fetches caller-supplied URLs (`urls` inputs) from inside the cluster, so a
 * URL is only fetched when it resolves to a public address — the same rule the service applies to
 * webhook targets (docs/api-contract.md §6). Local stdio runs get the same check; it costs one
 * lookup and closes the same hole on a developer's LAN.
 */
export function isPrivateAddress(ip) {
  const bare = String(ip).split("%")[0]; // a zone id (`fe80::1%en0`) names an interface, not an address
  if (isIP(bare) === 6) return isPrivateV6(hextets(bare));
  const [a, b] = bare.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** An IPv6 address as its eight 16-bit groups: `::` expanded, a trailing dotted quad folded into the last two. */
function hextets(ip) {
  let v = ip.toLowerCase();
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    v = `${v.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? null : tail ? tail.split(":") : [];
  const groups = right === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The IPv6 rule, the same one as the service's `WebhookTargetGuard` (imagestep#475 / #479). WHATWG turns
 * `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`, and this used to look for the dotted form only — so an IPv4 address
 * carried inside an IPv6 one (v4-mapped, v4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) is taken out and
 * judged by the IPv4 rule. The special-purpose blocks a public host never answers from, and the ones whose embedded
 * address cannot be read back (Teredo), are refused outright: when unsure, closed.
 */
function isPrivateV6(h) {
  const zeroUpTo = (n) => h.slice(0, n).every((g) => g === 0);
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (zeroUpTo(7) && h[7] <= 1) return true; // :: and ::1
  if (zeroUpTo(5) && h[5] === 0xffff) return isPrivateAddress(v4(h[6], h[7])); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return isPrivateAddress(v4(h[6], h[7])); // ::a.b.c.d (v4-compatible, deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((g) => g === 0)) return isPrivateAddress(v4(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isPrivateAddress(v4(h[1], h[2])); // 6to4
  if (h[0] === 0x64 && h[1] === 0xff9b) return true; // 64:ff9b:1::/48, local-use NAT64
  if (h[0] === 0x2001 && h[1] === 0) return true; // 2001::/32 Teredo: the IPv4 inside is obfuscated
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x100 && !h[1] && !h[2] && !h[3]) return true; // 100::/64 discard
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (zeroUpTo(4)) return true; // the rest of ::/64 (SIIT ::ffff:0:0:0/96 among it) — no public host lives there
  return false;
}

export async function assertPublicUrl(raw, resolver = lookup) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error(`not a URL: ${raw}`), { code: "invalid_param", param: "urls" });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw Object.assign(new Error(`only http(s) URLs can be fetched: ${raw}`), { code: "invalid_param", param: "urls" });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host, { all: true });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw Object.assign(new Error(`refusing to fetch a private address (${host} → ${address})`), {
        code: "invalid_param",
        param: "urls"
      });
    }
  }
  return url;
}
