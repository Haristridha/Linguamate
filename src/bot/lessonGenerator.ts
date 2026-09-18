import { supabase, UserRow } from "@/lib/supabase";
import { askGroqForValidatedJSON } from "@/lib/groq";
import { sendMessage } from "@/lib/telegram";
import { LessonPlan, LessonPlanSchema, formatActivityPrompt } from "@/lib/lessonPlan";

/**
 * Builds today's lesson: pulls recent mistakes + due vocabulary as context,
 * asks the model for a short structured plan (validated against
 * LessonPlanSchema, with an automatic retry if the shape is off), stores
 * it, and sends the first activity to the user. Subsequent activities are
 * delivered as the user responds (see lessonRunner.ts).
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

  const plan = await askGroqForValidatedJSON<LessonPlan>({
    userId: user.id,
    endpoint: "lesson_generation",
    schema: LessonPlanSchema,
    system: `You are LinguaMate, a friendly English tutor for Indonesian learners. Write lesson content mixing English (target language) with Indonesian explanations, matching a casual "ngobrol santai" tone. Keep everything short — this is delivered as chat messages, not a document.`,
    prompt: `Learner level: ${user.level_band}
Main goal: ${user.main_goal}
Daily time available: ${user.daily_duration_minutes} minutes
Recurring mistakes to address: ${JSON.stringify(recentMistakes ?? [])}
Vocabulary already due for spaced-repetition review today (do NOT re-teach these here, they are reviewed separately via /review): ${JSON.stringify(dueVocab ?? [])}

Build a lesson plan with 1 to 3 short activities total (never more than 3 — this is a chat message flow, not a document). At most ONE activity may be type "vocabulary", and if you include one, it introduces exactly ONE new word (not a list). Every field in new_word must be filled with a real, specific, non-empty value — never "undefined" or a placeholder.

Return JSON matching this exact shape:
{
  "objective": "short learning objective",
  "focus_reason": "one short sentence in Indonesian explaining why today's lesson focuses on this",
  "est_minutes": 15,
  "activities": [
    {"type":"vocabulary","prompt":"instruction asking the learner to use the word in a sentence","new_word":{"word":"deadline","translation_id":"tenggat waktu","definition_en":"the time or day by which something must be done","example_sentence":"The deadline is next Friday."}},
    {"type":"grammar","prompt":"a short grammar exercise as a question","target_answer":"the expected correct answer"},
    {"type":"conversation","prompt":"an open-ended conversational question"}
  ]
}`,
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

  // Insert any brand-new vocabulary item introduced in this lesson.
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
