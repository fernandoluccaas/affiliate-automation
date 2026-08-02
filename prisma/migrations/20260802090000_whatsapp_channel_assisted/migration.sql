-- A WhatsApp Channel is distinct from Cloud API and group messaging.
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_CHANNEL';

-- Assisted publications are prepared but must not be treated as delivered.
ALTER TYPE "PublicationStatus" ADD VALUE IF NOT EXISTS 'AWAITING_MANUAL_PUBLICATION';

ALTER TABLE "Publication"
ADD COLUMN "imageUrlSnapshot" TEXT,
ADD COLUMN "metadata" JSONB;
