import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { ARCHIVED_EVENT_MUTATION_ERROR, getArchiveConflict } from "../event-archive";
import { fxService, type FxService } from "../fx";
import { MoneyInput, canonical, idrEquivalent, moneyJson, multiply, normalizeMoney, TRANSACTION_SELECT, type Money } from "../money";

export type TransactionRow = {
  id: string;
  event_id: string;
  user_id?: string;
  name: string;
  quantity: number;
  unit_price: Money;
  base_currency?: string;
  fx_rate_to_idr?: Money | null;
  fx_rate_date?: string | null;
  fx_rate_provider?: string | null;
  payment_method: "cash" | "transfer" | "qris" | "ewallet" | "other";
  note: string | null;
  transaction_at: string;
  created_at: string;
  updated_at: string;
};

export const toTransaction = (r: TransactionRow) => ({
  id: r.id,
  eventId: r.event_id,
  name: r.name,
  quantity: r.quantity,
  baseCurrency: r.base_currency ?? "IDR",
  unitPrice: moneyJson(r.unit_price),
  total: moneyJson(multiply(r.quantity, r.unit_price)),
  fxRateToIdr: r.fx_rate_to_idr == null ? null : canonical(r.fx_rate_to_idr),
  fxRateDate: r.fx_rate_date ?? null,
  fxRateProvider: r.fx_rate_provider ?? null,
  idrEquivalent: idrEquivalent(multiply(r.quantity, r.unit_price), r.fx_rate_to_idr ?? null),
  paymentMethod: r.payment_method,
  note: r.note,
  transactionAt: r.transaction_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const PaymentMethod = t.Union([
  t.Literal("cash"),
  t.Literal("transfer"),
  t.Literal("qris"),
  t.Literal("ewallet"),
  t.Literal("other"),
]);

const TransactionName = t.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const Quantity = t.Integer({ minimum: 1, maximum: 2147483647 });
const UnitPrice = MoneyInput;
const Note = t.Union([t.String({ maxLength: 2000 }), t.Null()]);
const TransactionAt = t.Optional(t.String());

const EventIdParam = t.Object({ eventId: t.String({ format: "uuid" }) });
const IdParam = t.Object({ id: t.String({ format: "uuid" }) });

const isClientError = (code?: string) => !!code && (code.startsWith("22") || code.startsWith("23"));
const isArchiveDbError = (error?: { code?: string }) => error?.code === "55000";

export function createTransactionRoutes(authPlugin: typeof auth = auth, fx: FxService = fxService) {
  return new Elysia()
  .use(authPlugin)
  // POST /api/events/:eventId/transactions - Tambah transaksi ke event
  .post(
    "/events/:eventId/transactions",
    async ({ user, db, params, body, status }) => {
      // 1. Verifikasi kepemilikan event terlebih dahulu
      const { data: event, error: eventErr } = await db
        .from("events")
        .select("id, status, base_currency")
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (eventErr) return status(500, { error: eventErr.message });
      if (!event) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(event.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      const currency = event.base_currency ?? "IDR";
      if ((body.currency !== undefined && body.currency !== currency) || (body.baseCurrency !== undefined && body.baseCurrency !== currency)) {
        return status(400, { error: "Nominal harus menggunakan mata uang dasar event." });
      }
      let unitPrice: string;
      try { unitPrice = normalizeMoney(body.unitPrice, currency); }
      catch (error) { return status(400, { error: (error as Error).message }); }
      const rate = await fx.snapshot(currency);
      // 2. Buat transaksi
      const { data, error } = await db
        .from("transactions")
        .insert({
          event_id: params.eventId,
          user_id: user.id,
          name: body.name.trim(),
          quantity: body.quantity ?? 1,
          unit_price: unitPrice,
          base_currency: currency,
          fx_rate_to_idr: rate?.rate ?? null,
          fx_rate_date: rate?.date ?? null,
          fx_rate_provider: rate?.provider ?? null,
          payment_method: body.paymentMethod,
          note: body.note ?? null,
          transaction_at: body.transactionAt ?? new Date().toISOString(),
        })
        .select(TRANSACTION_SELECT)
        .single();

      if (error) {
        return status(isArchiveDbError(error) ? 409 : isClientError(error.code) ? 400 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
        });
      }
      return status(201, toTransaction(data as TransactionRow));
    },
    {
      params: EventIdParam,
      body: t.Object({
        name: TransactionName,
        quantity: t.Optional(Quantity),
        unitPrice: UnitPrice,
        currency: t.Optional(t.String({ pattern: "^[A-Z]{3}$" })),
        baseCurrency: t.Optional(t.String({ pattern: "^[A-Z]{3}$" })),
        paymentMethod: PaymentMethod,
        note: t.Optional(Note),
        transactionAt: TransactionAt,
      }),
    },
  )
  // PATCH /api/transactions/:id - Edit transaksi
  .patch(
    "/transactions/:id",
    async ({ user, db, params, body, status }) => {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.quantity !== undefined) patch.quantity = body.quantity;
      if (body.unitPrice !== undefined) patch.unit_price = body.unitPrice;
      if (body.paymentMethod !== undefined) patch.payment_method = body.paymentMethod;
      if (body.note !== undefined) patch.note = body.note;
      if (body.transactionAt !== undefined) patch.transaction_at = body.transactionAt;

      if (Object.keys(patch).length === 0) {
        return status(400, { error: "No fields to update" });
      }

      const { data: transaction, error: transactionError } = await db
        .from("transactions")
        .select("event_id")
        .eq("id", params.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (transactionError) return status(500, { error: transactionError.message });
      if (!transaction) return status(404, { error: "Transaction not found" });

      const { data: event, error: eventError } = await db
        .from("events")
        .select("status, base_currency")
        .eq("id", transaction.event_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (eventError) return status(500, { error: eventError.message });
      if (!event) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(event.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      const currency = event.base_currency ?? "IDR";
      if ((body.currency !== undefined && body.currency !== currency) || (body.baseCurrency !== undefined && body.baseCurrency !== currency)) {
        return status(400, { error: "Nominal harus menggunakan mata uang dasar event." });
      }
      if (body.unitPrice !== undefined) {
        try { patch.unit_price = normalizeMoney(body.unitPrice, currency); }
        catch (error) { return status(400, { error: (error as Error).message }); }
      }
      patch.updated_at = new Date().toISOString();

      const { data, error } = await db
        .from("transactions")
        .update(patch)
        .eq("id", params.id)
        .eq("user_id", user.id)
        .select(TRANSACTION_SELECT)
        .maybeSingle();

      if (error) {
        return status(isArchiveDbError(error) ? 409 : isClientError(error.code) ? 400 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
        });
      }
      if (!data) return status(404, { error: "Transaction not found" });

      return toTransaction(data as TransactionRow);
    },
    {
      params: IdParam,
      body: t.Object({
        name: t.Optional(TransactionName),
        quantity: t.Optional(Quantity),
        unitPrice: t.Optional(UnitPrice),
        currency: t.Optional(t.String({ pattern: "^[A-Z]{3}$" })),
        baseCurrency: t.Optional(t.String({ pattern: "^[A-Z]{3}$" })),
        paymentMethod: t.Optional(PaymentMethod),
        note: t.Optional(Note),
        transactionAt: TransactionAt,
      }),
    },
  )
  // DELETE /api/transactions/:id - Hapus transaksi
  .delete(
    "/transactions/:id",
    async ({ user, db, params, status }) => {
      const { data: transaction, error: transactionError } = await db
        .from("transactions")
        .select("event_id")
        .eq("id", params.id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (transactionError) return status(500, { error: transactionError.message });
      if (!transaction) return status(404, { error: "Transaction not found" });

      const { data: event, error: eventError } = await db
        .from("events")
        .select("status")
        .eq("id", transaction.event_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (eventError) return status(500, { error: eventError.message });
      if (!event) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(event.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      const { data, error } = await db
        .from("transactions")
        .delete()
        .eq("id", params.id)
        .eq("user_id", user.id)
        .select("id");

      if (error) {
        return status(isArchiveDbError(error) ? 409 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
        });
      }
      if (!data || data.length === 0) return status(404, { error: "Transaction not found" });

      return { deleted: true };
    },
    { params: IdParam },
  );
}

export const transactionRoutes = createTransactionRoutes();
