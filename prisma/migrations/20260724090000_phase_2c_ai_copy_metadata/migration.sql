CREATE TYPE "MessageSource" AS ENUM ('AI_GENERATED', 'DETERMINISTIC_FALLBACK');

ALTER TABLE "Publication"
  ADD COLUMN "messageSource" "MessageSource" NOT NULL DEFAULT 'DETERMINISTIC_FALLBACK',
  ADD COLUMN "aiModel" TEXT,
  ADD COLUMN "aiGenerationDurationMs" INTEGER,
  ADD COLUMN "aiValidationPassed" BOOLEAN,
  ADD COLUMN "aiValidationReasons" JSONB,
  ADD COLUMN "generatedAt" TIMESTAMP(3);
