import { spawn } from "node:child_process";
import { ensureYtDlpReady } from "../subtitle/service";
import { createLogger } from "../telegram/logger";

const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 5 * 60 * 1_000;

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timeout (${timeoutMs}ms): ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function isPlaywrightChromiumReady(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

async function installPlaywrightChromium(): Promise<void> {
  const bunxCmd = process.platform === "win32" ? "bunx.cmd" : "bunx";
  const result = await runCommand(
    bunxCmd,
    ["playwright", "install", "chromium"],
    PLAYWRIGHT_INSTALL_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "unknown error");
  }
}

export async function setupRuntimeBinaries(): Promise<void> {
  const logger = createLogger("runtime-setup");
  await logger.info("checking runtime binaries");

  const ytDlpBinary = await ensureYtDlpReady();
  await logger.info("yt-dlp ready", { binary: ytDlpBinary });

  if (await isPlaywrightChromiumReady()) {
    await logger.info("playwright chromium ready");
    return;
  }

  await logger.warn(
    "playwright chromium not found, installing automatically...",
  );
  await installPlaywrightChromium();

  const readyAfterInstall = await isPlaywrightChromiumReady();
  if (!readyAfterInstall) {
    throw new Error(
      "Playwright Chromium belum siap setelah install otomatis. Jalankan manual: bunx playwright install chromium",
    );
  }

  await logger.info("playwright chromium ready");
}
