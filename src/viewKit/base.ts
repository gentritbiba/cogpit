/**
 * The base kit module every stored view loads: React's API (Preact underneath,
 * aliased at build time), `cogpit/ui` and the runtime that mounts the app.
 * `modules` maps each import specifier a view may use to what it gets.
 */
import * as React from "react"
import * as ReactDOM from "react-dom"
import * as ReactDOMClient from "react-dom/client"
import * as JsxRuntime from "react/jsx-runtime"
import * as ui from "./ui"
import * as hooks from "./hooks"
import { mount } from "./runtime"

export const modules = {
  react: React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": JsxRuntime,
  "cogpit/ui": { ...ui, ...hooks },
  "cogpit/runtime": { mount },
}
