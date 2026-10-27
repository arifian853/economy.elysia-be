import { Elysia } from "elysia";
import { sanitizePublicEvent } from "../public-projection";
export { sanitizePublicEvent, type PublicEventView } from "../public-projection";

type PublicEventReader = (token: string) => Promise<{ data: unknown; error?: unknown }>;

const readPublicEvent: PublicEventReader = async (token) => {
  const { createPublicClient } = await import("../supabase");
  const { data, error } = await createPublicClient().rpc("get_public_event", { p_token: token });
  return { data, error };
};

export function createPublicEventRoutes(reader: PublicEventReader = readPublicEvent) {
  return new Elysia().get("/public/events", async ({ request, status, set }) => {
    set.headers["Cache-Control"] = "private, no-store";
    set.headers["X-Robots-Tag"] = "noindex, nofollow";
    set.headers["Referrer-Policy"] = "no-referrer";
    const token = request.headers.get("x-economy-share-token");
    if (!token || !/^(?:[a-f0-9]{64}|[A-Za-z0-9]{22})$/.test(token)) return status(404, { error: "Catatan tidak tersedia." });

    try {
      const result = await reader(token);
      if (result.error) return status(503, { error: "Catatan publik sementara tidak tersedia." });
      const publicView = sanitizePublicEvent(result.data);
      if (!publicView) return status(404, { error: "Catatan tidak tersedia." });
      return publicView;
    } catch {
      return status(503, { error: "Catatan publik sementara tidak tersedia." });
    }
  });
}

export const publicEventRoutes = createPublicEventRoutes();
