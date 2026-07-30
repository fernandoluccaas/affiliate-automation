import OpenAI from "openai";
import {
  buildPromoMessage,
  selectPromotionalHeadline,
  type PromoMessageInput,
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
    optionalHook: z.string().trim().min(1).max(140).nullable().optional(),
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
  couponUrl: z.string().url().optional().nullable(),
  couponDescription: z.string().trim().optional().nullable(),
  couponExpiration: z.union([z.date(), z.string()]).optional().nullable(),
  freeShipping: z.boolean().optional().nullable(),
  shippingStatus: z.enum(["FREE", "NOT_FREE", "UNKNOWN"]).default("UNKNOWN"),
  rating: z.union([z.number(), z.string()]).optional().nullable(),
  salesCount: z.number().int().optional().nullable(),
  trackingUrl: z.string().url(),
  footer: z.string().trim().optional().nullable(),
  seed: z.string().optional(),
  recentHeadlines: z.array(z.string().trim().min(1)).max(5).default([]),
});

export type PromotionalCopy = z.infer<typeof promotionalCopySchema>;
export type MessageGenerationInput = z.input<
  typeof messageGenerationInputSchema
>;
type ParsedMessageGenerationInput = z.output<
  typeof messageGenerationInputSchema
>;
export type MessageSource = "AI_GENERATED" | "DETERMINISTIC_FALLBACK";
export type AiProviderName = "OLLAMA" | "OPENAI" | "DETERMINISTIC";

export type ValidationResult = { valid: boolean; reasons: string[] };

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
  AI_PROVIDER?: string;
  AI_COPY_ENABLED?: string;
  AI_COPY_TIMEOUT_MS?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_TIMEOUT_MS?: string;
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
  baseUrl?: string;
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
  return (env.AI_PROVIDER?.trim().toLowerCase() || DEFAULT_AI_PROVIDER) ===
    "openai"
    ? "openai"
    : "ollama";
}

export function getAiCopyTimeoutMs(env: AiCopywriterEnv = process.env) {
  const parsed = Number(env.AI_COPY_TIMEOUT_MS ?? env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AI_COPY_TIMEOUT_MS;
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

function sanitizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function withTimeout(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function schemaForStructuredOutput() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      headline: { type: "string", maxLength: 100 },
      optionalHook: {
        anyOf: [{ type: "string", maxLength: 140 }, { type: "null" }],
      },
    },
    required: ["headline", "optionalHook"],
  };
}

export function buildPrompt(input: MessageGenerationInput) {
  return JSON.stringify(
    {
      task: "Choose one short promotional headline in Brazilian Portuguese. Do not write the offer body.",
      rules: [
        "Return only JSON matching the requested schema.",
        "Do not mention or invent prices, discounts, coupons, shipping, stock, URLs, urgency or guarantees.",
        "Respect the marketplace style.",
        "The headline must be selected from the application's allowed local pool.",
      ],
      schema: schemaForStructuredOutput(),
      context: {
        marketplace: input.marketplace,
        category: input.category ?? null,
        recentHeadlines: (input.recentHeadlines ?? []).slice(0, 5),
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

    const selected = selectPromotionalHeadline({
      marketplace: input.marketplace,
      seed:
        input.seed ??
        `${input.marketplace}:${input.title}:${input.trackingUrl}`,
      recentHeadlines: input.recentHeadlines ?? [],
      suggestion: parsed.data.headline,
    });

    return selected === parsed.data.headline
      ? { valid: true, reasons: [] }
      : {
          valid: false,
          reasons: [
            "AI headline is outside the allowed marketplace pool or was used recently.",
          ],
        };
  }
}

export class PromotionalCopyValidator extends AiMessageValidator {}

function promoInput(
  input: MessageGenerationInput,
  headlineSuggestion?: string,
): PromoMessageInput {
  return {
    ...input,
    ...(headlineSuggestion ? { headlineSuggestion } : {}),
  } as PromoMessageInput;
}

export function copyToMessage(
  copy: PromotionalCopy,
  input: MessageGenerationInput,
) {
  return buildPromoMessage(promoInput(input, copy.headline)).message;
}

function deterministicFallback(input: MessageGenerationInput) {
  return buildPromoMessage(promoInput(input)).message;
}

function parseGeneratedJson(value: string) {
  const trimmed = value.trim();
  return JSON.parse(
    trimmed.startsWith("```")
      ? trimmed
          .replace(/^```(?:json)?/i, "")
          .replace(/```$/, "")
          .trim()
      : trimmed,
  ) as unknown;
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
            "You only suggest a short promotional headline. Output strict JSON and never rewrite offer facts.",
          prompt: buildPrompt(input),
          stream: false,
          format: schemaForStructuredOutput(),
          options: { temperature: 0 },
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Ollama HTTP ${response.status}: ${response.statusText}`,
        );
      }
      const body = (await response.json()) as { response?: unknown };
      if (typeof body.response !== "string") {
        throw new Error("Ollama returned an invalid response.");
      }
      const parsed = promotionalCopySchema.safeParse(
        parseGeneratedJson(body.response),
      );
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues[0]?.message ?? "Generated headline is invalid.",
        );
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
    this.client =
      options.client ?? (new OpenAI({ apiKey }) as unknown as ResponsesClient);
    this.model = options.model ?? getOpenAiModel(env);
    this.timeoutMs = options.timeoutMs ?? getAiCopyTimeoutMs(env);
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
  }

  async generate(input: MessageGenerationInput): Promise<PromotionalCopy> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.requestOnce(input);
        const parsed = promotionalCopySchema.safeParse(
          parseGeneratedJson(response.output_text),
        );
        if (!parsed.success) {
          throw new Error(
            parsed.error.issues[0]?.message ?? "Generated headline is invalid.",
          );
        }
        return parsed.data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("AI generation failed.");
  }

  private requestOnce(input: MessageGenerationInput) {
    return this.client.responses.create(
      {
        model: this.model,
        instructions:
          "Suggest only a short promotional headline. Never rewrite offer facts.",
        input: buildPrompt(input),
        temperature: 0.2,
        max_output_tokens: 100,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "affiliate_promotional_headline",
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

export function createAiProvider(
  env: AiCopywriterEnv = process.env,
): AiProvider {
  return getAiProviderName(env) === "openai"
    ? new OpenAiProvider({ env })
    : new OllamaAiProvider({ env });
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

  async generate(
    input: MessageGenerationInput,
  ): Promise<MessageGenerationResult> {
    const parsed = messageGenerationInputSchema.parse(input);
    const env = this.options.env ?? process.env;
    if (!isAiCopyEnabled(env)) {
      return this.fallback(parsed, "DETERMINISTIC", undefined, [
        "AI copy generation is disabled.",
      ]);
    }

    const provider =
      this.options.provider ?? this.options.writer ?? createAiProvider(env);
    const generatedAt = new Date();
    const started = Date.now();
    try {
      const copy = await provider.generate(parsed);
      const validation = this.validator.validate(copy, parsed);
      const duration = Date.now() - started;
      if (!validation.valid) {
        return this.fallback(
          parsed,
          provider.provider,
          provider.model,
          validation.reasons,
          duration,
          generatedAt,
        );
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
    input: ParsedMessageGenerationInput,
    provider: AiProviderName,
    model: string | undefined,
    reasons: string[],
    durationMs?: number,
    generatedAt = new Date(),
  ): MessageGenerationResult {
    return {
      message: deterministicFallback(input),
      source: "DETERMINISTIC_FALLBACK",
      aiProvider: provider,
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
