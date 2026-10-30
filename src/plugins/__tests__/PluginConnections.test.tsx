import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { parseConnectionDefinition } from "@cogpit/plugin-contracts"
import type { PluginConnectionSnapshot } from "../../../shared/contracts/pluginConnections"
import { PluginConnections } from "../PluginConnections"
import type { RuntimePluginClient } from "../runtimeClient"
import { panelHostStatus, panelProject } from "./runtimePanelFixtures"

const definition = parseConnectionDefinition({
  version: 1, id: "service", label: "Example provider", secret: { id: "token", label: "API token" },
  auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate",
  resources: { account: { label: "Account", options: { operation: "accounts", items: "/accounts", id: "/id", label: "/name" } } },
  operations: {
    validate: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "me" }], args: {}, query: {} },
    accounts: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }], args: {}, query: {} },
    read: { audience: "panel", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }, { resource: "account" }], args: {}, query: {} },
  },
})
const nested = parseConnectionDefinition({
  version: 1, id: "service", label: "Example provider", secret: { id: "token", label: "API token" },
  auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate",
  resources: {
    account: { label: "Account", options: { operation: "accounts", items: "/accounts", id: "/id", label: "/name" } },
    folder: { label: "Folder", options: { operation: "folders", items: "/folders", id: "/id", label: "/name" } },
  },
  operations: {
    validate: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "me" }], args: {}, query: {} },
    accounts: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }], args: {}, query: {} },
    folders: { audience: "setup", origin: "https://example.com", method: "GET", path: [{ literal: "accounts" }, { resource: "account" }, { literal: "folders" }], args: {}, query: {} },
  },
})
function connection(status: "disconnected" | "connected" | "environment" = "disconnected", selected: PluginConnectionSnapshot["connections"][number]["selected"] = {}): PluginConnectionSnapshot {
  return { revision: 1, connections: [{ id: "service", label: "Example provider", status, readOnly: status === "environment", selected, definition }] }
}
function setup(snapshot = connection()) {
  const client = { connections: vi.fn<RuntimePluginClient["connections"]>(async () => snapshot), connectionOptions: vi.fn<RuntimePluginClient["connectionOptions"]>(async () => [{ id: "a", label: "Account A" }]), changeConnection: vi.fn<RuntimePluginClient["changeConnection"]>(async () => ({ ...connection("connected"), revision: 2 })) }
  return { client, ...render(<PluginConnections client={client} status={panelHostStatus} pluginId="example.sample" initialProjectId={panelProject.id} />) }
}
async function choose(label: string, optionLabel: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }))
  const option = await screen.findByRole("option", { name: optionLabel })
  fireEvent.mouseMove(option); fireEvent.mouseDown(option); fireEvent.mouseUp(option); fireEvent.click(option)
}

