import { Elysia, t } from "elysia";
import { fxService, type FxService, validDate } from "../fx";
import { minorUnits } from "../money";

export function createFxRoutes(fx: FxService = fxService) {
  return new Elysia({ prefix: "/fx" })
    .get("/currencies", async ({ status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      try { return await fx.listCurrencies(); }
      catch { return status(503, { error: "Daftar mata uang sementara tidak tersedia." }); }
    })
    .get("/rate", async ({ query, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const base = query.base.toUpperCase(), quote = (query.quote ?? "IDR").toUpperCase();
      try { minorUnits(base); minorUnits(quote); }
      catch { return status(400, { error: "Mata uang tidak didukung." }); }
      if (query.date && (!validDate(query.date) || query.date > new Date().toISOString().slice(0, 10))) return status(400, { error: "Tanggal kurs tidak valid." });
      try {
        if (!(await fx.supported(base)) || !(await fx.supported(quote))) return status(400, { error: "Mata uang tidak didukung." });
        const rate = await fx.getRate(base, quote, query.date);
        return { base, quote, rate: rate.rate, rateDate: rate.date, provider: rate.provider, stale: rate.stale };
      } catch { return status(503, { error: "Kurs referensi sementara tidak tersedia." }); }
    }, { query: t.Object({ base: t.String({ minLength: 3, maxLength: 3 }), quote: t.Optional(t.String({ minLength: 3, maxLength: 3 })), date: t.Optional(t.String({ maxLength: 10 })) }) });
}

export const fxRoutes = createFxRoutes();
