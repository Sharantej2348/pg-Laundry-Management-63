# PG Laundry Status — real-time, multi-device version

This is a standalone web app (not a Claude Artifact). It syncs live across
every device via Supabase Realtime — when one resident starts, cancels,
extends, or finishes a wash, everyone else sees it within a second or two,
no refresh needed.

## What changed from the Artifact prototype

- **Backend:** Supabase Postgres replaces Claude's Artifact storage.
- **Sync:** A WebSocket subscription (Postgres Realtime) replaces polling —
  changes push out instantly instead of waiting up to 4 seconds.
- **Claiming a machine is now truly atomic.** A Postgres function
  (`claim_machine` in `supabase/schema.sql`) does the "is it still
  available?" check and the write as one indivisible database operation.
  Two people tapping "Use machine" at the same instant cannot both win.
- **Alert preferences** (which machine *your* device wants to be alarmed
  about) now live in your browser's localStorage — this is a normal
  website, so that's no longer restricted the way it was inside Claude.
- **Dev/testing panel removed.** That was for testing inside Claude;
  "Report a problem" / "Mark as working again" already cover the real
  operational needs (a machine physically breaking).

## 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → Sign up (no card required) → **New project**.
2. Pick any name/region and a database password (save it somewhere — you
   likely won't need it day-to-day, but keep it).
3. Wait ~2 minutes for the project to finish provisioning.

## 2. Set up the database

1. In your new project, open **SQL Editor** in the left sidebar → **New query**.
2. Copy the entire contents of `supabase/schema.sql` from this project, paste it in, and click **Run**.
3. This creates the `machines` table, seeds the three machines as
   "available", turns on Realtime for the table, and creates the
   `claim_machine` function that makes claiming atomic.

## 3. Get your API keys

1. In Supabase, go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key (not the `service_role` key — that one must never go in frontend code).

## 4. Configure the app

1. In this project folder, copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Fill in the two values from step 3.

## 5. Try it locally (optional but recommended)

```
npm install
npm run dev
```
Open the printed `localhost` URL, then open it again in a second browser
tab (or your phone, pointed at your computer's local IP) — start a wash in
one tab and confirm the other tab updates within a second or two.

## 6. Deploy

**Option A — Vercel**
1. Push this folder to a GitHub repo.
2. On [vercel.com](https://vercel.com), **New Project** → import that repo.
3. In the project's **Environment Variables** settings, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the same values as your `.env`.
4. Deploy. Vercel gives you a public URL — that's what you share with residents.

**Option B — Netlify**
1. Same idea: push to GitHub, **Add new site → Import an existing project**, connect the repo.
2. Build command: `npm run build`. Publish directory: `dist`.
3. Add the same two environment variables under **Site settings → Environment variables**.
4. Deploy.

Either way, once deployed, put the resulting link somewhere everyone will
see it — a WhatsApp group pin, a QR code taped near the machines, etc.

## 7. Keeping it running

- Supabase's free tier pauses a project after a week of *zero* activity —
  not a concern once residents are actually using it daily, but worth
  knowing if you set this up early and don't launch it right away (just
  open the Supabase dashboard once to un-pause if that happens).
- Free tier includes 200 concurrent realtime connections. That's not 400
  residents connected every second, but 300–400 people who each check in
  briefly throughout the day will comfortably fit. If you later see
  connection-limit warnings in the Supabase dashboard, Pro is $25/month
  for 500 concurrent connections.

## Project structure

```
├── supabase/schema.sql   # run this once in Supabase's SQL Editor
├── src/
│   ├── App.jsx            # all app logic + UI
│   ├── supabaseClient.js  # reads your .env keys
│   ├── main.jsx           # React entry point
│   └── styles.css
├── index.html
├── package.json
└── .env.example
```
