// @vitest-environment node
import { describe, it, expect } from "vitest"
import type { NetworkInterfaceInfo } from "node:os"
import {
  resolveEnvPassword,
  isLoopbackHost,
  shouldFailClosed,
  firstNonInternalIPv4,
  resolveAdvertisedHost,
  buildBootBanner,
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

describe("resolveDeviceName", () => {
  it("prefers COGPIT_DEVICE_NAME", () => {
    expect(resolveDeviceName({ COGPIT_DEVICE_NAME: "studio" }, "fallback-host")).toBe("studio")
  })

  it("falls back to the hostname when unset or blank", () => {
    expect(resolveDeviceName({}, "fallback-host")).toBe("fallback-host")
    expect(resolveDeviceName({ COGPIT_DEVICE_NAME: "  " }, "fallback-host")).toBe("fallback-host")
  })
})
