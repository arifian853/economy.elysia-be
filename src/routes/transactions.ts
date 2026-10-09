import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { ARCHIVED_EVENT_MUTATION_ERROR, getArchiveConflict } from "../event-archive";

export type TransactionRow = {
  id: string;
  event_id: string;
  user_id: string;
  name: string;
  quantity: number;
  unit_price: number;
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
  unitPrice: Number(r.unit_price),
  total: r.quantity * Number(r.unit_price),
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
const Quantity = t.Integer({ minimum: 1 });
const UnitPrice = t.Integer({ minimum: 0 });
const Note = t.Union([t.String({ maxLength: 2000 }), t.Null()]);
const TransactionAt = t.Optional(t.String());

const EventIdParam = t.Object({ eventId: t.String({ format: "uuid" }) });
const IdParam = t.Object({ id: t.String({ format: "uuid" }) });

const isClientError = (code?: string) => !!code && (code.startsWith("22") || code.startsWith("23"));
const isArchiveDbError = (error?: { code?: string }) => error?.code === "55000";

export function createTransactionRoutes(authPlugin: typeof auth = auth) {
  return new Elysia()
  .use(authPlugin)
  // POST /api/events/:eventId/transactions - Tambah transaksi ke event
  .post(
    "/events/:eventId/transactions",
    async ({ user, db, params, body, status }) => {
      // 1. Verifikasi kepemilikan event terlebih dahulu
      const { data: event, error: eventErr } = await db
        .from("events")
        .select("id, status")
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (eventErr) return status(500, { error: eventErr.message });
      if (!event) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(event.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      // 2. Buat transaksi
      const { data, error } = await db
        .from("transactions")
        .insert({
          event_id: params.eventId,
          user_id: user.id,
          name: body.name.trim(),
          quantity: body.quantity ?? 1,
          unit_price: body.unitPrice,
          payment_method: body.paymentMethod,
          note: body.note ?? null,
          transaction_at: body.transactionAt ?? new Date().toISOString(),
        })
        .select()
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
        .select("status")
        .eq("id", transaction.event_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (eventError) return status(500, { error: eventError.message });
      if (!event) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(event.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      patch.updated_at = new Date().toISOString();

      const { data, error } = await db
        .from("transactions")
        .update(patch)
        .eq("id", params.id)
        .eq("user_id", user.id)
        .select()
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
