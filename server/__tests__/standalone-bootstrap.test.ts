// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { NetworkInterfaceInfo } from "node:os"
import {
  resolveEnvPassword,
  isLoopbackHost,
  shouldFailClosed,
  hasUsableNetworkCredentials,
  firstNonInternalIPv4,
  resolveAdvertisedHost,
  buildBootBanner,
  buildTeamBootNotices,
  resolveDeviceName,
} from "../lib/standalone-bootstrap"

// ── resolveEnvPassword ──────────────────────────────────────────────────

describe("resolveEnvPassword", () => {
  it("returns the inline COGPIT_NETWORK_PASSWORD when set", () => {
    expect(resolveEnvPassword({ COGPIT_NETWORK_PASSWORD: "hunter2hunter2" })).toBe("hunter2hunter2")
  })

  it("returns null when neither variable is set", () => {
    expect(resolveEnvPassword({})).toBeNull()
  })

  it("treats an empty inline value as unset", () => {
    expect(resolveEnvPassword({ COGPIT_NETWORK_PASSWORD: "" })).toBeNull()
  })

  it("reads COGPIT_NETWORK_PASSWORD_FILE and trims a single trailing newline", () => {
    const read = (p: string) => {
      expect(p).toBe("/run/secrets/cogpit")
      return "file-secret-value\n"
    }
    expect(
      resolveEnvPassword({ COGPIT_NETWORK_PASSWORD_FILE: "/run/secrets/cogpit" }, read),
    ).toBe("file-secret-value")
  })

  it("trims a trailing CRLF from the password file", () => {
    expect(
      resolveEnvPassword({ COGPIT_NETWORK_PASSWORD_FILE: "/f" }, () => "secret-value\r\n"),
    ).toBe("secret-value")
  })

  it("lets the password FILE win over the inline variable", () => {
    expect(
      resolveEnvPassword(
        { COGPIT_NETWORK_PASSWORD_FILE: "/f", COGPIT_NETWORK_PASSWORD: "inline" },
        () => "from-file",
      ),
    ).toBe("from-file")
  })

  it("treats an empty file as unset", () => {
    expect(resolveEnvPassword({ COGPIT_NETWORK_PASSWORD_FILE: "/f" }, () => "\n")).toBeNull()
  })

  it("propagates a file read error (must be loud, never silently passwordless)", () => {
    expect(() =>
      resolveEnvPassword({ COGPIT_NETWORK_PASSWORD_FILE: "/missing" }, () => {
        throw new Error("ENOENT")
      }),
    ).toThrow("ENOENT")
  })
})

// ── isLoopbackHost / shouldFailClosed ───────────────────────────────────

describe("isLoopbackHost", () => {
  it("recognizes loopback addresses", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true)
    }
  })

  it("treats wildcard and LAN binds as non-loopback", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5"]) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })
})

describe("shouldFailClosed", () => {
  it("fails closed on a non-loopback host with no password", () => {
    expect(shouldFailClosed("0.0.0.0", false)).toBe(true)
    expect(shouldFailClosed("192.168.1.10", false)).toBe(true)
  })

  it("allows a non-loopback host once a password exists", () => {
    expect(shouldFailClosed("0.0.0.0", true)).toBe(false)
  })

  it("never fails closed on loopback (password optional)", () => {
    expect(shouldFailClosed("127.0.0.1", false)).toBe(false)
    expect(shouldFailClosed("localhost", false)).toBe(false)
  })

  it("never fails closed in team edition (user accounts replace the network password)", () => {
    expect(shouldFailClosed("0.0.0.0", false, "team")).toBe(false)
    expect(shouldFailClosed("192.168.1.10", false, "team")).toBe(false)
  })

  it("still fails closed for an explicit personal edition (regression pin)", () => {
    expect(shouldFailClosed("0.0.0.0", false, "personal")).toBe(true)
    expect(shouldFailClosed("192.168.1.10", false, "personal")).toBe(true)
  })
})

describe("hasUsableNetworkCredentials", () => {
  it("accepts an environment password without persisted settings", () => {
    expect(hasUsableNetworkCredentials("environment-password", null)).toBe(true)
  })

  it("requires both persisted network access and a password", () => {
    expect(hasUsableNetworkCredentials(null, {
      networkAccess: true,
      networkPassword: "hashed",
    })).toBe(true)
    expect(hasUsableNetworkCredentials(null, {
      networkAccess: false,
      networkPassword: "hashed",
    })).toBe(false)
    expect(hasUsableNetworkCredentials(null, { networkAccess: true })).toBe(false)
  })
})

// ── banner helpers ──────────────────────────────────────────────────────

const IFACES: Record<string, NetworkInterfaceInfo[]> = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as NetworkInterfaceInfo],
  en0: [{ address: "192.168.1.42", family: "IPv4", internal: false } as NetworkInterfaceInfo],
}

