/**
 * TextGenerationTags - Provider-specific service tags for text generation.
 *
 * These allow the Codex and Claude implementations to coexist as separate
 * services so the {@link DynamicTextGeneration} layer can hold both and
 * dispatch at call time based on the active provider.
 *
 * @module TextGenerationTags
 */
import { ServiceMap } from "effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

/**
 * CodexTextGenerationTag - Service tag for the Codex CLI implementation.
 */
export class CodexTextGenerationTag extends ServiceMap.Service<
  CodexTextGenerationTag,
  TextGenerationShape
>()("t3/git/Services/TextGenerationTags/CodexTextGenerationTag") {}

/**
 * ClaudeTextGenerationTag - Service tag for the Claude CLI implementation.
 */
export class ClaudeTextGenerationTag extends ServiceMap.Service<
  ClaudeTextGenerationTag,
  TextGenerationShape
>()("t3/git/Services/TextGenerationTags/ClaudeTextGenerationTag") {}
