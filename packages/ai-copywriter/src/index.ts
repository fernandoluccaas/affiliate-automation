import OpenAI from "openai";
import {
  deterministicMessageComposer,
  formatBRLCurrency,
  type MessageOffer,
} from "@affiliate/publication";
import { z } from "zod";

const DEFAULT_AI_PROVIDER = "ollama";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_AI_COPY_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_MAX_RETRIES = 1;

export const promotionalCopySchema = z
  .object({
    headline: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(700),
    callToAction: z.string().trim().min(1).max(180),
    disclosure: z.string().trim().min(1).max(120),
    hashtags: z.array(z.string().trim().regex(/^#[A-Za-z0-9_]+$/)).max(8),
  })
  .strict();

export const messageGenerationInputSchema = z.object({
  title: z.string().trim().min(1),
  marketplace: z.string().trim().min(1),
  category: z.string().trim().optional().nullable(),
  originalPrice: z.union([z.number(), z.string()]).optional().nullable(),
  currentPrice: z.union([z.number(), z.string()]),
  discountPercentage: z.union([z.number(), z.string()]).optional().nullable(),
  couponCode: z.string().trim().optional().nullable(),
  couponExpiration: z.union([z.date(), z.string()]).optional().nullable(),
  freeShipping: z.boolean().optional().nullable(),
  shippingStatus: z.enum(["FREE", "NOT_FREE", "UNKNOWN"]).default("UNKNOWN"),
  rating: z.union([z.number(), z.string()]).optional().nullable(),
  salesCount: z.number().int().optional().nullable(),
  trackingUrl: z.string().url(),
});

export type PromotionalCopy = z.infer<typeof promotionalCopySchema>;
export type MessageGenerationInput = z.input<typeof messageGenerationInputSchema>;
export type MessageSource = "AI_GENERATED" | "DETERMINISTIC_FALLBACK";
export type AiProviderName = "OLLAMA" | "OPENAI" | "DETERMINISTIC";

export type ValidationResult = {
  valid: boolean;
  reasons: string[];
};

export type MessageGenerationResult = {
  message: string;
  source: MessageSource;
  aiProvider: AiProviderName;
  aiModel?: string | undefined;
  aiGenerationDurationMs?: number | undefined;
  aiValidationPassed: boolean;
  aiValidationReasons: string[];
  generatedAt: Date;
};

export type AiCopywriterEnv = {
  [key: string]: string | undefined;
  AI_PROVIDER?: string | undefined;
  AI_COPY_ENABLED?: string | undefined;
  AI_COPY_TIMEOUT_MS?: string | undefined;
  OLLAMA_BASE_URL?: string | undefined;
  OLLAMA_MODEL?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  OPENAI_TIMEOUT_MS?: string | undefined;
};

export type AiProvider = {
  readonly provider: Exclude<AiProviderName, "DETERMINISTIC">;
  readonly model: string;
  generate(input: MessageGenerationInput): Promise<PromotionalCopy>;
  healthCheck?(): Promise<AiProviderHealth>;
};

export type AiProviderHealth = {
  configured: boolean;
  available: boolean;
  provider: AiProviderName;
  model: string;
  baseUrl?: string | undefined;
  status: string;
};

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

type ResponsesClient = {
  responses: {
    create: (
      body: {
        model: string;
        instructions: string;
        input: string;
        temperature: number;
        max_output_tokens: number;
        store: boolean;
        text: {
          format: {
            type: "json_schema";
            name: string;
            strict: true;
            schema: Record<string, unknown>;
          };
        };
      },
      options?: { timeout?: number },
    ) => Promise<{ output_text: string }>;
  };
};

export function validatePromotionalCopy(copy: unknown) {
  return promotionalCopySchema.safeParse(copy);
}

export function isAiCopyEnabled(env: AiCopywriterEnv = process.env) {
  return env.AI_COPY_ENABLED !== "false";
}

export function getAiProviderName(env: AiCopywriterEnv = process.env) {
  const provider = env.AI_PROVIDER?.trim().toLowerCase() || DEFAULT_AI_PROVIDER;
  return provider === "openai" ? "openai" : "ollama";
}

export function getAiCopyTimeoutMs(env: AiCopywriterEnv = process.env) {
  const parsed = Number(env.AI_COPY_TIMEOUT_MS ?? env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AI_COPY_TIMEOUT_MS;
}

export function getOllamaBaseUrl(env: AiCopywriterEnv = process.env) {
  return sanitizeBaseUrl(env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL);
}

export function getOllamaModel(env: AiCopywriterEnv = process.env) {
  return env.OLLAMA_MODEL?.trim() || "";
}

export function getOpenAiModel(env: AiCopywriterEnv = process.env) {
  return env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

export function getOpenAiTimeoutMs(env: AiCopywriterEnv = process.env) {
  return getAiCopyTimeoutMs(env);
}

export function getOpenAiIntegrationStatus(env: AiCopywriterEnv = process.env) {
  return {
    configured: Boolean(env.OPENAI_API_KEY?.trim()),
    enabled: isAiCopyEnabled(env),
    provider: "OPENAI" as const,
    selected: getAiProviderName(env) === "openai",
    model: getOpenAiModel(env),
    timeoutMs: getAiCopyTimeoutMs(env),
  };
}

export function getOllamaIntegrationStatus(env: AiCopywriterEnv = process.env) {
  return {
    configured: Boolean(getOllamaBaseUrl(env) && getOllamaModel(env)),
    enabled: isAiCopyEnabled(env),
    provider: "OLLAMA" as const,
    selected: getAiProviderName(env) === "ollama",
    baseUrl: getOllamaBaseUrl(env),
    model: getOllamaModel(env),
    timeoutMs: getAiCopyTimeoutMs(env),
  };
}

function asNumber(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedNumber(value: number) {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function normalizeComparable(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function allCopyText(copy: PromotionalCopy) {
  return [
    copy.headline,
    copy.body,
    copy.callToAction,
    copy.disclosure,
    copy.hashtags.join(" "),
  ].join("\n");
}

function dateSummary(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function optionalCurrency(value: number | string | null | undefined) {
  return value === null || value === undefined ? null : formatBRLCurrency(value);
}

function optionalPercentage(value: number | string | null | undefined) {
  return value === null || value === undefined ? null : `${normalizedNumber(asNumber(value))}%`;
}

function sanitizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function schemaForStructuredOutput() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      headline: { type: "string", maxLength: 100 },
      body: { type: "string", maxLength: 700 },
      callToAction: { type: "string", maxLength: 180 },
      disclosure: { type: "string", maxLength: 120 },
      hashtags: {
        type: "array",
        maxItems: 8,
        items: { type: "string", pattern: "^#[A-Za-z0-9_]+$" },
      },
    },
    required: ["headline", "body", "callToAction", "disclosure", "hashtags"],
  };
}

export function buildPrompt(input: MessageGenerationInput) {
  return JSON.stringify(
    {
      task: "Generate promotional affiliate copy in Brazilian Portuguese.",
      rules: [
        "Use only the facts supplied in offer.",
        "Do not invent price, discount, coupon, shipping, stock, rating, urgency or guarantees.",
        "The only URL allowed is offer.trackingUrl, and it must appear exactly once.",
        "Include a clear affiliate disclosure.",
        "Return only JSON matching the requested schema.",
      ],
      schema: schemaForStructuredOutput(),
      offer: {
        title: input.title,
        marketplace: input.marketplace,
        category: input.category ?? null,
        originalPrice: optionalCurrency(input.originalPrice),
        currentPrice: formatBRLCurrency(input.currentPrice),
        discountPercentage: optionalPercentage(input.discountPercentage),
        couponCode: input.couponCode ?? null,
        couponExpiration: dateSummary(input.couponExpiration),
        shippingStatus: input.shippingStatus ?? "UNKNOWN",
        freeShipping: input.shippingStatus === "FREE" || input.freeShipping === true,
        rating: input.rating ?? null,
        salesCount: input.salesCount ?? null,
        trackingUrl: input.trackingUrl,
      },
    },
    null,
    2,
  );
}

export class AiMessageValidator {
  validate(copy: unknown, input: MessageGenerationInput): ValidationResult {
    const parsed = promotionalCopySchema.safeParse(copy);

    if (!parsed.success) {
      return {
        valid: false,
        reasons: parsed.error.issues.map((issue) => issue.message),
      };
    }

    const reasons: string[] = [];
    const text = allCopyText(parsed.data);
    const normalizedText = normalizeComparable(text);
    const allowedPrices = new Set([normalizeComparable(formatBRLCurrency(input.currentPrice))]);

    if (input.originalPrice !== null && input.originalPrice !== undefined) {
      allowedPrices.add(normalizeComparable(formatBRLCurrency(input.originalPrice)));
    }

    const moneyMentions = text.match(/R\$\s*\d[\d.\s]*(?:,\d{2})?/g) ?? [];
    for (const mention of moneyMentions) {
      if (!allowedPrices.has(normalizeComparable(mention))) {
        reasons.push(`Preco nao confirmado: ${mention}.`);
      }
    }

    const percentageMentions = text.match(/\d+(?:[,.]\d+)?\s*%/g) ?? [];

    if (input.discountPercentage === null || input.discountPercentage === undefined) {
      if (percentageMentions.length > 0) {
        reasons.push("Desconto foi mencionado sem desconto confirmado.");
      }
    } else {
      const allowedDiscount = Math.round(asNumber(input.discountPercentage) * 100) / 100;

      for (const mention of percentageMentions) {
        const value = Number(mention.replace("%", "").replace(",", ".").trim());

        if (Math.abs(value - allowedDiscount) > 0.01) {
          reasons.push(`Desconto nao confirmado: ${mention}.`);
        }
      }
    }

    const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    const uniqueUrls = new Set(urls.map((url) => url.replace(/[.,;]+$/, "")));
    const trackingUrlCount = urls.filter((url) => url.replace(/[.,;]+$/, "") === input.trackingUrl).length;

    if (!uniqueUrls.has(input.trackingUrl)) {
      reasons.push("URL de rastreamento ausente ou alterada.");
    }

    if (trackingUrlCount !== 1) {
      reasons.push("URL de rastreamento deve aparecer exatamente uma vez.");
    }

    for (const url of uniqueUrls) {
      if (url !== input.trackingUrl) {
        reasons.push(`URL nao permitida: ${url}.`);
      }
    }

    if ((input.couponCode?.trim() ?? "") === "") {
      if (/\b(cupom|coupon|codigo|código)\b/i.test(text)) {
        reasons.push("Cupom foi mencionado sem cupom confirmado.");
      }
    } else if (!normalizedText.includes(normalizeComparable(input.couponCode ?? ""))) {
      reasons.push("Cupom confirmado nao foi preservado.");
    }

    if (
      (input.shippingStatus ?? "UNKNOWN") !== "FREE" &&
      input.freeShipping !== true &&
      /(frete|envio)\s+gr[aá]tis/i.test(text)
    ) {
      reasons.push("Frete gratis foi mencionado sem confirmacao.");
    }

    if (!/(afiliad|#publi|publicidade|publ)/i.test(normalizedText)) {
      reasons.push("Divulgacao de afiliado ausente.");
    }

    if (
      /(menor preco|melhor preco|ultimas unidades|estoque limitado|so hoje|garantid[ao]|imperdivel)/i.test(
        normalizedText,
      )
    ) {
      reasons.push("Texto contem promessa ou urgencia nao confirmada.");
    }

    return {
      valid: reasons.length === 0,
      reasons,
    };
  }
}

export class PromotionalCopyValidator extends AiMessageValidator {}

export function copyToMessage(copy: PromotionalCopy, input: MessageGenerationInput) {
  const lines = [
    copy.headline,
    "",
    copy.body,
    "",
    copy.callToAction.includes(input.trackingUrl)
      ? copy.callToAction
      : `${copy.callToAction} ${input.trackingUrl}`,
    "",
    copy.disclosure,
  ];

  if (copy.hashtags.length > 0) {
    lines.push(copy.hashtags.join(" "));
  }

  return lines.join("\n").trim();
}

function deterministicFallback(input: MessageGenerationInput) {
  return deterministicMessageComposer(input as MessageOffer);
}

function parseGeneratedJson(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith("```")) {
    return JSON.parse(trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as unknown;
  }

  return JSON.parse(trimmed) as unknown;
}

export class OllamaAiProvider implements AiProvider {
  readonly provider = "OLLAMA";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    options: {
      baseUrl?: string;
      model?: string;
      timeoutMs?: number;
      fetchFn?: FetchLike;
      env?: AiCopywriterEnv;
    } = {},
  ) {
    const env = options.env ?? process.env;
    this.baseUrl = sanitizeBaseUrl(options.baseUrl ?? getOllamaBaseUrl(env));
    this.model = options.model ?? getOllamaModel(env);
    this.timeoutMs = options.timeoutMs ?? getAiCopyTimeoutMs(env);
    this.fetchFn = options.fetchFn ?? (fetch as FetchLike);
  }

  async generate(input: MessageGenerationInput): Promise<PromotionalCopy> {
    const timeout = withTimeout(this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: timeout.signal,
        body: JSON.stringify({
          model: this.model,
          system:
            "You are a careful affiliate copywriter. You must preserve factual accuracy and output strict JSON.",
          prompt: buildPrompt(input),
          stream: false,
          format: schemaForStructuredOutput(),
          options: { temperature: 0 },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText}`);
      }

      const body = (await response.json()) as { response?: unknown };

      if (typeof body.response !== "string") {
        throw new Error("Ollama returned an invalid response.");
      }

      const parsedJson = parseGeneratedJson(body.response);
      const parsed = promotionalCopySchema.safeParse(parsedJson);

      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Generated copy is invalid.");
      }

      return parsed.data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Ollama request timed out.");
      }

      throw error;
    } finally {
      timeout.clear();
    }
  }

  async healthCheck(): Promise<AiProviderHealth> {
    const timeout = withTimeout(Math.min(this.timeoutMs, 3_000));

    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: timeout.signal,
      });

      return {
        configured: Boolean(this.baseUrl && this.model),
        available: response.ok,
        provider: "OLLAMA",
        model: this.model,
        baseUrl: this.baseUrl,
        status: response.ok ? "available" : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        configured: Boolean(this.baseUrl && this.model),
        available: false,
        provider: "OLLAMA",
        model: this.model,
        baseUrl: this.baseUrl,
        status: error instanceof Error ? error.message : "unavailable",
      };
    } finally {
      timeout.clear();
    }
  }
}

export class OpenAiProvider implements AiProvider {
  readonly provider = "OPENAI";
  readonly model: string;
  private readonly client: ResponsesClient;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    options: {
      client?: ResponsesClient;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      maxRetries?: number;
      env?: AiCopywriterEnv;
    } = {},
  ) {
    const env = options.env ?? process.env;
    const apiKey = options.apiKey ?? env.OPENAI_API_KEY;

    if (!options.client && !apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    this.client = options.client ?? (new OpenAI({ apiKey }) as unknown as ResponsesClient);
    this.model = options.model ?? getOpenAiModel(env);
    this.timeoutMs = options.timeoutMs ?? getAiCopyTimeoutMs(env);
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
  }

  async generate(input: MessageGenerationInput): Promise<PromotionalCopy> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.requestOnce(input);
        const parsedJson = parseGeneratedJson(response.output_text);
        const parsed = promotionalCopySchema.safeParse(parsedJson);

        if (!parsed.success) {
          throw new Error(parsed.error.issues[0]?.message ?? "Generated copy is invalid.");
        }

        return parsed.data;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("AI generation failed.");
  }

  private requestOnce(input: MessageGenerationInput) {
    return this.client.responses.create(
      {
        model: this.model,
        instructions:
          "You are a careful affiliate copywriter. You must preserve factual accuracy and output strict JSON.",
        input: buildPrompt(input),
        temperature: 0.2,
        max_output_tokens: 500,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "affiliate_promotional_copy",
            strict: true,
            schema: schemaForStructuredOutput(),
          },
        },
      },
      { timeout: this.timeoutMs },
    );
  }
}

export class AiCopywriter extends OpenAiProvider {}

export function createAiProvider(env: AiCopywriterEnv = process.env): AiProvider {
  const provider = getAiProviderName(env);

  if (provider === "openai") {
    return new OpenAiProvider({ env });
  }

  return new OllamaAiProvider({ env });
}

export class MessageGenerationService {
  private readonly validator = new AiMessageValidator();

  constructor(
    private readonly options: {
      env?: AiCopywriterEnv;
      provider?: AiProvider;
      writer?: AiProvider;
      model?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async generate(input: MessageGenerationInput): Promise<MessageGenerationResult> {
    const parsed = messageGenerationInputSchema.parse(input);
    const env = this.options.env ?? process.env;

    if (!isAiCopyEnabled(env)) {
      return this.fallback(parsed, "DETERMINISTIC", undefined, ["AI copy generation is disabled."]);
    }

    const provider = this.options.provider ?? this.options.writer ?? createAiProvider(env);
    const generatedAt = new Date();
    const started = Date.now();

    try {
      const copy = await provider.generate(parsed);
      const validation = this.validator.validate(copy, parsed);
      const duration = Date.now() - started;

      if (!validation.valid) {
        return this.fallback(parsed, provider.provider, provider.model, validation.reasons, duration, generatedAt);
      }

      return {
        message: copyToMessage(copy, parsed),
        source: "AI_GENERATED",
        aiProvider: provider.provider,
        aiModel: provider.model,
        aiGenerationDurationMs: duration,
        aiValidationPassed: true,
        aiValidationReasons: [],
        generatedAt,
      };
    } catch (error) {
      return this.fallback(
        parsed,
        provider.provider,
        provider.model,
        [error instanceof Error ? error.message : "AI generation failed."],
        Date.now() - started,
        generatedAt,
      );
    }
  }

  private fallback(
    input: MessageGenerationInput,
    provider: AiProviderName,
    model: string | undefined,
    reasons: string[],
    durationMs?: number,
    generatedAt = new Date(),
  ): MessageGenerationResult {
    return {
      message: deterministicFallback(input),
      source: "DETERMINISTIC_FALLBACK",
      aiProvider: provider === "DETERMINISTIC" ? "DETERMINISTIC" : provider,
      aiModel: model,
      aiGenerationDurationMs: durationMs,
      aiValidationPassed: false,
      aiValidationReasons: reasons,
      generatedAt,
    };
  }
}

export async function generateMessageForOffer(input: MessageGenerationInput) {
  return new MessageGenerationService().generate(input);
}
