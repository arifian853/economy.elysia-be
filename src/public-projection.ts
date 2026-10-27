import { add, canonical, compare, idrEquivalent, minorUnits, moneyJson, normalizeMoney, subtract, type Money } from "./money";
import { validDate } from "./fx";

type PublicFx = { fxRateToIdr: string | null; fxRateDate: string | null; fxRateProvider: string | null; idrEquivalent: Money | null };
export type PublicEventView = {
  event: { name: string; eventDate: string; initialBudget: Money; initialBudgetKnown: boolean; status?: string; updatedAt?: string; currencyMode?: string; baseCurrency?: string;
    fxReferenceRateToIdr?: string | null; fxReferenceDate?: string | null; fxReferenceProvider?: string | null };
  budgetSummary: { budget: Money; cashBudget: Money | null; digitalBudget: Money | null; totalExpenses: Money; cashExpenses: Money;
    digitalExpenses: Money; totalRemaining: Money; cashRemaining: Money | null; digitalRemaining: Money | null };
  entries: Array<{ type: "expense"; name: string; amount: Money; source: "cash" | "digital"; transactionAt: string } & Partial<PublicFx>>;
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

function publicMoney(value: unknown, digits: number, signed = false): string {
  if (typeof value !== "string" && typeof value !== "number") throw Error("Invalid money");
  const text = canonical(value);
  if ((text.split(".")[1]?.length ?? 0) > digits || (!signed && compare(text, 0) < 0)) throw Error("Invalid precision");
  return text;
}
function publicFx(rate: unknown, date: unknown, provider: unknown, currency: string) {
  if (rate === null && date === null && provider === null) return { rate: null, date: null, provider: null };
  if (typeof rate !== "number" && typeof rate !== "string") throw Error("Invalid rate");
  const normalized = canonical(rate);
  if (compare(normalized, 0) <= 0 || normalized.length > 48 || typeof provider !== "string" || !/^[\p{L}\p{N} ._()/+-]{1,100}$/u.test(provider)) throw Error("Invalid reference");
  if (currency === "IDR") {
    if (normalized !== "1" || date !== null || provider !== "identity") throw Error("Invalid identity");
  } else if (typeof date !== "string" || !validDate(date) || date > new Date().toISOString().slice(0, 10)) throw Error("Invalid reference date");
  return { rate: normalized, date: date as string | null, provider };
}

export function sanitizePublicEvent(value: unknown): PublicEventView | null {
  try {
    if (!isRecord(value) || !isRecord(value.event) || !isRecord(value.budgetSummary) || !Array.isArray(value.entries)) return null;
    const rawEvent = value.event;
    const { name, eventDate } = rawEvent;
    if (typeof name !== "string" || !name.trim() || typeof eventDate !== "string" || !validDate(eventDate)) return null;
    // Old projections lack both fields. Their current budget is only an unknown placeholder.
    const missingInitial = rawEvent.initialBudget === undefined && rawEvent.initialBudgetKnown === undefined;
    const initial = missingInitial ? value.budgetSummary.budget : rawEvent.initialBudget;
    if ((typeof initial !== "string" && typeof initial !== "number") || (!missingInitial && typeof rawEvent.initialBudgetKnown !== "boolean")) return null;
    const currency = rawEvent.baseCurrency ?? "IDR";
    if (typeof currency !== "string") return null;
    const digits = minorUnits(currency);
    const event: PublicEventView["event"] = { name: name.trim(), eventDate,
      initialBudget: moneyJson(normalizeMoney(initial, currency, { positive: true })),
      initialBudgetKnown: missingInitial ? false : rawEvent.initialBudgetKnown as boolean };
    if (rawEvent.baseCurrency !== undefined) {
      if ((rawEvent.currencyMode !== "domestic" && rawEvent.currencyMode !== "international") || (rawEvent.currencyMode === "domestic" && currency !== "IDR")) return null;
      const fx = publicFx(rawEvent.fxReferenceRateToIdr, rawEvent.fxReferenceDate, rawEvent.fxReferenceProvider, currency);
      Object.assign(event, { currencyMode: rawEvent.currencyMode, baseCurrency: currency, fxReferenceRateToIdr: fx.rate, fxReferenceDate: fx.date, fxReferenceProvider: fx.provider });
    }
    if (rawEvent.status !== undefined) {
      if (!["upcoming", "active", "completed"].includes(String(rawEvent.status))) return null;
      event.status = rawEvent.status as string;
    }
    if (rawEvent.updatedAt !== undefined) {
      if (!timestamp(rawEvent.updatedAt)) return null;
      event.updatedAt = rawEvent.updatedAt;
    }
    const raw = value.budgetSummary;
    const budget = publicMoney(raw.budget, digits), totalExpenses = publicMoney(raw.totalExpenses, digits);
    const cashExpenses = publicMoney(raw.cashExpenses, digits), digitalExpenses = publicMoney(raw.digitalExpenses, digits);
    const totalRemaining = publicMoney(raw.totalRemaining, digits, true);
    const cashBudget = raw.cashBudget === null ? null : publicMoney(raw.cashBudget, digits);
    const digitalBudget = raw.digitalBudget === null ? null : publicMoney(raw.digitalBudget, digits);
    const cashRemaining = raw.cashRemaining === null ? null : publicMoney(raw.cashRemaining, digits, true);
    const digitalRemaining = raw.digitalRemaining === null ? null : publicMoney(raw.digitalRemaining, digits, true);
    const split = cashBudget !== null && digitalBudget !== null;
    if ((cashBudget === null) !== (digitalBudget === null) || (split && add(cashBudget, digitalBudget) !== budget) ||
        add(cashExpenses, digitalExpenses) !== totalExpenses || subtract(budget, totalExpenses) !== totalRemaining ||
        (split && (cashRemaining !== subtract(cashBudget, cashExpenses) || digitalRemaining !== subtract(digitalBudget, digitalExpenses))) ||
        (!split && (cashRemaining !== null || digitalRemaining !== null))) return null;
    const entries: PublicEventView["entries"] = [];
    for (const entry of value.entries) {
      if (!isRecord(entry) || entry.type !== "expense") continue;
      if (typeof entry.name !== "string" || !entry.name.trim() || (entry.source !== "cash" && entry.source !== "digital") || !timestamp(entry.transactionAt)) return null;
      const amount = publicMoney(entry.amount, digits);
      const projected: PublicEventView["entries"][number] = { type: "expense", name: entry.name.trim(), amount: moneyJson(amount), source: entry.source, transactionAt: entry.transactionAt };
      if (entry.fxRateToIdr !== undefined) {
        const fx = publicFx(entry.fxRateToIdr, entry.fxRateDate, entry.fxRateProvider, currency);
        Object.assign(projected, { fxRateToIdr: fx.rate, fxRateDate: fx.date, fxRateProvider: fx.provider, idrEquivalent: idrEquivalent(amount, fx.rate) });
      }
      entries.push(projected);
    }
    const entryTotal = entries.reduce((sum, e) => add(sum, e.amount), "0");
    const entryCash = entries.filter((e) => e.source === "cash").reduce((sum, e) => add(sum, e.amount), "0");
    if (entryTotal !== totalExpenses || entryCash !== cashExpenses || subtract(entryTotal, entryCash) !== digitalExpenses) return null;
    const json = (v: string | null) => v === null ? null : moneyJson(v);
    return { event, budgetSummary: { budget: moneyJson(budget), cashBudget: json(cashBudget), digitalBudget: json(digitalBudget),
      totalExpenses: moneyJson(totalExpenses), cashExpenses: moneyJson(cashExpenses), digitalExpenses: moneyJson(digitalExpenses),
      totalRemaining: moneyJson(totalRemaining), cashRemaining: json(cashRemaining), digitalRemaining: json(digitalRemaining) }, entries };
  } catch { return null; }
}
