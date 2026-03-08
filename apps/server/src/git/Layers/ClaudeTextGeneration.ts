/**
 * ClaudeTextGeneration - Text generation using the Claude Agent SDK.
 *
 * Uses `@anthropic-ai/claude-agent-sdk` `query()` with `outputFormat`
 * (json_schema) and `permissionMode: "plan"` for one-shot structured
 * generation of commit messages, PR content, and branch names.
 *
 * @module ClaudeTextGeneration
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer, Schema } from "effect";

import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "../Errors.ts";
import {
  type BranchNameGenerationResult,
  type CommitMessageGenerationResult,
  type PrContentGenerationResult,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { ClaudeTextGenerationTag } from "../Services/TextGenerationTags.ts";

const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-6";
const CLAUDE_TIMEOUT_MS = 180_000;

function toJsonSchemaObject(schema: Schema.Top): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    } as Record<string, unknown>;
  }
  return document.schema as Record<string, unknown>;
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/**
 * Run a one-shot Claude query with structured JSON output via the Agent SDK.
 *
 * Uses `permissionMode: "plan"` so no tools are executed.
 */
function runClaudeJson<S extends Schema.Top & { readonly DecodingServices: never }>({
  operation,
  cwd,
  prompt,
  outputSchemaJson,
}: {
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
  cwd: string;
  prompt: string;
  outputSchemaJson: S;
}): Effect.Effect<S["Type"], TextGenerationError> {
  return Effect.gen(function* () {
    const jsonSchema = toJsonSchemaObject(outputSchemaJson);

    const result = yield* Effect.tryPromise({
      try: (signal) => {
        return new Promise<{ result: string; structured_output?: unknown }>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              queryRuntime.close();
              reject(
                new TextGenerationError({
                  operation,
                  detail: "Claude SDK request timed out.",
                }),
              );
            }, CLAUDE_TIMEOUT_MS);

            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              queryRuntime.close();
            });

            const queryRuntime = query({
              prompt,
              options: {
                cwd,
                model: CLAUDE_DEFAULT_MODEL,
                permissionMode: "plan",
                outputFormat: {
                  type: "json_schema",
                  schema: jsonSchema,
                },
              },
            });

            (async () => {
              try {
                for await (const message of queryRuntime as AsyncIterable<SDKMessage>) {
                  if (message.type === "result") {
                    clearTimeout(timeout);
                    if (message.subtype === "success") {
                      resolve({
                        result: message.result,
                        structured_output: (message as Record<string, unknown>)
                          .structured_output,
                      });
                    } else {
                      reject(
                        new TextGenerationError({
                          operation,
                          detail: `Claude SDK query failed: ${(message as { errors?: string[] }).errors?.join(", ") ?? "unknown error"}`,
                        }),
                      );
                    }
                    return;
                  }
                }
                clearTimeout(timeout);
                reject(
                  new TextGenerationError({
                    operation,
                    detail: "Claude SDK query ended without a result message.",
                  }),
                );
              } catch (err) {
                clearTimeout(timeout);
                reject(err);
              }
            })();
          },
        );
      },
      catch: (cause) => {
        if (Schema.is(TextGenerationError)(cause)) return cause;
        const msg = cause instanceof Error ? cause.message : String(cause);
        return new TextGenerationError({
          operation,
          detail: `Claude SDK query failed: ${msg}`,
          cause,
        });
      },
    });

    // Prefer structured_output if available, otherwise parse the result string
    const resultData: unknown =
      result.structured_output != null
        ? result.structured_output
        : (() => {
            try {
              return JSON.parse(result.result) as unknown;
            } catch {
              return null;
            }
          })();

    if (resultData != null && typeof resultData === "object") {
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(outputSchemaJson)(resultData),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            cause,
          }),
      });
    }

    // Fallback: decode the result string as JSON
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.fromJsonString(outputSchemaJson))(result.result),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Claude returned invalid structured output.",
          cause,
        }),
    });
  });
}

const makeClaudeTextGeneration = Effect.succeed({
  generateCommitMessage: (input) => {
    const wantsBranch = input.includeBranch === true;

    const prompt = [
      "You write concise git commit messages.",
      wantsBranch
        ? "Return a JSON object with keys: subject, body, branch."
        : "Return a JSON object with keys: subject, body.",
      "Rules:",
      "- subject must be imperative, <= 72 chars, and no trailing period",
      "- body can be empty string or short bullet points",
      ...(wantsBranch
        ? ["- branch must be a short semantic git branch fragment for this change"]
        : []),
      "- capture the primary user-visible or developer-visible change",
      "",
      `Branch: ${input.branch ?? "(detached)"}`,
      "",
      "Staged files:",
      limitSection(input.stagedSummary, 6_000),
      "",
      "Staged patch:",
      limitSection(input.stagedPatch, 40_000),
    ].join("\n");

    const outputSchemaJson = wantsBranch
      ? Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
          branch: Schema.String,
        })
      : Schema.Struct({
          subject: Schema.String,
          body: Schema.String,
        });

    return runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson,
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            subject: sanitizeCommitSubject(generated.subject),
            body: generated.body.trim(),
            ...("branch" in generated && typeof generated.branch === "string"
              ? { branch: sanitizeFeatureBranchName(generated.branch) }
              : {}),
          }) satisfies CommitMessageGenerationResult,
      ),
    );
  },

  generatePrContent: (input) => {
    const prompt = [
      "You write GitHub pull request content.",
      "Return a JSON object with keys: title, body.",
      "Rules:",
      "- title should be concise and specific",
      "- body must be markdown and include headings '## Summary' and '## Testing'",
      "- under Summary, provide short bullet points",
      "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
      "",
      `Base branch: ${input.baseBranch}`,
      `Head branch: ${input.headBranch}`,
      "",
      "Commits:",
      limitSection(input.commitSummary, 12_000),
      "",
      "Diff stat:",
      limitSection(input.diffSummary, 12_000),
      "",
      "Diff patch:",
      limitSection(input.diffPatch, 40_000),
    ].join("\n");

    return runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
      }),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            title: sanitizePrTitle(generated.title),
            body: generated.body.trim(),
          }) satisfies PrContentGenerationResult,
      ),
    );
  },

  generateBranchName: (input) => {
    const attachmentLines = (input.attachments ?? []).map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    );

    const promptSections = [
      "You generate concise git branch names.",
      "Return a JSON object with key: branch.",
      "Rules:",
      "- Branch should describe the requested work from the user message.",
      "- Keep it short and specific (2-6 words).",
      "- Use plain words only, no issue prefixes and no punctuation-heavy text.",
      "- If images are attached, use them as primary context for visual/UI issues.",
      "",
      "User message:",
      limitSection(input.message, 8_000),
    ];
    if (attachmentLines.length > 0) {
      promptSections.push(
        "",
        "Attachment metadata:",
        limitSection(attachmentLines.join("\n"), 4_000),
      );
    }
    const prompt = promptSections.join("\n");

    return runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: Schema.Struct({
        branch: Schema.String,
      }),
    }).pipe(
      Effect.map(
        (generated) =>
          ({
            branch: sanitizeBranchFragment(generated.branch),
          }) satisfies BranchNameGenerationResult,
      ),
    );
  },
} satisfies TextGenerationShape);

export const ClaudeTextGenerationLive = Layer.effect(
  ClaudeTextGenerationTag,
  makeClaudeTextGeneration,
);
