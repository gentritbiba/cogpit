// @vitest-environment node
import { describe, expect, test } from "vitest";
import { CONTRACT_LIMITS, parseConnectionDefinition, type ConnectionDefinition as Definition } from "@cogpit/plugin-contracts";
import { createConnectionExecutor, CONNECTION_LIMITS, type HostConnection } from "../../plugins/connectionExecutor";
import { parseJsonText } from "../../plugins/json";
type BuiltRequest = {url:string;method:"GET";headers:Record<string,string>;redirect:"error"};
type TransportResponse = {status:number;body:string;headers?:Record<string,string>};
const LIMITS = {...CONNECTION_LIMITS,definitionBytes:CONTRACT_LIMITS.definitionBytes,callBytes:CONTRACT_LIMITS.argumentBytes,responseBytes:CONTRACT_LIMITS.responseBytes};
function validateDefinition(input:unknown):Definition {try{return parseConnectionDefinition(input)}catch{throw new Error("INVALID_REQUEST")}}
function createExecutor(definition:unknown,connection:HostConnection,transport:(request:BuiltRequest)=>Promise<TransportResponse>) {
 const parsed = validateDefinition(definition);
 return createConnectionExecutor(parsed,connection,{allowedOperations:Object.entries(parsed.operations).filter(([,op])=>op.audience==="panel").map(([name])=>name),transport:async input=>{
  const response = await transport({url:input.origin+input.path,method:"GET",redirect:"error",headers:{Accept:"application/json",[input.credential.header]:input.credential.scheme==="bearer"?`Bearer ${input.credential.secret}`:input.credential.secret}});
  if(!Number.isInteger(response.status)||response.status<200||response.status>=300) throw new Error("UPSTREAM_FAILED");
  try{return parseJsonText(new TextEncoder().encode(response.body),CONTRACT_LIMITS.responseBytes,{maxNodes:CONTRACT_LIMITS.responseNodes,maxDepth:CONTRACT_LIMITS.depth})}catch{throw Object.assign(new Error("INVALID_RESPONSE"),{code:"INVALID_RESPONSE"})}
 }});
}
import cloudflare from "./fixtures/connections/cloudflare.json";
import figma from "./fixtures/connections/figma.json";
import unknown from "./fixtures/connections/unknown.json";

const cfSecret = "fixture-cf-broad-token";
const figmaSecret = "fixture-figma-broad-token";
const unknownSecret = "fixture-api-key";
const cfConnection: HostConnection = {
  label: "Fixture Cloudflare", secret: cfSecret,
  selected: { account: { id: "account-a", label: "Account A" }, worker: { id: "worker-a", label: "Worker A" } },
};
const figmaConnection: HostConnection = {
  label: "Fixture Figma", secret: figmaSecret,
  selected: { file: { id: "file-a", label: "File A" } },
};
const unknownConnection: HostConnection = {
  label: "Fixture unknown", secret: unknownSecret,
  selected: { space: { id: "space-a", label: "Space A" } },
};
const json = (data: unknown): TransportResponse => ({ status: 200, body: JSON.stringify(data) });
function fakeTransport(response: TransportResponse = json({ value: "ok" })) {
  const seen: BuiltRequest[] = [];
  return { seen, send: async (request: BuiltRequest) => { seen.push(request); return response; } };
}
function unknownExecutor(response?: TransportResponse) {
  const fake = fakeTransport(response);
  return { fake, executor: createExecutor(unknown, unknownConnection, fake.send) };
}
const documentCall = (args: Record<string, unknown> = {}) => ({ operation: "document", args: { document: "readme", ...args } });

