import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { ensureShareToken, type ShareTokenStore } from "../share-token";
import { ARCHIVED_EVENT_MUTATION_ERROR, getArchiveConflict } from "../event-archive";
import { fxService, type FxService } from "../fx";
import { currencyFields, referencePatch, refreshEventReference, validateCurrency, type CurrencyRow } from "../event-currency";
import { add, canonical, compare, EVENT_SELECT, moneyJson, MoneyInput, multiply, normalizeMoney, subtract, TRANSACTION_SELECT, type Money } from "../money";
import { toTransaction, type TransactionRow } from "./transactions";

type EventRow = CurrencyRow & {
  id: string;
  name: string;
  event_date: string;
  budget: Money;
  initial_budget: Money;
  initial_budget_known: boolean;
  cash_budget: Money | null;
  status: "upcoming" | "active" | "completed";
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const toEvent = (r: EventRow) => ({
  id: r.id,
  name: r.name,
  eventDate: r.event_date,
  budget: moneyJson(r.budget),
  initialBudget: moneyJson(r.initial_budget),
  initialBudgetKnown: r.initial_budget_known,
  cashBudget: r.cash_budget === null ? null : moneyJson(r.cash_budget),
  digitalBudget: r.cash_budget === null ? null : moneyJson(subtract(r.budget, r.cash_budget)),
  ...currencyFields(r),
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

const ParticipantName = t.String({ minLength: 1, maxLength: 100, pattern: "\\S" });
const EditableStatus = t.Union([t.Literal("upcoming"), t.Literal("active")]);
const Name = t.String({ minLength: 1, maxLength: 200, pattern: "\\S" }); // tidak boleh kosong/spasi saja
const EventDate = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Budget = MoneyInput;
const CurrencyMode = t.Union([t.Literal("domestic"), t.Literal("international")]);
const Currency = t.String({ pattern: "^[A-Z]{3}$" });
const Notes = t.Union([t.String({ maxLength: 2000 }), t.Null()]);
const EventId = t.Object({ eventId: t.String({ format: "uuid" }) });

// Error Postgres kelas 22xxx/23xxx (nilai/constraint tidak valid) = salah input, bukan error server.
const isClientError = (code?: string) => !!code && (code.startsWith("22") || code.startsWith("23"));
const isArchiveDbError = (error?: { code?: string }) => error?.code === "55000";
const rpcMoneyFields = new Set(["amount", "budget", "cashBudget", "digitalBudget", "budgetDelta", "cashBudgetDelta"]);
const rpcMoney = (data: Record<string, unknown> | null) => data === null ? null : Object.fromEntries(
  Object.entries(data).map(([key, value]) => [key,
    rpcMoneyFields.has(key) && (typeof value === "string" || typeof value === "number") ? moneyJson(value) : value]),
);

export function createEventRoutes(authPlugin: typeof auth = auth, fx: FxService = fxService) {
  return new Elysia({ prefix: "/events" })
  .use(authPlugin)
  .post(
    "/:eventId/reallocations",
    async ({ user, db, params, body, status }) => {
      let amount: string;
      try {
        amount = canonical(body.amount);
        if (compare(amount, "0") <= 0) throw Error("Nominal realokasi harus positif.");
      } catch (error) { return status(400, { error: (error as Error).message }); }
      const { data, error } = await db.rpc("reallocate_event_funds", {
        p_event_id: params.eventId,
        p_user_id: user.id,
        p_from_channel: body.from,
        p_amount: amount,
        p_note: body.note ?? null,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        const http = code === "55000" ? 409 : code === "42501" ? 403 : code === "P0002" ? 404 : code === "22023" ? 400 : 500;
        return status(http, { error: http === 500 ? "Gagal memindahkan alokasi dana." : (error as { message?: string }).message });
      }
      return rpcMoney(data);
    },
    {
      params: EventId,
      body: t.Object({
        from: t.Union([t.Literal("cash"), t.Literal("digital")]),
        amount: MoneyInput,
        note: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  )
  .get("/:eventId/budget-history", async ({ user, db, params, status }) => {
    const { data: event, error: eventError } = await db.from("events").select("id")
      .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
    if (eventError) return status(500, { error: "Gagal membaca event." });
    if (!event) return status(404, { error: "Event tidak ditemukan." });
    const [moves, adjustments] = await Promise.all([
      db.from("event_fund_movements").select("id,from_channel,amount::text,note,created_at")
        .eq("event_id", params.eventId).eq("user_id", user.id).order("created_at", { ascending: false }),
      db.from("event_budget_adjustments").select("id,budget_delta::text,cash_budget_delta::text,reason,created_at")
        .eq("event_id", params.eventId).eq("user_id", user.id).order("created_at", { ascending: false }),
    ]);
    if (moves.error || adjustments.error) return status(500, { error: "Gagal membaca riwayat anggaran." });
    return {
      reallocations: (moves.data ?? []).map((r) => ({ ...r, amount: moneyJson(r.amount) })),
      adjustments: (adjustments.data ?? []).map((r) => ({ ...r, budget_delta: moneyJson(r.budget_delta), cash_budget_delta: moneyJson(r.cash_budget_delta) })),
    };
  }, { params: EventId })
  .post(
    "/:eventId/budget-adjustments",
    async ({ user, db, params, body, status }) => {
      let budgetDelta: string, cashBudgetDelta: string;
      try { budgetDelta = canonical(body.budgetDelta); cashBudgetDelta = canonical(body.cashBudgetDelta); }
      catch (error) { return status(400, { error: (error as Error).message }); }
      const { data, error } = await db.rpc("adjust_event_budget", {
        p_event_id: params.eventId,
        p_user_id: user.id,
        p_budget_delta: budgetDelta,
        p_cash_budget_delta: cashBudgetDelta,
        p_reason: body.reason,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        const http = code === "55000" ? 409 : code === "42501" ? 403 : code === "P0002" ? 404 : code === "22023" ? 400 : 500;
        return status(http, { error: http === 500 ? "Gagal menyesuaikan anggaran." : (error as { message?: string }).message });
      }
      return rpcMoney(data);
    },
    {
      params: EventId,
      body: t.Object({
        budgetDelta: MoneyInput,
        cashBudgetDelta: MoneyInput,
        reason: t.String({ minLength: 1, maxLength: 500, pattern: "\\S" }),
      }),
    },
  )
  .get("/", async ({ user, db, status }) => {
    const { data, error } = await db
      .from("events")
      .select(`${EVENT_SELECT}, transactions(quantity, unit_price::text), participants(id)`)
      .eq("user_id", user.id)
      .order("event_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return status(500, { error: error.message });

    type ListRow = EventRow & {
      transactions: { quantity: number; unit_price: Money }[];
      participants: { id: string }[];
    };
    return (data as unknown as ListRow[]).map(({ transactions, participants, ...event }) => ({
      ...toEvent(event),
      totalExpenses: moneyJson(transactions.reduce((sum, x) => add(sum, multiply(x.quantity, x.unit_price)), "0")),
      participantCount: participants.length,
    }));
  })
  .post(
    "/",
    async ({ user, db, body, status }) => {
      const mode = body.currencyMode ?? "domestic", currency = body.baseCurrency ?? "IDR";
      let budget: string;
      try {
        await validateCurrency(mode, currency, fx);
        budget = normalizeMoney(body.budget, currency, { positive: true });
      } catch (error) { return status(400, { error: (error as Error).message }); }
      const rate = await fx.snapshot(currency);
      const { data, error } = await db
        .from("events")
        .insert({
          user_id: user.id,
          name: body.name.trim(),
          event_date: body.eventDate,
          budget,
          initial_budget: budget,
          initial_budget_known: true,
          currency_mode: mode,
          base_currency: currency,
          ...referencePatch(rate),
          status: body.status ?? "upcoming",
          notes: body.notes ?? null,
        })
        .select(EVENT_SELECT)
        .single();
      if (error) return status(isClientError(error.code) ? 400 : 500, { error: error.message });

      if (body.participants && body.participants.length > 0) {
        const participantRows = body.participants.map((pName) => ({
          event_id: data.id,
          user_id: user.id,
          name: pName.trim(),
        }));
        const { error: pError } = await db.from("participants").insert(participantRows);
        if (pError) {
          // Cleanup event jika insert peserta gagal
          await db.from("events").delete().eq("id", data.id).eq("user_id", user.id);
          return status(isClientError(pError.code) ? 400 : 500, { error: pError.message });
        }
      }

      return status(201, toEvent(data as unknown as EventRow));
    },
    {
      body: t.Object({
        name: Name,
        eventDate: EventDate,
        budget: Budget,
        currencyMode: t.Optional(CurrencyMode),
        baseCurrency: t.Optional(Currency),
        status: t.Optional(EditableStatus),
        notes: t.Optional(Notes),
        participants: t.Optional(t.Array(ParticipantName)),
      }),
    },
  )
  .post(
    "/:eventId/complete",
    async ({ user, db, params, status }) => {
      const { data: current, error: readError } = await db
        .from("events")
        .select("id, status")
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (readError) return status(500, { error: readError.message });
      if (!current) return status(404, { error: "Event not found" });
      if (getArchiveConflict(current.status)) {
        return status(409, { error: ARCHIVED_EVENT_MUTATION_ERROR });
      }

      const completedAt = new Date().toISOString();
      const { data, error } = await db
        .from("events")
        .update({ status: "completed", completed_at: completedAt, updated_at: completedAt })
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .in("status", ["upcoming", "active"])
        .select(EVENT_SELECT)
        .maybeSingle();
      if (error) {
        return status(isArchiveDbError(error) ? 409 : 500, {
          error: isArchiveDbError(error) ? (error.message === "Event currency is locked." ? "Mata uang terkunci setelah transaksi pertama." : ARCHIVED_EVENT_MUTATION_ERROR) : error.message,
        });
      }
      if (!data) return status(409, { error: ARCHIVED_EVENT_MUTATION_ERROR });
      return toEvent(data as unknown as EventRow);
    },
    { params: EventId },
  )
  .get(
    "/:eventId/public-link",
    async ({ user, db, params, status }) => {
      const { data: existing, error: lookupError } = await db.from("events")
        .select("public_share_token")
        .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
      if (lookupError) return status(500, { error: "Gagal membaca status tautan publik." });
      if (!existing) return status(404, { error: "Event tidak ditemukan." });
      return existing.public_share_token
        ? { enabled: true, token: existing.public_share_token }
        : { enabled: false, token: null };
    },
    { params: EventId },
  )
  .post(
    "/:eventId/public-link",
    async ({ user, db, params, status }) => {
      const store: ShareTokenStore = {
        read: async () => {
          const { data, error } = await db.from("events")
            .select("public_share_token")
            .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
          if (error) throw error;
          return { found: Boolean(data), token: data?.public_share_token ?? null };
        },
        createIfEmpty: async (candidate) => {
          const { data, error } = await db.from("events")
            .update({ public_share_token: candidate })
            .eq("id", params.eventId).eq("user_id", user.id)
            .is("public_share_token", null)
            .select("public_share_token").maybeSingle();
          if (error) throw error;
          if (data) return { found: true, token: data.public_share_token, created: true };
          return { ...(await store.read()), created: false };
        },
      };

      try {
        const result = await ensureShareToken(store);
        if (result.status === "not-found") {
          return status(404, { error: "Event tidak ditemukan." });
        }
        if (result.status === "unavailable") {
          return status(409, { error: "Tautan belum siap. Coba lagi." });
        }
        return { enabled: true, token: result.token };
      } catch {
        return status(500, { error: "Gagal membuat tautan publik." });
      }
    },
    { params: EventId },
  )
  .delete(
    "/:eventId/public-link",
    async ({ user, db, params, status }) => {
      const { data, error } = await db
        .from("events")
        .update({ public_share_token: null })
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .select("id")
        .maybeSingle();
      if (error) return status(500, { error: "Gagal menonaktifkan tautan publik." });
      if (!data) return status(404, { error: "Event tidak ditemukan." });
      return { enabled: false };
    },
    { params: EventId },
  )
  .get(
    "/:eventId",
    async ({ user, db, params, status }) => {
      const { data: event, error } = await db
        .from("events")
        .select(EVENT_SELECT)
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) return status(500, { error: error.message });
      if (!event) return status(404, { error: "Event not found" });

      const [participants, transactions] = await Promise.all([
        db.from("participants").select("id, name").eq("event_id", params.eventId).eq("user_id", user.id).order("created_at"),
        db.from("transactions").select(TRANSACTION_SELECT).eq("event_id", params.eventId).eq("user_id", user.id).order("transaction_at", { ascending: false }),
      ]);
      if (participants.error || transactions.error) {
        return status(500, { error: (participants.error ?? transactions.error)!.message });
      }

      return {
        event: toEvent(await refreshEventReference(db, user.id, event as unknown as EventRow, fx)),
        participants: participants.data,
        transactions: (transactions.data as unknown as TransactionRow[]).map(toTransaction),
      };
    },
    { params: EventId },
  )
  .patch(
    "/:eventId",
    async ({ user, db, params, body, status }) => {
      if (body.budget !== undefined) {
        return status(400, { error: "Gunakan Penyesuaian Anggaran agar perubahan total tercatat di riwayat." });
      }
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.eventDate !== undefined) patch.event_date = body.eventDate;
      if (body.status !== undefined) patch.status = body.status;
      if (body.notes !== undefined) patch.notes = body.notes;

      // Inspect status before any currency validation or provider request.
      const { data: currentStatus, error: statusError } = await db
        .from("events").select(EVENT_SELECT)
        .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
      if (statusError) return status(500, { error: "Gagal memeriksa status event." });
      if (!currentStatus) return status(404, { error: "Event not found" });
      const currentEvent = currentStatus as unknown as EventRow;
      const archiveConflict = getArchiveConflict(currentEvent.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      const mode = body.currencyMode ?? currentEvent.currency_mode ?? "domestic";
      const currency = body.baseCurrency ?? (mode === "domestic" ? "IDR" : currentEvent.base_currency ?? "IDR");
      if (body.currencyMode !== undefined || body.baseCurrency !== undefined) {
        const changed = currency !== (currentEvent.base_currency ?? "IDR") || mode !== (currentEvent.currency_mode ?? "domestic");
        if (changed && currentEvent.currency_locked) return status(409, { error: "Mata uang terkunci setelah transaksi pertama." });
        try {
          await validateCurrency(mode, currency, fx);
          normalizeMoney(currentEvent.budget, currency, { positive: true });
          if (currentEvent.cash_budget !== null) normalizeMoney(currentEvent.cash_budget, currency);
        } catch (error) { return status(400, { error: (error as Error).message }); }
        patch.currency_mode = mode;
        patch.base_currency = currency;
        if (currency !== (currentEvent.base_currency ?? "IDR")) {
          // Same nominal amount in the newly selected currency; the SQL guard owns this reset too.
          patch.initial_budget = canonical(currentEvent.budget);
          patch.initial_budget_known = true;
        }
        if (changed) Object.assign(patch, referencePatch(await fx.snapshot(currency)));
      }

      if (body.cashBudget !== undefined) {
        const current = currentEvent;
        let cashBudget: string | null;
        try { cashBudget = body.cashBudget === null ? null : normalizeMoney(body.cashBudget, currency); }
        catch (error) { return status(400, { error: (error as Error).message }); }
        if (current.cash_budget !== null && (cashBudget === null || compare(cashBudget, current.cash_budget) !== 0)) {
          return status(400, { error: "Gunakan Realokasi Dana untuk mengubah pembagian tunai/digital." });
        }
        if (cashBudget !== null && compare(cashBudget, current.budget) > 0) return status(400, { error: "Anggaran tunai melebihi total anggaran." });
        patch.cash_budget = cashBudget;
      }

      if (Object.keys(patch).length === 0 && body.participants === undefined) {
        return status(400, { error: "No fields to update" });
      }

      patch.updated_at = new Date().toISOString();

      const { data, error } = await db
        .from("events")
        .update(patch)
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .select(EVENT_SELECT)
        .maybeSingle();
      if (error) {
        return status(isArchiveDbError(error) ? 409 : isClientError(error.code) ? 400 : 500, {
          error: isArchiveDbError(error) ? (error.message === "Event currency is locked." ? "Mata uang terkunci setelah transaksi pertama." : ARCHIVED_EVENT_MUTATION_ERROR) : error.message,
        });
      }
      if (!data) return status(404, { error: "Event not found" });

      if (body.participants !== undefined) {
        const { error: delErr } = await db
          .from("participants")
          .delete()
          .eq("event_id", params.eventId)
          .eq("user_id", user.id);
        if (delErr) return status(500, { error: delErr.message });

        if (body.participants.length > 0) {
          const participantRows = body.participants.map((pName) => ({
            event_id: params.eventId,
            user_id: user.id,
            name: pName.trim(),
          }));
          const { error: insErr } = await db.from("participants").insert(participantRows);
          if (insErr) return status(isClientError(insErr.code) ? 400 : 500, { error: insErr.message });
        }
      }

      return toEvent(data as unknown as EventRow);
    },
    {
      params: EventId,
      body: t.Object({
        name: t.Optional(Name),
        eventDate: t.Optional(EventDate),
        budget: t.Optional(Budget),
        cashBudget: t.Optional(t.Union([MoneyInput, t.Null()])),
        currencyMode: t.Optional(CurrencyMode),
        baseCurrency: t.Optional(Currency),
        status: t.Optional(EditableStatus),
        notes: t.Optional(Notes),
        participants: t.Optional(t.Array(ParticipantName)),
      }),
    },
  )
  .delete(
    "/:eventId",
    async ({ user, db, params, status }) => {
      const { data: current, error: currentError } = await db
        .from("events")
        .select("status")
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (currentError) return status(500, { error: currentError.message });
      if (!current) return status(404, { error: "Event not found" });

      const { data, error } = await db
        .from("events")
        .delete()
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .select("id");
      if (error) {
        return status(isArchiveDbError(error) ? 409 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
        });
      }
      if (data.length === 0) return status(404, { error: "Event not found" });
      return { deleted: true };
    },
    { params: EventId },
  );
}

export const eventRoutes = createEventRoutes();
