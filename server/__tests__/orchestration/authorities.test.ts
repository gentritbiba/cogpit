// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { localHost } from "../../sessionHosts/localHost"
import { commandDispatcher } from "../../lib/durableSend"
import { __resetEditionForTest, PERSONAL_EDITION } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"
import { createInstanceRuntime } from "../../agents/instanceRuntime"
import { instanceSessionId } from "../../../shared/session/instances"

afterEach(__resetEditionForTest)
describe("durable session authority", () => {
  it("checks receipt access against its native session before and after waiting", async () => {
    const dispatcher = commandDispatcher()
    const conversation = dispatcher.store.ensureConversation({ hostId: "local", agent: "codex", instanceId: "default", sessionId: "private" })
    dispatcher.store.admit("local", "private-receipt", conversation.id, { message: "Private request" })
    let allowed = false
    installFakeEdition({ access: { ...PERSONAL_EDITION.access, levelOf: async (_req, id) => id === "private" && !allowed ? null : "own" } })
    const req = new IncomingMessage(new Socket())
    await expect(localHost.receipt!("private-receipt", req)).rejects.toMatchObject({ status: 403 })
    allowed = true
    const waiting = localHost.receipt!("private-receipt", req, 20)
    const rejected = expect(waiting).rejects.toMatchObject({ status: 403 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    allowed = false
    await rejected
  })
  it("returns inactive read state for another provider account without launching a process", () => {
    const runtime = createInstanceRuntime({ id: "00000000-0000-4000-8000-000000000001", agent: "codex", label: "Account", homeDir: process.env.COGPIT_ORCHESTRATION_ROOT!, createdAt: 1 }, process.env.COGPIT_ORCHESTRATION_ROOT!)
    for (const id of ["native-default", instanceSessionId("00000000-0000-4000-8000-000000000002", "other")]) {
      expect(runtime.activity(id)).toEqual({ live: false, running: false })
      expect(runtime.hasSession(id)).toBe(false)
      expect(runtime.listPendingQuestions(id)).toEqual([])
      expect(runtime.listPendingApprovals(id)).toEqual([])
    }
  })
})
