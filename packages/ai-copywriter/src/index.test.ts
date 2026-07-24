import { describe, expect, it, vi } from "vitest";
import {
  AiCopywriter,
  MessageGenerationService,
  PromotionalCopyValidator,
  copyToMessage,
  getOpenAiIntegrationStatus,
  promotionalCopySchema,
  validatePromotionalCopy,
  type MessageGenerationInput,
  type PromotionalCopy,
} from "./index";

const input: MessageGenerationInput = {
  title: "Fone Bluetooth",
  marketplace: "SHOPEE",
  category: "Eletronicos",
  originalPrice: "199.90",
  currentPrice: "149.90",
  discountPercentage: "25.01",
  couponCode: "AUDIO10",
  couponExpiration: new Date("2026-07-25T12:00:00.000Z"),
  freeShipping: true,
  rating: "4.8",
  salesCount: 120,
  trackingUrl: "https://example.com/go/fone",
};

const validCopy: PromotionalCopy = {
  headline: "Fone Bluetooth com desconto",
  body: "De R$ 199,90 por R$ 149,90, com 25,01% de desconto e cupom AUDIO10.",
  callToAction: "Confira pelo link: https://example.com/go/fone",
  disclosure: "#publi - link de afiliado",
  hashtags: ["#oferta", "#audio"],
};

function writer(copy: PromotionalCopy) {
  return {
    compose: vi.fn().mockResolvedValue(copy),
  } as unknown as AiCopywriter;
}

describe("promotional copy schema", () => {
  it("accepts valid structured copy", () => {
    expect(validatePromotionalCopy(validCopy).success).toBe(true);
  });

  it("rejects extra properties", () => {
    expect(validatePromotionalCopy({ ...validCopy, extra: true }).success).toBe(false);
  });

  it("rejects invalid hashtags", () => {
    expect(promotionalCopySchema.safeParse({ ...validCopy, hashtags: ["oferta"] }).success).toBe(false);
  });
});

describe("PromotionalCopyValidator", () => {
  const validator = new PromotionalCopyValidator();

  it("approves copy that preserves confirmed facts", () => {
    expect(validator.validate(validCopy, input)).toEqual({ valid: true, reasons: [] });
  });

  it("rejects invented price", () => {
    const result = validator.validate(
      { ...validCopy, body: "De R$ 299,90 por R$ 149,90." },
      input,
    );

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Preco nao confirmado");
  });

  it("rejects invented discount", () => {
    const result = validator.validate({ ...validCopy, body: "Oferta com 50% de desconto." }, input);

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Desconto nao confirmado");
  });

  it("rejects missing tracking URL", () => {
    const result = validator.validate({ ...validCopy, callToAction: "Confira pelo link." }, input);

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("URL de rastreamento");
  });

  it("rejects extra URLs", () => {
    const result = validator.validate(
      { ...validCopy, body: `${validCopy.body} Veja tambem https://example.com/outro` },
      input,
    );

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("URL nao permitida");
  });

  it("rejects repeated tracking URL", () => {
    const result = validator.validate(
      { ...validCopy, body: `${validCopy.body} ${input.trackingUrl}` },
      input,
    );

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("exatamente uma vez");
  });

  it("rejects coupon mention when no coupon exists", () => {
    const result = validator.validate(validCopy, { ...input, couponCode: null });

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Cupom foi mencionado");
  });

  it("rejects changed coupon code", () => {
    const result = validator.validate({ ...validCopy, body: "Use cupom OUTRO." }, input);

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Cupom confirmado");
  });

  it("rejects free shipping when it is not confirmed", () => {
    const result = validator.validate(
      { ...validCopy, body: `${validCopy.body} Frete gratis.` },
      { ...input, freeShipping: false },
    );

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Frete gratis");
  });

  it("rejects copy without affiliate disclosure", () => {
    const result = validator.validate({ ...validCopy, disclosure: "Oferta selecionada" }, input);

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("Divulgacao de afiliado");
  });

  it("rejects urgency claims not present in offer facts", () => {
    const result = validator.validate({ ...validCopy, body: `${validCopy.body} So hoje.` }, input);

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("urgencia");
  });
});

describe("MessageGenerationService", () => {
  it("uses structured output and retries once", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ output_text: JSON.stringify(validCopy) });
    const ai = new AiCopywriter({
      apiKey: "test",
      client: { responses: { create } },
      model: "test-model",
      timeoutMs: 1234,
      maxRetries: 1,
    });

    await expect(ai.compose(input)).resolves.toEqual(validCopy);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "test-model",
        text: expect.objectContaining({
          format: expect.objectContaining({ type: "json_schema", strict: true }),
        }),
      }),
      { timeout: 1234 },
    );
  });

  it("returns AI copy when generation and validation pass", async () => {
    const result = await new MessageGenerationService({
      env: { OPENAI_API_KEY: "test", AI_COPY_ENABLED: "true" },
      writer: writer(validCopy),
      model: "test-model",
    }).generate(input);

    expect(result.source).toBe("AI_GENERATED");
    expect(result.aiValidationPassed).toBe(true);
    expect(result.message).toBe(copyToMessage(validCopy, input));
  });

  it("falls back when AI is disabled", async () => {
    const result = await new MessageGenerationService({
      env: { AI_COPY_ENABLED: "false", OPENAI_API_KEY: "test" },
      writer: writer(validCopy),
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("AI copy generation is disabled.");
    expect(result.message).toContain(input.trackingUrl);
  });

  it("falls back when API key is missing", async () => {
    const result = await new MessageGenerationService({ env: {} }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("OPENAI_API_KEY is not configured.");
  });

  it("falls back when OpenAI throws", async () => {
    const brokenWriter = {
      compose: vi.fn().mockRejectedValue(new Error("request failed")),
    } as unknown as AiCopywriter;

    const result = await new MessageGenerationService({
      env: { OPENAI_API_KEY: "test" },
      writer: brokenWriter,
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("request failed");
  });

  it("falls back when AI copy fails deterministic validation", async () => {
    const result = await new MessageGenerationService({
      env: { OPENAI_API_KEY: "test" },
      writer: writer({ ...validCopy, body: "Menor preco garantido com 90% de desconto." }),
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationPassed).toBe(false);
    expect(result.aiValidationReasons.length).toBeGreaterThan(0);
  });

  it("does not expose API key in integration status", () => {
    expect(getOpenAiIntegrationStatus({ OPENAI_API_KEY: "sk-secret" })).toEqual(
      expect.objectContaining({ configured: true }),
    );
    expect(JSON.stringify(getOpenAiIntegrationStatus({ OPENAI_API_KEY: "sk-secret" }))).not.toContain(
      "sk-secret",
    );
  });
});
