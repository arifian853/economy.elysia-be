import { canonical, compare, minorUnits } from "./money";

export type CurrencyInfo = { code: string; name: string; symbol: string; minorUnits: number };
export type FxRate = { base: string; quote: string; rate: string; date: string | null; provider: string };
export interface FxProvider {
  getRate(base: string, quote: string, date?: string): Promise<FxRate>;
  listCurrencies(): Promise<CurrencyInfo[]>;
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateRate(value: FxRate, base: string, quote: string, date?: string): FxRate {
  if (value.base !== base || value.quote !== quote || !value.date || !validDate(value.date) ||
      value.date > (date ?? new Date().toISOString().slice(0, 10)) ||
      !value.provider || value.provider.length > 100 || !/^[\p{L}\p{N} ._()/+-]+$/u.test(value.provider) ||
      compare(value.rate, "0") <= 0 || canonical(value.rate).length > 48) throw new Error("Invalid FX reference");
  return { base, quote, rate: canonical(value.rate), date: value.date, provider: value.provider };
}

function providerDecimal(value: unknown): string {
  const text = String(value);
  const scientific = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,2})$/.exec(text);
  if (!scientific) return canonical(text);
  const [, sign, whole, fraction = "", exponent] = scientific;
  const digits = whole + fraction, point = whole.length + Number(exponent);
  if (Math.abs(Number(exponent)) > 48) throw new Error("Invalid FX rate magnitude");
  return canonical(sign + (point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`));
}

export class FrankfurterProvider implements FxProvider {
  constructor(private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch) {}
  private async read(path: string): Promise<any> {
    const response = await this.fetcher(`https://api.frankfurter.dev/v2/${path}`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("FX provider unavailable");
    // Preserve the provider's decimal rate lexeme before JSON's number parser can round it.
    const text = await response.text();
    return JSON.parse(text.replace(/("rate"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g, '$1"$2"'));
  }
  async getRate(base: string, quote: string, date?: string): Promise<FxRate> {
    minorUnits(base); minorUnits(quote);
    if (date && !validDate(date)) throw new Error("Invalid date");
    const raw = await this.read(`rate/${base}/${quote}${date ? `?date=${date}` : ""}`);
    return validateRate({ ...raw, base: String(raw.base).toUpperCase(), quote: String(raw.quote).toUpperCase(), rate: providerDecimal(raw.rate), provider: "Frankfurter v2" }, base, quote, date);
  }
  async listCurrencies(): Promise<CurrencyInfo[]> {
    const raw = await this.read("currencies");
    if (!Array.isArray(raw) || raw.length > 1000) throw new Error("Invalid currency registry");
    return raw.flatMap((item) => {
      try {
        const code = item.iso_code;
        const digits = minorUnits(code);
        if (typeof item.name !== "string" || !item.name.trim()) return [];
        return [{ code, name: item.name.slice(0, 100), symbol: typeof item.symbol === "string" ? item.symbol.slice(0, 20) : code, minorUnits: digits }];
      } catch { return []; }
    });
  }
}

type CachedRate = { value: FxRate; expires: number; retryAfter: number };
export class FxService {
  private readonly rates = new Map<string, CachedRate>();
  private readonly pending = new Map<string, Promise<FxRate & { stale: boolean }>>();
  private currencies?: { value: CurrencyInfo[]; expires: number; retryAfter: number };
  private currencyPending?: Promise<CurrencyInfo[]>;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  constructor(private readonly provider: FxProvider, options: { now?: () => number; maxEntries?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  }
  get cacheSize() { return this.rates.size; }
  async listCurrencies(): Promise<CurrencyInfo[]> {
    if (this.currencies && Math.max(this.currencies.expires, this.currencies.retryAfter) > this.now()) return this.currencies.value;
    if (this.currencyPending) return this.currencyPending;
    this.currencyPending = (async () => {
      try {
        const value = (await this.provider.listCurrencies()).filter((x) => { try { return minorUnits(x.code) === x.minorUnits; } catch { return false; } });
        if (!value.length) throw new Error("Empty currency registry");
        this.currencies = { value, expires: this.now() + 24 * 60 * 60 * 1000, retryAfter: 0 };
        return value;
      } catch (error) {
        if (!this.currencies) throw error;
        this.currencies.retryAfter = this.now() + 60_000;
        return this.currencies.value;
      } finally { this.currencyPending = undefined; }
    })();
    return this.currencyPending;
  }
  async supported(code: string): Promise<boolean> {
    minorUnits(code);
    return code === "IDR" || (await this.listCurrencies()).some((x) => x.code === code);
  }
  async getRate(base: string, quote: string, date?: string): Promise<FxRate & { stale: boolean }> {
    minorUnits(base); minorUnits(quote);
    if (date && (!validDate(date) || date > new Date().toISOString().slice(0, 10))) throw new Error("Invalid date");
    if (base === quote) return { base, quote, rate: "1", date: null, provider: "identity", stale: false };
    const key = `${base}/${quote}/${date ?? "latest"}`;
    const cached = this.rates.get(key);
    if (cached && Math.max(cached.expires, cached.retryAfter) > this.now()) return { ...cached.value, stale: cached.expires <= this.now() };
    if (this.pending.has(key)) return this.pending.get(key)!;
    // Bound concurrent requests too, so arbitrary historical queries cannot grow memory indefinitely.
    if (this.pending.size >= this.maxEntries) throw new Error("FX busy");
    const pending = (async () => {
      try {
        const value = validateRate(await this.provider.getRate(base, quote, date), base, quote, date);
        this.rates.delete(key);
        this.rates.set(key, { value, expires: date ? Number.POSITIVE_INFINITY : this.now() + this.ttlMs, retryAfter: 0 });
        while (this.rates.size > this.maxEntries) this.rates.delete(this.rates.keys().next().value!);
        return { ...value, stale: false };
      } catch (error) {
        if (!cached) throw error;
        cached.retryAfter = this.now() + 60_000;
        return { ...cached.value, stale: true };
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, pending);
    return pending;
  }
  async snapshot(base: string): Promise<FxRate | null> {
    try { return await this.getRate(base, "IDR"); } catch { return null; }
  }
}

export const fxService = new FxService(new FrankfurterProvider());
