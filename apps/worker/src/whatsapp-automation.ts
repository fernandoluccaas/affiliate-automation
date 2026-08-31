export type WhatsAppAutomationMode = "OFF" | "DRY_RUN" | "LIVE";

export type WhatsAppAutomationConfiguration = {
  enabled: boolean;
  mode: WhatsAppAutomationMode;
  intervalMs: number;
  maxPerCycle: 1;
  maxPerDay: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  authorizationExpiryMinutes: number;
  readyForLive: boolean;
  blockers: string[];
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function operationalTime(value: string | undefined, fallback: string) {
  return value && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)
    ? value
    : fallback;
}

export function resolveWhatsAppAutomationConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppAutomationConfiguration {
  const enabled = env.WHATSAPP_AUTOMATION_ENABLED === "true";
  const mode: WhatsAppAutomationMode =
    env.WHATSAPP_AUTOMATION_MODE === "DRY_RUN" ||
    env.WHATSAPP_AUTOMATION_MODE === "LIVE"
      ? env.WHATSAPP_AUTOMATION_MODE
      : "OFF";
  const blockers = [
    ...(!enabled ? ["WHATSAPP_AUTOMATION_DISABLED"] : []),
    ...(mode === "OFF" ? ["WHATSAPP_AUTOMATION_MODE_OFF"] : []),
    ...(mode === "LIVE" &&
    env.WHATSAPP_GROUPS_WEB_EXPERIMENTAL_ENABLED !== "true"
      ? ["WHATSAPP_WEB_EXPERIMENTAL_DISABLED"]
      : []),
    ...(mode === "LIVE" && env.WHATSAPP_WEB_DRY_RUN !== "false"
      ? ["WHATSAPP_WEB_REAL_SEND_NOT_EXPLICITLY_ENABLED"]
      : []),
  ];
  return {
    enabled,
    mode,
    intervalMs:
      boundedInteger(
        env.WHATSAPP_AUTOMATION_INTERVAL_SECONDS,
        60,
        15,
        3600,
      ) * 1000,
    maxPerCycle: 1,
    maxPerDay: boundedInteger(env.WHATSAPP_AUTOMATION_MAX_PER_DAY, 10, 1, 100),
    windowStart: operationalTime(
      env.WHATSAPP_AUTOMATION_WINDOW_START,
      "08:00",
    ),
    windowEnd: operationalTime(env.WHATSAPP_AUTOMATION_WINDOW_END, "22:00"),
    timezone: env.WHATSAPP_AUTOMATION_TIMEZONE || "America/Fortaleza",
    authorizationExpiryMinutes: boundedInteger(
      env.WHATSAPP_AUTOMATION_AUTHORIZATION_EXPIRY_MINUTES,
      5,
      1,
      15,
    ),
    readyForLive: enabled && mode === "LIVE" && blockers.length === 0,
    blockers,
  };
}

