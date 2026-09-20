import { supabase, UserRow } from "@/lib/supabase";
import { askGroqForValidatedJSON, askGroqForText } from "@/lib/groq";
import { sendMessage, sendTyping } from "@/lib/telegram";
import { LessonPlan, formatActivityPrompt } from "@/lib/lessonPlan";
import { z } from "zod";

const CorrectionResultSchema = z.object({
  is_correct: z.boolean(),
  feedback_id: z.string().min(1), // short, casual, in Indonesian
  mistake_type: z.string().min(1).nullable(),
  corrected_sentence: z.string().min(1).nullable(),
});
type CorrectionResult = z.infer<typeof CorrectionResultSchema>;

/**
 * Rough heuristic for "the user is asking something" rather than
 * "the user is answering the current activity". Not perfect, but good
 * enough to stop clarifying questions from being silently swallowed as
 * if they were the next activity's answer.
 */
function isLikelyQuestion(text: string): boolean {
  const t = text.trim();
  if (t.endsWith("?")) return true;
  return /^(kenapa|mengapa|apa|gimana|bagaimana|maksudnya|bisa jelaskan|coba jelaskan|jelaskan|kok)\b/i.test(t);
}

/**
 * Called whenever the user sends free text and they have an in-progress
 * lesson today. Scores the answer against the current activity, records
 * any recurring mistake pattern, then either sends the next activity or
 * closes out the lesson with a summary.
 */
export async function handleLessonResponse(user: UserRow, text: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: lesson } = await supabase
    .from("lessons")
    .select("*")
    .eq("user_id", user.id)
    .eq("lesson_date", today)
    .maybeSingle();

  if (!lesson || lesson.status === "completed") return false;

  const plan = lesson.plan as LessonPlan;
  const activityIndex = lesson.activities_completed;
  const activity = plan.activities[activityIndex];
  if (!activity) return false;

  await sendTyping(user.telegram_chat_id);

  // If this looks like a question rather than an answer, address it
  // directly and leave the current activity pending — don't advance.
  if (isLikelyQuestion(text)) {
    const contextActivity = activityIndex > 0 ? plan.activities[activityIndex - 1] : activity;
    const clarification = await askGroqForText({
      userId: user.id,
      endpoint: "lesson_clarification",
      system:
        "You are a friendly, casual English tutor for Indonesian learners answering a quick clarifying question mid-lesson. Answer in Indonesian, casual tone, 2-4 sentences max. Be concrete. Do not restart the lesson, do not ask a new question of your own, and do not repeat the full earlier explanation verbatim — build on it.",
      prompt: `Earlier activity: "${contextActivity.prompt}"${contextActivity.target_answer ? `\nExpected idea: "${contextActivity.target_answer}"` : ""}\nLearner's clarifying question: "${text}"`,
      maxTokens: 300,
    });

    await sendMessage(user.telegram_chat_id, clarification);
    await sendMessage(
      user.telegram_chat_id,
      `Oke, balik ke tadi ya:\n${activity.prompt}`
    );

    await supabase.from("conversation_log").insert([
      {
        user_id: user.id,
        role: "user",
        content: text,
        meta: { lesson_id: lesson.id, activity_index: activityIndex, type: "clarification" },
      },
    ]);

    return true;
  }

  if (activity.type === "conversation") {
    // Open-ended, but still worth a real reaction instead of a canned line —
    // acknowledge something specific from what they actually said.
    const reply = await askGroqForText({
      userId: user.id,
      endpoint: "conversation_reaction",
      system:
        "You are a friendly, casual English tutor for Indonesian learners. React briefly and specifically to what the learner just said (1-2 sentences, Indonesian, casual). If their English had a small error, note it gently in passing — don't turn it into a full lecture. Never use a generic line like 'jawaban yang natural' — react to the actual content.",
      prompt: `Activity prompt: "${activity.prompt}"\nLearner's answer: "${text}"`,
      maxTokens: 200,
    });
    await sendMessage(user.telegram_chat_id, reply);
  } else {
    const correction = await askGroqForValidatedJSON<CorrectionResult>({
      userId: user.id,
      endpoint: "answer_correction",
      schema: CorrectionResultSchema,
      system:
        "You are a friendly, casual English tutor for Indonesian learners. Evaluate the learner's answer briefly and kindly. Never lecture — one or two sentences max, in Indonesian, casual tone.",
      prompt: `Activity prompt: "${activity.prompt}"\nExpected/target idea: "${activity.target_answer ?? "(open-ended, use judgment)"}"\nLearner's answer: "${text}"\n\nReturn JSON: {"is_correct": bool, "feedback_id": "short casual Indonesian feedback (never empty)", "mistake_type": "snake_case tag or null", "corrected_sentence": "corrected version or null"}`,
    });

    await sendMessage(
      user.telegram_chat_id,
      correction.feedback_id +
        (correction.corrected_sentence ? `\n<i>${correction.corrected_sentence}</i>` : "")
    );

    if (!correction.is_correct && correction.mistake_type) {
      await recordMistake(user.id, correction.mistake_type, text, correction.corrected_sentence);
    }
  }

  await supabase
    .from("conversation_log")
    .insert([
      { user_id: user.id, role: "user", content: text, meta: { lesson_id: lesson.id, activity_index: activityIndex } },
    ]);

  const nextIndex = activityIndex + 1;
  const isDone = nextIndex >= plan.activities.length;

  await supabase
    .from("lessons")
    .update({
      activities_completed: nextIndex,
      status: isDone ? "completed" : "in_progress",
      completed_at: isDone ? new Date().toISOString() : null,
    })
    .eq("id", lesson.id);

  if (isDone) {
    await closeOutLesson(user);
  } else {
    const nextActivity = plan.activities[nextIndex];
    await sendMessage(user.telegram_chat_id, formatActivityPrompt(nextActivity));
  }

  return true;
}

async function recordMistake(
  userId: string,
  mistakeType: string,
  wrongExample: string,
  correctedExample: string | null
) {
  const { data: existing } = await supabase
    .from("mistakes")
    .select("id, occurrences")
    .eq("user_id", userId)
    .eq("mistake_type", mistakeType)
    .eq("resolved", false)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("mistakes")
      .update({
        occurrences: existing.occurrences + 1,
        last_seen_at: new Date().toISOString(),
        example_wrong: wrongExample,
        example_corrected: correctedExample,
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("mistakes").insert({
      user_id: userId,
      mistake_type: mistakeType,
      example_wrong: wrongExample,
      example_corrected: correctedExample,
    });
  }
}

async function closeOutLesson(user: UserRow) {
  await updateStreak(user);

  const { data: freshUser } = await supabase.from("users").select("*").eq("id", user.id).single();

  await sendMessage(
    user.telegram_chat_id,
    `Sesi hari ini selesai! 🎉\n🔥 Streak: ${freshUser?.streak_current ?? 1} hari\n\nBesok aku ingatkan lagi jam ${user.preferred_time ?? "yang kamu pilih"}. Kalau mau review kosakata sekarang, ketik /review.`
  );
}

async function updateStreak(user: UserRow) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const wasYesterday = user.last_active_date === yesterday;
  const newStreak = wasYesterday ? user.streak_current + 1 : 1;

  await supabase
    .from("users")
    .update({
      streak_current: newStreak,
      streak_longest: Math.max(newStreak, user.streak_longest),
      last_active_date: today,
    })
    .eq("id", user.id);
}
