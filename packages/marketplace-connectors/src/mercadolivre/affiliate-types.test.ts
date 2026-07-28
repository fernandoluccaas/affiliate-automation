import { describe, expect, it } from "vitest";
import {
  parseMercadoLivreAffiliateTags,
  selectMercadoLivreAffiliateTag,
} from "./affiliate-types";

describe("Mercado Livre affiliate tags", () => {
  it.each([
    [["tag-one", "tag-two"]],
    [{ tags: ["tag-one", "tag-two"] }],
    [{ data: { tags: ["tag-one", "tag-two"] } }],
  ])("parses supported string response shapes", (response) => {
    expect(parseMercadoLivreAffiliateTags(response)).toEqual([
      {
        value: "tag-one",
        label: "tag-one",
        isDefault: false,
      },
      {
        value: "tag-two",
        label: "tag-two",
        isDefault: false,
      },
    ]);
  });

  it("normalizes object tags and tolerant default fields", () => {
    expect(
      parseMercadoLivreAffiliateTags({
        data: {
          tags: [
            {
              id: 123,
              tag: "tag-value",
              label: "Tag principal",
              is_default: "true",
            },
            {
              id: "secondary-id",
              name: "secondary-value",
              default: false,
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "123",
        value: "tag-value",
        label: "Tag principal",
        isDefault: true,
      },
      {
        id: "secondary-id",
        value: "secondary-value",
        label: "secondary-value",
        isDefault: false,
      },
    ]);
  });

  it("deduplicates tags and preserves default information", () => {
    expect(
      parseMercadoLivreAffiliateTags({
        tags: [
          { tag: "tag-one" },
          { tag: "tag-one", label: "Tag One", default: true },
          null,
          {},
        ],
      }),
    ).toEqual([
      {
        value: "tag-one",
        label: "Tag One",
        isDefault: true,
      },
    ]);
  });

  it("keeps a valid preferred tag", () => {
    const tags = parseMercadoLivreAffiliateTags([
      { id: "first-id", tag: "first" },
      { id: "preferred-id", tag: "preferred", default: true },
    ]);

    expect(selectMercadoLivreAffiliateTag(tags, "first")?.value).toBe("first");
    expect(selectMercadoLivreAffiliateTag(tags, "preferred-id")?.value).toBe(
      "preferred",
    );
  });

  it("selects the only available tag", () => {
    const tags = parseMercadoLivreAffiliateTags(["only-tag"]);

    expect(selectMercadoLivreAffiliateTag(tags)?.value).toBe("only-tag");
  });

  it("selects the default tag and otherwise the first tag", () => {
    const withDefault = parseMercadoLivreAffiliateTags([
      { tag: "first" },
      { tag: "default", default: true },
    ]);
    const withoutDefault = parseMercadoLivreAffiliateTags(["first", "second"]);

    expect(selectMercadoLivreAffiliateTag(withDefault)?.value).toBe("default");
    expect(selectMercadoLivreAffiliateTag(withoutDefault)?.value).toBe("first");
    expect(selectMercadoLivreAffiliateTag([])).toBeNull();
  });
});
