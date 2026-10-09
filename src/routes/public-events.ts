import { Elysia } from "elysia";

export type PublicEventView = {
  event: { name: string; eventDate: string };
  budgetSummary: {
    budget: number;
    cashBudget: number | null;
    digitalBudget: number | null;
    totalExpenses: number;
    cashExpenses: number;
    digitalExpenses: number;
    totalRemaining: number;
    cashRemaining: number | null;
    digitalRemaining: number | null;
  };
  entries: Array<{
    type: "expense";
    name: string;
    amount: number;
    source: "cash" | "digital";
    transactionAt: string;
  }>;
};

type PublicEventReader = (token: string) => Promise<{ data: unknown; error?: unknown }>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMoney = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNullableMoney = (value: unknown): value is number | null => value === null || isMoney(value);
const isNullableBalance = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value));

export function sanitizePublicEvent(value: unknown): PublicEventView | null {
  if (!isRecord(value) || !isRecord(value.event) || !isRecord(value.budgetSummary) || !Array.isArray(value.entries)) return null;
  const { name, eventDate } = value.event;
  if (typeof name !== "string" || !name.trim() || typeof eventDate !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(eventDate)) return null;

  const raw = value.budgetSummary;
  const { budget, cashBudget, digitalBudget, totalExpenses, cashExpenses, digitalExpenses, totalRemaining, cashRemaining, digitalRemaining } = raw;
  if (!isMoney(budget) || !isNullableMoney(cashBudget) || !isNullableMoney(digitalBudget) ||
      !isMoney(totalExpenses) || !isMoney(cashExpenses) || !isMoney(digitalExpenses) ||
      typeof totalRemaining !== "number" || !Number.isSafeInteger(totalRemaining) ||
      !isNullableBalance(cashRemaining) || !isNullableBalance(digitalRemaining)) return null;

  const splitConfigured = cashBudget !== null && digitalBudget !== null;
  if ((cashBudget === null) !== (digitalBudget === null) ||
      (splitConfigured && cashBudget + digitalBudget !== budget) ||
      totalExpenses !== cashExpenses + digitalExpenses ||
      totalRemaining !== budget - totalExpenses ||
      (splitConfigured && (cashRemaining !== cashBudget - cashExpenses || digitalRemaining !== digitalBudget - digitalExpenses)) ||
      (!splitConfigured && (cashRemaining !== null || digitalRemaining !== null))) return null;

  const entries = value.entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { type, name: entryName, amount, source, transactionAt } = entry;
    if (type !== "expense" || typeof entryName !== "string" || !entryName.trim() || !isMoney(amount) ||
        (source !== "cash" && source !== "digital") || typeof transactionAt !== "string" || !transactionAt) return [];
    return [{ type: "expense" as const, name: entryName.trim(), amount, source: source as "cash" | "digital", transactionAt }];
  });

  const entryTotal = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const entryCash = entries.filter((entry) => entry.source === "cash").reduce((sum, entry) => sum + entry.amount, 0);
  if (entryTotal !== totalExpenses || entryCash !== cashExpenses || entryTotal - entryCash !== digitalExpenses) return null;

  return {
    event: { name: name.trim(), eventDate },
    budgetSummary: { budget, cashBudget, digitalBudget, totalExpenses, cashExpenses, digitalExpenses, totalRemaining, cashRemaining, digitalRemaining },
    entries,
  };
}

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
