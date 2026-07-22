import { z } from "zod";

export const promotionalCopySchema = z.object({
  headline: z.string().min(1).max(120),
  body: z.string().min(1).max(1000),
  callToAction: z.string().min(1).max(120),
  disclosure: z.string().min(1).max(200),
  hashtags: z.array(z.string().regex(/^#[A-Za-z0-9_]+$/)).max(10),
});

export type PromotionalCopy = z.infer<typeof promotionalCopySchema>;

export function validatePromotionalCopy(copy: unknown) {
  return promotionalCopySchema.safeParse(copy);
}
