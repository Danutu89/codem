/**
 * Playwright-based browser automation tools exposed to the Vercel AI SDK v6.
 *
 * These tools let an LM Studio model interact with a running web application:
 * navigate, click, fill inputs, take screenshots, read page content, etc.
 *
 * Uses `jsonSchema()` with `inputSchema` (AI SDK v6 API).
 */
import { tool, jsonSchema } from "ai";
import type { Page } from "playwright";

export function createBrowserTools(page: Page) {
  return {
    navigateTo: tool({
      description: "Navigate to a URL. Use absolute URLs or paths relative to the base URL.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "URL or path to navigate to" } },
        required: ["url"],
      }),
      execute: async ({ url }) => {
        try {
          await page.goto(url, { waitUntil: "load", timeout: 30_000 });
          // Give SPAs a moment to finish rendering after initial load
          await page.waitForTimeout(2_000);
          return { success: true, url: page.url(), title: await page.title() };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    clickElement: tool({
      description: "Click an element by CSS selector, text content, role, or test ID.",
      inputSchema: jsonSchema<{ selector: string; selectorType: string }>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: 'CSS selector, text("..."), role("..."), or testid("...")',
          },
          selectorType: {
            type: "string",
            enum: ["css", "text", "role", "testid", "label"],
            default: "css",
          },
        },
        required: ["selector"],
      }),
      execute: async ({ selector, selectorType = "css" }) => {
        try {
          let locator;
          switch (selectorType) {
            case "text":
              locator = page.getByText(selector);
              break;
            case "role":
              locator = page.getByRole(selector as Parameters<typeof page.getByRole>[0]);
              break;
            case "testid":
              locator = page.getByTestId(selector);
              break;
            case "label":
              locator = page.getByLabel(selector);
              break;
            default:
              locator = page.locator(selector);
          }
          await locator.click({ timeout: 5_000 });
          return { success: true, clicked: selector };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    fillInput: tool({
      description: "Fill a form input field with a value.",
      inputSchema: jsonSchema<{ selector: string; value: string; selectorType: string }>({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector or label of the input" },
          value: { type: "string", description: "Value to type into the input" },
          selectorType: {
            type: "string",
            enum: ["css", "label", "placeholder", "testid"],
            default: "css",
          },
        },
        required: ["selector", "value"],
      }),
      execute: async ({ selector, value, selectorType = "css" }) => {
        try {
          let locator;
          switch (selectorType) {
            case "label":
              locator = page.getByLabel(selector);
              break;
            case "placeholder":
              locator = page.getByPlaceholder(selector);
              break;
            case "testid":
              locator = page.getByTestId(selector);
              break;
            default:
              locator = page.locator(selector);
          }
          await locator.fill(value, { timeout: 5_000 });
          return { success: true, filled: selector, value };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    assertVisible: tool({
      description: "Assert that an element is visible on the page.",
      inputSchema: jsonSchema<{ selector: string; selectorType: string }>({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector or text to check" },
          selectorType: {
            type: "string",
            enum: ["css", "text", "role", "testid"],
            default: "css",
          },
        },
        required: ["selector"],
      }),
      execute: async ({ selector, selectorType = "css" }) => {
        try {
          let locator;
          switch (selectorType) {
            case "text":
              locator = page.getByText(selector);
              break;
            case "role":
              locator = page.getByRole(selector as Parameters<typeof page.getByRole>[0]);
              break;
            case "testid":
              locator = page.getByTestId(selector);
              break;
            default:
              locator = page.locator(selector);
          }
          const visible = await locator.isVisible();
          return { success: visible, visible, selector };
        } catch (e) {
          return { success: false, visible: false, error: String(e) };
        }
      },
    }),

    assertText: tool({
      description: "Assert that an element contains specific text.",
      inputSchema: jsonSchema<{
        selector: string;
        expectedText: string;
        exact: boolean;
      }>({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          expectedText: { type: "string", description: "Text that should be present" },
          exact: {
            type: "boolean",
            default: false,
            description: "Whether to match exact text",
          },
        },
        required: ["selector", "expectedText"],
      }),
      execute: async ({ selector, expectedText, exact = false }) => {
        try {
          const locator = page.locator(selector);
          const text = await locator.textContent({ timeout: 5_000 });
          const matches = exact ? text === expectedText : (text?.includes(expectedText) ?? false);
          return { success: matches, actualText: text, expectedText };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    takeScreenshot: tool({
      description: "Take a screenshot of the page or a specific element.",
      inputSchema: jsonSchema<{ selector?: string; fullPage: boolean }>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to screenshot (omit for full page)",
          },
          fullPage: { type: "boolean", default: false },
        },
        required: [],
      }),
      execute: async ({ selector, fullPage = false }) => {
        try {
          let buffer: Buffer;
          if (selector) {
            buffer = await page.locator(selector).screenshot({ timeout: 5_000 });
          } else {
            buffer = await page.screenshot({ fullPage });
          }
          const base64 = buffer.toString("base64");
          return { success: true, screenshot: base64, size: buffer.length };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    getPageContent: tool({
      description:
        "Get the current page content (simplified DOM) for understanding the page structure.",
      inputSchema: jsonSchema<{ selector?: string }>({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to scope content (omit for full page)",
          },
        },
        required: [],
      }),
      execute: async ({ selector }) => {
        try {
          const el = selector ? page.locator(selector) : page.locator("body");
          const html = await el.innerHTML({ timeout: 5_000 });
          return { success: true, content: html, url: page.url() };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    waitForElement: tool({
      description: "Wait for an element to reach a specific state.",
      inputSchema: jsonSchema<{ selector: string; state: string; timeout: number }>({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector of the element" },
          state: {
            type: "string",
            enum: ["visible", "hidden", "attached", "detached"],
            default: "visible",
          },
          timeout: {
            type: "number",
            default: 10000,
            description: "Timeout in milliseconds",
          },
        },
        required: ["selector"],
      }),
      execute: async ({
        selector,
        state = "visible",
        timeout = 10_000,
      }) => {
        try {
          await page
            .locator(selector)
            .waitFor({ state: state as "visible" | "hidden" | "attached" | "detached", timeout });
          return { success: true, selector, state };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),

    pressKey: tool({
      description: "Press a keyboard key (Enter, Tab, Escape, etc.).",
      inputSchema: jsonSchema<{ key: string }>({
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key to press (Enter, Tab, Escape, ArrowDown, etc.)",
          },
        },
        required: ["key"],
      }),
      execute: async ({ key }) => {
        try {
          await page.keyboard.press(key);
          return { success: true, key };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
    }),
  };
}

export type BrowserTools = ReturnType<typeof createBrowserTools>;
