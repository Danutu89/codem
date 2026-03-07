/**
 * AI-powered browser test runner.
 *
 * Launches a headless Playwright Chromium browser, navigates to the target app,
 * and uses an LM Studio model (via OpenAI-compatible API) to autonomously
 * verify the application's UI.
 *
 * Uses a manual agentic loop with a sliding context window so that context
 * usage stays constant regardless of step count.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool } from "ai";
import type { BrowserTestResult, BrowserTestStepResult } from "@t3tools/contracts";

export interface BrowserTestCallbacks {
  onRunning: (message: string) => void;
  onStep: (step: BrowserTestStepResult) => void;
  onCompleted: (result: BrowserTestResult) => void;
  onError: (error: string) => void;
}

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;
let activeAbortController: AbortController | null = null;

export async function stopBrowserTest(): Promise<void> {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (activeContext) {
    await activeContext.close().catch(() => {});
    activeContext = null;
  }
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
}

export function isBrowserTestRunning(): boolean {
  return activeBrowser !== null && activeBrowser.isConnected();
}

// ── Action log entry (compact summary of each step) ─────────────────

interface ActionLogEntry {
  step: number;
  action: string;
  target: string;
  ok: boolean;
  observation: string;
}

function formatActionLog(log: ActionLogEntry[]): string {
  if (log.length === 0) return "No actions taken yet.";
  return log
    .map((e) => {
      const targetPart = e.target ? ` on "${e.target}"` : "";
      return `${e.step}. [${e.ok ? "OK" : "FAIL"}] ${e.action}${targetPart} → ${e.observation}`;
    })
    .join("\n");
}

// ── Page snapshot (simplified full HTML) ─────────────────────────────

// Shared simplify logic injected into the page context.
// Returns { html, truncated } so callers know if the budget was hit.
function buildSimplifyScript(selector: string | null, budget: number) {
  return { selector, budget };
}

async function runSimplify(
  page: Page,
  opts: { selector: string | null; budget: number },
): Promise<{ html: string; truncated: boolean }> {
  return page.evaluate(({ selector, budget }) => {
    const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "path", "meta", "link", "head"]);
    const KEEP_ATTRS = new Set(["id", "class", "href", "src", "type", "name", "placeholder", "value", "role", "aria-label", "data-testid", "for", "action", "method", "target", "alt", "title", "disabled", "checked", "selected"]);
    const MAX_DEPTH = 15;
    let spent = 0;
    let truncated = false;

    function simplify(el: Element, depth: number): string {
      if (spent >= budget) { truncated = true; return ""; }
      if (depth > MAX_DEPTH) { truncated = true; return ""; }

      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return "";

      const attrs: string[] = [];
      for (const attr of el.attributes) {
        if (KEEP_ATTRS.has(attr.name)) {
          attrs.push(`${attr.name}="${attr.value}"`);
        }
      }
      const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";

      if (["br", "hr", "img", "input"].includes(tag)) {
        const s = `<${tag}${attrStr} />`;
        spent += s.length;
        return s;
      }

      const childParts: string[] = [];
      let skippedChildren = 0;
      for (const child of el.childNodes) {
        if (spent >= budget) {
          skippedChildren++;
          continue;
        }
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.textContent ?? "").trim();
          if (text) {
            childParts.push(text);
            spent += text.length;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const childHtml = simplify(child as Element, depth + 1);
          if (childHtml) childParts.push(childHtml);
        }
      }

      if (skippedChildren > 0) {
        truncated = true;
        childParts.push(`<!-- +${skippedChildren} more children -->`);
      }

      const inner = childParts.join("");
      if (!inner && !attrStr && (tag === "div" || tag === "span")) return "";

      const result = `<${tag}${attrStr}>${inner}</${tag}>`;
      spent += tag.length * 2 + attrStr.length + 5;
      return result;
    }

    let root: Element | null;
    if (selector) {
      root = document.querySelector(selector);
      if (!root) return { html: `<!-- element not found: ${selector} -->`, truncated: false };
    } else {
      root = document.body;
    }
    if (!root) return { html: "<body></body>", truncated: false };

    const html = simplify(root, 0);
    if (truncated) {
      return { html: html + `\n<!-- snapshot truncated — use inspectElement to explore further -->`, truncated };
    }
    return { html, truncated };
  }, opts);
}

async function getPageSnapshot(page: Page): Promise<string> {
  try {
    const title = await page.title();
    const url = page.url();

    const { html, truncated } = await runSimplify(page, buildSimplifyScript(null, 24_000));

    let result = `URL: ${url}\nTitle: ${title}\n\nHTML:\n${html}`;
    if (truncated) {
      result += `\n\n⚠ Page was truncated. Use the "inspectElement" tool with a CSS selector to explore sections that were cut off.`;
    }
    return result;
  } catch {
    return `URL: ${page.url()}\n(page snapshot failed)`;
  }
}

// ── Truncate error strings ──────────────────────────────────────────

function truncateError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
}

// ── Main runner ─────────────────────────────────────────────────────

const MAX_STEPS = 20;

export async function runBrowserTest(options: {
  appUrl: string;
  lmStudioEndpoint: string;
  lmStudioModelId: string;
  instructions?: string | undefined;
  userPrompt?: string | undefined;
  callbacks: BrowserTestCallbacks;
}): Promise<BrowserTestResult> {
  const { appUrl, lmStudioEndpoint, lmStudioModelId, instructions, userPrompt, callbacks } = options;

  // Clean up any previous run
  await stopBrowserTest();

  const abortController = new AbortController();
  activeAbortController = abortController;
  const startTime = Date.now();
  const steps: BrowserTestStepResult[] = [];
  const consoleLogs: Array<{ level: string; text: string }> = [];
  const screenshots: string[] = [];
  const actionLog: ActionLogEntry[] = [];

  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  try {
    callbacks.onRunning("Launching browser...");

    browser = await chromium.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    activeBrowser = browser;

    browser.on("disconnected", () => {
      activeBrowser = null;
      activeContext = null;
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      baseURL: appUrl,
    });
    activeContext = context;

    page = await context.newPage();

    // Collect console logs
    page.on("console", (msg) => {
      const type = msg.type();
      const level = type === "warning" ? "warn" : type;
      if (["error", "warn", "info", "log"].includes(level)) {
        consoleLogs.push({ level, text: msg.text() });
      }
    });

    callbacks.onRunning(`Navigating to ${appUrl}...`);
    await page.goto(appUrl, { waitUntil: "load", timeout: 30_000 });
    // Give SPAs a moment to finish rendering after initial load
    await page.waitForTimeout(2_000);

    callbacks.onRunning("Starting AI verification...");

    // Set up the LM Studio AI model
    const lmStudio = createOpenAI({
      baseURL: lmStudioEndpoint,
      apiKey: "lm-studio",
      compatibility: "compatible",
    });
    const modelId = lmStudioModelId || "default";
    const model = lmStudio.chat(modelId, { structuredOutputs: false });

    const hasAgentContext = !!instructions?.trim();
    const hasUserPrompt = !!userPrompt?.trim();

    let systemPrompt: string;
    if (hasAgentContext) {
      const contextParts: string[] = [];
      if (hasUserPrompt) {
        contextParts.push(`## User's original request\n${userPrompt!.trim()}`);
      }
      contextParts.push(`## What the coding agent changed\n${instructions!.trim()}`);

      systemPrompt = `You are a QA tester verifying specific changes made by a coding agent to a web application.

${contextParts.join("\n\n")}

Your job:
1. Look at the current page state and the history of actions already taken
2. Choose ONE action that **has not been tried yet** to verify the changes
3. After enough verification, use the "finish" action with your verdict

IMPORTANT RULES:
- Do NOT repeat an action you already took. Check the "Actions taken so far" section carefully.
- Each step should verify something NEW — a different element, page, or interaction.
- If a previous action failed, try a DIFFERENT approach rather than retrying the same thing.
- Focus on verifying what the agent changed. Do not explore unrelated areas.
- Once you have enough evidence (pass or fail), call "finish" immediately.`;
    } else {
      systemPrompt = `You are a QA tester verifying a web application.
${hasUserPrompt ? `\n## User's bug report / request\n${userPrompt!.trim()}\n` : ""}
Your job:
1. Look at the current page state and the history of actions already taken
2. Choose ONE action that **has not been tried yet** to verify the app works
3. After enough verification, use the "finish" action with your verdict

IMPORTANT RULES:
- Do NOT repeat an action you already took. Check the "Actions taken so far" section carefully.
- Each step should verify something NEW — a different element, page, or interaction.
- If a previous action failed, try a DIFFERENT approach rather than retrying the same thing.
- Be thorough but efficient. Focus on the most important user-facing functionality.
- Once you have enough evidence (pass or fail), call "finish" immediately.`;
    }

    // ── Manual agentic loop (fixed context per iteration) ─────────

    let finalVerdict = "";

    for (let stepNumber = 1; stepNumber <= MAX_STEPS; stepNumber++) {
      if (abortController.signal.aborted) break;

      // Get fresh page snapshot each step
      const snapshot = await getPageSnapshot(page);

      // Only keep last 10 action log entries to bound context
      const recentLog = actionLog.slice(-10);

      const stepsRemaining = MAX_STEPS - stepNumber;
      let urgency = "";
      if (stepsRemaining <= 0) {
        urgency = `\n\n🚨 THIS IS YOUR LAST STEP. You MUST call "finish" now with your verdict based on everything you've observed so far.`;
      } else if (stepsRemaining <= 2) {
        urgency = `\n\n⚠ Only ${stepsRemaining} step(s) remaining. You should call "finish" NOW unless you have critical verification left.`;
      }

      const stepPrompt = `## Current page state
${snapshot}

## Actions taken so far (step ${stepNumber} of ${MAX_STEPS})
${formatActionLog(recentLog)}

## Console errors
${consoleLogs.filter((l) => l.level === "error").slice(-5).map((l) => l.text).join("\n") || "None"}

Choose your next action. Do NOT repeat any action from the list above. If you have enough information, use "finish" with your verdict.${urgency}`;

      // Track what tool was called in this iteration
      let stepAction = "thinking";
      let stepTarget = "";
      let stepSuccess = true;
      let stepDone = false;
      let stepObservation = "";

      // On the very last step, only expose the finish tool to force a verdict
      const isLastStep = stepNumber >= MAX_STEPS;

      // Single-step generateText — no accumulation across iterations
      const { text } = await generateText({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: stepPrompt }],
        tools: isLastStep ? {
          finish: tool({
            description: 'End the test. Provide verdict: "pass" or "fail", and a summary.',
            inputSchema: jsonSchema<{ verdict: string; summary: string }>({
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["pass", "fail"] },
                summary: { type: "string", description: "Brief explanation of test results" },
              },
              required: ["verdict", "summary"],
            }),
            execute: async ({ verdict, summary }) => {
              stepAction = "finish";
              stepTarget = verdict;
              stepDone = true;
              stepSuccess = verdict === "pass";
              stepObservation = summary;
              finalVerdict = summary;
              return { done: true, verdict, summary };
            },
          }),
        } : {
          navigateTo: tool({
            description: "Navigate to a URL or path.",
            inputSchema: jsonSchema<{ url: string }>({
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
            }),
            execute: async ({ url }) => {
              stepAction = "navigate";
              stepTarget = url;
              try {
                await page.goto(url, { waitUntil: "load", timeout: 30_000 });
                await page.waitForTimeout(2_000);
                stepObservation = `Navigated to ${page.url()} successfully`;
                return { success: true, url: page.url() };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Navigation failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          clickElement: tool({
            description: 'Click an element. Use selectorType: "css", "text", "role", "testid", or "label".',
            inputSchema: jsonSchema<{ selector: string; selectorType?: string }>({
              type: "object",
              properties: {
                selector: { type: "string" },
                selectorType: { type: "string", enum: ["css", "text", "role", "testid", "label"] },
              },
              required: ["selector"],
            }),
            execute: async ({ selector, selectorType = "css" }) => {
              stepAction = "click";
              stepTarget = `${selectorType}:${selector}`;
              try {
                let locator;
                switch (selectorType) {
                  case "text": locator = page.getByText(selector); break;
                  case "role": locator = page.getByRole(selector as Parameters<typeof page.getByRole>[0]); break;
                  case "testid": locator = page.getByTestId(selector); break;
                  case "label": locator = page.getByLabel(selector); break;
                  default: locator = page.locator(selector);
                }
                await locator.click({ timeout: 5_000 });
                stepObservation = `Clicked element successfully, page may have changed`;
                return { success: true };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Click failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          fillInput: tool({
            description: "Fill a form input field.",
            inputSchema: jsonSchema<{ selector: string; value: string; selectorType?: string }>({
              type: "object",
              properties: {
                selector: { type: "string" },
                value: { type: "string" },
                selectorType: { type: "string", enum: ["css", "label", "placeholder", "testid"] },
              },
              required: ["selector", "value"],
            }),
            execute: async ({ selector, value, selectorType = "css" }) => {
              stepAction = "fill";
              stepTarget = `${selectorType}:${selector} = "${value.slice(0, 50)}"`;
              try {
                let locator;
                switch (selectorType) {
                  case "label": locator = page.getByLabel(selector); break;
                  case "placeholder": locator = page.getByPlaceholder(selector); break;
                  case "testid": locator = page.getByTestId(selector); break;
                  default: locator = page.locator(selector);
                }
                await locator.fill(value, { timeout: 5_000 });
                stepObservation = `Filled input with "${value.slice(0, 50)}" successfully`;
                return { success: true };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Fill failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          assertVisible: tool({
            description: "Check that an element is visible.",
            inputSchema: jsonSchema<{ selector: string; selectorType?: string }>({
              type: "object",
              properties: {
                selector: { type: "string" },
                selectorType: { type: "string", enum: ["css", "text", "role", "testid"] },
              },
              required: ["selector"],
            }),
            execute: async ({ selector, selectorType = "css" }) => {
              stepAction = "assertVisible";
              stepTarget = `${selectorType}:${selector}`;
              try {
                let locator;
                switch (selectorType) {
                  case "text": locator = page.getByText(selector); break;
                  case "role": locator = page.getByRole(selector as Parameters<typeof page.getByRole>[0]); break;
                  case "testid": locator = page.getByTestId(selector); break;
                  default: locator = page.locator(selector);
                }
                const visible = await locator.isVisible();
                stepSuccess = visible;
                stepObservation = visible ? `Element IS visible on page` : `Element is NOT visible on page`;
                return { success: visible, visible };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Assertion failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          takeScreenshot: tool({
            description: "Take a screenshot (for evidence, not returned to you).",
            inputSchema: jsonSchema<{ fullPage?: boolean }>({
              type: "object",
              properties: { fullPage: { type: "boolean" } },
              required: [],
            }),
            execute: async ({ fullPage = false }) => {
              stepAction = "screenshot";
              try {
                const buffer = await page.screenshot({ fullPage });
                screenshots.push(buffer.toString("base64"));
                stepObservation = `Screenshot captured (${fullPage ? "full page" : "viewport"})`;
                return { success: true, captured: true };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Screenshot failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          pressKey: tool({
            description: "Press a keyboard key (Enter, Tab, Escape, etc.).",
            inputSchema: jsonSchema<{ key: string }>({
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
            }),
            execute: async ({ key }) => {
              stepAction = "pressKey";
              stepTarget = key;
              try {
                await page.keyboard.press(key);
                stepObservation = `Key "${key}" pressed successfully`;
                return { success: true };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Key press failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          inspectElement: tool({
            description:
              "Get the simplified HTML of a specific element by CSS selector. " +
              "Use this when the page snapshot was truncated and you need to see " +
              "a section that was cut off. Returns the subtree with its own budget.",
            inputSchema: jsonSchema<{ selector: string }>({
              type: "object",
              properties: {
                selector: {
                  type: "string",
                  description: "CSS selector of the element to inspect (e.g. 'main', '#content', '.sidebar', 'section:nth-child(3)')",
                },
              },
              required: ["selector"],
            }),
            execute: async ({ selector }) => {
              stepAction = "inspectElement";
              stepTarget = selector;
              try {
                const { html, truncated } = await runSimplify(
                  page,
                  buildSimplifyScript(selector, 16_000),
                );
                stepObservation = html
                  ? `Inspected "${selector}" (${html.length} chars${truncated ? ", truncated" : ""})`
                  : `Element "${selector}" not found or empty`;
                return {
                  success: true,
                  selector,
                  html,
                  truncated,
                  hint: truncated
                    ? "Content was still truncated. Narrow down with a more specific selector."
                    : undefined,
                };
              } catch (e) {
                stepSuccess = false;
                stepObservation = `Inspect failed: ${truncateError(e)}`;
                return { success: false, error: truncateError(e) };
              }
            },
          }),
          finish: tool({
            description: 'End the test. Provide verdict: "pass" or "fail", and a summary.',
            inputSchema: jsonSchema<{ verdict: string; summary: string }>({
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["pass", "fail"] },
                summary: { type: "string", description: "Brief explanation of test results" },
              },
              required: ["verdict", "summary"],
            }),
            execute: async ({ verdict, summary }) => {
              stepAction = "finish";
              stepTarget = verdict;
              stepDone = true;
              stepSuccess = verdict === "pass";
              stepObservation = summary;
              finalVerdict = summary;
              return { done: true, verdict, summary };
            },
          }),
        },
        toolChoice: "required",
        maxSteps: 2, // tool call + result, then stop
        maxOutputTokens: 1024,
        abortSignal: abortController.signal,
      });

      // If the model produced text instead of a tool call, capture it
      if (text && text.length > 0 && !finalVerdict) {
        finalVerdict = text;
      }

      // Record step
      const stepResult: BrowserTestStepResult = {
        stepNumber,
        action: stepAction,
        target: stepTarget.slice(0, 200),
        success: stepSuccess,
        detail: text || undefined,
      };
      steps.push(stepResult);
      callbacks.onStep(stepResult);

      // Add to action log with observation so the AI knows what was already tested
      actionLog.push({
        step: stepNumber,
        action: stepAction,
        target: stepTarget.slice(0, 100),
        ok: stepSuccess,
        observation: stepObservation || (text || "done").slice(0, 120),
      });

      if (stepDone) break;
    }

    // Auto-synthesize verdict if the model never called finish
    if (!finalVerdict) {
      const failedSteps = actionLog.filter((e) => !e.ok);
      if (failedSteps.length > 0) {
        finalVerdict = `Auto-verdict: FAIL — ${failedSteps.length} action(s) failed: ${failedSteps.map((e) => `${e.action} on "${e.target}"`).join(", ")}. The AI agent used all ${MAX_STEPS} steps without providing an explicit verdict.`;
      } else {
        finalVerdict = `Auto-verdict: PASS — All ${actionLog.length} action(s) succeeded. The AI agent used all ${MAX_STEPS} steps without providing an explicit verdict.`;
      }
    }

    const aiSummary = finalVerdict;
    const passed = inferPassed(aiSummary);
    const durationMs = Date.now() - startTime;

    const result: BrowserTestResult = {
      passed,
      totalSteps: steps.length,
      durationMs,
      aiSummary,
      steps,
      consoleLogs,
      screenshots,
    };

    callbacks.onCompleted(result);
    return result;
  } catch (error) {
    if (abortController.signal.aborted) {
      const abortResult: BrowserTestResult = {
        passed: false,
        totalSteps: steps.length,
        durationMs: Date.now() - startTime,
        aiSummary: "Test was stopped by user.",
        steps,
        consoleLogs,
        screenshots,
      };
      callbacks.onError("Test was stopped by user.");
      return abortResult;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    callbacks.onError(errorMessage);

    return {
      passed: false,
      totalSteps: steps.length,
      durationMs: Date.now() - startTime,
      aiSummary: `Test failed with error: ${errorMessage}`,
      steps,
      consoleLogs,
      screenshots,
    };
  } finally {
    await stopBrowserTest();
  }
}

function inferPassed(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("fail") || lower.includes("broken") || lower.includes("error")) {
    return false;
  }
  if (
    lower.includes("pass") ||
    lower.includes("success") ||
    lower.includes("working correctly") ||
    lower.includes("verified") ||
    lower.includes("looks good")
  ) {
    return true;
  }
  return true;
}
