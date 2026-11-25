import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { DevicePaneProvider } from "@/contexts/DevicePaneContext"
import { useCan } from "@/hooks/useCapability"
import { useCurrentUser } from "@/hooks/useCurrentUser"
import { useEditionIdentity } from "@/edition/hooks"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { NO_CAPABILITIES, type MeResponse } from "../../../shared/contracts/identity"

const me = (username: string, terminal: boolean): MeResponse => ({
  authenticated: true,
  edition: "team",
  user: { id: `u_${username}`, username, displayName: username },
  capabilities: { ...NO_CAPABILITIES, terminal },
})

function Probe() {
  const user = useCurrentUser()
  const can = useCan()
  const identity = useEditionIdentity()
  return <p data-testid="probe">{`${user.user?.username}:${can("terminal")}:${identity.can("terminal")}`}</p>
}

afterEach(() => {
  cleanup()
  __resetCapabilitiesForTest()
  window.history.replaceState(null, "", "/")
})

describe("identity in a machine's pane", () => {
  it("answers for the pane's machine while another machine is on screen", () => {
    window.history.replaceState(null, "", "/d/dev_a/")
    setMe(me("alice", true))
    window.history.replaceState(null, "", "/d/dev_b/")
    setMe(me("bob", false))

    render(<DevicePaneProvider value="dev_a"><Probe /></DevicePaneProvider>)
    expect(screen.getByTestId("probe")).toHaveTextContent("alice:true:true")
  })
})
