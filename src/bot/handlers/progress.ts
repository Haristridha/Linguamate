import { supabase, UserRow } from "@/lib/supabase";
import { sendMessage } from "@/lib/telegram";

/**
 * Computes and sends a weekly summary. Called by the cron endpoint
 * (see app/api/cron/daily-reminders) on the user's designated
 * "summary day", or on demand via /progress.
 */
export async function generateWeeklySummary(user: UserRow) {
  const periodEnd = new Date();
  const periodStart = new Date(Date.now() - 6 * 86400000);
  const periodStartStr = periodStart.toISOString().slice(0, 10);
  const periodEndStr = periodEnd.toISOString().slice(0, 10);

  const { data: lessons } = await supabase
    .from("lessons")
    .select("status")
    .eq("user_id", user.id)
    .gte("lesson_date", periodStartStr)
    .lte("lesson_date", periodEndStr);

  const lessonsCompleted = (lessons ?? []).filter((l) => l.status === "completed").length;

  const { data: vocabIntroduced } = await supabase
    .from("vocabulary_items")
    .select("status")
    .eq("user_id", user.id)
    .gte("created_at", periodStart.toISOString());

  const total = vocabIntroduced?.length ?? 0;
  const retained = (vocabIntroduced ?? []).filter((v) => v.status !== "new").length;
  const retentionPct = total > 0 ? Math.round((retained / total) * 100) : 0;

  const { data: mistakes } = await supabase
    .from("mistakes")
    .select("mistake_type, occurrences")
    .eq("user_id", user.id)
    .eq("resolved", false)
    .order("occurrences", { ascending: false })
    .limit(3);

  const topWeakAreas = (mistakes ?? []).map((m) => m.mistake_type);

  await supabase.from("progress_snapshots").insert({
    user_id: user.id,
    period_start: periodStartStr,
    period_end: periodEndStr,
    streak_days: user.streak_current,
    lessons_completed: lessonsCompleted,
    vocab_introduced: total,
    vocab_retention_pct: retentionPct,
    grammar_accuracy_pct: null, // could be derived from conversation_log meta in a fuller version
    conversation_sessions: null,
    top_weak_areas: topWeakAreas,
    next_focus: topWeakAreas[0] ?? null,
  });

  await sendMessage(
    user.telegram_chat_id,
    `📊 <b>Ringkasan Minggu Ini</b>\n\n` +
      `Streak: ${user.streak_current} hari\n` +
      `Pelajaran selesai: ${lessonsCompleted}/7\n` +
      `Kosakata baru: ${total}, retensi ${retentionPct}%\n\n` +
      (topWeakAreas.length
        ? `<b>Masih sering salah:</b> ${topWeakAreas.join(", ")}\n\n`
        : "") +
      `<b>Fokus minggu depan:</b> ${topWeakAreas[0] ?? "menjaga konsistensi"}`
  );
}
