import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolveAll = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

const resolveAll: ResolveAll = (hostname) => lookup(hostname, { all: true });

// Addresses our server must never be made to call: its own machine, the
// private network, cloud metadata (169.254.169.254) and reserved ranges.
const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mappedV4) return isPublicAddress(mappedV4);

  const family = isIP(address);
  if (family === 0) return false;
  return !privateRanges.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Whether a webhook may be sent to this URL: https, and every address the
 * name resolves to is public. The name is resolved again when the request is
 * made, so a name that changes in between (DNS rebinding) is not covered.
 */
export async function isAllowedWebhookDestination(
  url: URL,
  resolve: ResolveAll = resolveAll,
): Promise<boolean> {
  if (url.protocol !== "https:") return false;

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  try {
    const addresses = await resolve(hostname);
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return false;
  }
}