function minutesAt(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function configuredMinutes(value: string) {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function isWhatsAppAutomationWindowOpen(
  configuration: WhatsAppAutomationConfiguration,
  now: Date,
) {
  const current = minutesAt(now, configuration.timezone);
  const start = configuredMinutes(configuration.windowStart);
  const end = configuredMinutes(configuration.windowEnd);
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

export type WhatsAppAutomationCycleResult = {
  status: "OFF" | "DRY_RUN" | "IDLE" | "BLOCKED" | "PUBLISHED" | "FAILED";
  reason: string | null;
  publicationId: string | null;
  browserOpened: boolean;
  sendCalled: boolean;
};

export type WhatsAppAutomationCycleDependencies = {
  now(): Date;
  aborted?(): boolean;
  sentToday(): Promise<number>;
  nextPublication(): Promise<{ publicationId: string } | null>;
  preflight(publicationId: string): Promise<{
    ready: boolean;
    reason: string | null;
    browserOpened: boolean;
  }>;
  authorize(publicationId: string): Promise<void>;
  revoke?(publicationId: string, reason: string): Promise<void>;
  dispatch(publicationId: string): Promise<{
    status: "PUBLISHED" | "DELIVERY_UNCERTAIN" | "FAILED" | "SKIPPED";
    errorCode: string | null;
    browserOpened: boolean;
    sendCalled: boolean;
  }>;
};

export async function runWhatsAppAutomationCycle(
  configuration: WhatsAppAutomationConfiguration,
  dependencies: WhatsAppAutomationCycleDependencies,
): Promise<WhatsAppAutomationCycleResult> {
  if (!configuration.enabled || configuration.mode === "OFF") {
    return {
      status: "OFF",
      reason: configuration.blockers[0] ?? "WHATSAPP_AUTOMATION_MODE_OFF",
      publicationId: null,
      browserOpened: false,
      sendCalled: false,
    };
  }
  if (!isWhatsAppAutomationWindowOpen(configuration, dependencies.now())) {
    return {
      status: "IDLE",
      reason: "WHATSAPP_AUTOMATION_OUTSIDE_OPERATIONAL_WINDOW",
      publicationId: null,
      browserOpened: false,
      sendCalled: false,
    };
  }
  if ((await dependencies.sentToday()) >= configuration.maxPerDay) {
    return {
      status: "IDLE",
      reason: "WHATSAPP_AUTOMATION_DAILY_LIMIT_REACHED",
      publicationId: null,
      browserOpened: false,
      sendCalled: false,
    };
  }
  const candidate = await dependencies.nextPublication();
  if (!candidate) {
    return {
      status: "IDLE",
      reason: "WHATSAPP_AUTOMATION_QUEUE_EMPTY",
      publicationId: null,
      browserOpened: false,
      sendCalled: false,
    };
  }
  if (dependencies.aborted?.()) {
    return {
      status: "BLOCKED",
      reason: "WHATSAPP_AUTOMATION_LEADERSHIP_LOST",
      publicationId: candidate.publicationId,
      browserOpened: false,
      sendCalled: false,
    };
  }
  const preflight = await dependencies.preflight(candidate.publicationId);
  if (!preflight.ready) {
    return {
      status: "BLOCKED",
      reason: preflight.reason ?? "WHATSAPP_AUTOMATION_PREFLIGHT_FAILED",
      publicationId: candidate.publicationId,
      browserOpened: preflight.browserOpened,
      sendCalled: false,
    };
  }
  if (dependencies.aborted?.()) {
    return {
      status: "BLOCKED",
      reason: "WHATSAPP_AUTOMATION_LEADERSHIP_LOST",
      publicationId: candidate.publicationId,
      browserOpened: preflight.browserOpened,
      sendCalled: false,
    };
  }
  if (configuration.mode === "DRY_RUN") {
    return {
      status: "DRY_RUN",
      reason: null,
      publicationId: candidate.publicationId,
      browserOpened: preflight.browserOpened,
      sendCalled: false,
    };
  }
  if (!configuration.readyForLive) {
    return {
      status: "BLOCKED",
      reason: configuration.blockers[0] ?? "WHATSAPP_AUTOMATION_LIVE_BLOCKED",
      publicationId: candidate.publicationId,
      browserOpened: preflight.browserOpened,
      sendCalled: false,
    };
  }
  await dependencies.authorize(candidate.publicationId);
  if (dependencies.aborted?.()) {
    await dependencies
      .revoke?.(
        candidate.publicationId,
        "WHATSAPP_AUTOMATION_LEADERSHIP_LOST",
      )
      .catch(() => undefined);
    return {
      status: "BLOCKED",
      reason: "WHATSAPP_AUTOMATION_LEADERSHIP_LOST",
      publicationId: candidate.publicationId,
      browserOpened: preflight.browserOpened,
      sendCalled: false,
    };
  }
  const dispatched = await dependencies.dispatch(candidate.publicationId);
  return {
    status:
      dispatched.status === "PUBLISHED"
        ? "PUBLISHED"
        : dispatched.status === "DELIVERY_UNCERTAIN"
          ? "BLOCKED"
          : "FAILED",
    reason: dispatched.errorCode,
    publicationId: candidate.publicationId,
    browserOpened: dispatched.browserOpened,
    sendCalled: dispatched.sendCalled,
  };
}
