import dns from "node:dns/promises";
import net from "node:net";

export function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = p;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mappedIpv4 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
    if (mappedIpv4) return isPrivateIp(mappedIpv4);
    return (
      s === "::" ||
      s === "::1" ||
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      /^fe[89ab]/.test(s) ||
      s.startsWith("ff")
    );
  }
  return true;
}
export async function assertPublicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only public HTTP(S) URLs are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  )
    throw new Error("Internal host blocked");
  const records = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address)))
    throw new Error("Private or internal address blocked");
  return url;
}