describe("firstNonInternalIPv4", () => {
  it("returns the first non-internal IPv4 address", () => {
    expect(firstNonInternalIPv4(IFACES)).toBe("192.168.1.42")
  })

  it("returns null when only internal interfaces exist", () => {
    expect(firstNonInternalIPv4({ lo0: IFACES.lo0 })).toBeNull()
  })
})

describe("resolveAdvertisedHost", () => {
  it("advertises the LAN IPv4 for a wildcard bind", () => {
    expect(resolveAdvertisedHost("0.0.0.0", IFACES)).toBe("192.168.1.42")
    expect(resolveAdvertisedHost("::", IFACES)).toBe("192.168.1.42")
  })

  it("advertises the bind host verbatim otherwise", () => {
    expect(resolveAdvertisedHost("192.168.1.9", IFACES)).toBe("192.168.1.9")
  })
})

describe("buildBootBanner", () => {
  it("includes the device name, LAN URL, and add-device hint for a wildcard bind", () => {
    const lines = buildBootBanner({ deviceName: "build-box", host: "0.0.0.0", port: 19384, interfaces: IFACES })
    const text = lines.join("\n")
    expect(text).toContain('"build-box"')
    expect(text).toContain("http://192.168.1.42:19384")
    expect(text).toContain("Devices → Add device → 192.168.1.42:19384")
  })

  it("warns when a wildcard bind has no detectable LAN IPv4", () => {
    const lines = buildBootBanner({ deviceName: "box", host: "0.0.0.0", port: 19384, interfaces: { lo0: IFACES.lo0 } })
    expect(lines.join("\n")).toContain("no non-internal IPv4")
  })

  it("uses the explicit host for a non-wildcard bind", () => {
    const lines = buildBootBanner({ deviceName: "box", host: "192.168.1.7", port: 8080, interfaces: IFACES })
    expect(lines.join("\n")).toContain("Devices → Add device → 192.168.1.7:8080")
  })
})

describe("buildTeamBootNotices", () => {
  const base = { host: "0.0.0.0", port: 19384, interfaces: IFACES }

  it("is silent in personal edition regardless of the other inputs", () => {
    expect(
      buildTeamBootNotices({ ...base, edition: "personal", userCount: 0, envPasswordSet: true }),
    ).toEqual([])
  })

  it("announces the first-admin bootstrap URL when no users exist", () => {
    const text = buildTeamBootNotices({
      ...base, edition: "team", userCount: 0, envPasswordSet: false,
    }).join("\n")
    expect(text).toContain("no users yet")
    expect(text).toContain("http://192.168.1.42:19384")
    expect(text).toContain("first admin")
  })

  it("says a plain-HTTP bootstrap URL cannot log a browser in", () => {
    const text = buildTeamBootNotices({
      ...base, edition: "team", userCount: 0, envPasswordSet: false,
    }).join("\n")
    expect(text).toContain("HTTPS")
  })

  it("prefers COGPIT_PUBLIC_URL — the address a browser can actually log in on", () => {
    const text = buildTeamBootNotices({
      ...base, edition: "team", userCount: 0, envPasswordSet: false,
      publicUrl: "https://cogpit.example.com/",
    }).join("\n")
    expect(text).toContain("https://cogpit.example.com to create the first admin")
    expect(text).not.toContain("192.168.1.42")
    // The public URL is already HTTPS-capable: no proxy nag on top of it.
    expect(text).not.toContain("HTTPS")
  })

  it("ignores a blank public URL", () => {
    const text = buildTeamBootNotices({
      ...base, edition: "team", userCount: 0, envPasswordSet: false, publicUrl: "  ",
    }).join("\n")
    expect(text).toContain("http://192.168.1.42:19384")
  })

  it("advertises the loopback URL for a loopback bind", () => {
    const text = buildTeamBootNotices({
      edition: "team", userCount: 0, envPasswordSet: false,
      host: "127.0.0.1", port: 20000, interfaces: IFACES,
    }).join("\n")
    expect(text).toContain("http://127.0.0.1:20000")
  })

  it("warns that a set network password is ignored in team edition", () => {
    const text = buildTeamBootNotices({
      ...base, edition: "team", userCount: 3, envPasswordSet: true,
    }).join("\n")
    expect(text).toContain("COGPIT_NETWORK_PASSWORD")
    expect(text).toContain("ignored")
  })

  it("stays quiet for a team boot with users and no env password", () => {
    expect(
      buildTeamBootNotices({ ...base, edition: "team", userCount: 2, envPasswordSet: false }),
    ).toEqual([])
  })
})

describe("resolveDeviceName", () => {
  it("prefers COGPIT_DEVICE_NAME", () => {
    expect(resolveDeviceName({ COGPIT_DEVICE_NAME: "studio" }, "fallback-host")).toBe("studio")
  })

  it("falls back to the hostname when unset or blank", () => {
    expect(resolveDeviceName({}, "fallback-host")).toBe("fallback-host")
    expect(resolveDeviceName({ COGPIT_DEVICE_NAME: "  " }, "fallback-host")).toBe("fallback-host")
  })
})
