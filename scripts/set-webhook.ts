/**
 * Run once after deploying: sets your Telegram bot's webhook to point
 * at your deployed /api/telegram/webhook endpoint.
 *
 * Usage:
 *   BASE_URL=https://your-app.vercel.app npm run set-webhook
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = process.env.BASE_URL;

if (!token || !secret || !baseUrl) {
  console.error("Missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, or BASE_URL env var.");
  process.exit(1);
}

const webhookUrl = `${baseUrl}/api/telegram/webhook?secret=${secret}`;

fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: webhookUrl }),
})
  .then((r) => r.json())
  .then((data) => console.log("setWebhook response:", data))
  .catch((err) => console.error("Failed to set webhook:", err));
