export type ClickContext = {
  slug: string;
  channelId?: string;
  publicationId?: string;
  userAgent?: string;
  referer?: string;
};

export function buildTrackingPath(slug: string) {
  return `/go/${encodeURIComponent(slug)}`;
}
