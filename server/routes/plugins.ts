import { createHash } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { z } from "zod"
import { parseFrameMessage } from "@cogpit/plugin-contracts"
import { clientRuntimeSchema, pluginScopeSchema, pluginProjectSchema } from "../../shared/contracts/pluginManagement"
import { pluginConnectionTargetSchema, pluginConnectionIdentitySchema, pluginConnectionMutationSchema } from "../../shared/contracts/pluginConnections"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../http"
import { PluginAuthorizationError } from "../plugins/authorization"
import { clientImpact } from "../plugins/clientImpact"
import { getPluginManager } from "../plugins/manager"
import { PACKAGE_LIMITS } from "../plugins/package"
import { pluginRuntimeDescriptor } from "../plugins/runtime"
import { PLUGIN_SHELL_HEADERS, PLUGIN_SHELL_HTML } from "../plugins/shell"
import { parseJsonText } from "../plugins/json"

const revisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const uninstallSchema = z.union([revisionSchema.extend({ deleteData: z.literal(false).optional() }), revisionSchema.extend({ deleteData: z.literal(true), expectedConnectionRevision: revisionSchema.shape.expectedRevision })])
const leaseSchema = z.strictObject({ pluginId: z.string().max(128), projectId: z.string().max(64).nullable(), workspacePath: z.string().min(1).max(8192).nullable().optional(), contextEpoch: z.string().min(1).max(128), client: clientRuntimeSchema })
const publisherSchema = z.strictObject({ publisher: z.string().max(64), label: z.string().min(1).max(100), root: z.string().max(PACKAGE_LIMITS.metadata), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), development: z.literal(true) })

async function readBinary(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    length += bytes.length
    if (length > PACKAGE_LIMITS.upload) throw new HttpBodyError("Plugin package exceeds the 4 MiB upload limit", 413)
    chunks.push(bytes)
  }
  if (req.aborted) throw new HttpBodyError("Package upload was interrupted", 400)
  return Buffer.concat(chunks, length)
}

function headerJson(req: IncomingMessage, name: string): unknown {
  const raw = req.headers[name]
  if (typeof raw !== "string" || raw.length > 16_384) throw new HttpBodyError(`Missing or invalid ${name} header`, 400)
  return parseJsonText(Buffer.from(raw), 16_384)
}

