import { describe, expect, it, vi } from "vitest";
import {
  AiMessageValidator,
  MessageGenerationService,
  OllamaAiProvider,
  OpenAiProvider,
  copyToMessage,
  createAiProvider,
  getOpenAiIntegrationStatus,
  promotionalCopySchema,
  validatePromotionalCopy,
  type AiProvider,
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

function provider(copy: PromotionalCopy): AiProvider {
  return {
    provider: "OLLAMA",
    model: "test-model",
    generate: vi.fn().mockResolvedValue(copy),
  };
}

function fetchResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body,
  };
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

describe("AiMessageValidator", () => {
  const validator = new AiMessageValidator();

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

describe("OllamaAiProvider", () => {
  it("returns valid JSON from Ollama HTTP structured output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({ response: JSON.stringify(validCopy) }));
    const ollama = new OllamaAiProvider({
      baseUrl: "http://localhost:11434",
      model: "qwen3:4b",
      fetchFn,
    });

    await expect(ollama.generate(input)).resolves.toEqual(validCopy);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"qwen3:4b"'),
      }),
    );
  });

  it("throws on invalid JSON so the service can fallback", async () => {
    const ollama = new OllamaAiProvider({
      fetchFn: vi.fn().mockResolvedValue(fetchResponse({ response: "not-json" })),
    });

    await expect(ollama.generate(input)).rejects.toThrow();
  });

  it("throws on HTTP errors so the service can fallback", async () => {
    const ollama = new OllamaAiProvider({
      fetchFn: vi.fn().mockResolvedValue(fetchResponse({ error: "missing model" }, false, 404)),
    });

    await expect(ollama.generate(input)).rejects.toThrow("Ollama HTTP 404");
  });

  it("preserves Unicode from Ollama provider through validated messages", async () => {
    const copy: PromotionalCopy = {
      headline: "\u{1F525} Promoção especial",
      body: "Promoção válida para São Luís com preço R$ 149,90 e cupom AUDIO10.",
      callToAction: "Confira em https://example.com/go/fone",
      disclosure: "#publi - link de afiliado",
      hashtags: ["#oferta"],
    };
    const ollama = new OllamaAiProvider({
      fetchFn: vi.fn().mockResolvedValue(fetchResponse({ response: JSON.stringify(copy) })),
    });
    const service = new MessageGenerationService({ provider: ollama });
    const result = await service.generate(input);

    expect(result.source).toBe("AI_GENERATED");
    expect(result.message).toContain("\u{1F525} Promoção especial");
    expect(result.message).toContain("São Luís");
    expect(result.message).not.toContain("Ã°Å¸");
    expect(result.message).not.toContain("Ãƒ");
    expect(result.message).not.toContain("Ã‚");
  });

  it("reports health without requiring the local service to be online", async () => {
    const ollama = new OllamaAiProvider({
      baseUrl: "http://localhost:11434/",
      model: "qwen3:4b",
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
    });

    await expect(ollama.healthCheck()).resolves.toEqual(
      expect.objectContaining({
        configured: true,
        available: false,
        baseUrl: "http://localhost:11434",
        model: "qwen3:4b",
      }),
    );
  });
});

describe("OpenAiProvider", () => {
  it("uses structured output and retries once", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ output_text: JSON.stringify(validCopy) });
    const ai = new OpenAiProvider({
      apiKey: "test",
      client: { responses: { create } },
      model: "test-model",
      timeoutMs: 1234,
      maxRetries: 1,
    });

    await expect(ai.generate(input)).resolves.toEqual(validCopy);
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
});

describe("MessageGenerationService", () => {
  it("selects Ollama by default and never requires an OpenAI key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({ response: JSON.stringify(validCopy) }));
    const result = await new MessageGenerationService({
      env: {
        AI_PROVIDER: "ollama",
        AI_COPY_ENABLED: "true",
        OLLAMA_BASE_URL: "http://localhost:11434",
        OLLAMA_MODEL: "qwen3:4b",
      },
      provider: new OllamaAiProvider({ fetchFn, model: "qwen3:4b" }),
    }).generate(input);

    expect(result.source).toBe("AI_GENERATED");
    expect(result.aiProvider).toBe("OLLAMA");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("selects provider by configuration", () => {
    expect(createAiProvider({ AI_PROVIDER: "ollama" })).toBeInstanceOf(OllamaAiProvider);
    expect(
      createAiProvider({ AI_PROVIDER: "openai", OPENAI_API_KEY: "test" }),
    ).toBeInstanceOf(OpenAiProvider);
  });

  it("returns AI copy when generation and validation pass", async () => {
    const result = await new MessageGenerationService({
      provider: provider(validCopy),
    }).generate(input);

    expect(result.source).toBe("AI_GENERATED");
    expect(result.aiProvider).toBe("OLLAMA");
    expect(result.aiValidationPassed).toBe(true);
    expect(result.message).toBe(copyToMessage(validCopy, input));
  });

  it("falls back and does not call provider when AI is disabled", async () => {
    const disabledProvider = provider(validCopy);
    const result = await new MessageGenerationService({
      env: { AI_COPY_ENABLED: "false" },
      provider: disabledProvider,
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiProvider).toBe("DETERMINISTIC");
    expect(result.aiValidationReasons).toContain("AI copy generation is disabled.");
    expect(disabledProvider.generate).not.toHaveBeenCalled();
  });

  it("falls back when Ollama is unavailable", async () => {
    const result = await new MessageGenerationService({
      provider: {
        provider: "OLLAMA",
        model: "qwen3:4b",
        generate: vi.fn().mockRejectedValue(new Error("fetch failed")),
      },
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiProvider).toBe("OLLAMA");
    expect(result.aiValidationReasons).toContain("fetch failed");
  });

  it("falls back on timeout", async () => {
    const result = await new MessageGenerationService({
      provider: {
        provider: "OLLAMA",
        model: "qwen3:4b",
        generate: vi.fn().mockRejectedValue(new Error("Ollama request timed out.")),
      },
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("Ollama request timed out.");
  });

  it("falls back on HTTP error", async () => {
    const result = await new MessageGenerationService({
      provider: {
        provider: "OLLAMA",
        model: "qwen3:4b",
        generate: vi.fn().mockRejectedValue(new Error("Ollama HTTP 500: Server Error")),
      },
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("Ollama HTTP 500: Server Error");
  });

  it("falls back on invalid JSON", async () => {
    const result = await new MessageGenerationService({
      provider: {
        provider: "OLLAMA",
        model: "qwen3:4b",
        generate: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      },
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("Unexpected token");
  });

  it("falls back when generated copy invents price", async () => {
    const result = await new MessageGenerationService({
      provider: provider({ ...validCopy, body: "De R$ 299,90 por R$ 149,90." }),
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons.join(" ")).toContain("Preco nao confirmado");
  });

  it("falls back when generated copy invents coupon", async () => {
    const result = await new MessageGenerationService({
      provider: provider(validCopy),
    }).generate({ ...input, couponCode: null });

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons.join(" ")).toContain("Cupom foi mencionado");
  });

  it("falls back when generated copy invents free shipping", async () => {
    const result = await new MessageGenerationService({
      provider: provider({ ...validCopy, body: `${validCopy.body} Frete gratis.` }),
    }).generate({ ...input, freeShipping: false });

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons.join(" ")).toContain("Frete gratis");
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
