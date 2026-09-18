/**
 * SM-2 style spaced repetition, simplified for a 4-point recall scale
 * matched to how a learner naturally reports a word: 'again' (forgot),
 * 'hard' (recalled with effort), 'good' (recalled fine), 'easy' (trivial).
 */

export type RecallResult = "again" | "hard" | "good" | "easy";

export type VocabSchedule = {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
};

const QUALITY_MAP: Record<RecallResult, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

export function nextSchedule(current: VocabSchedule, result: RecallResult): VocabSchedule {
  const q = QUALITY_MAP[result];
  let { ease_factor, interval_days, repetitions } = current;

  if (q < 3) {
    // Forgotten: reset repetitions, bring it back tomorrow.
    return { ease_factor: Math.max(1.3, ease_factor - 0.2), interval_days: 1, repetitions: 0 };
  }

  repetitions += 1;
  ease_factor = Math.max(
    1.3,
    ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  );

  if (repetitions === 1) interval_days = 1;
  else if (repetitions === 2) interval_days = 3;
  else interval_days = Math.round(interval_days * ease_factor);

  return { ease_factor, interval_days, repetitions };
}

export function statusFromSchedule(schedule: VocabSchedule): "new" | "learning" | "review" | "mastered" {
  if (schedule.repetitions === 0) return "learning";
  if (schedule.interval_days >= 21) return "mastered";
  return "review";
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
