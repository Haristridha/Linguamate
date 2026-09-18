import { supabase, UserRow } from "@/lib/supabase";
import { sendMessage, sendTyping } from "@/lib/telegram";
import { askGroqForJSON } from "@/lib/groq";
import { generateAndSendDailyLesson } from "@/bot/lessonGenerator";

/**
 * Onboarding is driven by a simple state machine stored in conversation_log
 * meta, so the flow survives serverless cold starts (no in-memory state).
 * State values: welcome -> assess_q1 -> assess_q2 -> assess_q3 ->
 * ask_time -> ask_duration -> ask_goal -> done
 */

const ASSESSMENT_QUESTIONS = [
  {
    key: "grammar_mcq",
    text: `Pertanyaan 1 dari 3.\n\nPilih yang paling tepat:\n"She ___ to the office every day."`,
    buttons: [
      { text: "A. go", callback_data: "assess:1:go" },
      { text: "B. goes", callback_data: "assess:1:goes" },
      { text: "C. going", callback_data: "assess:1:going" },
    ],
  },
];

export async function startOnboarding(user: UserRow) {
  await sendMessage(
    user.telegram_chat_id,
    `Halo${user.first_name ? ", " + user.first_name : ""}! Aku <b>LinguaMate</b> 👋 Aku bakal bantu kamu belajar Inggris lewat sesi singkat tiap hari, disesuaikan sama levelmu.\n\nSebelum mulai, aku mau kenal levelmu dulu lewat tes singkat — sekitar 5 menit.`
  );
  await setState(user.id, "assess_q1");
  await sendMessage(user.telegram_chat_id, ASSESSMENT_QUESTIONS[0].text, {
    buttons: ASSESSMENT_QUESTIONS[0].buttons,
  });
}

async function setState(userId: string, state: string, data: Record<string, unknown> = {}) {
  await supabase.from("conversation_log").insert({
    user_id: userId,
    role: "assistant",
    content: `[state:${state}]`,
    meta: { type: "onboarding_state", state, ...data },
  });
}

export async function getOnboardingState(userId: string) {
  const { data } = await supabase
    .from("conversation_log")
    .select("meta")
    .eq("user_id", userId)
    .eq("meta->>type", "onboarding_state")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.meta as { state: string; [k: string]: unknown }) ?? null;
}

/** Handles a button press during onboarding (assessment MCQ, time/duration/goal picks). */
export async function handleOnboardingCallback(
  user: UserRow,
  state: string,
  callbackData: string
) {
  if (state === "assess_q1") {
    const answer = callbackData.split(":")[2];
    const correct = answer === "goes";
    await sendMessage(
      user.telegram_chat_id,
      correct ? "Betul! 👍" : 'Hampir — jawaban tepatnya "goes" (subjek tunggal + present tense).'
    );
    await setState(user.id, "assess_q2", { q1_correct: correct });
    await sendMessage(
      user.telegram_chat_id,
      `Pertanyaan 2 dari 3.\n\nTulis satu kalimat pendek tentang aktivitasmu kemarin (pakai past tense).`
    );
    return;
  }

  if (state === "ask_time") {
    const time = callbackData.split(":")[1]; // e.g. "07:00"
    await supabase.from("users").update({ preferred_time: time }).eq("id", user.id);
    await setState(user.id, "ask_duration");
    await sendMessage(user.telegram_chat_id, "Berapa lama waktu yang kamu punya per hari?", {
      buttons: [
        { text: "15 menit", callback_data: "duration:15" },
        { text: "20 menit", callback_data: "duration:20" },
        { text: "30 menit", callback_data: "duration:30" },
      ],
    });
    return;
  }

  if (state === "ask_duration") {
    const minutes = parseInt(callbackData.split(":")[1], 10);
    await supabase.from("users").update({ daily_duration_minutes: minutes }).eq("id", user.id);
    await setState(user.id, "ask_goal");
    await sendMessage(user.telegram_chat_id, "Terakhir — tujuan utama belajarmu apa?", {
      buttons: [
        { text: "Kerja & email", callback_data: "goal:work" },
        { text: "Ngobrol santai", callback_data: "goal:casual" },
        { text: "Wawancara kerja", callback_data: "goal:interview" },
      ],
    });
    return;
  }

  if (state === "ask_goal") {
    const goal = callbackData.split(":")[1];
    const { data: updatedUser } = await supabase
      .from("users")
      .update({ main_goal: goal, onboarding_completed: true })
      .eq("id", user.id)
      .select("*")
      .single();
    await finishOnboarding(user.telegram_chat_id);
    if (updatedUser) await generateAndSendDailyLesson(updatedUser as UserRow);
    return;
  }
}

