import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("SUPABASE_URL dan SUPABASE_ANON_KEY wajib diisi (lihat .env.example)");
}

// Client per-request memakai access token user, sehingga RLS tetap berlaku.
export function createUserClient(token: string) {
  return createClient(url!, anonKey!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Anonymous reader uses only the public SECURITY DEFINER projection; no service-role key.
export function createPublicClient() {
  return createClient(url!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
