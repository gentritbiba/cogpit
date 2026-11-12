import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

import { SearchSection } from "@/components/ConfigDialog/SearchSection"
import type { EmbeddingSettingsReport, EmbeddingSettingsView } from "../../../../shared/contracts/memoryEmbeddings"

const SAVED: EmbeddingSettingsView = {
  url: "https://embed.test/v1/embeddings",
  model: "some-model",
  dimensions: 256,
  queryPrefix: "",
  minScore: 0.55,
  hasApiKey: true,
}

const report = (overrides: Partial<EmbeddingSettingsReport> = {}): EmbeddingSettingsReport => ({
  settings: null,
  progress: null,
  error: null,
  defaults: { dimensions: 256, minScore: 0.55 },
  ...overrides,
})

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body })

/** GETs answer `reports` in turn; a POST answers what `post` gives for its body. */
function serve(reports: EmbeddingSettingsReport[], post: (body: { action: string }) => unknown = () => ok(reports.at(-1))) {
  let index = 0
  mocks.authFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== "/api/memory-embeddings") throw new Error(`Unexpected request: ${url}`)
    if (init?.method === "POST") return post(JSON.parse(String(init.body)))
    return ok(reports[Math.min(index++, reports.length - 1)])
  })
}

const posts = () => mocks.authFetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init.body))

async function openSection() {
  await userEvent.click(await screen.findByRole("button", { name: /search by meaning/i }))
}

beforeEach(() => {
  mocks.authFetch.mockReset()
})