/** Handles free-text answers during onboarding (assessment Q2 and Q3). */
export async function handleOnboardingText(user: UserRow, state: string, text: string) {
  if (state === "assess_q2") {
    const hasPast = /ed\b|went|watched|ate|saw|did|was|were|had/i.test(text);
    await sendMessage(
      user.telegram_chat_id,
      hasPast
        ? "Bagus, bentuk lampaunya kelihatan pas 👌"
        : "Dicatat ya — sepertinya past tense masih perlu dilatih."
    );
    await setState(user.id, "assess_q3", { q2_has_past: hasPast, q2_answer: text });
    await sendMessage(
      user.telegram_chat_id,
      `Terakhir, pertanyaan 3 dari 3. Baca ini lalu jawab singkat:\n\n"Rina works at a small company. She likes her job but the traffic to work is tiring."\n\nApa yang bikin Rina capek?`
    );
    return;
  }

  if (state === "assess_q3") {
    await sendTyping(user.telegram_chat_id);
    const priorState = await getOnboardingState(user.id);
    const result = await scoreAssessment({
      q1Correct: !!priorState?.q1_correct,
      q2HasPast: !!priorState?.q2_has_past,
      q3Answer: text,
    });

    await supabase.from("assessments").insert({
      user_id: user.id,
      type: "baseline",
      level_band_result: result.level_band,
      score: result,
      weak_areas: result.weak_areas,
      strengths: result.strengths,
    });
    await supabase.from("users").update({ level_band: result.level_band }).eq("id", user.id);

    await sendMessage(
      user.telegram_chat_id,
      `Selesai! Hasil sementara:\n<b>Level: ${formatLevel(result.level_band)}</b>\nKekuatan: ${result.strengths.join(", ") || "-"}\nPerlu dilatih: ${result.weak_areas.join(", ") || "-"}`
    );

    await setState(user.id, "ask_time");
    await sendMessage(user.telegram_chat_id, "Jam berapa biasanya kamu enak buat belajar?", {
      buttons: [
        { text: "Pagi (07:00)", callback_data: "time:07:00" },
        { text: "Siang (12:00)", callback_data: "time:12:00" },
        { text: "Malam (20:00)", callback_data: "time:20:00" },
      ],
    });
    return;
  }
}

async function scoreAssessment(input: { q1Correct: boolean; q2HasPast: boolean; q3Answer: string }) {
  return askGroqForJSON<{
    level_band: "beginner" | "lower_intermediate" | "intermediate" | "upper_intermediate";
    weak_areas: string[];
    strengths: string[];
  }>({
    endpoint: "assessment_scoring",
    system:
      "You are an English placement test evaluator for Indonesian learners. Classify the learner into a level band and list weak areas / strengths using short snake_case tags (e.g. simple_past, reading_comprehension, vocabulary_range).",
    prompt: `Grammar MCQ correct: ${input.q1Correct}\nPast-tense sentence used correctly: ${input.q2HasPast}\nReading comprehension answer: "${input.q3Answer}"\n\nReturn JSON: {"level_band": "...", "weak_areas": ["..."], "strengths": ["..."]}`,
  });
}

function formatLevel(level: string) {
  const map: Record<string, string> = {
    beginner: "Beginner",
    lower_intermediate: "Lower Intermediate",
    intermediate: "Intermediate",
    upper_intermediate: "Upper Intermediate",
  };
  return map[level] ?? level;
}

async function finishOnboarding(chatId: number) {
  await sendMessage(
    chatId,
    "Mantap, semua siap! Aku susun rencana belajar buat kamu. Pelajaran pertamamu akan segera menyusul 🎉"
  );
}
