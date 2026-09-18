import { supabase, UserRow } from "@/lib/supabase";
import { sendMessage } from "@/lib/telegram";
import { nextSchedule, statusFromSchedule, addDays, RecallResult } from "@/lib/spacedRepetition";

/** Starts a review session: sends the first due word as a recall prompt. */
export async function startReview(user: UserRow) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: due } = await supabase
    .from("vocabulary_items")
    .select("*")
    .eq("user_id", user.id)
    .lte("next_review_at", today)
    .order("next_review_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!due) {
    await sendMessage(user.telegram_chat_id, "Tidak ada kosakata yang perlu direview sekarang. Mantap! 👏");
    return;
  }

  await sendMessage(
    user.telegram_chat_id,
    `🔁 Review kosakata\n\nApa arti kata ini?\n<b>"${due.word}"</b>`,
    {
      buttons: [{ text: "Lihat jawaban", callback_data: `review:reveal:${due.id}` }],
    }
  );
}

/** Reveals the answer and asks the user to self-rate recall difficulty. */
export async function revealReviewAnswer(user: UserRow, vocabId: string) {
  const { data: item } = await supabase.from("vocabulary_items").select("*").eq("id", vocabId).single();
  if (!item) return;

  await sendMessage(
    user.telegram_chat_id,
    `<b>${item.word}</b> — ${item.translation_id}\n<i>${item.example_sentence}</i>\n\nSeberapa gampang kamu inget tadi?`,
    {
      buttons: [
        { text: "😵 Lupa", callback_data: `review:rate:${vocabId}:again` },
        { text: "😅 Susah", callback_data: `review:rate:${vocabId}:hard` },
        { text: "🙂 Oke", callback_data: `review:rate:${vocabId}:good` },
        { text: "😎 Gampang", callback_data: `review:rate:${vocabId}:easy` },
      ],
      buttonsPerRow: 2,
    }
  );
}

/** Applies the self-rating to the SM-2 schedule and offers the next due word. */
export async function rateReviewItem(user: UserRow, vocabId: string, result: RecallResult) {
  const { data: item } = await supabase.from("vocabulary_items").select("*").eq("id", vocabId).single();
  if (!item) return;

  const schedule = nextSchedule(
    { ease_factor: item.ease_factor, interval_days: item.interval_days, repetitions: item.repetitions },
    result
  );
  const nextReviewAt = addDays(new Date(), schedule.interval_days).toISOString().slice(0, 10);

  await supabase
    .from("vocabulary_items")
    .update({
      ease_factor: schedule.ease_factor,
      interval_days: schedule.interval_days,
      repetitions: schedule.repetitions,
      next_review_at: nextReviewAt,
      last_result: result,
      status: statusFromSchedule(schedule),
    })
    .eq("id", vocabId);

  await sendMessage(user.telegram_chat_id, `Oke, ketemu lagi dalam ${schedule.interval_days} hari.`);
  await startReview(user); // continue to next due word, or tell them they're done
}
