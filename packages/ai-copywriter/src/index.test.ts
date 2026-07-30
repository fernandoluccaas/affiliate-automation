import { describe, expect, it, vi } from "vitest";
import {
  SHOPEE_HEADLINES,
  MERCADO_LIVRE_HEADLINES,
} from "@affiliate/publication";
import {
  AiMessageValidator,
  MessageGenerationService,
  OllamaAiProvider,
  OpenAiProvider,
  buildPrompt,
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
  category: "Eletrônicos",
  originalPrice: "199.90",
  currentPrice: "149.90",
  discountPercentage: "25.01",
  couponCode: "AUDIO10",
  freeShipping: true,
  shippingStatus: "FREE",
  trackingUrl: "https://example.com/go/fone",
  seed: "channel-1:offer-1",
  recentHeadlines: [],
};

const validCopy: PromotionalCopy = {
  headline: SHOPEE_HEADLINES[0],
  optionalHook: null,
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

describe("promotional headline schema", () => {
  it("accepts only a headline and optional hook", () => {
    expect(validatePromotionalCopy(validCopy).success).toBe(true);
    expect(
      validatePromotionalCopy({ headline: validCopy.headline }).success,
    ).toBe(true);
  });

  it.each(["price", "coupon", "trackingUrl", "body", "disclosure"])(
    "rejects AI output containing mutable fact field %s",
    (field) => {
      expect(
        promotionalCopySchema.safeParse({
          ...validCopy,
          [field]: "invented",
        }).success,
      ).toBe(false);
    },
  );

  it("builds a prompt without offer prices, coupons or purchase URLs", () => {
    const prompt = buildPrompt(input);
    expect(prompt).toContain("SHOPEE");
    expect(prompt).not.toContain("149.90");
    expect(prompt).not.toContain("AUDIO10");
    expect(prompt).not.toContain(input.trackingUrl);
  });
});

describe("AiMessageValidator", () => {
  const validator = new AiMessageValidator();

  it("accepts an unused headline from the marketplace pool", () => {
    expect(validator.validate(validCopy, input)).toEqual({
      valid: true,
      reasons: [],
    });
  });

  it("rejects a headline from another marketplace", () => {
    expect(
      validator.validate({ headline: MERCADO_LIVRE_HEADLINES[0] }, input).valid,
    ).toBe(false);
  });

  it("rejects a recently used headline", () => {
    expect(
      validator.validate(validCopy, {
        ...input,
        recentHeadlines: [validCopy.headline],
      }).valid,
    ).toBe(false);
  });
});

describe("AI providers", () => {
  it("reads strict headline JSON from Ollama", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        fetchResponse({ response: JSON.stringify(validCopy) }),
      );
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

  it("throws on invalid Ollama JSON so the service can fallback", async () => {
    const ollama = new OllamaAiProvider({
      fetchFn: vi
        .fn()
        .mockResolvedValue(fetchResponse({ response: "not-json" })),
    });
    await expect(ollama.generate(input)).rejects.toThrow();
  });

  it("reports unavailable Ollama health without throwing", async () => {
    const ollama = new OllamaAiProvider({
      baseUrl: "http://localhost:11434/",
      model: "qwen3:4b",
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(ollama.healthCheck()).resolves.toMatchObject({
      configured: true,
      available: false,
      baseUrl: "http://localhost:11434",
    });
  });

  it("uses OpenAI structured output and retries once", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
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
        text: {
          format: expect.objectContaining({
            type: "json_schema",
            strict: true,
          }),
        },
      }),
      { timeout: 1234 },
    );
  });
});

describe("MessageGenerationService", () => {
  it("uses AI only for the headline and reconstructs all facts locally", async () => {
    const result = await new MessageGenerationService({
      provider: provider(validCopy),
    }).generate(input);

    expect(result.source).toBe("AI_GENERATED");
    expect(result.message).toBe(copyToMessage(validCopy, input));
    expect(result.message).toContain("Fone Bluetooth");
    expect(result.message).toContain("R$ 149,90");
    expect(result.message).toContain("AUDIO10");
    expect(result.message).toContain(input.trackingUrl);
    expect(result.message).not.toContain("#publi");
    expect(
      result.message.match(/https:\/\/example\.com\/go\/fone/g),
    ).toHaveLength(1);
  });

  it("falls back when AI returns an invented full-copy field", async () => {
    const unsafe = {
      ...validCopy,
      price: "R$ 1,00",
      trackingUrl: "https://attacker.invalid",
    };
    const result = await new MessageGenerationService({
      provider: provider(unsafe as PromotionalCopy),
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.message).toContain("R$ 149,90");
    expect(result.message).toContain(input.trackingUrl);
    expect(result.message).not.toContain("attacker.invalid");
  });

  it("falls back for cross-marketplace or repeated headlines", async () => {
    const result = await new MessageGenerationService({
      provider: provider({ headline: MERCADO_LIVRE_HEADLINES[0] }),
    }).generate(input);
    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons.join(" ")).toContain(
      "allowed marketplace pool",
    );
  });

  it("falls back without calling the provider when AI is disabled", async () => {
    const disabledProvider = provider(validCopy);
    const result = await new MessageGenerationService({
      env: { AI_COPY_ENABLED: "false" },
      provider: disabledProvider,
    }).generate(input);

    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiProvider).toBe("DETERMINISTIC");
    expect(disabledProvider.generate).not.toHaveBeenCalled();
  });

  it("falls back on provider timeout or malformed response", async () => {
    const result = await new MessageGenerationService({
      provider: {
        provider: "OLLAMA",
        model: "qwen3:4b",
        generate: vi
          .fn()
          .mockRejectedValue(new Error("Ollama request timed out.")),
      },
    }).generate(input);
    expect(result.source).toBe("DETERMINISTIC_FALLBACK");
    expect(result.aiValidationReasons).toContain("Ollama request timed out.");
  });

  it("selects providers by configuration", () => {
    expect(createAiProvider({ AI_PROVIDER: "ollama" })).toBeInstanceOf(
      OllamaAiProvider,
    );
    expect(
      createAiProvider({
        AI_PROVIDER: "openai",
        OPENAI_API_KEY: "test",
      }),
    ).toBeInstanceOf(OpenAiProvider);
  });

  it("does not expose the OpenAI key in integration status", () => {
    const status = getOpenAiIntegrationStatus({
      OPENAI_API_KEY: "sk-secret",
    });
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sk-secret");
  });
});
