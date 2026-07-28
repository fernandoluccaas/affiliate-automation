import { describe, expect, it } from "vitest";
import {
  extractMercadoLivreCsrfToken,
  mergeMercadoLivreCookies,
  normalizeMercadoLivreCookie,
  parseMercadoLivreCookie,
} from "./affiliate-cookie";

describe("Mercado Livre affiliate cookie utilities", () => {
  it("normalizes whitespace and ignores empty segments", () => {
    expect(
      normalizeMercadoLivreCookie(
        "  synthetic_session = synthetic-value ; ; locale = pt-BR  ;",
      ),
    ).toBe("synthetic_session=synthetic-value; locale=pt-BR");
  });

  it("uses the first equals sign and preserves the remaining value", () => {
    expect(
      parseMercadoLivreCookie(
        "synthetic_session=synthetic=value=with=equals",
      ).get("synthetic_session"),
    ).toBe("synthetic=value=with=equals");
  });

  it("lets the last duplicate cookie value win", () => {
    expect(
      normalizeMercadoLivreCookie(
        "synthetic_session=first; locale=pt-BR; synthetic_session=last",
      ),
    ).toBe("synthetic_session=last; locale=pt-BR");
  });

  it("rejects malformed input without echoing its contents", () => {
    const rawCookie = "synthetic_session=synthetic-value; private-fragment";

    expect(() => normalizeMercadoLivreCookie(rawCookie)).toThrow(
      "Invalid Mercado Livre cookie format.",
    );

    try {
      normalizeMercadoLivreCookie(rawCookie);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("private-fragment");
      expect((error as Error).message).not.toContain("synthetic-value");
    }
  });

  it("rejects control characters without echoing cookie values", () => {
    const rawCookie =
      "synthetic_session=synthetic-private-value\r\ninjected=true";

    expect(() => normalizeMercadoLivreCookie(rawCookie)).toThrow(
      "Invalid Mercado Livre cookie format.",
    );

    try {
      normalizeMercadoLivreCookie(rawCookie);
    } catch (error) {
      expect((error as Error).message).not.toContain("synthetic-private-value");
    }
  });

  it("merges updated cookies while preserving cookies not returned", () => {
    expect(
      mergeMercadoLivreCookies("synthetic_session=old; locale=pt-BR", [
        "synthetic_session=new=value; Path=/; HttpOnly",
        "synthetic_extra=added; Path=/; Secure",
      ]),
    ).toBe("synthetic_session=new=value; locale=pt-BR; synthetic_extra=added");
  });

  it("supports combined Set-Cookie fallback headers with Expires commas", () => {
    expect(
      mergeMercadoLivreCookies("locale=pt-BR", [
        "synthetic_session=fresh; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/, synthetic_extra=added; Path=/",
      ]),
    ).toBe("locale=pt-BR; synthetic_session=fresh; synthetic_extra=added");
  });

  it("supports fallback header lines prefixed with Set-Cookie", () => {
    expect(
      mergeMercadoLivreCookies("locale=pt-BR", [
        "Set-Cookie: synthetic_session=fresh; Path=/\r\nSet-Cookie: synthetic_extra=added; Path=/",
      ]),
    ).toBe("locale=pt-BR; synthetic_session=fresh; synthetic_extra=added");
  });

  it("removes cookies expired through Max-Age or Expires", () => {
    expect(
      mergeMercadoLivreCookies(
        "synthetic_session=old; synthetic_expired=old; locale=pt-BR",
        [
          "synthetic_session=deleted; Max-Age=0; Path=/",
          "synthetic_expired=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
        ],
      ),
    ).toBe("locale=pt-BR");
  });

  it("honors a positive Max-Age over an old Expires attribute", () => {
    expect(
      mergeMercadoLivreCookies("synthetic_session=old", [
        "synthetic_session=fresh; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ]),
    ).toBe("synthetic_session=fresh");
  });

  it("extracts CSRF names case-insensitively and decodes URI values", () => {
    expect(
      extractMercadoLivreCsrfToken(
        "locale=pt-BR; XSRF-TOKEN=synthetic%3Dcsrf%2520value",
      ),
    ).toBe("synthetic=csrf%20value");
  });

  it("keeps an undecodable CSRF value intact", () => {
    expect(extractMercadoLivreCsrfToken("CSRF_TOKEN=synthetic%invalid")).toBe(
      "synthetic%invalid",
    );
  });

  it("does not use _d2id as an automatic CSRF fallback", () => {
    expect(
      extractMercadoLivreCsrfToken("_d2id=synthetic-device-id"),
    ).toBeNull();
  });
});
