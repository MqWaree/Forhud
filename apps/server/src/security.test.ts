import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateIp } from "./security";
describe("SSRF protection", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.2",
    "172.16.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fd00::1",
    "::ffff:10.0.0.2",
    "::ffff:172.16.0.2",
    "::ffff:192.168.0.2",
  ])(`blocks private IP %s`, (ip) => expect(isPrivateIp(ip)).toBe(true));
  it("allows public IPs", () => expect(isPrivateIp("1.1.1.1")).toBe(false));
  it("rejects localhost without resolving", async () =>
    await expect(assertPublicUrl("http://localhost/admin")).rejects.toThrow(
      /Internal/,
    ));
  it("rejects non-http protocols", async () =>
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(
      /HTTP/,
    ));
});
