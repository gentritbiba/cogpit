import { describe, expect, it } from "vitest"
import * as sdk from "../sdk"

/**
 * The edition package imports these from core, and core's own CI never builds
 * it. Changing this list is a change to the package's API: update the package
 * in the same pair of commits.
 */
const PINNED = [
  "ConfirmActionDialog",
  "HeaderIconButton",
  "InlineEditPanel",
  "LOCAL_DEVICE_ID",
  "agentKindForDirName",
  "agentProjectBadge",
  "authFetch",
  "can",
  "clearSessionListCache",
  "cn",
  "devicePathPrefix",
  "deviceScopedKey",
  "dirNameToPath",
  "formatCost",
  "formatRelativeTime",
  "formatTokenCount",
  "getCurrentUser",
  "isRemoteDeviceActive",
  "jsonFetch",
  "projectGroupKey",
  "publishListsStale",
  "publishSessionAccess",
  "readError",
  "readJson",
  "revealSessionById",
  "sessionAccessTicket",
  "subscribeCapabilities",
  "switchDevice",
  "useCapability",
  "useCurrentUser",
  "useDevices",
  "useProjectList",
  "useProjectNames",
  "useSessionContext",
]

describe("the edition SDK", () => {
  it("exports exactly the pinned slice of core", () => {
    expect(Object.keys(sdk).sort()).toEqual(PINNED)
  })

  it("exports nothing undefined", () => {
    for (const name of PINNED) expect(sdk[name as keyof typeof sdk], name).toBeDefined()
  })
})
