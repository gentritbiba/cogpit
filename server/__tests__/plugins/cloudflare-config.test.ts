// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runGit } from "../../lib/gitProject"
import { configBindings, configEnvironments, describeConfig, discoverWranglerProjects, findLocalWrangler, parseJsonc, selectWranglerProject } from "../../plugins/integrations/cloudflare"

let directory: string
let repository: string
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "cogpit-cloudflare-config-")))
  repository = join(directory, "repository")
  await mkdir(repository)
  await runGit(repository, ["init"])
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe("Wrangler configuration discovery", () => {
  it("finds the repository configuration from a nested session directory and reports the Git root", async () => {
    const cwd = join(repository, "src", "routes")
    await mkdir(cwd, { recursive: true })
    await writeFile(join(repository, "wrangler.toml"), "name = \"api\"\ncompatibility_date = \"2026-01-01\"\n")
    await expect(discoverWranglerProjects(cwd)).resolves.toEqual([expect.objectContaining({ root: repository, configPath: join(repository, "wrangler.toml"), key: "wrangler.toml", repositoryRoot: repository, config: { name: "api", compatibility_date: "2026-01-01" } })])
  })

  it("scans child folders when neither the session directory nor its ancestors hold a configuration", async () => {
    for (const [folder, name] of [["services/router", "router"], ["services/api", "api"], ["node_modules/dep", "dep"], [".hidden", "hidden"], ["a/b/c/d/deep", "deep"]]) {
      await mkdir(join(repository, folder), { recursive: true })
      await writeFile(join(repository, folder, "wrangler.toml"), `name = "${name}"\n`)
    }
    await mkdir(join(repository, "services", "broken"))
    await writeFile(join(repository, "services", "broken", "wrangler.toml"), "name = [unclosed\n")
    const projects = await discoverWranglerProjects(repository)
    expect(projects.map(project => [project.key, project.config.name])).toEqual([["services/api/wrangler.toml", "api"], ["services/router/wrangler.toml", "router"]])
    expect(selectWranglerProject(projects, undefined).key).toBe("services/api/wrangler.toml")
    expect(selectWranglerProject(projects, "services/router/wrangler.toml").config.name).toBe("router")
    expect(() => selectWranglerProject(projects, "services/other/wrangler.toml")).toThrow(expect.objectContaining({ code: "cloudflare_config_invalid" }))
    await writeFile(join(repository, "wrangler.toml"), "name = \"root\"\n")
    await expect(discoverWranglerProjects(repository)).resolves.toEqual([expect.objectContaining({ key: "wrangler.toml", config: { name: "root" } })])
  })

  it("prefers the nearest app configuration and JSON over TOML in the same directory", async () => {
    const app = join(repository, "apps", "api"), cwd = join(app, "src")
    await mkdir(cwd, { recursive: true })
    await writeFile(join(repository, "wrangler.toml"), "name = \"root\"\n")
    await writeFile(join(app, "wrangler.toml"), "name = \"toml\"\n")
    await writeFile(join(app, "wrangler.jsonc"), "{ \"name\": \"jsonc\" }")
    await expect(discoverWranglerProjects(cwd)).resolves.toEqual([expect.objectContaining({ root: app, key: "apps/api/wrangler.jsonc", config: { name: "jsonc" } })])
  })

  it("parses JSONC comments and trailing commas without touching string contents", async () => {
    await writeFile(join(repository, "wrangler.jsonc"), `{
  // The Worker name
  "name": "edge", /* inline */
  "vars": { "GREETING": "hello, // not a comment */", "TRAILING": "a,]" },
  "routes": [ { "pattern": "example.com/*" }, ],
}`)
    await expect(discoverWranglerProjects(repository)).resolves.toEqual([expect.objectContaining({ config: { name: "edge", vars: { GREETING: "hello, // not a comment */", TRAILING: "a,]" }, routes: [{ pattern: "example.com/*" }] } })])
  })

  it("reports a missing configuration instead of searching above the repository", async () => {
    await writeFile(join(directory, "wrangler.toml"), "name = \"outer\"\n")
    await expect(discoverWranglerProjects(repository)).rejects.toMatchObject({ code: "cloudflare_config_missing" })
    await expect(discoverWranglerProjects(join(directory, "missing"))).rejects.toMatchObject({ status: 404, code: "cloudflare_config_missing" })
    await expect(discoverWranglerProjects("relative/path")).rejects.toMatchObject({ code: "cloudflare_config_missing" })
  })

  it("does not fall back past a malformed nearer configuration", async () => {
    const app = join(repository, "app")
    await mkdir(app)
    await writeFile(join(repository, "wrangler.toml"), "name = \"root\"\n")
    await writeFile(join(app, "wrangler.toml"), "name = [unclosed\n")
    await expect(discoverWranglerProjects(app)).rejects.toMatchObject({ code: "cloudflare_config_invalid", message: "Unable to parse wrangler.toml" })
  })

  it("works outside a repository using only the session directory", async () => {
    const folder = join(directory, "plain")
    await mkdir(folder)
    await writeFile(join(folder, "wrangler.json"), "{\"name\":\"plain\"}")
    await expect(discoverWranglerProjects(folder)).resolves.toEqual([expect.objectContaining({ root: folder, key: "wrangler.json", repositoryRoot: null, config: { name: "plain" } })])
    await expect(discoverWranglerProjects(directory)).resolves.toEqual([expect.objectContaining({ key: "plain/wrangler.json" })])
  })
})

