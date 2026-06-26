-- 0007_llm_token_index.sql — daily LLM Token Expenditure Index.
--
-- Why a dedicated table: the index is a macro/sentiment signal surfaced on
-- the Regime tab alongside CRI/VCG. It captures the weighted-median price
-- per million tokens across a basket of frontier models (Claude Opus/
-- Sonnet, GPT-4o, Gemini 2.5 Pro, DeepSeek V3, Llama 3.1 405B, Mistral
-- Large). Rising index = inference is getting more expensive — falling
-- index = compute is commoditising. Sourced from the free Artificial
-- Analysis API (1000 req/day quota).
--
-- Source: scripts/llm_token_index.py pulls
-- https://artificialanalysis.ai/api/v2/data/llms/models once per day at
-- 06:30 UTC and writes one row keyed by YYYY-MM-DD UTC. Idempotent on
-- `date` — re-running on the same day overwrites the row.
--
-- index_value is normalized to 1.0 on the first date persisted so the
-- chart reads like Silicon Data's compute-cost index (1.0 at base date,
-- climbing or falling thereafter). raw_avg_usd carries the pre-normalize
-- weighted average for sanity-checking.

CREATE TABLE IF NOT EXISTS llm_token_index (
  date                 TEXT    PRIMARY KEY,         -- YYYY-MM-DD UTC
  index_value          REAL    NOT NULL,            -- normalized (1.0 = base date)
  raw_avg_usd          REAL    NOT NULL,            -- weighted avg USD per Mtok pre-normalize
  components           TEXT    NOT NULL,            -- JSON: {model_id: {input_per_mtok, output_per_mtok, weight}}
  methodology_version  INTEGER NOT NULL DEFAULT 1,  -- bump when weighting changes
  created_at           INTEGER NOT NULL             -- unix epoch (seconds)
);

CREATE INDEX IF NOT EXISTS llm_token_index_date_idx
  ON llm_token_index (date DESC);
