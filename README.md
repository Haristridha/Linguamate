# LinguaMate

Bot tutor bahasa Inggris berbasis AI untuk pengguna Indonesia, via Telegram.
Dibangun dengan Next.js (App Router) + TypeScript, Supabase (Postgres), dan Claude API.

## Fitur MVP yang sudah diimplementasikan

- Onboarding percakapan + placement test singkat (3 pertanyaan)
- Penjadwalan preferensi (jam belajar, durasi, tujuan)
- Generator pelajaran harian personal (Claude), berbasis level + kesalahan berulang + kosakata yang jatuh tempo
- Koreksi grammar per-jawaban dengan pencatatan pola kesalahan
- Kosakata dengan spaced repetition (algoritma gaya SM-2)
- Streak harian
- Ringkasan progres mingguan otomatis (tiap Minggu) + on-demand (`/progress`)
- Reminder terjadwal via cron endpoint

Belum termasuk (sesuai PRD, masuk fase lanjutan): WhatsApp, voice, dashboard web, gamifikasi.

## 1. Setup Supabase

1. Buat project baru di [supabase.com](https://supabase.com).
2. Buka SQL Editor, jalankan seluruh isi `supabase/schema.sql`.
3. Catat `Project URL` dan `service_role key` (Settings → API) — **jangan** pakai `anon key`, karena bot berjalan sepenuhnya di server.

## 2. Setup Telegram Bot

1. Chat [@BotFather](https://t.me/BotFather) di Telegram, `/newbot`, ikuti instruksinya.
2. Simpan token yang diberikan sebagai `TELEGRAM_BOT_TOKEN`.
3. Buat string acak sendiri untuk `TELEGRAM_WEBHOOK_SECRET` (contoh: `openssl rand -hex 16`).

## 3. Setup Groq API

1. Buat API key di [console.groq.com](https://console.groq.com).
2. Isi sebagai `GROQ_API_KEY`.
3. Atur `GROQ_MODELS` — daftar model dipisah koma, dicoba berurutan. Kalau
   model pertama kena rate limit (429), request otomatis pindah ke model
   berikutnya dalam daftar. Default: `openai/gpt-oss-120b,openai/gpt-oss-20b`.

## 4. Konfigurasi environment

```bash
cp .env.example .env.local
# isi semua nilai di .env.local
```

## 5. Install & jalankan lokal

```bash
npm install
npm run dev
```

Untuk testing webhook secara lokal, gunakan tunnel (ngrok/cloudflared) karena Telegram butuh URL HTTPS publik.

## 6. Deploy

Paling mudah: deploy ke [Vercel](https://vercel.com).

1. Push project ini ke GitHub, import ke Vercel.
2. Isi semua environment variable dari `.env.example` di dashboard Vercel.
3. Deploy.

## 7. Daftarkan webhook ke Telegram

Setelah deploy:

```bash
BASE_URL=https://nama-app-kamu.vercel.app npm run set-webhook
```

Ini memberi tahu Telegram untuk mengirim semua pesan ke
`https://nama-app-kamu.vercel.app/api/telegram/webhook?secret=...`

## 8. Aktifkan cron reminder

Bot butuh sesuatu yang memanggil endpoint berikut tiap 15 menit:

```
GET https://nama-app-kamu.vercel.app/api/cron/daily-reminders?secret=<CRON_SECRET>
```

Opsi termudah di Vercel: tambahkan file `vercel.json` di root:

```json
{
  "crons": [
    { "path": "/api/cron/daily-reminders?secret=YOUR_CRON_SECRET", "schedule": "*/15 * * * *" }
  ]
}
```

(Vercel Cron ada di paket Pro; alternatif gratis: [cron-job.org](https://cron-job.org) memanggil URL yang sama.)

## Struktur proyek

```
src/
  app/
    api/telegram/webhook/route.ts   # entry point semua update Telegram
    api/cron/daily-reminders/route.ts
  bot/
    handlers/
      onboarding.ts    # placement test + preferensi
      review.ts        # spaced repetition kosakata
      progress.ts       # ringkasan mingguan
    lessonGenerator.ts # bikin rencana pelajaran harian via Claude
    lessonRunner.ts     # proses jawaban per-aktivitas
  lib/
    supabase.ts
    telegram.ts
    groq.ts             # panggilan AI + fallback antar model
    spacedRepetition.ts
supabase/schema.sql     # seluruh skema database
```

## Perintah bot (untuk pengguna)

- `/start` — mulai / lihat menu utama
- `/pelajaran` — mulai atau lanjutkan pelajaran hari ini
- `/review` — latihan kosakata (spaced repetition)
- `/progress` — lihat ringkasan progres
- `/jeda` — jeda pengingat harian
- `/lanjutkan` — aktifkan lagi pengingat harian

## Catatan biaya & monitoring

Setiap panggilan Groq API dicatat ke tabel `ai_usage_log` (token in/out per model,
termasuk model mana yang akhirnya dipakai jika terjadi fallback). Kalau kamu
naik ke paket berbayar Groq dengan harga per-token, tambahkan perhitungan biaya
di `src/lib/groq.ts` (fungsi `logUsage`).

## Fallback antar model

`src/lib/groq.ts` mencoba model dalam urutan `GROQ_MODELS` satu per satu.
Kalau model yang sedang dicoba merespons dengan error rate limit (HTTP 429),
sistem otomatis lanjut ke model berikutnya di daftar untuk request yang sama —
pengguna tidak akan melihat kegagalan itu. Error lain (bukan rate limit)
tetap dilempar apa adanya supaya tidak menyembunyikan bug.

## Yang perlu disesuaikan sebelum produksi

- Rate limiting / anti-spam sederhana pada webhook
- Validasi lebih ketat terhadap input pengguna sebelum dikirim ke Claude
- Retry/backoff untuk panggilan Claude API yang gagal
- Trimming `conversation_log` secara berkala (tabel ini bisa tumbuh cepat)
- Dukungan voice message (transkripsi) — belum diimplementasikan
