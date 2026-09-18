import { z } from "zod";

export const NewWordSchema = z.object({
    word: z.string().min(1),
    translation_id: z.string().min(1),
    definition_en: z.string().min(1),
    example_sentence: z.string().min(1),
});

export const ActivitySchema = z
    .object({
        type: z.enum(["vocabulary", "grammar", "reading", "conversation"]),
        prompt: z.string().min(1),
        target_answer: z.string().optional(),
        new_word: NewWordSchema.optional(),
    })
    .refine((a) => a.type !== "vocabulary" || !!a.new_word, {
        message: "vocabulary activities must include a fully-filled new_word object",
    });

export const LessonPlanSchema = z.object({
    objective: z.string().min(1),
    focus_reason: z.string().min(1),
    est_minutes: z.number().positive(),
    activities: z.array(ActivitySchema).min(1).max(3),
});

export type LessonPlan = z.infer<typeof LessonPlanSchema>;
export type LessonActivity = LessonPlan["activities"][number];

/**
 * Renders one activity as a chat message. Because the plan has already
 * passed LessonPlanSchema validation by the time it gets here, a
 * "vocabulary" activity is guaranteed to have a complete new_word — no
 * need to guard against undefined fields at this point.
 */
export function formatActivityPrompt(activity: LessonActivity): string {
    if (activity.type === "vocabulary" && activity.new_word) {
        return `Kata baru: <b>"${activity.new_word.word}"</b> — ${activity.new_word.translation_id}\nContoh: "${activity.new_word.example_sentence}"\n\n${activity.prompt}`;
    }
    return activity.prompt;
}
