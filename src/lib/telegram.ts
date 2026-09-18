const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

type InlineKeyboardButton = { text: string; callback_data: string };

/**
 * Sends a plain text message, optionally with quick-reply buttons
 * (rendered as an inline keyboard, one button per row for readability
 * on mobile, or in rows of 2 for short labels).
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options?: { buttons?: InlineKeyboardButton[]; buttonsPerRow?: number }
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (options?.buttons?.length) {
    const perRow = options.buttonsPerRow ?? 1;
    const rows: InlineKeyboardButton[][] = [];
    for (let i = 0; i < options.buttons.length; i += perRow) {
      rows.push(options.buttons.slice(i, i + perRow));
    }
    body.reply_markup = { inline_keyboard: rows };
  }

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Telegram sendMessage failed:", errText);
  }
  return res.json();
}

/** Acknowledges a button press so Telegram stops showing the loading spinner. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function sendTyping(chatId: number) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// ---- Incoming update shapes (subset of Telegram's schema, only what we use) ----
export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; username?: string; first_name?: string };
    chat: { id: number };
    text?: string;
    voice?: { file_id: string; duration: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message: { chat: { id: number } };
    data: string;
  };
};
