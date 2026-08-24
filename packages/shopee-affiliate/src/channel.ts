import { prisma, type PrismaClient } from "@affiliate/database";

const SUPPORTED_CHANNEL_TYPES = new Set([
  "TELEGRAM",
  "WHATSAPP_GROUPS",
  "MANUAL_EXPORT",
]);

export type ShopeeChannelPolicyRecord = {
  id: string;
  type: string;
  enabled: boolean;
  allowedMarketplaces: string[];
};

export interface ShopeeChannelPolicyStore {
  list(): Promise<ShopeeChannelPolicyRecord[]>;
  load(id: string): Promise<ShopeeChannelPolicyRecord | null>;
  updateAllowedMarketplaces(
    id: string,
    allowedMarketplaces: string[],
  ): Promise<ShopeeChannelPolicyRecord>;
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sanitize(channel: ShopeeChannelPolicyRecord) {
  return {
    id: channel.id,
    type: channel.type,
    enabled: channel.enabled,
    allowedMarketplaces: [...channel.allowedMarketplaces].sort(),
    shopeeAllowed: channel.allowedMarketplaces.includes("SHOPEE"),
  };
}

export function createPrismaShopeeChannelPolicyStore(
  database: PrismaClient = prisma,
): ShopeeChannelPolicyStore {
  const select = {
    id: true,
    type: true,
    enabled: true,
    allowedMarketplaces: true,
  } as const;
  const normalize = (channel: {
    id: string;
    type: string;
    enabled: boolean;
    allowedMarketplaces: unknown;
  }) => ({
    ...channel,
    allowedMarketplaces: strings(channel.allowedMarketplaces),
  });
  return {
    async list() {
      const channels = await database.channel.findMany({
        where: {
          type: { in: ["TELEGRAM", "WHATSAPP_GROUPS", "MANUAL_EXPORT"] },
        },
        orderBy: { createdAt: "asc" },
        select,
      });
      return channels.map(normalize);
    },
    async load(id) {
      const channel = await database.channel.findUnique({
        where: { id },
        select,
      });
      return channel ? normalize(channel) : null;
    },
    async updateAllowedMarketplaces(id, allowedMarketplaces) {
      return normalize(
        await database.channel.update({
          where: { id },
          data: { allowedMarketplaces },
          select,
        }),
      );
    },
  };
}

export async function inspectShopeeChannelPolicies(
  input: {
    channelId?: string;
    store?: ShopeeChannelPolicyStore;
  } = {},
) {
  const store = input.store ?? createPrismaShopeeChannelPolicyStore();
  const channels = input.channelId
    ? [await store.load(input.channelId)].filter(
        (channel): channel is ShopeeChannelPolicyRecord => channel !== null,
      )
    : await store.list();
  return {
    status:
      input.channelId && channels.length === 0 ? "NOT_FOUND" : "INSPECTED",
    channels: channels.map(sanitize),
    total: channels.length,
    shopeeEnabled: channels.filter((channel) =>
      channel.allowedMarketplaces.includes("SHOPEE"),
    ).length,
    externalRequests: 0 as const,
    writes: 0,
    messagesSent: 0 as const,
    stateModified: false,
  };
}

export async function updateShopeeChannelPolicy(input: {
  channelId: string;
  action: "ENABLE" | "DISABLE";
  confirmed: boolean;
  store?: ShopeeChannelPolicyStore;
}) {
  if (!input.confirmed) throw new Error("SHOPEE_CHANNEL_CHANGE_NOT_CONFIRMED");
  const store = input.store ?? createPrismaShopeeChannelPolicyStore();
  const current = await store.load(input.channelId);
  if (!current) throw new Error("SHOPEE_CHANNEL_NOT_FOUND");
  if (!SUPPORTED_CHANNEL_TYPES.has(current.type)) {
    throw new Error("SHOPEE_CHANNEL_TYPE_UNSUPPORTED");
  }
  const before = sanitize(current);
  const next =
    input.action === "ENABLE"
      ? [...new Set([...current.allowedMarketplaces, "SHOPEE"])]
      : current.allowedMarketplaces.filter(
          (marketplace) => marketplace !== "SHOPEE",
        );
  const changed = next.length !== current.allowedMarketplaces.length;
  const updated = changed
    ? await store.updateAllowedMarketplaces(current.id, next)
    : current;
  return {
    status: changed ? "UPDATED" : "UNCHANGED",
    action: input.action,
    before,
    after: sanitize(updated),
    externalRequests: 0 as const,
    writes: changed ? 1 : 0,
    messagesSent: 0 as const,
    stateModified: changed,
  };
}
