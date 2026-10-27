import { fxService, type FxService, type FxRate } from "./fx";
import { canonical, type Money } from "./money";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CurrencyRow = {
  currency_mode?: "domestic" | "international";
  base_currency?: string;
  currency_locked?: boolean;
  fx_reference_rate_to_idr?: Money | null;
  fx_reference_date?: string | null;
  fx_reference_provider?: string | null;
};
export function currencyFields(row: CurrencyRow) {
  const baseCurrency = row.base_currency ?? "IDR";
  return {
    currencyMode: row.currency_mode ?? "domestic",
    baseCurrency,
    currencyLocked: row.currency_locked ?? false,
    fxReferenceRateToIdr: baseCurrency === "IDR" ? "1" : row.fx_reference_rate_to_idr == null ? null : canonical(row.fx_reference_rate_to_idr),
    fxReferenceDate: baseCurrency === "IDR" ? null : row.fx_reference_date ?? null,
    fxReferenceProvider: baseCurrency === "IDR" ? "identity" : row.fx_reference_provider ?? null,
  };
}
export const referencePatch = (rate: FxRate | null) => ({
  fx_reference_rate_to_idr: rate?.rate ?? null,
  fx_reference_date: rate?.date ?? null,
  fx_reference_provider: rate?.provider ?? null,
});

export async function validateCurrency(mode: "domestic" | "international", code: string, fx: FxService = fxService) {
  if (mode === "domestic" && code !== "IDR") throw new Error("Event domestik hanya menggunakan IDR.");
  if (!(await fx.supported(code))) throw new Error("Mata uang tidak didukung.");
}

// Completed events never fetch or persist new references. Conditional writes also protect a concurrent completion/currency change.
export async function refreshEventReference<T extends CurrencyRow & { id: string; status: string; updated_at?: string }>(db: SupabaseClient, ownerId: string, event: T, fx: FxService): Promise<T> {
  if (event.status === "completed" || !event.base_currency || event.base_currency === "IDR") return event;
  const rate = await fx.snapshot(event.base_currency);
  if (!rate || (rate.rate === event.fx_reference_rate_to_idr && rate.date === event.fx_reference_date && rate.provider === event.fx_reference_provider)) return event;
  if (event.fx_reference_date && rate.date && rate.date < event.fx_reference_date) return event;
  const patch = referencePatch(rate);
  const { data, error } = await db.from("events").update(patch).eq("id", event.id).eq("user_id", ownerId)
    .eq("base_currency", event.base_currency).in("status", ["upcoming", "active"])
    .or(`fx_reference_date.is.null,fx_reference_date.lte.${rate.date}`).select("id,updated_at").maybeSingle();
  return !error && data ? { ...event, ...patch, updated_at: data.updated_at ?? event.updated_at } : event;
}
