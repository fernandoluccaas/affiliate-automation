CREATE TYPE "AiProviderName" AS ENUM ('OLLAMA', 'OPENAI', 'DETERMINISTIC');

ALTER TABLE "Publication"
  ADD COLUMN "aiProvider" "AiProviderName" NOT NULL DEFAULT 'DETERMINISTIC';

UPDATE "Publication"
SET "aiProvider" = CASE
  WHEN "messageSource" = 'AI_GENERATED' THEN 'OPENAI'::"AiProviderName"
  ELSE 'DETERMINISTIC'::"AiProviderName"
END;
