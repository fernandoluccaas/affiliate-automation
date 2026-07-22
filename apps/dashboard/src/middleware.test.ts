import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicPath, middleware } from "./middleware";

describe("middleware route protection", () => {
  it("allows public paths", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
  });

  it("redirects protected routes without a session", async () => {
    const response = await middleware(new NextRequest("http://localhost/ofertas"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });
});