describe("SearchSection", () => {
  it("is off until an endpoint is saved, then saves the address, model and key", async () => {
    serve([report()], () => ok(report({ settings: { ...SAVED, hasApiKey: true }, progress: { passages: 10, embedded: 0 } })))
    render(<SearchSection disabled={false} />)
    expect(await screen.findByText("Off")).toBeInTheDocument()
    await openSection()
    expect(screen.getByRole("button", { name: "Save endpoint" })).toBeDisabled()

    await userEvent.type(screen.getByLabelText("Endpoint address"), "https://embed.test/v1/embeddings")
    await userEvent.type(screen.getByLabelText("Model"), "some-model")
    await userEvent.type(screen.getByLabelText("API key"), "secret")
    await userEvent.click(screen.getByRole("button", { name: "Save endpoint" }))

    expect(await screen.findByText("0 of 10 passages indexed")).toBeInTheDocument()
    expect(posts()).toEqual([{ action: "save", settings: { url: "https://embed.test/v1/embeddings", model: "some-model", apiKey: "secret", dimensions: 256, queryPrefix: "", minScore: 0.55 } }])
    expect(screen.getByLabelText("API key")).toHaveValue("")
    expect(screen.getByText("Indexing 0%")).toBeInTheDocument()
  })

  it("fills in the query instruction a Qwen3 embedding model expects, until one is written by hand", async () => {
    serve([report()])
    render(<SearchSection disabled={false} />)
    await openSection()
    await userEvent.click(screen.getByRole("button", { name: "Advanced settings" }))

    await userEvent.type(screen.getByLabelText("Model"), "Qwen3-Embedding-0.6B")
    expect((screen.getByLabelText("Query instruction") as HTMLTextAreaElement).value).toMatch(/^Instruct: .*\nQuery: $/)

    await userEvent.clear(screen.getByLabelText("Query instruction"))
    await userEvent.type(screen.getByLabelText("Model"), "-GGUF")
    expect(screen.getByLabelText("Query instruction")).toHaveValue("")
  })

  it("keeps the saved key out of the request unless a new one is typed", async () => {
    serve([report({ settings: SAVED, progress: { passages: 4, embedded: 4 } })])
    render(<SearchSection disabled={false} />)
    expect(await screen.findByText("On")).toBeInTheDocument()
    await openSection()
    expect(screen.getByText("4 of 4 passages indexed")).toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Saved. Leave blank to keep it.")
    expect(screen.getByRole("button", { name: "Save endpoint" })).toBeDisabled()

    await userEvent.clear(screen.getByLabelText("Model"))
    await userEvent.type(screen.getByLabelText("Model"), "other-model")
    await userEvent.click(screen.getByRole("button", { name: "Save endpoint" }))

    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].settings).toEqual({ url: SAVED.url, model: "other-model", dimensions: 256, queryPrefix: "", minScore: 0.55 })
  })

  it("says the saved key stays behind when the address moves to another server", async () => {
    serve([report({ settings: SAVED })])
    render(<SearchSection disabled={false} />)
    await openSection()

    await userEvent.clear(screen.getByLabelText("Endpoint address"))
    await userEvent.type(screen.getByLabelText("Endpoint address"), "https://elsewhere.test/v1/embeddings")

    expect(screen.getByText(/saved key belongs to the old address/i)).toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Leave blank if the endpoint needs none")
  })

  it("tests the typed endpoint and shows the answer or the reason it failed", async () => {
    const answers = [{ ok: true, ms: 84 }, { ok: false, error: "the embedding endpoint answered 401: Unauthorized" }]
    serve([report({ settings: SAVED })], () => ok(answers.shift()))
    render(<SearchSection disabled={false} />)
    await openSection()

    await userEvent.click(screen.getByRole("button", { name: "Test" }))
    expect(await screen.findByText("The endpoint answered in 84 ms")).toBeInTheDocument()
    expect(posts()[0]).toMatchObject({ action: "test", settings: { url: SAVED.url, model: SAVED.model } })

    await userEvent.click(screen.getByRole("button", { name: "Test" }))
    expect(await screen.findByText("The embedding endpoint answered 401: Unauthorized")).toBeInTheDocument()
  })

  it("reads the progress again while session text is still being indexed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    try {
      serve([report({ settings: SAVED, progress: { passages: 4, embedded: 1 } }), report({ settings: SAVED, progress: { passages: 4, embedded: 4 } })])
      render(<SearchSection disabled={false} />)
      await openSection()
      expect(screen.getByText("1 of 4 passages indexed")).toBeInTheDocument()

      await act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(screen.getByText("4 of 4 passages indexed")).toBeInTheDocument()

      await act(() => vi.advanceTimersByTimeAsync(20_000))
      expect(mocks.authFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("turns search by meaning off", async () => {
    serve([report({ settings: SAVED })], () => ok(report()))
    render(<SearchSection disabled={false} />)
    await openSection()

    await userEvent.click(screen.getByRole("button", { name: "Turn off" }))

    expect(await screen.findByText("Off")).toBeInTheDocument()
    expect(posts()).toEqual([{ action: "off" }])
    expect(screen.getByLabelText("Endpoint address")).toHaveValue("")
  })

  it("shows why embedding is stopped and a refused save", async () => {
    serve([report({ settings: SAVED, progress: { passages: 4, embedded: 1 }, error: "the embedding endpoint answered 503" })],
      () => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "embeddings: model is required" }) }))
    render(<SearchSection disabled={false} />)
    expect(await screen.findByText("Not working")).toBeInTheDocument()
    await openSection()
    expect(screen.getByText("The embedding endpoint answered 503")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("Model"), "-v2")
    await userEvent.click(screen.getByRole("button", { name: "Save endpoint" }))

    expect(await screen.findByText("Embeddings: model is required")).toBeInTheDocument()
    expect(screen.getByLabelText("Model")).toHaveValue("some-model-v2")
  })

  it("is read-only without config access, and absent for someone who is not a host administrator", async () => {
    serve([report({ settings: SAVED })])
    const { unmount } = render(<SearchSection disabled />)
    await openSection()
    expect(screen.getByLabelText("Endpoint address")).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Save endpoint" })).not.toBeInTheDocument()
    unmount()

    mocks.authFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "no" }) }))
    const { container } = render(<SearchSection disabled={false} />)
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
