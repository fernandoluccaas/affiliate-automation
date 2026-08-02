import { describe, expect, it, vi } from "vitest";
import { prepareRemoteImage, validateRemoteImageUrl } from "./media";

describe("remote image preparation", () => {
  it.each([
    "http://example.com/image.jpg",
    "https://localhost/image.jpg",
    "https://127.0.0.1/image.jpg",
    "https://192.168.1.2/image.jpg",
    "https://user:pass@example.com/image.jpg",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateRemoteImageUrl(url)).toThrow();
  });

  it("accepts an HTTPS image within the byte limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" },
      }),
    );
    await expect(
      prepareRemoteImage("https://cdn.example.com/image.jpg", { fetchImpl }),
    ).resolves.toMatchObject({
      contentType: "image/jpeg",
      filename: "offer.jpeg",
    });
  });

  it("validates every redirect target", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://10.0.0.1/secret" },
        }),
      );
    await expect(
      prepareRemoteImage("https://cdn.example.com/image.jpg", { fetchImpl }),
    ).rejects.toThrow("MEDIA_URL_NOT_ALLOWED");
  });

  it("rejects non-image and oversized responses", async () => {
    const textFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("not image", {
          headers: { "content-type": "text/plain" },
        }),
      );
    await expect(
      prepareRemoteImage("https://cdn.example.com/file", {
        fetchImpl: textFetch,
      }),
    ).rejects.toThrow("MEDIA_CONTENT_TYPE_INVALID");

    const largeFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array(10), {
          headers: { "content-type": "image/png" },
        }),
      );
    await expect(
      prepareRemoteImage("https://cdn.example.com/image.png", {
        fetchImpl: largeFetch,
        maxBytes: 5,
      }),
    ).rejects.toThrow("MEDIA_TOO_LARGE");
  });
});
