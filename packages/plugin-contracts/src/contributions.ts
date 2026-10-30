import { z } from "zod"
import { boundedText, canonicalPath, identifier, jsonPointer, label } from "./schema.js"

const fieldBase = { id: identifier, label, description: boundedText(512).optional() }
export const settingFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...fieldBase, type: z.literal("string"), default: boundedText(4096).default(""), maxLength: z.number().int().min(1).max(4096).default(256) }),
  z.strictObject({ ...fieldBase, type: z.literal("boolean"), default: z.boolean().default(false) }),
  z.strictObject({ ...fieldBase, type: z.literal("number"), default: z.number().finite(), min: z.number().finite(), max: z.number().finite(), step: z.number().positive().optional() }),
  z.strictObject({ ...fieldBase, type: z.literal("select"), default: boundedText(256), options: z.array(z.strictObject({ value: boundedText(256), label })).min(1).max(64) }),
]).superRefine((field, context) => {
  if (field.type === "number" && (field.min > field.max || field.default < field.min || field.default > field.max)) context.addIssue({ code: "custom", message: "Invalid numeric setting bounds/default" })
  if (field.type === "string" && field.default.length > field.maxLength) context.addIssue({ code: "custom", message: "Default exceeds setting length" })
  if (field.type === "select" && (!field.options.some(option => option.value === field.default) || new Set(field.options.map(option => option.value)).size !== field.options.length)) context.addIssue({ code: "custom", message: "Invalid select options/default" })
})
export const settingsContributionSchema = z.strictObject({
  scope: z.enum(["plugin", "project"]),
  fields: z.array(settingFieldSchema).min(1).max(32).refine(fields => new Set(fields.map(field => field.id)).size === fields.length, "Duplicate setting ID"),
}).refine(definition => new TextEncoder().encode(JSON.stringify(Object.fromEntries(definition.fields.map(field => [field.id, field.default])))).byteLength <= 16384, "Default settings exceed 16 KiB")
export const skillContributionSchema = z.strictObject({ id: identifier, title: label, description: boundedText(512), source: canonicalPath.refine(path => path.endsWith(".md"), "Skill source must be Markdown") })
export const chatBlockContributionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), title: label,
  height: z.number().int().min(80).max(800).default(240),
})
export type PluginSettingField = z.infer<typeof settingFieldSchema>
/** Icons Cogpit draws itself, so a contribution can be a compact button without shipping artwork. */
export const contributionIconSchema = z.enum(["speaker"])
export const sessionActionContributionSchema = z.strictObject({ id: identifier, title: label, icon: contributionIconSchema.optional(), skill: identifier, prompt: boundedText(4096).refine(value => value.trim().length > 0, "Action prompt is required") })
/** Cogpit records the user's microphone and sends the WAV to `operation`; `text` points at the transcript in its JSON answer. */
export const dictationContributionSchema = z.strictObject({ title: label, connection: identifier, operation: identifier, text: jsonPointer })
export type PluginDictationContribution = z.infer<typeof dictationContributionSchema>
export type PluginSettingsContribution = z.infer<typeof settingsContributionSchema>
export type PluginSettingsValues = Record<string, string | number | boolean>
export const SETTINGS_STORAGE_KEY = "cogpit.settings"

export function validateSettings(definition: PluginSettingsContribution, input: unknown): PluginSettingsValues {
  const fields: Record<string, z.ZodType> = {}
  for (const field of definition.fields) {
    fields[field.id] = field.type === "string" ? z.string().max(field.maxLength).default(field.default)
      : field.type === "boolean" ? z.boolean().default(field.default)
      : field.type === "number" ? z.number().finite().min(field.min).max(field.max).default(field.default)
      : z.enum(field.options.map(option => option.value) as [string, ...string[]]).default(field.default)
  }
  return z.strictObject(fields).parse(input) as PluginSettingsValues
}

export function parsePluginBlockLanguage(language: string | null): { pluginId: string; blockId: string } | null {
  const match = language?.match(/^cogpit:([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*):([a-z][a-z0-9-]{0,63})$/u)
  return match ? { pluginId: match[1], blockId: match[2] } : null
}
