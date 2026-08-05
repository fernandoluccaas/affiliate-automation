import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("dashboard liveness", () => {
  it("does not depend on database or Redis", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "LIVE",
      component: "dashboard",
    });
  });
});
