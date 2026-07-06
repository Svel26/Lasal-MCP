import { z } from "zod";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readState } from "../state.js";
import { EDGE_EXE } from "../utils/engine.js";

export const hmiBrowserSchema = {
  action: z.enum(["open", "screenshot", "console", "eval", "click", "type", "wait", "close"])
    .describe("Action to perform in the HMI browser session."),
  url: z.string().optional().describe("URL to navigate to (open action only). Defaults to the active HMI runtime URL."),
  viewport: z.object({
    width: z.number().int(),
    height: z.number().int()
  }).optional().describe("Browser viewport size (open action only). Defaults to 1200x800."),
  fullPage: z.boolean().optional().default(false).describe("Take a full page screenshot (screenshot action only)."),
  selector: z.string().optional().describe("CSS/Text selector to screenshot, click, type, or wait for."),
  text: z.string().optional().describe("Text content to type, or to find for clicking."),
  x: z.number().int().optional().describe("X coordinate for mouse click."),
  y: z.number().int().optional().describe("Y coordinate for mouse click."),
  expression: z.string().optional().describe("JavaScript expression to evaluate (eval action only)."),
  ms: z.number().int().optional().describe("Milliseconds to wait (wait action only)."),
  clear: z.boolean().optional().default(false).describe("Clear the console/error buffers after reading them (console action only)."),
};

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
const consoleLogs: string[] = [];
const pageErrors: string[] = [];

async function ensureBrowser() {
  if (browser) return;

  const launchOptions: any = {
    headless: true,
  };

  if (EDGE_EXE) {
    launchOptions.executablePath = EDGE_EXE;
  } else {
    launchOptions.channel = "msedge";
  }

  browser = await chromium.launch(launchOptions);
  context = await browser.newContext();
  page = await context.newPage();

  page.on("console", (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    if (consoleLogs.length > 500) consoleLogs.shift();
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.stack || err.message);
    if (pageErrors.length > 100) pageErrors.shift();
  });
}

export async function hmiBrowserHandler(args: {
  action: "open" | "screenshot" | "console" | "eval" | "click" | "type" | "wait" | "close";
  url?: string;
  viewport?: { width: number; height: number };
  fullPage?: boolean;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  expression?: string;
  ms?: number;
  clear?: boolean;
}) {
  try {
    if (args.action === "close") {
      if (browser) {
        await browser.close();
        browser = null;
        context = null;
        page = null;
      }
      return { content: [{ type: "text" as const, text: "Browser session closed." }] };
    }

    await ensureBrowser();
    const p = page!;

    switch (args.action) {
      case "open": {
        const state = readState();
        const targetUrl = args.url || state.hmiRuntime?.url || "file:///C:/lslvisu/index.html";
        const width = args.viewport?.width ?? 1200;
        const height = args.viewport?.height ?? 800;

        await p.setViewportSize({ width, height });
        await p.goto(targetUrl, { waitUntil: "networkidle", timeout: 15000 });
        // Also wait a brief moment for HMI animation to settle
        await new Promise(resolve => setTimeout(resolve, 1500));

        return { content: [{ type: "text" as const, text: `Successfully opened ${targetUrl} with viewport ${width}x${height}` }] };
      }

      case "screenshot": {
        let buffer: Buffer;
        if (args.selector) {
          buffer = await p.locator(args.selector).screenshot();
        } else {
          buffer = await p.screenshot({ fullPage: args.fullPage });
        }
        return {
          content: [{
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType: "image/png"
          }]
        };
      }

      case "console": {
        const logs = [...consoleLogs];
        const errors = [...pageErrors];
        if (args.clear) {
          consoleLogs.length = 0;
          pageErrors.length = 0;
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ logs, errors }, null, 2)
          }]
        };
      }

      case "eval": {
        if (!args.expression) {
          return { content: [{ type: "text" as const, text: "expression is required for action 'eval'" }], isError: true };
        }
        const res = await p.evaluate(args.expression);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(res, null, 2)
          }]
        };
      }

      case "click": {
        if (args.selector) {
          await p.click(args.selector, { timeout: 10000 });
        } else if (args.text) {
          await p.click(`text=${args.text}`, { timeout: 10000 });
        } else if (args.x !== undefined && args.y !== undefined) {
          await p.mouse.click(args.x, args.y);
        } else {
          return { content: [{ type: "text" as const, text: "selector, text, or coordinates (x, y) required for action 'click'" }], isError: true };
        }
        // Give time for click events/transitions to resolve
        await new Promise(resolve => setTimeout(resolve, 500));
        return { content: [{ type: "text" as const, text: "Click executed successfully." }] };
      }

      case "type": {
        if (!args.selector) {
          return { content: [{ type: "text" as const, text: "selector is required for action 'type'" }], isError: true };
        }
        const val = args.text ?? "";
        await p.fill(args.selector, val, { timeout: 10000 });
        return { content: [{ type: "text" as const, text: `Successfully typed "${val}" into ${args.selector}.` }] };
      }

      case "wait": {
        if (args.selector) {
          await p.waitForSelector(args.selector, { timeout: args.ms ?? 10000 });
          return { content: [{ type: "text" as const, text: `Selector ${args.selector} appeared.` }] };
        } else if (args.ms) {
          await new Promise(resolve => setTimeout(resolve, args.ms));
          return { content: [{ type: "text" as const, text: `Waited for ${args.ms} ms.` }] };
        } else {
          return { content: [{ type: "text" as const, text: "selector or ms is required for action 'wait'" }], isError: true };
        }
      }

      default:
        return { content: [{ type: "text" as const, text: `Unknown action: ${args.action}` }], isError: true };
    }
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Browser error: ${e.message}` }], isError: true };
  }
}
