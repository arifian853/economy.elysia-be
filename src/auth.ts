import { Elysia } from "elysia";
import { createUserClient } from "./supabase";

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

// Validasi access token Supabase; return user + client ber-RLS, atau null jika tidak valid.
export async function requireUser(request: Request) {
  const token = getBearerToken(request);
  if (!token) return null;

  const db = createUserClient(token);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;

  return { user: data.user, db };
}

// Pasang dengan `.use(auth)`: semua route setelahnya wajib login (401 jika tidak) dan mendapat `user` & `db`.
export const auth = new Elysia({ name: "auth" }).resolve(
  { as: "scoped" },
  async ({ request, status }) => {
    const result = await requireUser(request);
    if (!result) return status(401, { error: "Unauthorized" });
    return result;
  },
);
