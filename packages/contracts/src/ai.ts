import { Schema } from "effect";
import { TrimmedNonEmptyStringSchema } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

// ── Thread Title Generation ──────────────────────────────────────────

export const AiGenerateThreadTitleInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
  provider: Schema.optional(ProviderKind),
});
export type AiGenerateThreadTitleInput = typeof AiGenerateThreadTitleInput.Type;

export interface AiGenerateThreadTitleResult {
  title: string;
}
