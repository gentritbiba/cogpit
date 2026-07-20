import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  LOCAL_DEVICE_ID,
  getActiveDeviceId,
  isRemoteDeviceActive,
  devicePrefix,
  withBase,
  deviceScopedKey,
  saveLastPath,
  switchDevice,
} from "@/lib/device"

function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

describe("device", () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
    setPath("/")
  })

  // ── getActiveDeviceId ─────────────────────────────────────────────────

  describe("getActiveDeviceId", () => {
    it("returns local for the root path", () => {
      setPath("/")
      expect(getActiveDeviceId()).toBe(LOCAL_DEVICE_ID)
    })

    it("parses the id from /d/<id>", () => {
      setPath("/d/dev_abc123")
      expect(getActiveDeviceId()).toBe("dev_abc123")
    })

    it("parses the id from /d/<id>/<dir>/<session>", () => {
      setPath("/d/dev_abc123/-Users-foo/sess-1")
      expect(getActiveDeviceId()).toBe("dev_abc123")
    })

    it("handles the trailing slash form /d/<id>/", () => {
      setPath("/d/dev_x/")
      expect(getActiveDeviceId()).toBe("dev_x")
    })

    it("treats a claude dirName path as local (dirNames start with '-', no collision)", () => {
      setPath("/-Users-gentritbiba-agent-window")
      expect(getActiveDeviceId()).toBe(LOCAL_DEVICE_ID)
    })

    it("treats a codex dirName path as local", () => {
      setPath("/codex__Users-foo/sess")
      expect(getActiveDeviceId()).toBe(LOCAL_DEVICE_ID)
    })
  })

  // ── isRemoteDeviceActive / devicePrefix ───────────────────────────────

  describe("isRemoteDeviceActive", () => {
    it("is false on the local device", () => {
      setPath("/-Users-foo/sess")
      expect(isRemoteDeviceActive()).toBe(false)
    })

    it("is true on a remote device", () => {
      setPath("/d/dev_x/")
      expect(isRemoteDeviceActive()).toBe(true)
    })
  })

  describe("devicePrefix", () => {
    it("is empty for the local device", () => {
      setPath("/")
      expect(devicePrefix()).toBe("")
    })

    it("is /hub/<id> for a remote device", () => {
      setPath("/d/dev_x/")
      expect(devicePrefix()).toBe("/hub/dev_x")
    })
  })

  // ── withBase ──────────────────────────────────────────────────────────

  describe("withBase", () => {
    it("is a no-op on the local device", () => {
      setPath("/")
      expect(withBase("/api/foo")).toBe("/api/foo")
      expect(withBase("/__pty")).toBe("/__pty")
      expect(withBase("/api/hub/devices")).toBe("/api/hub/devices")
    })

    describe("on a remote device", () => {
      beforeEach(() => setPath("/d/dev_x/"))

      it("prefixes /api/* URLs", () => {
        expect(withBase("/api/foo")).toBe("/hub/dev_x/api/foo")
      })

      it("prefixes /__pty URLs", () => {
        expect(withBase("/__pty")).toBe("/hub/dev_x/__pty")
      })

      it("never prefixes /api/hub/* (hub-scoped)", () => {
        expect(withBase("/api/hub/devices")).toBe("/api/hub/devices")
      })

      it("never prefixes /api/auth/* (hub-scoped)", () => {
        expect(withBase("/api/auth/verify")).toBe("/api/auth/verify")
      })

      it("leaves non-api, non-pty strings untouched", () => {
        expect(withBase("/something")).toBe("/something")
        expect(withBase("relative/path")).toBe("relative/path")
        expect(withBase("https://example.com/api/x")).toBe("https://example.com/api/x")
      })
    })
  })

  // ── deviceScopedKey ───────────────────────────────────────────────────

  describe("deviceScopedKey", () => {
    it("returns the bare key on the local device", () => {
      setPath("/")
      expect(deviceScopedKey("cogpit:permissions")).toBe("cogpit:permissions")
    })

    it("suffixes the key with the device id on a remote device", () => {
      setPath("/d/dev_x/")
      expect(deviceScopedKey("cogpit:permissions")).toBe("cogpit:permissions::dev_x")
    })
  })

  // ── saveLastPath / switchDevice ───────────────────────────────────────

  describe("saveLastPath", () => {
    it("writes the last path to sessionStorage keyed by device", () => {
      saveLastPath("dev_x", "/d/dev_x/-Users-foo/sess-1")
      expect(sessionStorage.getItem("cogpit-last-path::dev_x")).toBe(
        "/d/dev_x/-Users-foo/sess-1",
      )
    })
  })

  describe("switchDevice", () => {
    it("pushes /d/<id>/ and dispatches the change event for a remote device with no saved path", () => {
      const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {})
      const handler = vi.fn()
      window.addEventListener("cogpit-device-changed", handler)

      switchDevice("dev_x")

      expect(pushSpy).toHaveBeenCalledWith(null, "", "/d/dev_x/")
      expect(handler).toHaveBeenCalledOnce()

      window.removeEventListener("cogpit-device-changed", handler)
    })

    it("pushes / for the local device with no saved path", () => {
      const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {})
      switchDevice(LOCAL_DEVICE_ID)
      expect(pushSpy).toHaveBeenCalledWith(null, "", "/")
    })

    it("restores the saved last path when present", () => {
      sessionStorage.setItem("cogpit-last-path::dev_x", "/d/dev_x/-Users-foo/sess-1")
      const pushSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {})

      switchDevice("dev_x")

      expect(pushSpy).toHaveBeenCalledWith(null, "", "/d/dev_x/-Users-foo/sess-1")
    })
  })
})
