import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { acquireLock } from "@affiliate/redis";
import type { BrowserContext } from "playwright";
import { PlaywrightWhatsAppWebPageAdapter } from "./whatsapp-web-page-adapter";
import type {
  BrowserSession,
  WhatsAppWebBrowserLauncher,
  WhatsAppWebProfileLock,
} from "./whatsapp-web-types";

export function sanitizeWhatsAppWebProfileKey(value: string) {
  const key = value.trim();
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("WHATSAPP_WEB_PROFILE_KEY_INVALID");
  }
  return key;
}

export function resolveWhatsAppWebProfilePath(
  root: string,
  profileKey: string,
) {
  const safeKey = sanitizeWhatsAppWebProfileKey(profileKey);
  const rootPath = isAbsolute(root)
    ? resolve(root)
    : resolve(findWorkspaceRoot(), root);
  const profilePath = resolve(rootPath, safeKey);
  if (!profilePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("WHATSAPP_WEB_PROFILE_KEY_INVALID");
  }
  return profilePath;
}

function findWorkspaceRoot(start = process.cwd()) {
  let current = resolve(start);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          workspaces?: unknown;
        };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Keep walking; malformed child manifests must not alter the safe root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export class RedisWhatsAppWebProfileLock implements WhatsAppWebProfileLock {
  async acquire(profileKey: string, ttlMs: number) {
    const safeKey = sanitizeWhatsAppWebProfileKey(profileKey);
    return acquireLock(`whatsapp-web:profile:${safeKey}`, ttlMs, {
      requireRedis: true,
    });
  }
}

export class PlaywrightWhatsAppWebBrowserLauncher implements WhatsAppWebBrowserLauncher {
  async isAvailable() {
    try {
      const { chromium } = await import("playwright");
      await access(chromium.executablePath());
      return true;
    } catch {
      return false;
    }
  }

  async launchPersistent(input: {
    userDataDir: string;
    headless: boolean;
    actionTimeoutMs: number;
    navigationTimeoutMs: number;
    confirmationTimeoutMs: number;
    slowMoMs?: number;
    devtools?: boolean;
  }): Promise<BrowserSession> {
    let context: BrowserContext | null = null;
    try {
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(input.userDataDir, {
        headless: input.devtools ? false : input.headless,
        ...(input.devtools ? { args: ["--auto-open-devtools-for-tabs"] } : {}),
        slowMo: input.slowMoMs ?? 0,
        viewport: { width: 1280, height: 900 },
      });
      context.setDefaultTimeout(input.actionTimeoutMs);
      context.setDefaultNavigationTimeout(input.navigationTimeoutMs);
      const page = context.pages()[0] ?? (await context.newPage());
      return {
        adapter: new PlaywrightWhatsAppWebPageAdapter(
          page,
          input.confirmationTimeoutMs,
          input.actionTimeoutMs,
        ),
        close: async () => context?.close(),
      };
    } catch (error) {
      await context?.close().catch(() => undefined);
      const unavailable = new Error("WHATSAPP_WEB_BROWSER_UNAVAILABLE");
      unavailable.cause = error;
      throw unavailable;
    }
  }
}

