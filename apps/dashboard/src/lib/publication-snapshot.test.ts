import { describe, expect, it } from "vitest";
import { publicationTitleSnapshot } from "./publication-snapshot";

describe("publication snapshots", () => {
  it("uses the immutable publication title snapshot", () => {
    expect(
      publicationTitleSnapshot({
        offerTitleSnapshot: "pcd teste",
      }),
    ).toBe("pcd teste");
  });
});
