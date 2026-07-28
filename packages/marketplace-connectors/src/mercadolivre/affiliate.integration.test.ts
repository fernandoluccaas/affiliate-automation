import { describe, expect, it } from "vitest";
import {
  MercadoLivreAffiliateLinkService,
  normalizeMercadoLivreGeneratedAffiliateUrl,
} from "./affiliate-link";
import { MercadoLivreAffiliateSessionService } from "./affiliate-session";

const testCookie = process.env.MERCADOLIVRE_TEST_COOKIE;
const testAffiliateLink = process.env.MERCADOLIVRE_TEST_AFFILIATE_LINK;
const testProductUrl = process.env.MERCADOLIVRE_TEST_PRODUCT_URL;
const integrationConfigured = Boolean(
  testCookie && testAffiliateLink && testProductUrl,
);

describe.skipIf(!integrationConfigured)(
  "Mercado Livre affiliate real integration",
  () => {
    it("validates the session, lists tags and creates an HTTPS affiliate link", async () => {
      if (!testCookie || !testAffiliateLink || !testProductUrl) {
        throw new Error(
          "Mercado Livre affiliate integration variables are not configured.",
        );
      }

      expect(
        normalizeMercadoLivreGeneratedAffiliateUrl(testAffiliateLink),
      ).toBeTruthy();

      const session =
        await new MercadoLivreAffiliateSessionService().validateSession({
          cookie: testCookie,
        });
      const selectedTag = session.selectedTag;

      expect(session.tags.length).toBeGreaterThan(0);
      expect(selectedTag).not.toBeNull();

      if (!selectedTag) {
        throw new Error(
          "Mercado Livre affiliate session returned no selectable tag.",
        );
      }

      const result = await new MercadoLivreAffiliateLinkService().create({
        productUrl: testProductUrl,
        affiliateTag: selectedTag.value,
        cookie: session.cookie,
        csrfToken: session.csrfToken,
      });
      const affiliateUrl = new URL(result.affiliateUrl);

      expect(affiliateUrl.protocol).toBe("https:");
      expect(
        ["meli.la", "mercadolivre.com.br", "mercadolibre.com"].some(
          (domain) =>
            affiliateUrl.hostname === domain ||
            affiliateUrl.hostname.endsWith(`.${domain}`),
        ),
      ).toBe(true);
    }, 120_000);
  },
);