export function registerPluginRoutes(use: UseFn): void {
  const manager = getPluginManager()
  use("/api/plugins", async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    const path = (req.url ?? "/").split("?")[0]
    const method = req.method ?? "GET"
    if (method === "GET" && path === "/shell/v1") {
      for (const [name, value] of Object.entries(PLUGIN_SHELL_HEADERS)) res.setHeader(name, value)
      res.end(PLUGIN_SHELL_HTML)
      return
    }
    if (method === "GET" && path === "/runtime") {
      sendJson(res, 200, pluginRuntimeDescriptor(manager?.snapshot().revision))
      return
    }
    const recognized = ["/session", "/status", "/workspace/resolve", "/publishers", "/stage", "/stage-seed", "/leases", "/connections", "/connections/credential", "/connections/options", "/connections/select", "/connections/disconnect", "/connections/clear-data", "/connections/import-legacy"].includes(path)
      || /^\/(?:transactions|payload|installed|leases)\/[a-zA-Z0-9.-]+(?:\/(?:trial|commit|enabled|scope|pin|rollback|renew|call|session))?$/.test(path)
    if (!recognized) { sendJson(res, 404, { code: "NOT_FOUND", error: "Unknown plugin endpoint" }); return }
    const requestAbort = new AbortController()
    const abort = () => requestAbort.abort()
    const responseClosed = () => { if (!res.writableFinished) abort() }
    req.once("aborted", abort)
    res.once("close", responseClosed)
    try {
      if (!manager) throw new PluginAuthorizationError(503, "STALE_ACTIVATION", "Plugin manager is not initialized")
      if (method === "POST" && path === "/session") {
        const input = z.strictObject({ client: clientRuntimeSchema.optional() }).parse(await readJsonBody(req, { allowEmpty: true, maxBytes: 16_384 }))
        sendJson(res, 200, manager.authorization.createOrRenewSession(req, input.client))
        return
      }
      const binding = manager.authorization.resolve(req)
      const checkBinding = manager.authorize(req, binding)
      const socket = req.socket
      const authorize = () => {
        if (requestAbort.signal.aborted || req.aborted || socket.destroyed || res.destroyed) throw new PluginAuthorizationError(409, "STALE_ACTIVATION", "The coordinating client disconnected")
        checkBinding()
      }
      if (method === "DELETE" && path === "/session") {
        manager.authorization.revokeSession(req)
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === "GET" && path === "/status") {
        const projects = await manager.projects.list()
        authorize()
        const store = manager.snapshot()
        const { name, instanceId, ...runtime } = pluginRuntimeDescriptor(store.revision)
        sendJson(res, 200, { runtime, host: { name, instanceId }, store, projects, safeMode: manager.safeMode, connectionRevision: manager.connectionRevision })
        return
      }
      if (method === "POST" && path === "/workspace/resolve") {
        const { workspacePath } = z.strictObject({ workspacePath: z.string().min(1).max(8192) }).parse(await readJsonBody(req, { maxBytes: 16_384 }))
        authorize()
        const project = await manager.projects.resolveWorkspaceProject(workspacePath)
        authorize()
        sendJson(res, 200, pluginProjectSchema.nullable().parse(project))
        return
      }
      if (method === "GET" && path === "/connections") {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams
        if (query.size !== new Set(query.keys()).size) throw new HttpBodyError("Duplicate connection query fields", 400)
        const input = pluginConnectionTargetSchema.parse({ ...Object.fromEntries(query), projectId: query.get("projectId") })
        const result = await manager.listConnections(req, input, { authorize, signal: requestAbort.signal })
        authorize()
        sendJson(res, 200, result)
        return
      }
      if (method === "POST" && path.startsWith("/connections/")) {
        const input = await readJsonBody(req, { maxBytes: 8192 })
        const options = { authorize, signal: requestAbort.signal }
        let result: unknown
        if (path === "/connections/credential") {
          result = await manager.setCredential(req, pluginConnectionMutationSchema.extend({ secret: z.string().min(1).max(4096) }).parse(input), options)
        } else if (path === "/connections/options") {
          result = await manager.listResourceOptions(req, pluginConnectionIdentitySchema.extend({ resourceId: z.string().min(1).max(64) }).parse(input), options)
        } else if (path === "/connections/select") {
          result = await manager.selectResource(req, pluginConnectionMutationSchema.extend({ resourceId: z.string().min(1).max(64), value: z.string().min(1).max(2048).nullable() }).parse(input), options)
        } else if (path === "/connections/disconnect") {
          result = await manager.disconnect(req, pluginConnectionMutationSchema.parse(input), options)
        } else if (path === "/connections/import-legacy") {
          result = await manager.importLegacyConnection(req, pluginConnectionMutationSchema.extend({ replaceExisting: z.boolean().optional() }).parse(input), options)
        } else if (path === "/connections/clear-data") {
          const parsed = revisionSchema.extend({ pluginId: pluginConnectionTargetSchema.shape.pluginId }).parse(input)
          await manager.clearData(req, parsed, options)
          result = { ok: true }
        }
        authorize()
        sendJson(res, 200, result)
        return
      }
      if (method === "POST" && path === "/publishers") {
        const input = publisherSchema.parse(await readJsonBody(req, { maxBytes: PACKAGE_LIMITS.metadata * 2 }))
        const root = Buffer.from(input.root, "utf8")
        parseJsonText(root, PACKAGE_LIMITS.metadata)
        if (createHash("sha256").update(root).digest("hex") !== input.fingerprint) throw new HttpBodyError("Developer root fingerprint changed", 400)
        await manager.store.enrollDeveloper(input.publisher, input.label, root, { authorize })
        sendJson(res, 200, manager.snapshot())
        return
      }
      if (method === "POST" && path === "/stage") {
        const client = clientRuntimeSchema.parse(headerJson(req, "x-cogpit-plugin-client"))
        const scope = pluginScopeSchema.parse(headerJson(req, "x-cogpit-plugin-scope"))
        const bytes = await readBinary(req)
        await manager.validateScope(scope)
        authorize()
        const preview = await manager.store.stage(bytes, { owner: binding.sessionId, client, scope, authorize })
        sendJson(res, 200, clientImpact(preview, manager.authorization.activeClients(binding.sessionId), pluginRuntimeDescriptor()))
        return
      }
      if (method === "POST" && path === "/stage-seed") {
        const input = z.strictObject({ pluginId: pluginConnectionTargetSchema.shape.pluginId, client: clientRuntimeSchema, scope: pluginScopeSchema }).parse(await readJsonBody(req))
        await manager.validateScope(input.scope)
        authorize()
        const preview = await manager.store.stageSeed(input.pluginId, { owner: binding.sessionId, client: input.client, scope: input.scope, authorize })
        sendJson(res, 200, clientImpact(preview, manager.authorization.activeClients(binding.sessionId), pluginRuntimeDescriptor()))
        return
      }
      const [category, id, operation] = path.slice(1).split("/")
      if (method === "GET" && category === "payload" && id && !operation) {
        const payload = await manager.store.payload(id, binding.sessionId)
        authorize()
        res.setHeader("Content-Type", "application/octet-stream")
        res.setHeader("Content-Disposition", 'attachment; filename="plugin.payload"')
        res.setHeader("Content-Length", payload.length)
        res.end(payload)
        return
      }
      if (category === "transactions" && id) {
        if (method === "POST" && operation === "trial") {
          sendJson(res, 200, await manager.store.beginTrial(id, binding.sessionId, { authorize }))
          return
        }
        if (method === "POST" && operation === "commit") {
          const { expectedRevision } = revisionSchema.parse(await readJsonBody(req))
          await manager.store.commit(id, binding.sessionId, { authorize, expectedRevision })
          sendJson(res, 200, manager.snapshot())
          return
        }
        if (method === "GET" && !operation) {
          const outcome = await manager.store.transactionOutcome(id, binding.sessionId)
          authorize()
          sendJson(res, 200, outcome)
          return
        }
        if (method === "DELETE" && !operation) {
          await manager.store.cancel(id, binding.sessionId, { authorize })
          sendJson(res, 200, { ok: true })
          return
        }
      }
      if (category === "installed" && id && (method === "POST" || method === "DELETE")) {
        const input = await readJsonBody(req)
        if (method === "DELETE" && !operation) {
          await manager.uninstall(req, { pluginId: id, ...uninstallSchema.parse(input) }, { authorize, signal: requestAbort.signal })
        } else if (method === "POST" && operation === "enabled") {
          const parsed = revisionSchema.extend({ enabled: z.boolean() }).parse(input)
          await manager.store.setEnabled(id, parsed.enabled, { expectedRevision: parsed.expectedRevision, authorize })
        } else if (method === "POST" && operation === "pin") {
          const parsed = revisionSchema.extend({ pinned: z.boolean() }).parse(input)
          await manager.store.setPin(id, parsed.pinned, { expectedRevision: parsed.expectedRevision, authorize })
        } else if (method === "POST" && operation === "scope") {
          const parsed = revisionSchema.extend({ scope: pluginScopeSchema }).parse(input)
          await manager.validateScope(parsed.scope)
          await manager.store.setScope(id, parsed.scope, { expectedRevision: parsed.expectedRevision, authorize })
        } else if (method === "POST" && operation === "rollback") {
          const parsed = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), client: clientRuntimeSchema, scope: pluginScopeSchema }).parse(input)
          await manager.validateScope(parsed.scope)
          const preview = await manager.store.rollback(id, parsed.digest, { owner: binding.sessionId, client: parsed.client, scope: parsed.scope, authorize })
          sendJson(res, 200, clientImpact(preview, manager.authorization.activeClients(binding.sessionId), pluginRuntimeDescriptor()))
          return
        } else { sendJson(res, 404, { code: "NOT_FOUND", error: "Unknown plugin action" }); return }
        sendJson(res, 200, manager.snapshot())
        return
      }
      if (method === "POST" && path === "/leases") {
        const lease = await manager.createLease(req, leaseSchema.parse(await readJsonBody(req)))
        sendJson(res, 200, { id: lease.id, expiresAt: lease.expiresAt })
        return
      }
      if (category === "leases" && id) {
        if (method === "DELETE" && !operation) {
          manager.leases.revoke(binding, id)
          sendJson(res, 200, { ok: true })
          return
        }
        if (method === "POST" && operation === "renew") {
          const lease = await manager.renewLease(req, id)
          sendJson(res, 200, { id: lease.id, expiresAt: lease.expiresAt })
          return
        }
        if (method === "POST" && operation === "session") {
          const { handle } = z.strictObject({ handle: z.string().regex(/^s_[a-f0-9]{48}$/) }).parse(await readJsonBody(req, { maxBytes: 1024 }))
          const address = await manager.resolveSession(req, id, handle, requestAbort.signal)
          authorize()
          sendJson(res, 200, address)
          return
        }
        if (method === "POST" && operation === "call") {
          const request = parseFrameMessage(await readJsonBody(req))
          if (request.type !== "request") throw new HttpBodyError("Expected a plugin request", 400)
          const value = await manager.call(req, id, request, { signal: requestAbort.signal })
          authorize()
          sendJson(res, 200, { value })
          return
        }
      }
      sendJson(res, 405, { code: "METHOD_NOT_ALLOWED", error: "Unsupported plugin action" })
    } catch (error) {
      const status = error instanceof PluginAuthorizationError ? error.status : error instanceof HttpBodyError ? error.statusCode : 400
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "INVALID_REQUEST"
      sendJson(res, status, { code, error: (error instanceof Error ? error.message : "Plugin request failed").slice(0, 1000) })
    } finally {
      req.removeListener("aborted", abort)
      res.removeListener("close", responseClosed)
    }
  })
}
