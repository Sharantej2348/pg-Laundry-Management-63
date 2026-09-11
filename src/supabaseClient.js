import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fails loudly and early instead of a confusing blank screen — the two
  // most common setup mistakes are a missing .env file locally, or
  // forgetting to add these as environment variables in the Vercel/Netlify
  // project settings before deploying.
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set them in a .env file locally, " +
      "or in your hosting provider's environment variable settings."
  );
}

export const supabase = createClient(url, anonKey);