describe("same executor, data-only providers", () => {
  test.each([cloudflare, figma, unknown])("validates $id declarations", (definition) => {
    expect(validateDefinition(definition).id).toBe(definition.id);
  });

  test("Cloudflare validates, lists both accounts and workers, then binds the selected account and Worker", async () => {
    const seen: BuiltRequest[] = [];
    const transport = async (request: BuiltRequest) => {
      seen.push(request);
      expect(request.headers.Authorization).toBe(`Bearer ${cfSecret}`);
      const path = new URL(request.url).pathname;
      if (path.endsWith("tokens/verify")) return json({ success: true });
      if (path === "/client/v4/accounts") return json({ result: [{ id: "account-a", name: "Account A" }, { id: "account-b", name: "Account B" }] });
      if (path.endsWith("/scripts")) return json({ result: [{ id: "worker-a" }, { id: "worker-b" }] });
      return json({ result: [{ id: "deployment-1" }] });
    };
    const executor = createExecutor(cloudflare, cfConnection, transport);
    expect((await executor.validate()).ok).toBe(true);
    expect(await executor.listOptions("account")).toEqual({ ok: true, data: [{ id: "account-a", label: "Account A" }, { id: "account-b", label: "Account B" }] });
    expect(await executor.listOptions("worker")).toEqual({ ok: true, data: [{ id: "worker-a", label: "worker-a" }, { id: "worker-b", label: "worker-b" }] });
    expect(await executor.request({ operation: "deployments", args: {} })).toEqual({ ok: true, data: { result: [{ id: "deployment-1" }] } });
    expect(seen[2]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/account-a/workers/scripts");
    expect(seen[3]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/account-a/workers/scripts/worker-a/deployments");
    for (const resource of [{ account: "account-b" }, { worker: "worker-b" }]) {
      expect(await executor.request({ operation: "deployments", args: resource })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    }
    expect(seen).toHaveLength(4);
  });

  test("Figma uses a raw token header and a selected file while node IDs stay encoded query data", async () => {
    const fake = fakeTransport(json({ files: [{ key: "file-a", name: "File A" }, { key: "file-b", name: "File B" }] }));
    const executor = createExecutor(figma, figmaConnection, fake.send);
    expect((await executor.validate()).ok).toBe(true);
    expect(await executor.listOptions("file")).toEqual({ ok: true, data: [{ id: "file-a", label: "File A" }, { id: "file-b", label: "File B" }] });
    expect((await executor.request({ operation: "file", args: { depth: 2 } })).ok).toBe(true);
    expect((await executor.request({ operation: "nodes", args: { ids: "1:2,3:4&file=file-b" } })).ok).toBe(true);
    expect(fake.seen[2]!.url).toBe("https://api.figma.com/v1/files/file-a?depth=2");
    const url = new URL(fake.seen[3]!.url);
    expect(url.pathname).toBe("/v1/files/file-a/nodes");
    expect([...url.searchParams.entries()]).toEqual([["ids", "1:2,3:4&file=file-b"]]);
    expect(fake.seen.every((request) => request.headers["X-Figma-Token"] === figmaSecret && !Object.hasOwn(request.headers, "Authorization"))).toBe(true);
    expect(await executor.request({ operation: "file", args: { file: "file-b" } })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(4);
  });

  test("an unknown provider validates, maps options, injects X-API-Key, and encodes argument/resource slots", async () => {
    const fake = fakeTransport(json({ items: [{ key: "space-a", display: { name: "Space A" } }, { key: "space-b", display: { name: "Space B" } }] }));
    const connection = structuredClone(unknownConnection);
    connection.selected.space!.id = "space a+é";
    const executor = createExecutor(unknown, connection, fake.send);
    expect((await executor.validate()).ok).toBe(true);
    expect(await executor.listOptions("space")).toEqual({ ok: true, data: [{ id: "space-a", label: "Space A" }, { id: "space-b", label: "Space B" }] });
    expect((await executor.request(documentCall({ document: "API guide é?draft#part", q: "a&admin=true", limit: 2, archived: false, locale: "sq" }))).ok).toBe(true);
    const request = fake.seen.at(-1)!;
    expect(request.url).toBe("https://api.meridian.test/v1/spaces/space%20a%2B%C3%A9/documents/API%20guide%20%C3%A9%3Fdraft%23part?search=a%26admin%3Dtrue&limit=2&archived=false&locale=sq");
    expect(request.headers).toEqual({ Accept: "application/json", "X-API-Key": unknownSecret });
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
  });
});

describe("caller boundary", () => {
  test.each([
    { url: "https://attacker.test" }, { headers: { Host: "attacker.test" } }, { headers: { Authorization: "override" } },
    { method: "POST" }, { body: {} }, { connection: "someone-else" }, { selected: { space: "space-b" } },
    { audience: "setup" }, { origin: "https://attacker.test" }, { path: "/v1/admin" },
  ])("rejects caller control fields %j before transport", async (extra) => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request({ ...documentCall(), ...extra })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test.each(["url", "headers", "space", "apiKey", "unknown", "constructor", "__proto__"])("rejects unknown/selected-resource argument %s", async (key) => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request(documentCall({ [key]: "space-b" }))).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test.each(["validate", "spaces", "missing", "constructor", "__proto__"])("panel cannot call setup or unknown operation %s", async (operation) => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request({ operation, args: {} })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test("a missing selected resource stops panel and dependent setup operations", async () => {
    const fake = fakeTransport();
    const executor = createExecutor(cloudflare, { ...cfConnection, selected: {} }, fake.send);
    expect(await executor.request({ operation: "deployments", args: {} })).toEqual({ ok: false, error: "RESOURCE_REQUIRED" });
    expect(await executor.listOptions("worker")).toEqual({ ok: false, error: "RESOURCE_REQUIRED" });
    expect(fake.seen).toHaveLength(0);
  });

  test("snapshots declarations and host selections and never trusts later caller mutation", async () => {
    const fake = fakeTransport();
    const definition = structuredClone(unknown);
    const connection = structuredClone(unknownConnection);
    const executor = createExecutor(definition, connection, fake.send);
    definition.operations.document.origin = "https://attacker.test";
    connection.selected.space!.id = "space-b";
    const state = executor.publicState();
    (state.selected.space as { id: string }).id = "space-c";
    expect((await executor.request(documentCall())).ok).toBe(true);
    expect(fake.seen[0]!.url).toBe("https://api.meridian.test/v1/spaces/space-a/documents/readme");
  });

  test.each([".", "..", "../secret", "a/b", "a\\b", "%2e%2e", "%252e%252e", "x%2fy", "\u0000", "a\nHost:evil"])("rejects path argument traversal %j", async (document) => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request(documentCall({ document }))).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test.each(["..", "../account-b", "%2e%2e", "a\\b", "a/b"])("rejects invalid host selection %j", (id) => {
    const connection = structuredClone(unknownConnection);
    connection.selected.space!.id = id;
    expect(() => createExecutor(unknown, connection, fakeTransport().send)).toThrow("INVALID_REQUEST");
  });

  test.each([
    { document: "a".repeat(129) }, { q: "é".repeat(65) }, { q: {} }, { q: null },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "2" }, { limit: NaN },
    { archived: "false" }, { locale: "de" }, { document: undefined },
  ])("rejects oversized or incorrectly typed args %j", async (args) => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request(documentCall(args))).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test("enforces total call bytes before transport", async () => {
    const { executor, fake } = unknownExecutor();
    expect(await executor.request(documentCall({ q: "a".repeat(LIMITS.callBytes + 1) }))).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(fake.seen).toHaveLength(0);
  });

  test("does not run accessors or function values", async () => {
    const { executor, fake } = unknownExecutor();
    let executed = false;
    const args = { get document() { executed = true; return "readme"; } };
    expect(await executor.request({ operation: "document", args })).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(await executor.request(documentCall({ document: () => "readme" }))).toEqual({ ok: false, error: "INVALID_REQUEST" });
    expect(executed).toBe(false);
    expect(fake.seen).toHaveLength(0);
  });
});

describe("declaration boundary", () => {
  function altered(mutator: (definition: Definition) => void) {
    const definition = validateDefinition(unknown);
    mutator(definition);
    return definition;
  }

  test.each([
    "http://api.meridian.test", "https://api.meridian.test/", "https://api.meridian.test/path", "https://api.meridian.test?x=1",
    "https://user:secret@api.meridian.test", "https://api.meridian.test:444", "https://api.meridian.test:443",
    "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://service.local", "https://service.localhost",
  ])("rejects non-exact HTTPS DNS origin %s", (origin) => {
    expect(() => validateDefinition(altered((d) => { d.operations.document!.origin = origin; }))).toThrow("INVALID_REQUEST");
  });

  test.each(["Host", "Cookie", "Set-Cookie", "Content-Length", "X-Forwarded-Host", "X-HTTP-Method-Override", "Authorization\r\nHost"])("rejects unsafe credential header %s", (header) => {
    expect(() => validateDefinition(altered((d) => { d.auth.header = header; }))).toThrow("INVALID_REQUEST");
  });

  test.each(["..", "%2e%2e", "a/b", "a\\b", "?query", "#fragment", "${args.document}"])("rejects unsafe literal %s", (literal) => {
    expect(() => validateDefinition(altered((d) => { d.operations.document!.path[0] = { literal }; }))).toThrow("INVALID_REQUEST");
  });

  test("rejects author expressions, regexes, unknown fields, resource argument aliases, and unresolved slots", () => {
    const definitions = [
      { ...unknown, expression: "fetch('https://attacker.test')" },
      altered((d) => { (d.operations.document!.args.document as unknown as Record<string, unknown>).pattern = ".*"; }),
      altered((d) => { (d.operations.document as unknown as Record<string, unknown>).headers = { Host: "attacker.test" }; }),
      altered((d) => { d.operations.document!.args.space = { type: "string", maxLength: 32 }; }),
      altered((d) => { d.operations.document!.path[0] = { resource: "missing" }; }),
      altered((d) => { d.operations.document!.path[0] = { arg: "missing" }; }),
      altered((d) => { d.operations.document!.query.unknown = "missing"; }),
      altered((d) => { (d.resources.space!.options as {items:string}).items = "/items/~9"; }),
      altered((d) => { (d.resources.space!.options as {operation:string}).operation = "document"; }),
    ];
    for (const definition of definitions) expect(() => validateDefinition(definition)).toThrow("INVALID_REQUEST");
  });

  test("rejects oversized definitions, excess paths, and object cycles", () => {
    expect(() => validateDefinition({ ...unknown, label: "x".repeat(LIMITS.definitionBytes) })).toThrow("INVALID_REQUEST");
    expect(() => validateDefinition(altered((d) => { d.operations.document!.path = Array.from({ length: 17 }, () => ({ literal: "v1" })); }))).toThrow("INVALID_REQUEST");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateDefinition(cycle)).toThrow("INVALID_REQUEST");
  });
});

describe("secret and response boundary", () => {
  test("public state omits credentials and successful responses omit all upstream headers", async () => {
    const response = { ...json({ name: "Safe result" }), headers: { "Set-Cookie": unknownSecret, "X-API-Key": unknownSecret, Authorization: unknownSecret } };
    const { executor } = unknownExecutor(response);
    expect(executor.publicState()).toEqual({ label: "Fixture unknown", status: "configured", selected: unknownConnection.selected });
    expect(await executor.request(documentCall())).toEqual({ ok: true, data: { name: "Safe result" } });
    expect(JSON.stringify(executor.publicState())).not.toContain(unknownSecret);
  });

  test.each([
    { token: unknownSecret }, { nested: [{ value: `Bearer ${unknownSecret}` }] }, { [unknownSecret]: "secret in a JSON key" },
  ])("rejects upstream credential echoes %j", async (data) => {
    const { executor } = unknownExecutor(json(data));
    const response = await executor.request(documentCall());
    expect(response).toEqual({ ok: false, error: "INVALID_RESPONSE" });
    expect(JSON.stringify(response)).not.toContain(unknownSecret);
  });

  test("detects escaped secret strings after parsing JSON", async () => {
    const secret = 'synthetic-quote"backslash\\token';
    const fake = fakeTransport(json({ echo: secret }));
    const executor = createExecutor(unknown, { ...unknownConnection, secret }, fake.send);
    expect(await executor.request(documentCall())).toEqual({ ok: false, error: "INVALID_RESPONSE" });
  });

  test.each([301, 302, 307, 308, 401, 403, 429, 500, NaN])("returns a static error for status %s and never follows Location", async (status) => {
    const { executor, fake } = unknownExecutor({ status, body: unknownSecret, headers: { Location: "https://attacker.test" } });
    expect(await executor.request(documentCall())).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]!.redirect).toBe("error");
  });

  test("does not return a transport exception containing credential-bearing requests", async () => {
    const executor = createExecutor(unknown, unknownConnection, async (request) => { throw new Error(JSON.stringify(request)); });
    expect(await executor.request(documentCall())).toEqual({ ok: false, error: "UPSTREAM_FAILED" });
  });

  test.each([
    { body: "<html>unexpected</html>" },
    { body: JSON.stringify({ value: "a".repeat(LIMITS.responseBytes) }) },
    { body: "[".repeat(20) + "null" + "]".repeat(20) },
  ])("rejects invalid, oversized or deep JSON response", async ({ body }) => {
    const { executor } = unknownExecutor({ status: 200, body });
    expect(await executor.request(documentCall())).toEqual({ ok: false, error: "INVALID_RESPONSE" });
  });

  test.each(["secret\r\nHost: attacker.test", "secret with spaces", "a".repeat(LIMITS.secretBytes + 1)])("rejects invalid secret bytes without echoing them", (secret) => {
    expect(() => createExecutor(unknown, { ...unknownConnection, secret }, fakeTransport().send)).toThrow("INVALID_REQUEST");
  });

  test("does not expose secrets through host labels or selected resource labels", () => {
    expect(() => createExecutor(unknown, { ...unknownConnection, label: unknownSecret }, fakeTransport().send)).toThrow("INVALID_REQUEST");
    expect(() => createExecutor(unknown, { ...unknownConnection, selected: { space: { id: "space-a", label: unknownSecret } } }, fakeTransport().send)).toThrow("INVALID_REQUEST");
  });

  test.each([
    { items: [{ key: "..", display: { name: "Bad path" } }] },
    { items: [{ key: "space-a", display: { name: "A" } }, { key: "space-a", display: { name: "Duplicate" } }] },
    { items: [{ key: "space-a", display: { wrong: "Missing label" } }] },
    { items: { key: "space-a" } },
    { items: Array.from({ length: LIMITS.options + 1 }, (_, i) => ({ key: `space-${i}`, display: { name: `Space ${i}` } })) },
  ])("rejects unsafe/malformed/oversized resource choices", async (data) => {
    const { executor } = unknownExecutor(json(data));
    expect(await executor.listOptions("space")).toEqual({ ok: false, error: "INVALID_RESPONSE" });
  });
});
