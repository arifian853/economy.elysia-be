import { describe, expect, test } from "bun:test";
import { FxService, FrankfurterProvider, type FxProvider } from "../src/fx";
import { createFxRoutes } from "../src/routes/fx";
import { Elysia } from "elysia";

const rate = { base: "SGD", quote: "IDR", rate: "12742.125", date: "2026-10-23", provider: "Frankfurter v2" };
const currencies = [{ code: "SGD", name: "Singapore Dollar", symbol: "S$", minorUnits: 2 }, { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp", minorUnits: 0 }];

describe("backend FX reference", () => {
  test("caches rates, falls back truthfully and bounds historical keys", async () => {
    let calls = 0, now = 0, fail = false;
    const provider: FxProvider = {
      listCurrencies: async () => currencies,
      getRate: async () => { calls++; if (fail) throw new Error("offline"); return rate; },
    };
    const fx = new FxService(provider, { now: () => now, maxEntries: 2, ttlMs: 100 });
    expect(await fx.getRate("SGD", "IDR")).toMatchObject({ ...rate, stale: false });
    await fx.getRate("SGD", "IDR");
    expect(calls).toBe(1);
    now = 101; fail = true;
    expect(await fx.getRate("SGD", "IDR")).toMatchObject({ ...rate, stale: true });
    expect(await fx.snapshot("SGD")).toMatchObject({ rate: rate.rate, date: rate.date });
    expect(await fx.snapshot("USD")).toBeNull();
    fail = false;
    await fx.getRate("SGD", "IDR", "2026-10-24");
    await fx.getRate("SGD", "IDR", "2026-10-25");
    expect(fx.cacheSize).toBeLessThanOrEqual(2);
  });
  test("Frankfurter v2 uses backend requests and validates response data", async () => {
    const urls: string[] = [];
    const provider = new FrankfurterProvider(async (input) => {
      urls.push(String(input));
      return Response.json(String(input).includes("currencies") ? [
        { iso_code: "SGD", name: "Singapore Dollar", symbol: "S$" },
        { iso_code: "BTC", name: "Bitcoin" }, { iso_code: "XYZ", name: "Fake" },
      ] : { base: "SGD", quote: "IDR", rate: 12742.125, date: "2026-10-23" });
    });
    expect(await provider.getRate("SGD", "IDR", "2026-10-24")).toEqual(rate);
    expect(urls[0]).toContain("/v2/rate/SGD/IDR?date=2026-10-24");
    expect((await provider.listCurrencies()).map((x) => x.code)).toEqual(["SGD"]);
    const bad = new FrankfurterProvider(async () => Response.json({ ...rate, rate: -1 }));
    await expect(bad.getRate("SGD", "IDR")).rejects.toThrow();
  });
  test("preserves provider decimal lexemes and small scientific rates exactly", async () => {
    const precise = new FrankfurterProvider(async () => new Response('{"base":"SGD","quote":"IDR","date":"2026-10-23","rate":12742.1234567890123456789}'));
    expect((await precise.getRate("SGD", "IDR")).rate).toBe("12742.1234567890123456789");
    const small = new FrankfurterProvider(async () => new Response('{"base":"SGD","quote":"IDR","date":"2026-10-23","rate":1.2345e-8}'));
    expect((await small.getRate("SGD", "IDR")).rate).toBe("0.000000012345");
  });
  test("serves safe currencies/rates and gracefully handles failure without owner auth", async () => {
    const fx = new FxService({ listCurrencies: async () => currencies, getRate: async () => rate });
    const app = new Elysia().use(createFxRoutes(fx));
    const response = await app.handle(new Request("http://localhost/fx/rate?base=SGD&quote=IDR"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rate: rate.rate, rateDate: rate.date });
    expect((await app.handle(new Request("http://localhost/fx/rate?base=XYZ&quote=IDR"))).status).toBe(400);
    expect((await app.handle(new Request("http://localhost/fx/rate?base=SGD&quote=IDR&date=2026-02-30"))).status).toBe(400);
    const failed = new Elysia().use(createFxRoutes(new FxService({ listCurrencies: async () => { throw Error("private error"); }, getRate: async () => { throw Error("private error"); } })));
    const unavailable = await failed.handle(new Request("http://localhost/fx/currencies"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private error");
  });
});
