import OpenAI from "openai";
import {
  deterministicMessageComposer,
  formatBRLCurrency,
  type MessageOffer,
} from "@affiliate/publication";
import { z } from "zod";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_OPENAI_TIMEOUT_MS = 8_000;
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
  originalPrice: z.union([z.number(), z.string()]),
  currentPrice: z.union([z.number(), z.string()]),
  discountPercentage: z.union([z.number(), z.string()]),
  couponCode: z.string().trim().optional().nullable(),
  couponExpiration: z.union([z.date(), z.string()]).optional().nullable(),
  freeShipping: z.boolean(),
  rating: z.union([z.number(), z.string()]).optional().nullable(),
  salesCount: z.number().int().optional().nullable(),
  trackingUrl: z.string().url(),
});

export type PromotionalCopy = z.infer<typeof promotionalCopySchema>;
export type MessageGenerationInput = z.infer<typeof messageGenerationInputSchema>;
export type MessageSource = "AI_GENERATED" | "DETERMINISTIC_FALLBACK";

export type ValidationResult = {
  valid: boolean;
  reasons: string[];
};

export type MessageGenerationResult = {
  message: string;
  source: MessageSource;
  aiModel?: string | undefined;
  aiGenerationDurationMs?: number | undefined;
  aiValidationPassed: boolean;
  aiValidationReasons: string[];
  generatedAt: Date;
};

export type AiCopywriterEnv = {
  [key: string]: string | undefined;
  AI_COPY_ENABLED?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  OPENAI_TIMEOUT_MS?: string | undefined;
};

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

export function getOpenAiModel(env: AiCopywriterEnv = process.env) {
  return env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

export function getOpenAiTimeoutMs(env: AiCopywriterEnv = process.env) {
  const parsed = Number(env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPENAI_TIMEOUT_MS;
}

export function getOpenAiIntegrationStatus(env: AiCopywriterEnv = process.env) {
  return {
    configured: Boolean(env.OPENAI_API_KEY?.trim()),
    enabled: isAiCopyEnabled(env),
    model: getOpenAiModel(env),
    timeoutMs: getOpenAiTimeoutMs(env),
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
      offer: {
        title: input.title,
        marketplace: input.marketplace,
        category: input.category ?? null,
        originalPrice: formatBRLCurrency(input.originalPrice),
        currentPrice: formatBRLCurrency(input.currentPrice),
        discountPercentage: `${normalizedNumber(asNumber(input.discountPercentage))}%`,
        couponCode: input.couponCode ?? null,
        couponExpiration: dateSummary(input.couponExpiration),
        freeShipping: input.freeShipping,
        rating: input.rating ?? null,
        salesCount: input.salesCount ?? null,
        trackingUrl: input.trackingUrl,
      },
    },
    null,
    2,
  );
}

export class PromotionalCopyValidator {
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
    const allowedPrices = new Set([
      normalizeComparable(formatBRLCurrency(input.originalPrice)),
      normalizeComparable(formatBRLCurrency(input.currentPrice)),
    ]);

    const moneyMentions = text.match(/R\$\s*\d[\d.\s]*(?:,\d{2})?/g) ?? [];
    for (const mention of moneyMentions) {
      if (!allowedPrices.has(normalizeComparable(mention))) {
        reasons.push(`Preco nao confirmado: ${mention}.`);
      }
    }

    const allowedDiscount = Math.round(asNumber(input.discountPercentage) * 100) / 100;
    const percentageMentions = text.match(/\d+(?:[,.]\d+)?\s*%/g) ?? [];
    for (const mention of percentageMentions) {
      const value = Number(mention.replace("%", "").replace(",", ".").trim());

      if (Math.abs(value - allowedDiscount) > 0.01) {
        reasons.push(`Desconto nao confirmado: ${mention}.`);
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

    if (!input.freeShipping && /(frete|envio)\s+gr[aá]tis/i.test(text)) {
      reasons.push("Frete gratis foi mencionado sem confirmacao.");
    }

    if (!/(afiliad|#publi|publicidade|publ)/i.test(normalizedText)) {
      reasons.push("Divulgacao de afiliado ausente.");
    }

    if (/(menor preco|melhor preco|ultimas unidades|estoque limitado|so hoje|garantid[ao]|imperdivel)/i.test(normalizedText)) {
      reasons.push("Texto contem promessa ou urgencia nao confirmada.");
    }

    return {
      valid: reasons.length === 0,
      reasons,
    };
  }
}

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

export class AiCopywriter {
  private readonly client: ResponsesClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(
    options: {
      client?: ResponsesClient;
      apiKey?: string;
      model?: string;
      timeoutMs?: number;
      maxRetries?: number;
    } = {},
  ) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;

    if (!options.client && !apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    this.client = options.client ?? (new OpenAI({ apiKey }) as unknown as ResponsesClient);
    this.model = options.model ?? getOpenAiModel();
    this.timeoutMs = options.timeoutMs ?? getOpenAiTimeoutMs();
    this.maxRetries = options.maxRetries ?? DEFAULT_OPENAI_MAX_RETRIES;
  }

  async compose(input: MessageGenerationInput): Promise<PromotionalCopy> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.requestOnce(input);
        const parsedJson = JSON.parse(response.output_text) as unknown;
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

export class MessageGenerationService {
  private readonly validator = new PromotionalCopyValidator();

  constructor(
    private readonly options: {
      env?: AiCopywriterEnv;
      writer?: AiCopywriter;
      model?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async generate(input: MessageGenerationInput): Promise<MessageGenerationResult> {
    const parsed = messageGenerationInputSchema.parse(input);
    const env = this.options.env ?? process.env;
    const model = this.options.model ?? getOpenAiModel(env);

    if (!isAiCopyEnabled(env)) {
      return this.fallback(parsed, model, ["AI copy generation is disabled."]);
    }

    if (!env.OPENAI_API_KEY?.trim() && !this.options.writer) {
      return this.fallback(parsed, model, ["OPENAI_API_KEY is not configured."]);
    }

    const generatedAt = new Date();
    const started = Date.now();

    try {
      const writer =
        this.options.writer ??
        new AiCopywriter({
          apiKey: env.OPENAI_API_KEY ?? "",
          model,
          timeoutMs: this.options.timeoutMs ?? getOpenAiTimeoutMs(env),
        });
      const copy = await writer.compose(parsed);
      const validation = this.validator.validate(copy, parsed);
      const duration = Date.now() - started;

      if (!validation.valid) {
        return this.fallback(parsed, model, validation.reasons, duration, generatedAt);
      }

      return {
        message: copyToMessage(copy, parsed),
        source: "AI_GENERATED",
        aiModel: model,
        aiGenerationDurationMs: duration,
        aiValidationPassed: true,
        aiValidationReasons: [],
        generatedAt,
      };
    } catch (error) {
      return this.fallback(parsed, model, [error instanceof Error ? error.message : "AI generation failed."], Date.now() - started, generatedAt);
    }
  }

  private fallback(
    input: MessageGenerationInput,
    model: string,
    reasons: string[],
    durationMs?: number,
    generatedAt = new Date(),
  ): MessageGenerationResult {
    return {
      message: deterministicFallback(input),
      source: "DETERMINISTIC_FALLBACK",
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
