import { Elysia } from "elysia";
import { createClient } from "@supabase/supabase-js";
import { auth } from "./auth";
import { createEconomyAssistantApi } from "./assistant-api";
import { eventRoutes } from "./routes/events";
import { publicEventRoutes } from "./routes/public-events";
import { transactionRoutes } from "./routes/transactions";
import { evidenceRoutes } from "./routes/evidence";
import { fxRoutes } from "./routes/fx";

const port = Number(process.env.PORT ?? 3001);

export const app = new Elysia({ prefix: "/api" })
  .get("/health", () => ({ status: "ok" }))
  .use(publicEventRoutes)
  .use(fxRoutes)
  .use(auth)
  .get("/me", ({ user }) => ({ id: user.id, email: user.email }))
  .use(eventRoutes)
  .use(transactionRoutes)
  .use(evidenceRoutes);

if (import.meta.main) {
  app.listen({ port, hostname: "127.0.0.1" });
  console.log(
    `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
  );

  const assistantToken = process.env.ECONOMY_ASSISTANT_TOKEN;
  const assistantOwnerId = process.env.ECONOMY_ASSISTANT_OWNER_ID;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  if (assistantToken && assistantOwnerId && serviceRoleKey && supabaseUrl) {
    const assistantDb = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const assistantApi = createEconomyAssistantApi({
      token: assistantToken,
      ownerId: assistantOwnerId,
      db: assistantDb,
    });
    const assistantPort = Number(process.env.ECONOMY_ASSISTANT_PORT ?? 3002);
    assistantApi.listen({ port: assistantPort, hostname: "127.0.0.1" });
    console.log(`Economy assistant API is running on 127.0.0.1:${assistantPort}`);
  }
}
