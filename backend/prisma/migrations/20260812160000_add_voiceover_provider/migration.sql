-- Which vision provider reads the frames (anthropic | openai | gemini).
ALTER TABLE "voiceover_settings" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'anthropic';