export type WhatsAppWebRuntimeConfig = {
  enabled: boolean;
  dryRun: boolean;
  headless: boolean;
  userDataRoot: string;
  debugRoot: string;
  debugScreenshots: boolean;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  confirmationTimeoutMs: number;
  profileLockTtlMs: number;
  maxPublicationsPerRun: number;
  autoPauseAfterFirstSuccess: boolean;
  allowTextFallback: boolean;
  slowMoMs: number;
  keepOpenOnError: boolean;
  keepOpenOnErrorTimeoutMs: number;
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getWhatsAppWebRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppWebRuntimeConfig {
  return {
    enabled: env.WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED === "true",
    dryRun: env.WHATSAPP_WEB_DRY_RUN !== "false",
    headless: env.WHATSAPP_WEB_HEADLESS === "true",
    userDataRoot: env.WHATSAPP_WEB_USER_DATA_ROOT || ".local/whatsapp-web",
    debugRoot: env.WHATSAPP_WEB_DEBUG_ROOT || ".local/whatsapp-debug",
    debugScreenshots: env.WHATSAPP_WEB_DEBUG_SCREENSHOTS === "true",
    actionTimeoutMs: positiveInteger(
      env.WHATSAPP_WEB_ACTION_TIMEOUT_MS,
      30_000,
    ),
    navigationTimeoutMs: positiveInteger(
      env.WHATSAPP_WEB_NAVIGATION_TIMEOUT_MS,
      60_000,
    ),
    confirmationTimeoutMs: positiveInteger(
      env.WHATSAPP_WEB_CONFIRMATION_TIMEOUT_MS,
      20_000,
    ),
    profileLockTtlMs:
      positiveInteger(env.WHATSAPP_WEB_PROFILE_LOCK_TTL_SECONDS, 180) * 1_000,
    maxPublicationsPerRun: Math.min(
      1,
      positiveInteger(env.WHATSAPP_WEB_MAX_PUBLICATIONS_PER_RUN, 1),
    ),
    autoPauseAfterFirstSuccess:
      env.WHATSAPP_WEB_AUTO_PAUSE_AFTER_FIRST_SUCCESS !== "false",
    allowTextFallback: env.WHATSAPP_WEB_ALLOW_TEXT_FALLBACK !== "false",
    slowMoMs: Math.min(
      2_000,
      nonNegativeInteger(env.WHATSAPP_WEB_SLOW_MO_MS, 0),
    ),
    keepOpenOnError: env.WHATSAPP_WEB_KEEP_OPEN_ON_ERROR === "true",
    keepOpenOnErrorTimeoutMs: Math.min(
      60_000,
      positiveInteger(env.WHATSAPP_WEB_KEEP_OPEN_ON_ERROR_TIMEOUT_MS, 30_000),
    ),
  };
}

export class WhatsAppWebSessionManager {
  constructor(
    private readonly config: WhatsAppWebRuntimeConfig,
    private readonly launcher: WhatsAppWebBrowserLauncher = new PlaywrightWhatsAppWebBrowserLauncher(),
    private readonly profileLock: WhatsAppWebProfileLock = new RedisWhatsAppWebProfileLock(),
  ) {}

  async withConnectedSession<T>(
    profileKey: string,
    operation: (adapter: BrowserSession["adapter"]) => Promise<T>,
    localDiagnostic?: {
      keepOpenOnErrorMs: number;
      isFailure(result: T): boolean;
      devtools?: boolean;
    },
  ): Promise<T> {
    const safeKey = sanitizeWhatsAppWebProfileKey(profileKey);
    if (!(await this.launcher.isAvailable())) {
      throw new Error("WHATSAPP_WEB_BROWSER_UNAVAILABLE");
    }
    const lock = await this.profileLock.acquire(
      safeKey,
      this.config.profileLockTtlMs,
    );
    if (!lock.acquired) {
      throw new Error(
        lock.failureReason === "REDIS_UNAVAILABLE"
          ? "REDIS_UNAVAILABLE"
          : "WHATSAPP_WEB_PROFILE_IN_USE",
      );
    }
    let session: BrowserSession | null = null;
    const renewal = setInterval(
      () => void lock.extend(this.config.profileLockTtlMs),
      Math.max(1_000, Math.floor(this.config.profileLockTtlMs / 3)),
    );
    renewal.unref?.();
    try {
      session = await this.launcher.launchPersistent({
        userDataDir: resolveWhatsAppWebProfilePath(
          this.config.userDataRoot,
          safeKey,
        ),
        headless: this.config.headless,
        actionTimeoutMs: this.config.actionTimeoutMs,
        navigationTimeoutMs: this.config.navigationTimeoutMs,
        confirmationTimeoutMs: this.config.confirmationTimeoutMs,
        slowMoMs: this.config.slowMoMs,
        ...(localDiagnostic?.devtools ? { devtools: true } : {}),
      });
      await session.adapter.navigate();
      if ((await session.adapter.detectAuthenticationState()) !== "CONNECTED") {
        throw new Error("WHATSAPP_WEB_LOGIN_REQUIRED");
      }
      const result = await operation(session.adapter);
      if (
        localDiagnostic &&
        localDiagnostic.keepOpenOnErrorMs > 0 &&
        localDiagnostic.isFailure(result)
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, localDiagnostic.keepOpenOnErrorMs),
        );
      }
      return result;
    } catch (error) {
      if (localDiagnostic && localDiagnostic.keepOpenOnErrorMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, localDiagnostic.keepOpenOnErrorMs),
        );
      }
      throw error;
    } finally {
      clearInterval(renewal);
      await session?.close().catch(() => undefined);
      await lock.release().catch(() => undefined);
    }
  }
}
