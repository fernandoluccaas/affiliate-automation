import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicPath, middleware } from "./middleware";

describe("middleware route protection", () => {
  it("allows public paths", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/health/live")).toBe(true);
    expect(isPublicPath("/api/health/ready")).toBe(true);
    expect(isPublicPath("/go/oferta-1")).toBe(true);
  });

  it("redirects protected routes without a session", async () => {
    const response = await middleware(new NextRequest("http://localhost/ofertas"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it("keeps administrative pages protected", async () => {
    const response = await middleware(new NextRequest("http://localhost/canais"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });
});
