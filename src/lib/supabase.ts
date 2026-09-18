import { createClient } from "@supabase/supabase-js";

// Server-only client. Uses the service role key, so this file must
// NEVER be imported into client-side ("use client") components.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing Supabase env vars. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
  );
}

export const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

export type UserRow = {
  id: string;
  telegram_chat_id: number;
  telegram_username: string | null;
  first_name: string | null;
  level_band: "beginner" | "lower_intermediate" | "intermediate" | "upper_intermediate" | null;
  main_goal: string | null;
  preferred_time: string | null;
  timezone: string;
  daily_duration_minutes: number;
  onboarding_completed: boolean;
  reminders_paused: boolean;
  streak_current: number;
  streak_longest: number;
  last_active_date: string | null;
};

export async function getOrCreateUser(chatId: number, username?: string, firstName?: string) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();

  if (existing) return existing as UserRow;

  const { data: created, error } = await supabase
    .from("users")
    .insert({
      telegram_chat_id: chatId,
      telegram_username: username ?? null,
      first_name: firstName ?? null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return created as UserRow;
}
