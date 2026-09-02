import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";

import type { BrowserStatus } from "@kbo/contracts";
import { chromium } from "playwright";

export async function inspectPlaywrightBrowser(): Promise<BrowserStatus> {
  const version = playwrightVersion();
  try {
    const executablePath = chromium.executablePath();
    await access(executablePath, fsConstants.R_OK | fsConstants.X_OK);
    return {
      installed: true,
      version,
      executablePath,
      message: "Playwright Chromium을 사용할 수 있습니다.",
    };
  } catch (error: unknown) {
    return {
      installed: false,
      version,
      executablePath: null,
      message: error instanceof Error ? error.message : "Playwright Chromium을 확인할 수 없습니다.",
    };
  }
}

function playwrightVersion(): string | null {
  const require = createRequire(import.meta.url);
  const value = require("playwright/package.json") as unknown;
  if (typeof value !== "object" || value === null || !("version" in value)) return null;
  return typeof value.version === "string" ? value.version : null;
}
