import { supabase, UserRow } from "@/lib/supabase";
import { askGroqForJSON } from "@/lib/groq";
import { sendMessage, sendTyping } from "@/lib/telegram";

type LessonPlan = {
  objective: string;
  focus_reason: string;
  est_minutes: number;
  activities: Array<{
    type: "vocabulary" | "grammar" | "reading" | "conversation";
    prompt: string;
    target_answer?: string;
    new_word?: {
      word: string;
      translation_id: string;
      definition_en: string;
      example_sentence: string;
    };
  }>;
};

type CorrectionResult = {
  is_correct: boolean;
  feedback_id: string; // short, casual, in Indonesian
  mistake_type: string | null; // snake_case tag, or null if no mistake
  corrected_sentence: string | null;
};

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

  if (activity.type === "conversation") {
    // Open-ended: just acknowledge naturally and move on, no strict scoring.
    await sendMessage(user.telegram_chat_id, "Nice, jawaban yang natural 👍");
  } else {
    const correction = await askGroqForJSON<CorrectionResult>({
      userId: user.id,
      endpoint: "answer_correction",
      system:
        "You are a friendly, casual English tutor for Indonesian learners. Evaluate the learner's answer briefly and kindly. Never lecture — one or two sentences max, in Indonesian, casual tone.",
      prompt: `Activity prompt: "${activity.prompt}"\nExpected/target idea: "${activity.target_answer ?? "(open-ended, use judgment)"}"\nLearner's answer: "${text}"\n\nReturn JSON: {"is_correct": bool, "feedback_id": "short casual Indonesian feedback", "mistake_type": "snake_case tag or null", "corrected_sentence": "corrected version or null"}`,
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

function formatActivityPrompt(activity: LessonPlan["activities"][number]) {
  if (activity.type === "vocabulary" && activity.new_word) {
    return `Kata baru: <b>"${activity.new_word.word}"</b> — ${activity.new_word.translation_id}\nContoh: "${activity.new_word.example_sentence}"\n\n${activity.prompt}`;
  }
  return activity.prompt;
}
