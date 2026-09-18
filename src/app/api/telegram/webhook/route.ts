import { NextRequest, NextResponse } from "next/server";
import { getOrCreateUser, supabase } from "@/lib/supabase";
import { TelegramUpdate, answerCallbackQuery, sendMessage } from "@/lib/telegram";
import {
  startOnboarding,
  getOnboardingState,
  handleOnboardingCallback,
  handleOnboardingText,
} from "@/bot/handlers/onboarding";
import { generateAndSendDailyLesson } from "@/bot/lessonGenerator";
import { handleLessonResponse } from "@/bot/lessonRunner";
import { startReview, revealReviewAnswer, rateReviewItem } from "@/bot/handlers/review";
import { generateWeeklySummary } from "@/bot/handlers/progress";
import { RecallResult } from "@/lib/spacedRepetition";

/**
 * Single entry point for all Telegram updates. Kept intentionally
 * "dumb" — it identifies the user and routes to the right handler,
 * business logic lives in src/bot/*.
 *
 * Configure this URL as the Telegram webhook:
 *   https://<your-domain>/api/telegram/webhook?secret=<TELEGRAM_WEBHOOK_SECRET>
 */
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update = (await req.json()) as TelegramUpdate;

  try {
    if (update.callback_query) {
      await handleCallback(update);
    } else if (update.message?.text) {
      await handleTextMessage(update);
    } else if (update.message?.voice) {
      await sendMessage(
        update.message.chat.id,
        "Voice belum didukung di versi ini — coba ketik jawabannya dulu ya 🙏"
      );
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message.chat.id;
    if (chatId) {
      await sendMessage(chatId, "Waduh, ada gangguan sesaat di sistemku. Coba lagi sebentar lagi ya 🙏");
    }
  }

  // Always 200 quickly so Telegram doesn't retry-storm us.
  return NextResponse.json({ ok: true });
}

async function handleTextMessage(update: TelegramUpdate) {
  const msg = update.message!;
  const chatId = msg.chat.id;
  const text = msg.text!.trim();

  const user = await getOrCreateUser(chatId, msg.from.username, msg.from.first_name);

  // Slash commands
  if (text === "/start") {
    if (user.onboarding_completed) {
      await sendMessage(chatId, `Halo lagi, ${user.first_name ?? "teman"}! Ketik /pelajaran untuk sesi hari ini, atau /review untuk latihan kosakata.`);
    } else {
      await startOnboarding(user);
    }
    return;
  }
  if (text === "/pelajaran") {
    await generateAndSendDailyLesson(user);
    return;
  }
  if (text === "/review") {
    await startReview(user);
    return;
  }
  if (text === "/progress") {
    await generateWeeklySummary(user);
    return;
  }
  if (text === "/jeda") {
    await supabase.from("users").update({ reminders_paused: true }).eq("id", user.id);
    await sendMessage(chatId, "Oke, pengingat harian aku jeda dulu. Ketik /lanjutkan kapan saja untuk mengaktifkan lagi.");
    return;
  }
  if (text === "/lanjutkan") {
    await supabase.from("users").update({ reminders_paused: false }).eq("id", user.id);
    await sendMessage(chatId, "Pengingat harian aktif lagi 👍");
    return;
  }

  // Not a command — figure out conversational context.
  if (!user.onboarding_completed) {
    const state = await getOnboardingState(user.id);
    if (state) await handleOnboardingText(user, state.state, text);
    return;
  }

  const handledByLesson = await handleLessonResponse(user, text);
  if (handledByLesson) return;

  // Fallback: no active lesson/onboarding step expecting text.
  await sendMessage(
    chatId,
    "Ketik /pelajaran untuk mulai sesi hari ini, atau /review untuk latihan kosakata 😊"
  );
}

async function handleCallback(update: TelegramUpdate) {
  const cb = update.callback_query!;
  const chatId = cb.message.chat.id;
  await answerCallbackQuery(cb.id);

  const user = await getOrCreateUser(chatId, cb.from.username, cb.from.first_name);
  const data = cb.data;

  if (data.startsWith("review:reveal:")) {
    await revealReviewAnswer(user, data.split(":")[2]);
    return;
  }
  if (data.startsWith("review:rate:")) {
    const [, , vocabId, result] = data.split(":");
    await rateReviewItem(user, vocabId, result as RecallResult);
    return;
  }

  if (!user.onboarding_completed) {
    const state = await getOnboardingState(user.id);
    if (state) await handleOnboardingCallback(user, state.state, data);
    return;
  }
}
