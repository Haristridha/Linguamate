import { supabase, UserRow } from "@/lib/supabase";
import { askGroqForJSON } from "@/lib/groq";
import { sendMessage } from "@/lib/telegram";

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

/**
 * Builds today's lesson: pulls recent mistakes + due vocabulary as context,
 * asks Claude for a short structured plan, stores it, and sends the first
 * activity to the user. Subsequent activities are delivered as the user
 * responds (see lessonRunner.ts).
 */
export async function generateAndSendDailyLesson(user: UserRow) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: existing } = await supabase
    .from("lessons")
    .select("*")
    .eq("user_id", user.id)
    .eq("lesson_date", today)
    .maybeSingle();

  if (existing) {
    await sendLessonIntro(user, existing.focus_reason, existing.plan as LessonPlan);
    return existing;
  }

  const { data: recentMistakes } = await supabase
    .from("mistakes")
    .select("mistake_type, occurrences")
    .eq("user_id", user.id)
    .eq("resolved", false)
    .order("occurrences", { ascending: false })
    .limit(3);

  const { data: dueVocab } = await supabase
    .from("vocabulary_items")
    .select("word")
    .eq("user_id", user.id)
    .lte("next_review_at", today)
    .limit(5);

  const wordCount = wordsPerDay(user.daily_duration_minutes);

  const plan = await askGroqForJSON<LessonPlan>({
    userId: user.id,
    endpoint: "lesson_generation",
    system: `You are LinguaMate, a friendly English tutor for Indonesian learners. Write lesson content mixing English (target language) with Indonesian explanations, matching a casual "ngobrol santai" tone. Keep everything short — this is delivered as chat messages, not a document. Lessons must be 1-3 small activities only, never a long lecture.`,
    prompt: `Learner level: ${user.level_band}\nMain goal: ${user.main_goal}\nDaily time available: ${user.daily_duration_minutes} minutes\nRecurring mistakes to address: ${JSON.stringify(recentMistakes ?? [])}\nVocabulary due for review today: ${JSON.stringify(dueVocab ?? [])}\nNew words to introduce today: ${wordCount}\n\nReturn JSON matching this shape:\n{\n  "objective": "short learning objective",\n  "focus_reason": "one short sentence explaining to the learner, in Indonesian, why today's lesson focuses on this",\n  "est_minutes": number,\n  "activities": [\n    {"type":"vocabulary","prompt":"...","new_word":{"word":"...","translation_id":"...","definition_en":"...","example_sentence":"..."}},\n    {"type":"grammar","prompt":"...","target_answer":"..."},\n    {"type":"conversation","prompt":"..."}\n  ]\n}`,
    maxTokens: 1500,
  });

  const { data: lesson, error } = await supabase
    .from("lessons")
    .insert({
      user_id: user.id,
      lesson_date: today,
      focus_reason: plan.focus_reason,
      plan,
      activities_total: plan.activities.length,
      status: "sent",
    })
    .select("*")
    .single();

  if (error) throw error;

  // Insert any brand-new vocabulary items introduced in this lesson.
  for (const activity of plan.activities) {
    if (activity.type === "vocabulary" && activity.new_word) {
      await supabase.from("vocabulary_items").insert({
        user_id: user.id,
        word: activity.new_word.word,
        translation_id: activity.new_word.translation_id,
        definition_en: activity.new_word.definition_en,
        example_sentence: activity.new_word.example_sentence,
      });
    }
  }

  await sendLessonIntro(user, plan.focus_reason, plan);
  return lesson;
}

async function sendLessonIntro(user: UserRow, focusReason: string, plan: LessonPlan) {
  await sendMessage(
    user.telegram_chat_id,
    `📚 <b>Pelajaran Hari Ini</b>\n${focusReason}\n\nEstimasi: ${plan.est_minutes} menit`
  );
  const first = plan.activities[0];
  if (first) {
    await sendMessage(user.telegram_chat_id, formatActivityPrompt(first));
  }
}

function formatActivityPrompt(activity: LessonPlan["activities"][number]) {
  if (activity.type === "vocabulary" && activity.new_word) {
    return `Kata baru: <b>"${activity.new_word.word}"</b> — ${activity.new_word.translation_id}\nContoh: "${activity.new_word.example_sentence}"\n\n${activity.prompt}`;
  }
  return activity.prompt;
}

function wordsPerDay(minutes: number): number {
  if (minutes <= 15) return 5;
  if (minutes <= 20) return 7;
  return 10;
}
