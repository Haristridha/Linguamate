import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { sendMessage } from "@/lib/telegram";
import { generateAndSendDailyLesson } from "@/bot/lessonGenerator";
import { generateWeeklySummary } from "@/bot/handlers/progress";

/**
 * Meant to be hit every 15-30 minutes by an external scheduler
 * (Vercel Cron, GitHub Actions, cron-job.org, etc), e.g.:
 *   GET https://<domain>/api/cron/daily-reminders?secret=<CRON_SECRET>
 *
 * It finds users whose preferred_time falls in the current window
 * (in their own timezone) and sends that day's reminder + lesson.
 * On Sundays it also sends the weekly summary.
 */
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: users, error } = await supabase
    .from("users")
    .select("*")
    .eq("onboarding_completed", true)
    .eq("reminders_paused", false);

  if (error) {
    console.error(error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  let remindersSent = 0;
  let summariesSent = 0;

  for (const user of users ?? []) {
    const localNow = nowInTimezone(user.timezone ?? "Asia/Jakarta");
    const currentHHMM = `${pad(localNow.getHours())}:${pad(localNow.getMinutes())}`;

    if (isWithinWindow(currentHHMM, user.preferred_time)) {
      const today = localNow.toISOString().slice(0, 10);
      const { data: alreadySent } = await supabase
        .from("lessons")
        .select("id")
        .eq("user_id", user.id)
        .eq("lesson_date", today)
        .maybeSingle();

      if (!alreadySent) {
        await sendMessage(
          user.telegram_chat_id,
          `⏰ Waktunya belajar! Sesi hari ini sekitar ${user.daily_duration_minutes} menit.`
        );
        await generateAndSendDailyLesson(user);
        remindersSent++;
      }

      if (localNow.getDay() === 0) {
        // Sunday: also send the weekly summary.
        await generateWeeklySummary(user);
        summariesSent++;
      }
    }
  }

  return NextResponse.json({ ok: true, remindersSent, summariesSent });
}

function nowInTimezone(timezone: string): Date {
  const str = new Date().toLocaleString("en-US", { timeZone: timezone });
  return new Date(str);
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

/** True if currentHHMM is within 15 minutes after the user's preferred time. */
function isWithinWindow(currentHHMM: string, preferredTime: string | null): boolean {
  if (!preferredTime) return false;
  const [ch, cm] = currentHHMM.split(":").map(Number);
  const [ph, pm] = preferredTime.split(":").map(Number);
  const currentMinutes = ch * 60 + cm;
  const preferredMinutes = ph * 60 + pm;
  const diff = currentMinutes - preferredMinutes;
  return diff >= 0 && diff < 15;
}
