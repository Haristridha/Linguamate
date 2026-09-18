import Groq from "groq-sdk";
import { z } from "zod";
import { supabase } from "./supabase";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Tried in order. If a model returns a rate-limit error (429), we
// automatically retry the same request on the next model in the list.
// Configure via GROQ_MODELS in .env (comma-separated), e.g.:
//   GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3-27b
const MODEL_CHAIN = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429;
}

async function logUsage(
  userId: string | null,
  endpoint: string,
  model: string,
  inputTokens: number,
  outputTokens: number
) {
  // Groq's free/dev tiers are quota-based rather than per-token billed,
  // so we log token counts for visibility but skip a cost estimate.
  // Fill in your plan's actual per-token pricing here if you're on a paid tier.
  await supabase.from("ai_usage_log").insert({
    user_id: userId,
    endpoint: `${endpoint} (${model})`,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: null,
  });
}

/**
 * Runs the given call against each model in MODEL_CHAIN in order,
 * moving to the next one only on a 429 (rate limit) response.
 * Any other error is thrown immediately.
 */
async function withFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const model of MODEL_CHAIN) {
    try {
      return await fn(model);
    } catch (err) {
      if (isRateLimitError(err)) {
        console.warn(`Groq model ${model} rate-limited, trying next in chain...`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("All Groq models in the fallback chain failed.");
}

/**
 * Calls Groq with a system prompt + user prompt and expects the
 * response to be pure JSON matching the given shape. Used for anything
 * we need to parse programmatically (lesson plans, corrections, etc).
 */
export async function askGroqForJSON<T>(params: {
  system: string;
  prompt: string;
  userId?: string;
  endpoint: string;
  maxTokens?: number;
}): Promise<T> {
  return withFallback(async (model) => {
    const res = await groq.chat.completions.create({
      model,
      max_tokens: params.maxTokens ?? 1200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            params.system +
            "\n\nRespond with ONLY valid JSON. No markdown fences, no preamble, no explanation.",
        },
        { role: "user", content: params.prompt },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? "{}";
    const cleaned = raw.replace(/```json|```/g, "").trim();

    await logUsage(
      params.userId ?? null,
      params.endpoint,
      model,
      res.usage?.prompt_tokens ?? 0,
      res.usage?.completion_tokens ?? 0
    );

    try {
      return JSON.parse(cleaned) as T;
    } catch (err) {
      console.error("Failed to parse Groq JSON response:", cleaned);
      throw new Error("AI_JSON_PARSE_ERROR");
    }
  });
}

/** Plain conversational reply (used for open-ended chat/roleplay practice). */
export async function askGroqForText(params: {
  system: string;
  prompt: string;
  userId?: string;
  endpoint: string;
  maxTokens?: number;
}): Promise<string> {
  return withFallback(async (model) => {
    const res = await groq.chat.completions.create({
      model,
      max_tokens: params.maxTokens ?? 500,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt },
      ],
    });

    await logUsage(
      params.userId ?? null,
      params.endpoint,
      model,
      res.usage?.prompt_tokens ?? 0,
      res.usage?.completion_tokens ?? 0
    );

    return res.choices[0]?.message?.content ?? "";
  });
}

/**
 * Same as askGroqForJSON, but validates the result against a Zod schema.
 * Open-weight models (unlike bigger hosted models) are more likely to
 * drop a field or invent a slightly different shape, so we don't trust
 * "valid JSON" to mean "valid for our code" — if validation fails, we
 * retry once with the specific errors fed back to the model. If it still
 * doesn't match, we throw rather than silently rendering "undefined" to
 * the user.
 */
export async function askGroqForValidatedJSON<T>(params: {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  userId?: string;
  endpoint: string;
  maxTokens?: number;
}): Promise<T> {
  const { schema, prompt, ...rest } = params;

  const raw = await askGroqForJSON<unknown>({ ...rest, prompt });
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  console.warn(`${rest.endpoint}: schema validation failed, retrying once`, parsed.error.issues);

  const correctionPrompt = `${prompt}\n\nYour previous response did not match the required schema. Validation errors: ${JSON.stringify(
    parsed.error.issues.slice(0, 5)
  )}\n\nReturn corrected JSON only, matching the schema exactly. Every required field must be a real, non-empty, meaningful value — never a placeholder like "undefined" or an empty string.`;

  const retryRaw = await askGroqForJSON<unknown>({ ...rest, prompt: correctionPrompt });
  const retryParsed = schema.safeParse(retryRaw);
  if (retryParsed.success) return retryParsed.data;

  console.error(`${rest.endpoint}: schema validation failed again after retry`, retryParsed.error.issues);
  throw new Error(`AI_SCHEMA_VALIDATION_FAILED: ${rest.endpoint}`);
}
