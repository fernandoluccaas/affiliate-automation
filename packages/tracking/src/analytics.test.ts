import { describe, expect, it, vi } from "vitest";
import { collectAnalytics, safeConversionRate, validateAnalyticsPeriod } from "./analytics";

describe("analytics", () => {
  it("does not divide by zero and validates bounded periods", () => {
    expect(safeConversionRate(3, 0)).toBe(0);
    expect(safeConversionRate(1, 4)).toBe(25);
    expect(() => validateAnalyticsPeriod({ from: new Date("2025-01-01"), to: new Date("2026-08-05") })).toThrow("ANALYTICS_PERIOD_TOO_LARGE");
    expect(() => validateAnalyticsPeriod({ from: new Date("2026-08-05"), to: new Date("2026-08-05") })).toThrow("ANALYTICS_PERIOD_INVALID");
  });

  it("returns zeros without inventing data", async () => {
    const database = {
      click: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      conversion: {
        count: vi.fn().mockResolvedValue(0),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      commission: { groupBy: vi.fn().mockResolvedValue([]) },
      trackingDailyMetric: { aggregate: vi.fn().mockResolvedValue({ _sum: {} }) },
      importJob: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await collectAnalytics({ from: new Date("2026-08-01"), to: new Date("2026-08-06") }, database as never);
    expect(result).toMatchObject({ clicks: 0, conversions: 0, conversionRate: 0, redirects: 0, trackingDegraded: 0 });
    expect(result.revenueByCurrency).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it("keeps revenue and commissions separated by currency", async () => {
    const database = {
      click: {
        count: vi.fn().mockResolvedValue(10),
        findMany: vi.fn().mockResolvedValue([{ fingerprintHash: "hash" }]),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      conversion: {
        count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1).mockResolvedValueOnce(0),
        groupBy: vi.fn()
          .mockResolvedValueOnce([
            { currency: "BRL", _sum: { amount: { toString: () => "100" } }, _count: { _all: 1 } },
            { currency: "USD", _sum: { amount: { toString: () => "20" } }, _count: { _all: 1 } },
          ])
          .mockResolvedValue([]),
      },
      commission: { groupBy: vi.fn().mockResolvedValue([
        { currency: "BRL", status: "APPROVED", _sum: { amount: { toString: () => "10" } }, _count: { _all: 1 } },
        { currency: "USD", status: "PENDING", _sum: { amount: { toString: () => "2" } }, _count: { _all: 1 } },
      ]) },
      trackingDailyMetric: { aggregate: vi.fn().mockResolvedValue({ _sum: { redirects: 12, clicksPersisted: 10 } }) },
      importJob: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await collectAnalytics({ from: new Date("2026-08-01"), to: new Date("2026-08-06") }, database as never);
    expect(result.conversionRate).toBe(20);
    expect(result.revenueByCurrency).toEqual([
      { currency: "BRL", amount: 100, conversions: 1 },
      { currency: "USD", amount: 20, conversions: 1 },
    ]);
    expect(result.commissionsByCurrencyAndStatus).toHaveLength(2);
    expect(result.averageCommissionByCurrency).toEqual([
      { currency: "BRL", average: 10, commissions: 1 },
      { currency: "USD", average: 2, commissions: 1 },
    ]);
  });
});
