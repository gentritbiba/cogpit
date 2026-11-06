import generated from "../../generated/view-kit/index.json"

/** One prebuilt kit module, as `scripts/build-view-kit.ts` writes it. */
export interface ViewKitModule {
  id: string
  provides: string[]
  always: boolean
  /** CommonJS; its `exports.modules` maps each provided specifier to its exports. */
  code: string
  css: string
}

export interface ViewKitIndex {
  modules: ViewKitModule[]
}

export const VIEW_KIT: ViewKitIndex = generated

/** The kit module providing `specifier`, if any. */
export function kitModuleFor(specifier: string, kit: ViewKitIndex = VIEW_KIT): ViewKitModule | undefined {
  return kit.modules.find((module) => module.provides.includes(specifier))
}

/** Every specifier a view may import from the kit. */
export function kitSpecifiers(kit: ViewKitIndex = VIEW_KIT): string[] {
  return kit.modules.flatMap((module) => module.provides).filter((specifier) => specifier !== "cogpit/runtime")
}
