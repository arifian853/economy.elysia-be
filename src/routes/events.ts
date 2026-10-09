import { Elysia, t } from "elysia";
import { auth } from "../auth";
import { ensureShareCode, type ShareCodeStore } from "../share-code";
import { resolveCashBudgetUpdate } from "../budget-allocation";
import { ARCHIVED_EVENT_MUTATION_ERROR, getArchiveConflict } from "../event-archive";

type EventRow = {
  id: string;
  name: string;
  event_date: string;
  budget: number;
  cash_budget: number | null;
  status: "upcoming" | "active" | "completed";
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type TransactionRow = {
  id: string;
  event_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  payment_method: string;
  note: string | null;
  transaction_at: string;
};

const toEvent = (r: EventRow) => ({
  id: r.id,
  name: r.name,
  eventDate: r.event_date,
  budget: Number(r.budget),
  cashBudget: r.cash_budget === null ? null : Number(r.cash_budget),
  digitalBudget: r.cash_budget === null ? null : Number(r.budget) - Number(r.cash_budget),
  status: r.status,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

const toTransaction = (r: TransactionRow) => ({
  id: r.id,
  eventId: r.event_id,
  name: r.name,
  quantity: r.quantity,
  unitPrice: Number(r.unit_price),
  total: r.quantity * Number(r.unit_price),
  paymentMethod: r.payment_method,
  note: r.note,
  transactionAt: r.transaction_at,
});

const ParticipantName = t.String({ minLength: 1, maxLength: 100, pattern: "\\S" });
const EditableStatus = t.Union([t.Literal("upcoming"), t.Literal("active")]);
const Name = t.String({ minLength: 1, maxLength: 200, pattern: "\\S" }); // tidak boleh kosong/spasi saja
const EventDate = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Budget = t.Integer({ minimum: 1 });
const Notes = t.Union([t.String({ maxLength: 2000 }), t.Null()]);
const EventId = t.Object({ eventId: t.String({ format: "uuid" }) });

// Error Postgres kelas 22xxx/23xxx (nilai/constraint tidak valid) = salah input, bukan error server.
const isClientError = (code?: string) => !!code && (code.startsWith("22") || code.startsWith("23"));
const isArchiveDbError = (error?: { code?: string }) => error?.code === "55000";

export function createEventRoutes(authPlugin: typeof auth = auth) {
  return new Elysia({ prefix: "/events" })
  .use(authPlugin)
  .get("/", async ({ user, db, status }) => {
    const { data, error } = await db
      .from("events")
      .select("*, transactions(quantity, unit_price), participants(id)")
      .eq("user_id", user.id)
      .order("event_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) return status(500, { error: error.message });

    type ListRow = EventRow & {
      transactions: { quantity: number; unit_price: number }[];
      participants: { id: string }[];
    };
    return (data as ListRow[]).map(({ transactions, participants, ...event }) => ({
      ...toEvent(event),
      totalExpenses: transactions.reduce((sum, x) => sum + x.quantity * x.unit_price, 0),
      participantCount: participants.length,
    }));
  })
  .post(
    "/",
    async ({ user, db, body, status }) => {
      const { data, error } = await db
        .from("events")
        .insert({
          user_id: user.id,
          name: body.name.trim(),
          event_date: body.eventDate,
          budget: body.budget,
          status: body.status ?? "upcoming",
          notes: body.notes ?? null,
        })
        .select()
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

      return status(201, toEvent(data as EventRow));
    },
    {
      body: t.Object({
        name: Name,
        eventDate: EventDate,
        budget: Budget,
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
        .select()
        .maybeSingle();
      if (error) {
        return status(isArchiveDbError(error) ? 409 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
        });
      }
      if (!data) return status(409, { error: ARCHIVED_EVENT_MUTATION_ERROR });
      return toEvent(data as EventRow);
    },
    { params: EventId },
  )
  .get(
    "/:eventId/public-link",
    async ({ user, db, params, status }) => {
      const { data: existing, error: lookupError } = await db.from("events")
        .select("public_share_token, public_share_code")
        .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
      if (lookupError) return status(500, { error: "Gagal membaca status tautan publik." });
      if (!existing) return status(404, { error: "Event tidak ditemukan." });
      if (!existing.public_share_token && !existing.public_share_code) return { enabled: false, token: null };
      if (existing.public_share_code) return { enabled: true, token: existing.public_share_code };

      const store: ShareCodeStore = {
        read: async () => {
          const { data, error } = await db.from("events")
            .select("public_share_token, public_share_code")
            .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
          if (error) throw error;
          return { found: Boolean(data), code: data?.public_share_code ?? null };
        },
        createIfEmpty: async (candidate) => {
          const { data, error } = await db.from("events")
            .update({ public_share_code: candidate })
            .eq("id", params.eventId).eq("user_id", user.id)
            .is("public_share_code", null)
            .select("public_share_code").maybeSingle();
          if (error) throw error;
          if (data) return { found: true, code: data.public_share_code, created: true };
          const current = await store.read();
          return { ...current, created: false };
        },
      };
      try {
        const result = await ensureShareCode(store);
        if (result.status === "not-found") return status(404, { error: "Event tidak ditemukan." });
        if (result.status === "unavailable") return status(409, { error: "Tautan belum siap. Coba lagi." });
        return { enabled: true, token: result.code };
      } catch {
        return status(500, { error: "Gagal membaca status tautan publik." });
      }
    },
    { params: EventId },
  )
  .post(
    "/:eventId/public-link",
    async ({ user, db, params, status }) => {
      const store: ShareCodeStore = {
        read: async () => {
          const { data, error } = await db.from("events")
            .select("public_share_token, public_share_code")
            .eq("id", params.eventId).eq("user_id", user.id).maybeSingle();
          if (error) throw error;
          return { found: Boolean(data), code: data?.public_share_code ?? null };
        },
        createIfEmpty: async (candidate) => {
          const { data, error } = await db.from("events")
            .update({ public_share_code: candidate })
            .eq("id", params.eventId).eq("user_id", user.id)
            .is("public_share_code", null)
            .select("public_share_code").maybeSingle();
          if (error) throw error;
          if (data) return { found: true, code: data.public_share_code, created: true };
          return { ...(await store.read()), created: false };
        },
      };

      try {
        const result = await ensureShareCode(store);
        if (result.status === "not-found") {
          return status(404, { error: "Event tidak ditemukan." });
        }
        if (result.status === "unavailable") {
          return status(409, { error: "Tautan belum siap. Coba lagi." });
        }
        return { enabled: true, token: result.code };
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
        .update({ public_share_token: null, public_share_code: null })
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
        .select()
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) return status(500, { error: error.message });
      if (!event) return status(404, { error: "Event not found" });

      const [participants, transactions] = await Promise.all([
        db.from("participants").select("id, name").eq("event_id", params.eventId).order("created_at"),
        db.from("transactions").select().eq("event_id", params.eventId).order("transaction_at", { ascending: false }),
      ]);
      if (participants.error || transactions.error) {
        return status(500, { error: (participants.error ?? transactions.error)!.message });
      }

      return {
        event: toEvent(event as EventRow),
        participants: participants.data,
        transactions: (transactions.data as TransactionRow[]).map(toTransaction),
      };
    },
    { params: EventId },
  )
  .patch(
    "/:eventId",
    async ({ user, db, params, body, status }) => {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.eventDate !== undefined) patch.event_date = body.eventDate;
      if (body.budget !== undefined) patch.budget = body.budget;
      if (body.status !== undefined) patch.status = body.status;
      if (body.notes !== undefined) patch.notes = body.notes;

      if (body.budget !== undefined || body.cashBudget !== undefined) {
        const { data: current, error: currentError } = await db
          .from("events")
          .select("budget, cash_budget")
          .eq("id", params.eventId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (currentError) return status(500, { error: "Gagal memvalidasi pembagian anggaran." });
        if (!current) return status(404, { error: "Event not found" });

        const result = resolveCashBudgetUpdate(
          body.budget ?? Number(current.budget),
          current.cash_budget === null ? null : Number(current.cash_budget),
          body.cashBudget,
        );
        if (!result.ok) {
          return status(400, { error: "Anggaran tunai harus di antara Rp0 dan total anggaran." });
        }
        if (body.cashBudget !== undefined || result.cashBudget !== current.cash_budget) {
          patch.cash_budget = result.cashBudget;
        }
      }

      if (Object.keys(patch).length === 0 && body.participants === undefined) {
        return status(400, { error: "No fields to update" });
      }

      const { data: currentStatus, error: statusError } = await db
        .from("events")
        .select("status")
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (statusError) return status(500, { error: "Gagal memeriksa status event." });
      if (!currentStatus) return status(404, { error: "Event not found" });
      const archiveConflict = getArchiveConflict(currentStatus.status);
      if (archiveConflict) return status(409, { error: archiveConflict });

      patch.updated_at = new Date().toISOString();

      const { data, error } = await db
        .from("events")
        .update(patch)
        .eq("id", params.eventId)
        .eq("user_id", user.id)
        .select()
        .maybeSingle();
      if (error) {
        return status(isArchiveDbError(error) ? 409 : isClientError(error.code) ? 400 : 500, {
          error: isArchiveDbError(error) ? ARCHIVED_EVENT_MUTATION_ERROR : error.message,
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

      return toEvent(data as EventRow);
    },
    {
      params: EventId,
      body: t.Object({
        name: t.Optional(Name),
        eventDate: t.Optional(EventDate),
        budget: t.Optional(Budget),
        cashBudget: t.Optional(t.Union([t.Integer({ minimum: 0 }), t.Null()])),
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
