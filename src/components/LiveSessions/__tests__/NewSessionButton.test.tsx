import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react"
import { cloneElement, isValidElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { NewSessionButton } from "../NewSessionButton"

const mocks = vi.hoisted(() => ({
  useProjectList: vi.fn((_enabled: boolean) => [] as unknown[]),
  pickerProps: null as null | {
    onNewSession: (dirName: string, cwd?: string) => void
    onNewFolder: (cwd: string) => void
    defaultAgentKind: string
  },
}))

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-testid="picker" data-open={open}>{children}</div>
  ),
  PopoverTrigger: ({ render: renderProp, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { render?: ReactElement }) => (
    isValidElement(renderProp)
      ? cloneElement(renderProp as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>, props, children)
      : <button type="button" {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/ProjectSwitcherList", () => ({
  useProjectList: mocks.useProjectList,
  ProjectSwitcherList: (props: NonNullable<typeof mocks.pickerProps>) => {
    mocks.pickerProps = props
    return <div data-testid="project-list" />
  },
}))

afterEach(() => {
  cleanup()
  mocks.pickerProps = null
  mocks.useProjectList.mockClear()
})

function renderButton(overrides: Partial<Parameters<typeof NewSessionButton>[0]> = {}) {
  const props = {
    project: null,
    onNewSession: vi.fn(),
    onNewFolder: vi.fn(),
    defaultAgentKind: "claude" as const,
    pickerOpen: false,
    onPickerOpenChange: vi.fn(),
    ...overrides,
  }
  render(<NewSessionButton {...props} />)
  return props
}

describe("NewSessionButton across every project", () => {
  it("shows an icon-only New session button that opens the project picker", () => {
    const props = renderButton()

    const button = screen.getByRole("button", { name: "New session" })
    expect(button).toHaveTextContent("")
    expect(button.querySelector("svg")).not.toBeNull()
    expect(button.getAttribute("title")).toMatch(/^Start a new session \(.+\)$/)
    expect(screen.getByTestId("project-list")).toBeInTheDocument()
    expect(mocks.pickerProps?.defaultAgentKind).toBe("claude")
    expect(props.onNewSession).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: /another folder/ })).not.toBeInTheDocument()
  })

  it("loads the projects only while the picker is open", () => {
    renderButton()
    expect(mocks.useProjectList).toHaveBeenLastCalledWith(false)
    cleanup()

    renderButton({ pickerOpen: true })
    expect(mocks.useProjectList).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId("picker")).toHaveAttribute("data-open", "true")
  })

  it("closes the picker and starts in the chosen project", () => {
    const props = renderButton({ pickerOpen: true })

    mocks.pickerProps!.onNewSession("-work-app", "/work/app")

    expect(props.onPickerOpenChange).toHaveBeenCalledWith(false)
    expect(props.onNewSession).toHaveBeenCalledWith("-work-app", "/work/app")
  })

  it("closes the picker and starts in a chosen folder", () => {
    const props = renderButton({ pickerOpen: true })

    mocks.pickerProps!.onNewFolder("/work/new-thing")

    expect(props.onPickerOpenChange).toHaveBeenCalledWith(false)
    expect(props.onNewFolder).toHaveBeenCalledWith("/work/new-thing")
  })

  it("is disabled with a spinner while a session is being created", () => {
    renderButton({ creatingSession: true })
    const button = screen.getByRole("button", { name: "New session" })
    expect(button).toBeDisabled()
    expect(button.querySelector(".animate-spin")).not.toBeNull()
  })
})

describe("NewSessionButton focused on a project", () => {
  const project = { dirName: "-work-app", cwd: "/work/app", label: "App" }

  it("starts in the focused project in one click, from an icon named for the project", () => {
    const props = renderButton({ project })

    const button = screen.getByRole("button", { name: "New session in App" })
    expect(button).toHaveTextContent("")
    expect(button.querySelector("svg")).not.toBeNull()
    expect(button).toHaveAttribute("title", "New session in App")
    fireEvent.click(button)

    expect(props.onNewSession).toHaveBeenCalledWith("-work-app", "/work/app")
    expect(screen.queryByTestId("project-list")).not.toBeInTheDocument()
  })

  it("leaves starting anywhere else to the list options", () => {
    renderButton({ project })

    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /another folder/ })).not.toBeInTheDocument()
  })

  it("is disabled with a spinner while a session is being created", () => {
    renderButton({ project, creatingSession: true })

    const button = screen.getByRole("button", { name: "New session in App" })
    expect(button).toBeDisabled()
    expect(button.querySelector(".animate-spin")).not.toBeNull()
  })
})
