import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEventRoutes } from "./routes/events";
import { createTransactionRoutes } from "./routes/transactions";
import { createEvidenceRoutes } from "./routes/evidence";
import { fxService, type FxService } from "./fx";

function secureTokenMatch(header: string | null, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createEconomyAssistantApi({
  token,
  ownerId,
  db,
  fx = fxService,
}: {
  token: string;
  ownerId: string;
  db: SupabaseClient;
  fx?: FxService;
}) {
  const ownerAuth = new Elysia({ name: "economy-assistant-owner-auth" }).resolve(
    { as: "scoped" },
    () => ({ user: { id: ownerId }, db }),
  );

  return new Elysia({ name: "economy-assistant-api" })
    .onBeforeHandle(({ request, set }) => {
      if (secureTokenMatch(request.headers.get("authorization"), token)) return;
      set.status = 401;
      return { error: "Unauthorized" };
    })
    .get("/health", () => ({ status: "ok" }))
    .use(createEventRoutes(ownerAuth as never, fx))
    .use(createTransactionRoutes(ownerAuth as never, fx))
    .use(createEvidenceRoutes(ownerAuth as never));
}
