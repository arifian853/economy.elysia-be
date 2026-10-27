import { t } from "elysia";

export type Money = number | string;
// JSON numbers remain accepted for existing clients. Decimal strings are the exact wire format.
export const MoneyInput = t.Union([t.Number(), t.String({ minLength: 1, maxLength: 64, pattern: "^-?[0-9]+(?:\\.[0-9]+)?$" })]);
const isoCurrencies = new Set(Intl.supportedValuesOf("currency"));

export function minorUnits(currency: string): number {
  if (!isoCurrencies.has(currency)) throw new Error("Mata uang ISO 4217 tidak didukung.");
  // Economy has always recorded whole rupiah; preserve this product convention.
  return currency === "IDR" ? 0 : new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!;
}

function parts(value: Money): { units: bigint; scale: number } {
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error("Gunakan string desimal untuk nilai besar.");
  const text = String(value);
  if (text.length > 100 || !/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error("Nominal harus berupa desimal biasa.");
  const [whole, fraction = ""] = text.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function decimal(units: bigint, scale: number): string {
  const sign = units < 0n ? "-" : "";
  let digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  if (scale) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
  return units === 0n ? "0" : sign + digits;
}

export function canonical(value: Money): string {
  const { units, scale } = parts(value);
  return decimal(units, scale);
}

export function normalizeMoney(value: Money, currency: string, options: { signed?: boolean; positive?: boolean } = {}): string {
  const result = canonical(value);
  const { units, scale } = parts(result);
  if (scale > minorUnits(currency) || (!options.signed && units < 0n) || (options.positive && units <= 0n)) throw new Error("Nominal tidak sesuai pecahan mata uang event.");
  // Retain every possible old bigint major-unit value. New values use the same bound.
  if (compare(result, "9223372036854775807") > 0 || compare(result, "-9223372036854775807") < 0) throw new Error("Nominal terlalu besar.");
  return result;
}

export function add(a: Money, b: Money): string {
  const x = parts(a), y = parts(b), scale = Math.max(x.scale, y.scale);
  return decimal(x.units * 10n ** BigInt(scale - x.scale) + y.units * 10n ** BigInt(scale - y.scale), scale);
}
export const subtract = (a: Money, b: Money) => add(a, canonical(b) === "0" ? "0" : String(b).startsWith("-") ? String(b).slice(1) : `-${b}`);
export function multiply(a: Money, b: Money): string {
  const x = parts(a), y = parts(b);
  return decimal(x.units * y.units, x.scale + y.scale);
}
export function compare(a: Money, b: Money): number {
  const { units } = parts(subtract(a, b));
  return units < 0n ? -1 : units > 0n ? 1 : 0;
}
export function moneyJson(value: Money): Money {
  const normalized = canonical(value);
  return !normalized.includes(".") && Number.isSafeInteger(Number(normalized)) ? Number(normalized) : normalized;
}
export function idrEquivalent(amount: Money, rate: Money | null): Money | null {
  if (rate === null) return null;
  const { units, scale } = parts(multiply(amount, rate));
  const divisor = 10n ** BigInt(scale);
  // Reference rupiah uses half-up rounding, independent of binary floating point.
  const rounded = (units < 0n ? -units : units) + divisor / 2n;
  return moneyJson(((units < 0n ? -1n : 1n) * (rounded / divisor)).toString());
}

// PostgREST must serialize numeric columns as text before JSON parsing can lose precision.
export const EVENT_SELECT = "id,name,event_date,budget::text,initial_budget::text,initial_budget_known,cash_budget::text,status,notes,created_at,updated_at,completed_at,currency_mode,base_currency,currency_locked,fx_reference_rate_to_idr::text,fx_reference_date,fx_reference_provider";
export const TRANSACTION_SELECT = "id,event_id,name,quantity,unit_price::text,payment_method,note,transaction_at,created_at,updated_at,base_currency,fx_rate_to_idr::text,fx_rate_date,fx_rate_provider";
