-- LinguaMate schema (MVP)
-- Run this in the Supabase SQL editor, or via `supabase db push`.

create extension if not exists "uuid-ossp";

-- =========================================================
-- USERS
-- =========================================================
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  telegram_chat_id bigint unique not null,
  telegram_username text,
  first_name text,
  level_band text check (level_band in ('beginner','lower_intermediate','intermediate','upper_intermediate')),
  main_goal text,                    -- e.g. 'work', 'casual', 'interview'
  preferred_time text,               -- 'HH:MM' local time
  timezone text default 'Asia/Jakarta',
  daily_duration_minutes int default 15,
  onboarding_completed boolean default false,
  reminders_paused boolean default false,
  streak_current int default 0,
  streak_longest int default 0,
  last_active_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- =========================================================
-- ASSESSMENTS (baseline + periodic reassessments)
-- =========================================================
create table if not exists assessments (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  type text check (type in ('baseline','periodic')) default 'baseline',
  level_band_result text,
  score jsonb,                       -- raw per-section scores
  weak_areas text[],                 -- e.g. ['simple_past','irregular_verbs']
  strengths text[],
  created_at timestamptz default now()
);

-- =========================================================
-- VOCABULARY ITEMS (per-user, spaced repetition)
-- =========================================================
create table if not exists vocabulary_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  word text not null,
  translation_id text,               -- Indonesian translation
  definition_en text,
  example_sentence text,
  collocations text[],
  status text check (status in ('new','learning','review','mastered')) default 'new',
  ease_factor numeric default 2.5,   -- SM-2 style
  interval_days int default 0,
  repetitions int default 0,
  next_review_at date default current_date,
  last_result text check (last_result in ('again','hard','good','easy')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_vocab_due on vocabulary_items(user_id, next_review_at);

-- =========================================================
-- MISTAKES (grammar / usage errors, recurring pattern tracking)
-- =========================================================
create table if not exists mistakes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  mistake_type text not null,        -- e.g. 'simple_past', 'article_usage'
  example_wrong text,
  example_corrected text,
  occurrences int default 1,
  last_seen_at timestamptz default now(),
  resolved boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_mistakes_user_type on mistakes(user_id, mistake_type);

-- =========================================================
-- LESSONS (daily generated plan + delivery record)
-- =========================================================
create table if not exists lessons (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  lesson_date date not null default current_date,
  focus_reason text,                 -- shown to user: why this lesson today
  plan jsonb not null,                -- structured plan: activities[], objective, est_minutes
  status text check (status in ('pending','sent','in_progress','completed','skipped')) default 'pending',
  activities_completed int default 0,
  activities_total int default 0,
  created_at timestamptz default now(),
  completed_at timestamptz
);
create unique index if not exists idx_lessons_user_date on lessons(user_id, lesson_date);

-- =========================================================
-- CONVERSATION LOG (for AI context + analytics, trimmed periodically)
-- =========================================================
create table if not exists conversation_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  role text check (role in ('user','assistant')) not null,
  content text not null,
  meta jsonb,                        -- e.g. {activity_type, lesson_id}
  created_at timestamptz default now()
);
create index if not exists idx_convlog_user_time on conversation_log(user_id, created_at desc);

-- =========================================================
-- PROGRESS SNAPSHOTS (weekly summaries)
-- =========================================================
create table if not exists progress_snapshots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  streak_days int,
  lessons_completed int,
  vocab_introduced int,
  vocab_retention_pct numeric,
  grammar_accuracy_pct numeric,
  conversation_sessions int,
  top_weak_areas text[],
  next_focus text,
  created_at timestamptz default now()
);

-- =========================================================
-- AI USAGE LOG (cost monitoring)
-- =========================================================
create table if not exists ai_usage_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users(id) on delete set null,
  endpoint text,                     -- e.g. 'lesson_generation','correction'
  input_tokens int,
  output_tokens int,
  estimated_cost_usd numeric,
  created_at timestamptz default now()
);

-- updated_at trigger helper
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated on users;
create trigger trg_users_updated before update on users
  for each row execute function set_updated_at();

drop trigger if exists trg_vocab_updated on vocabulary_items;
create trigger trg_vocab_updated before update on vocabulary_items
  for each row execute function set_updated_at();
