import { describe, expect, it, vi } from "vitest";
import {
  StripeV2MercadoLivreAffiliatePortalAdapter,
  createMercadoLivreAffiliatePortalAdapter,
} from "./affiliate-portal-adapter";

describe("MercadoLivreAffiliatePortalAdapter", () => {
  it("uses stripe_v2 by default", () => {
    expect(
      createMercadoLivreAffiliatePortalAdapter({ env: {} }),
    ).toBeInstanceOf(StripeV2MercadoLivreAffiliatePortalAdapter);
  });

  it("does not call an unapproved endpoint mode", () => {
    const fetchFn = vi.fn();

    expect(() =>
      createMercadoLivreAffiliatePortalAdapter({
        mode: "create_link_v2",
        fetchFn,
      }),
    ).toThrow("endpoint mode is not enabled");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