describe("Wrangler configuration summary", () => {
  it("lists bindings by kind with resource names and never with values", () => {
    const bindings = configBindings({
      vars: { API_URL: "https://example.com", SECRET_LIKE: "value" },
      kv_namespaces: [{ binding: "SESSIONS", id: "abc" }],
      d1_databases: [{ binding: "DB", database_name: "app", database_id: "d1" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "uploads" }],
      durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }], consumers: [{ queue: "jobs" }] },
      services: [{ binding: "AUTH", service: "auth-worker" }],
      ai: { binding: "AI" },
      assets: { directory: "./public", binding: "ASSETS" },
      workflows: [{ binding: "FLOW", name: "sync", class_name: "Sync" }],
      send_email: [{ name: "MAILER" }],
      unsafe: { bindings: [{ name: "IGNORED", type: "x" }] },
    })
    expect(bindings).toEqual([
      { name: "SESSIONS", type: "kv_namespaces", target: null },
      { name: "DB", type: "d1_databases", target: "app" },
      { name: "FILES", type: "r2_buckets", target: "uploads" },
      { name: "COUNTER", type: "durable_objects", target: "Counter" },
      { name: "JOBS", type: "queues.producers", target: "jobs" },
      { name: "jobs", type: "queues.consumers", target: null },
      { name: "AUTH", type: "services", target: "auth-worker" },
      { name: "FLOW", type: "workflows", target: "sync" },
      { name: "MAILER", type: "send_email", target: null },
      { name: "AI", type: "ai", target: null },
      { name: "ASSETS", type: "assets", target: "./public" },
      { name: "API_URL", type: "vars", target: null },
      { name: "SECRET_LIKE", type: "vars", target: null },
    ])
    expect(JSON.stringify(bindings)).not.toContain("https://example.com")
  })

  it("resolves environments the way Wrangler does: names, routes and crons inherit, bindings do not", () => {
    const environments = configEnvironments({
      name: "api",
      compatibility_date: "2026-01-01",
      routes: ["api.example.com/*"],
      triggers: { crons: ["0 * * * *"] },
      vars: { STAGE: "production" },
      kv_namespaces: [{ binding: "CACHE", id: "1" }],
      env: {
        staging: { vars: { STAGE: "staging" } },
        preview: { name: "api-pr", compatibility_date: "2026-06-01", route: { pattern: "preview.example.com/*" }, triggers: { crons: [] } },
        "bad name!": { name: "ignored" },
      },
    }, "api")
    expect(environments).toEqual([
      { name: null, workerName: "api", routes: ["api.example.com/*"], crons: ["0 * * * *"], bindings: [{ name: "CACHE", type: "kv_namespaces", target: null }, { name: "STAGE", type: "vars", target: null }], compatibilityDate: "2026-01-01" },
      { name: "preview", workerName: "api-pr", routes: ["preview.example.com/*"], crons: [], bindings: [], compatibilityDate: "2026-06-01" },
      { name: "staging", workerName: "api-staging", routes: ["api.example.com/*"], crons: ["0 * * * *"], bindings: [{ name: "STAGE", type: "vars", target: null }], compatibilityDate: "2026-01-01" },
    ])
  })

  it("rejects Pages projects and configurations without a Worker name", () => {
    const project = { root: "/repo", configPath: "/repo/wrangler.toml", key: "wrangler.toml", repositoryRoot: "/repo" }
    expect(() => describeConfig({ ...project, config: { name: "site", pages_build_output_dir: "./dist" } })).toThrow(expect.objectContaining({ code: "cloudflare_pages_unsupported" }))
    expect(() => describeConfig({ ...project, config: { compatibility_date: "2026-01-01" } })).toThrow(expect.objectContaining({ code: "cloudflare_config_invalid" }))
    expect(describeConfig({ ...project, config: { name: "api", compatibility_date: "2026-01-01" } })).toMatchObject({ workerName: "api", environments: [{ compatibilityDate: "2026-01-01" }] })
  })

  it("parses JSONC edge cases", () => {
    expect(parseJsonc("// only\n{\"a\": [1, 2, /* three */], \"b\": \"\\\\\", }")).toEqual({ a: [1, 2], b: "\\" })
    expect(() => parseJsonc("{ \"unterminated")).toThrow()
  })
})

describe("project-local Wrangler", () => {
  it("prefers the nearest node_modules binary between the configuration directory and the repository root", async () => {
    const app = join(repository, "apps", "api")
    await mkdir(join(repository, "node_modules", ".bin"), { recursive: true })
    await mkdir(app, { recursive: true })
    await writeFile(join(repository, "node_modules", ".bin", "wrangler"), "#!/bin/sh\n")
    await expect(findLocalWrangler({ root: app, repositoryRoot: repository }, "linux")).resolves.toBe(join(repository, "node_modules", ".bin", "wrangler"))
    await mkdir(join(app, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(app, "node_modules", ".bin", "wrangler.cmd"), "")
    await expect(findLocalWrangler({ root: app, repositoryRoot: repository }, "win32")).resolves.toBe(join(app, "node_modules", ".bin", "wrangler.cmd"))
  })

  it("never looks above the repository root or outside a plain folder", async () => {
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(directory, "node_modules", ".bin", "wrangler"), "")
    await expect(findLocalWrangler({ root: repository, repositoryRoot: repository }, "linux")).resolves.toBeNull()
    const plain = join(directory, "plain")
    await mkdir(plain)
    await expect(findLocalWrangler({ root: plain, repositoryRoot: null }, "linux")).resolves.toBeNull()
  })
})
