import type {
  ShopeeAffiliateConfiguration,
  ShopeeCategoryRule,
  ShopeeDatafeedInspectResult,
  ShopeeDatafeedPreviewResult,
  ShopeeOperationalImportResult,
  ShopeeOperationalOfferState,
  ShopeeBulkAffiliateLinkResult,
  ShopeeRemoteDiscoveryResult,
  ShopeeAutomatedDiscoveryResult,
} from "@affiliate/shopee-affiliate";

export type ShopeeDashboardConfigurationDto = ShopeeAffiliateConfiguration & {
  categories: ShopeeCategoryRule[];
  offerCounts: { pending: number; ready: number };
  pendingOffers: Array<{
    id: string;
    title: string;
    externalProductId: string;
    statusReason: string | null;
  }>;
};

export type ShopeeDatafeedActionInput = {
  files: string[];
  categories: Array<{
    id: string;
    enabled: boolean;
    priority: number;
    minPerCategory: number;
    maxPerCategory: number;
  }>;
  filters: {
    priceMin: number | null;
    priceMax: number | null;
    discountMin: number | null;
    itemRatingMin: number | null;
    shopRatingMin: number | null;
    crossBorderAllowed: boolean;
    forbiddenWords: string[];
  };
};

export type ShopeeActionResult<T> =
  | { ok: true; data: T; message: string }
  | { ok: false; errorCode: string; message: string };

export type ShopeeInspectActionResult =
  ShopeeActionResult<ShopeeDatafeedInspectResult>;
export type ShopeePreviewActionResult =
  ShopeeActionResult<ShopeeDatafeedPreviewResult>;
export type ShopeeImportActionResult =
  | {
      ok: true;
      data: ShopeeOperationalImportResult;
      offerState: ShopeeOperationalOfferState;
      message: string;
    }
  | { ok: false; errorCode: string; message: string };

export type ShopeeBulkLinkActionResult =
  | {
      ok: true;
      data: ShopeeBulkAffiliateLinkResult;
      offerState: ShopeeOperationalOfferState;
      message: string;
    }
  | { ok: false; errorCode: string; message: string };

export type ShopeeRemoteActionInput = {
  confirmLiveCall: true;
  referenceIds: string[];
  pageSize: number;
  maxPages: number;
  maxItems: number;
};

export type ShopeeRemoteFeedsActionResult = ShopeeActionResult<{
  status: "SUCCEEDED";
  feeds: Array<{
    referenceId: string;
    datafeedId: string;
    name: string;
    totalCount: number;
    date: string;
    feedMode: "FULL";
  }>;
  externalRequests: number;
  writes: 0;
  stateModified: false;
}>;
export type ShopeeRemotePreviewActionResult =
  ShopeeActionResult<ShopeeRemoteDiscoveryResult>;
export type ShopeeRemoteImportActionResult =
  ShopeeActionResult<ShopeeAutomatedDiscoveryResult>;
