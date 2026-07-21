import { describe, expect, expectTypeOf, it } from "vitest"

import * as legacyCodex from "../codex"
import * as legacyInteractiveState from "../interactiveState"
import * as legacyMessageTypeGuards from "../messageTypeGuards"
import * as legacyParser from "../parser"
import * as legacyPricingTiers from "../pricingTiers"
import * as legacySessionStats from "../sessionStats"
import * as legacySessionStatus from "../sessionStatus"
import * as legacyTokenCosts from "../token-costs"
import * as legacyTurnBuilder from "../turnBuilder"
import type * as LegacyInteractiveTypes from "../interactiveState"
import type * as LegacyParserTypes from "../parser"
import type * as LegacyPricingTypes from "../pricingTiers"
import type * as LegacySessionStatusTypes from "../sessionStatus"
import type * as LegacyTokenCostTypes from "../token-costs"
import type * as LegacyTypes from "../types"
import * as canonicalCodex from "../../../shared/session/codex"
import * as canonicalInteractiveState from "../../../shared/session/interactiveState"
import * as canonicalMessageTypeGuards from "../../../shared/session/messageTypeGuards"
import * as canonicalParser from "../../../shared/session/parser"
import * as canonicalPricingTiers from "../../../shared/session/pricingTiers"
import * as canonicalSessionStats from "../../../shared/session/sessionStats"
import * as canonicalSessionStatus from "../../../shared/session/sessionStatus"
import * as canonicalTokenCosts from "../../../shared/session/token-costs"
import * as canonicalTurnBuilder from "../../../shared/session/turnBuilder"
import type * as CanonicalInteractiveTypes from "../../../shared/session/interactiveState"
import type * as CanonicalParserTypes from "../../../shared/session/parser"
import type * as CanonicalPricingTypes from "../../../shared/session/pricingTiers"
import type * as CanonicalSessionStatusTypes from "../../../shared/session/sessionStatus"
import type * as CanonicalTokenCostTypes from "../../../shared/session/token-costs"
import type * as CanonicalTypes from "../../../shared/session/types"

type LegacyTypeSurface = {
  TextBlock: LegacyTypes.TextBlock
  ThinkingBlock: LegacyTypes.ThinkingBlock
  ToolUseBlock: LegacyTypes.ToolUseBlock
  ToolResultBlock: LegacyTypes.ToolResultBlock
  ImageBlock: LegacyTypes.ImageBlock
  ContentBlock: LegacyTypes.ContentBlock
  UserContent: LegacyTypes.UserContent
  AgentToolUseResult: LegacyTypes.AgentToolUseResult
  UserMessage: LegacyTypes.UserMessage
  TokenUsage: LegacyTypes.TokenUsage
  AssistantMessage: LegacyTypes.AssistantMessage
  AgentProgressData: LegacyTypes.AgentProgressData
  HookEventName: LegacyTypes.HookEventName
  HookProgressData: LegacyTypes.HookProgressData
  ParsedHookEvent: LegacyTypes.ParsedHookEvent
  ProgressMessage: LegacyTypes.ProgressMessage
  SystemMessage: LegacyTypes.SystemMessage
  FileHistorySnapshotMessage: LegacyTypes.FileHistorySnapshotMessage
  SummaryMessage: LegacyTypes.SummaryMessage
  QueueOperationMessage: LegacyTypes.QueueOperationMessage
  RawMessage: LegacyTypes.RawMessage
  ToolCall: LegacyTypes.ToolCall
  SubAgentMessage: LegacyTypes.SubAgentMessage
  TurnContentBlock: LegacyTypes.TurnContentBlock
  Turn: LegacyTypes.Turn
  SessionStats: LegacyTypes.SessionStats
  ParsedSession: LegacyTypes.ParsedSession
  ArchivedToolCall: LegacyTypes.ArchivedToolCall
  ArchivedTurn: LegacyTypes.ArchivedTurn
  Branch: LegacyTypes.Branch
  UndoState: LegacyTypes.UndoState
}