describe("host-owned plugin connections", () => {
  it("names the selected host and sends credentials only through the trusted management client", async () => {
    const value = setup()
    const input = await screen.findByLabelText("API token")
    expect(screen.getByText(/Connection credentials belong to Host/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "synthetic-fixture-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }))
    expect(input).toHaveValue("")
    await waitFor(() => expect(value.client.changeConnection).toHaveBeenCalledWith({ pluginId: "example.sample", projectId: panelProject.id }, "service", "credential", { secret: "synthetic-fixture-secret" }, 1, expect.any(AbortSignal)))
    expect(await screen.findByText("Connected")).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain("synthetic-fixture-secret")
  })
  it("keeps environment credentials read-only while permitting resource selection", async () => {
    const value = setup(connection("environment"))
    let finishOptions!: (choices: { id: string; label: string }[]) => void
    value.client.connectionOptions.mockImplementationOnce(() => new Promise((resolve) => { finishOptions = resolve }))
    expect(await screen.findByText("Configured by host")).toBeInTheDocument()
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument()
    const select = await screen.findByRole("combobox", { name: "Account" })
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledOnce())
    expect(select).toBeDisabled()
    await act(async () => { finishOptions([{ id: "a", label: "Account A" }]) })
    await waitFor(() => expect(select).toBeEnabled())
  })
  it("loads a root resource's choices as soon as the connection is available", async () => {
    const value = setup(connection("connected"))
    const select = await screen.findByRole("combobox", { name: "Account" })
    await waitFor(() => expect(select).toBeEnabled())
    expect(value.client.connectionOptions).toHaveBeenCalledExactlyOnceWith({ pluginId: "example.sample", projectId: panelProject.id }, "service", "account", expect.any(AbortSignal))
    expect(screen.queryByRole("button", { name: "Browse choices" })).not.toBeInTheDocument()
    fireEvent.click(select)
    fireEvent.click(await screen.findByRole("option", { name: "Account A" }))
    await waitFor(() => expect(value.client.changeConnection).toHaveBeenCalledWith({ pluginId: "example.sample", projectId: panelProject.id }, "service", "select", { resourceId: "account", value: "a" }, 1, expect.any(AbortSignal)))
  })
  it("does not load choices before a connection exists", async () => {
    const value = setup()
    await screen.findByLabelText("API token")
    expect(value.client.connectionOptions).not.toHaveBeenCalled()
    expect(screen.queryByRole("combobox", { name: "Account" })).not.toBeInTheDocument()
  })
  it("reloads root choices after a saved selection or credential change", async () => {
    const value = setup(connection("connected"))
    let revision = 1
    value.client.changeConnection.mockImplementation(async (_target, _connection, action) => ({ ...connection("connected", action === "select" ? { account: { id: "a", label: "Account A" } } : {}), revision: ++revision }))
    const select = await screen.findByRole("combobox", { name: "Account" })
    await waitFor(() => expect(select).toBeEnabled())
    fireEvent.click(select)
    fireEvent.click(await screen.findByRole("option", { name: "Account A" }))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent("Account A"))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "synthetic-replacement-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Replace credential" }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(3))
  })
  it("offers a retry when choices fail to load", async () => {
    const value = setup(connection("connected"))
    value.client.connectionOptions.mockRejectedValueOnce(new Error("Provider is unavailable"))
    expect(await screen.findByText("Provider is unavailable")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Account" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    expect(screen.queryByText("Provider is unavailable")).not.toBeInTheDocument()
    expect(value.client.connectionOptions).toHaveBeenCalledTimes(2)
  })
  it("rediscovers choices in every project after replacing a host-wide credential", async () => {
    const value = setup(connection("connected"))
    let credential = "A"
    const second = { ...panelProject, id: `p_${"b".repeat(40)}`, name: "Second project" }
    const status = { ...panelHostStatus, projects: [panelProject, second] }
    value.client.connectionOptions.mockImplementation(async () => [{ id: credential, label: `Account ${credential}` }])
    value.client.changeConnection.mockImplementation(async () => { credential = "B"; return { ...connection("connected"), revision: 2 } })
    value.rerender(<PluginConnections client={value.client} status={status} pluginId="example.sample" initialProjectId={panelProject.id} />)
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    await choose("Project settings", second.name)
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(2))
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "synthetic-replacement" } })
    fireEvent.click(screen.getByRole("button", { name: "Replace credential" }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(3))
    await choose("Project settings", panelProject.name)
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(4))
    expect(value.client.connectionOptions).toHaveBeenLastCalledWith({ pluginId: "example.sample", projectId: panelProject.id }, "service", "account", expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("combobox", { name: "Account" }))
    expect(await screen.findByRole("option", { name: "Account B" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Account A" })).not.toBeInTheDocument()
  })
  it("rediscovers root choices after another client changes the connection revision", async () => {
    const value = setup(connection("connected"))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    value.client.connectionOptions.mockResolvedValue([{ id: "b", label: "Account B" }])
    value.rerender(<PluginConnections client={value.client} status={{ ...panelHostStatus, connectionRevision: 2 }} pluginId="example.sample" initialProjectId={panelProject.id} />)
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    fireEvent.click(screen.getByRole("combobox", { name: "Account" }))
    expect(await screen.findByRole("option", { name: "Account B" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Account A" })).not.toBeInTheDocument()
  })
  it("keeps dependent resources behind an explicit browse until their parent is chosen", async () => {
    const value = setup({ revision: 1, connections: [{ id: "service", label: "Example provider", status: "connected", readOnly: false, selected: { account: { id: "a", label: "Account A" } }, definition: nested }] })
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    expect(value.client.connectionOptions).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Browse choices" }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenLastCalledWith(expect.anything(), "service", "folder", expect.any(AbortSignal)))
  })
  it("drops discovered child choices when a parent selection changes", async () => {
    const snapshot: PluginConnectionSnapshot = { revision: 1, connections: [{ id: "service", label: "Example provider", status: "connected", readOnly: false, selected: { account: { id: "a", label: "Account A" } }, definition: nested }] }
    const value = setup(snapshot)
    value.client.connectionOptions.mockImplementation(async (_target, _connection, resource) => resource === "account" ? [{ id: "a", label: "Account A" }, { id: "b", label: "Account B" }] : [{ id: "folder-a", label: "Folder A" }])
    value.client.changeConnection.mockResolvedValue({ revision: 2, connections: [{ ...snapshot.connections[0], selected: { account: { id: "b", label: "Account B" } } }] })
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Browse choices" }))
    await screen.findByRole("combobox", { name: "Folder" })
    fireEvent.click(screen.getByRole("combobox", { name: "Account" }))
    const option = await screen.findByRole("option", { name: "Account B" })
    fireEvent.mouseMove(option)
    fireEvent.mouseDown(option)
    fireEvent.mouseUp(option)
    fireEvent.click(option)
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent("Account B"))
    expect(screen.queryByRole("combobox", { name: "Folder" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Browse choices" }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledTimes(4))
  })
  it("cancels option discovery when its settings view is closed", async () => {
    const value = setup(connection("connected"))
    let resolve!: (value: { id: string; label: string }[]) => void
    value.client.connectionOptions.mockImplementation(() => new Promise((yes) => { resolve = yes }))
    await waitFor(() => expect(value.client.connectionOptions).toHaveBeenCalledOnce())
    const signal = value.client.connectionOptions.mock.calls[0][3]
    value.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolve([{ id: "late", label: "Late response" }]) })
    expect(screen.queryByText("Late response")).not.toBeInTheDocument()
  })
  it("keeps the credential cleared when validation fails and displays a retryable error", async () => {
    const value = setup()
    value.client.changeConnection.mockRejectedValue(new Error("Provider rejected the credential"))
    const input = await screen.findByLabelText("API token")
    fireEvent.change(input, { target: { value: "synthetic-invalid-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }))
    expect(await screen.findByText("Provider rejected the credential")).toBeInTheDocument()
    expect(input).toHaveValue("")
  })
})