type CanonicalTypeSurface = {
  TextBlock: CanonicalTypes.TextBlock
  ThinkingBlock: CanonicalTypes.ThinkingBlock
  ToolUseBlock: CanonicalTypes.ToolUseBlock
  ToolResultBlock: CanonicalTypes.ToolResultBlock
  ImageBlock: CanonicalTypes.ImageBlock
  ContentBlock: CanonicalTypes.ContentBlock
  UserContent: CanonicalTypes.UserContent
  AgentToolUseResult: CanonicalTypes.AgentToolUseResult
  UserMessage: CanonicalTypes.UserMessage
  TokenUsage: CanonicalTypes.TokenUsage
  AssistantMessage: CanonicalTypes.AssistantMessage
  AgentProgressData: CanonicalTypes.AgentProgressData
  HookEventName: CanonicalTypes.HookEventName
  HookProgressData: CanonicalTypes.HookProgressData
  ParsedHookEvent: CanonicalTypes.ParsedHookEvent
  ProgressMessage: CanonicalTypes.ProgressMessage
  SystemMessage: CanonicalTypes.SystemMessage
  FileHistorySnapshotMessage: CanonicalTypes.FileHistorySnapshotMessage
  SummaryMessage: CanonicalTypes.SummaryMessage
  QueueOperationMessage: CanonicalTypes.QueueOperationMessage
  RawMessage: CanonicalTypes.RawMessage
  ToolCall: CanonicalTypes.ToolCall
  SubAgentMessage: CanonicalTypes.SubAgentMessage
  TurnContentBlock: CanonicalTypes.TurnContentBlock
  Turn: CanonicalTypes.Turn
  SessionStats: CanonicalTypes.SessionStats
  ParsedSession: CanonicalTypes.ParsedSession
  ArchivedToolCall: CanonicalTypes.ArchivedToolCall
  ArchivedTurn: CanonicalTypes.ArchivedTurn
  Branch: CanonicalTypes.Branch
  UndoState: CanonicalTypes.UndoState
}

type LegacyAuxiliaryTypeSurface = {
  ParseSessionOptions: LegacyParserTypes.ParseSessionOptions
  ParserPendingInteraction: LegacyParserTypes.PendingInteraction
  SessionStatus: LegacySessionStatusTypes.SessionStatus
  SessionStatusInfo: LegacySessionStatusTypes.SessionStatusInfo
  CostInput: LegacyTokenCostTypes.CostInput
  PricingTier: LegacyPricingTypes.PricingTier
  PlanApprovalState: LegacyInteractiveTypes.PlanApprovalState
  UserQuestionState: LegacyInteractiveTypes.UserQuestionState
  PendingInteraction: LegacyInteractiveTypes.PendingInteraction
}

type CanonicalAuxiliaryTypeSurface = {
  ParseSessionOptions: CanonicalParserTypes.ParseSessionOptions
  ParserPendingInteraction: CanonicalParserTypes.PendingInteraction
  SessionStatus: CanonicalSessionStatusTypes.SessionStatus
  SessionStatusInfo: CanonicalSessionStatusTypes.SessionStatusInfo
  CostInput: CanonicalTokenCostTypes.CostInput
  PricingTier: CanonicalPricingTypes.PricingTier
  PlanApprovalState: CanonicalInteractiveTypes.PlanApprovalState
  UserQuestionState: CanonicalInteractiveTypes.UserQuestionState
  PendingInteraction: CanonicalInteractiveTypes.PendingInteraction
}

type RuntimeModule = Readonly<Record<string, unknown>>

const modulePairs: ReadonlyArray<readonly [string, RuntimeModule, RuntimeModule]> = [
  ["parser", legacyParser, canonicalParser],
  ["codex", legacyCodex, canonicalCodex],
  ["turnBuilder", legacyTurnBuilder, canonicalTurnBuilder],
  ["messageTypeGuards", legacyMessageTypeGuards, canonicalMessageTypeGuards],
  ["sessionStats", legacySessionStats, canonicalSessionStats],
  ["sessionStatus", legacySessionStatus, canonicalSessionStatus],
  ["token-costs", legacyTokenCosts, canonicalTokenCosts],
  ["pricingTiers", legacyPricingTiers, canonicalPricingTiers],
  ["interactiveState", legacyInteractiveState, canonicalInteractiveState],
]

describe("session-core compatibility facades", () => {
  it.each(modulePairs)("%s preserves every runtime export by identity", (_name, legacy, canonical) => {
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(canonical).sort())
    for (const [exportName, implementation] of Object.entries(canonical)) {
      expect(legacy[exportName]).toBe(implementation)
    }
  })

  it("preserves every value export signature", () => {
    expectTypeOf(legacyParser).toEqualTypeOf(canonicalParser)
    expectTypeOf(legacyCodex).toEqualTypeOf(canonicalCodex)
    expectTypeOf(legacyTurnBuilder).toEqualTypeOf(canonicalTurnBuilder)
    expectTypeOf(legacyMessageTypeGuards).toEqualTypeOf(canonicalMessageTypeGuards)
    expectTypeOf(legacySessionStats).toEqualTypeOf(canonicalSessionStats)
    expectTypeOf(legacySessionStatus).toEqualTypeOf(canonicalSessionStatus)
    expectTypeOf(legacyTokenCosts).toEqualTypeOf(canonicalTokenCosts)
    expectTypeOf(legacyPricingTiers).toEqualTypeOf(canonicalPricingTiers)
    expectTypeOf(legacyInteractiveState).toEqualTypeOf(canonicalInteractiveState)
  })

  it("preserves all public session-core type contracts", () => {
    expectTypeOf<LegacyTypeSurface>().toEqualTypeOf<CanonicalTypeSurface>()
    expectTypeOf<LegacyAuxiliaryTypeSurface>().toEqualTypeOf<CanonicalAuxiliaryTypeSurface>()
  })
})
