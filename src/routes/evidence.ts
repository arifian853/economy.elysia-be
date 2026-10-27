import { Elysia, t } from "elysia";
import { auth } from "../auth";
import {
  createEvidenceReadUrl, deleteEvidenceObject, evidenceMagicMatches, readR2Config,
  storeEvidence, validateEvidenceFile, validateEvidenceLink,
} from "../evidence-storage";

const IdParam = t.Object({ id: t.String({ format: "uuid" }) });
const clientError = (code?: string) => !!code && (code.startsWith("22") || code.startsWith("23"));

type EvidenceStorage = { store: typeof storeEvidence; readUrl: typeof createEvidenceReadUrl; remove: typeof deleteEvidenceObject };
const defaultStorage: EvidenceStorage = { store: storeEvidence, readUrl: createEvidenceReadUrl, remove: deleteEvidenceObject };

export function createEvidenceRoutes(authPlugin: typeof auth = auth, storage: EvidenceStorage = defaultStorage) {
  const ownedOpenTransaction = async (db: any, userId: string, transactionId: string, allowArchived = false): Promise<
    { tx: { id: string; event_id: string } } | { error: string; status: 404 | 409 | 500 }
  > => {
    const { data: tx, error } = await db.from("transactions").select("id, event_id").eq("id", transactionId).eq("user_id", userId).maybeSingle();
    if (error) return { error: "Gagal membaca pengeluaran.", status: 500 as const };
    if (!tx) return { error: "Pengeluaran tidak ditemukan.", status: 404 as const };
    const { data: event, error: eventError } = await db.from("events").select("status").eq("id", tx.event_id).eq("user_id", userId).maybeSingle();
    if (eventError) return { error: "Gagal memeriksa event.", status: 500 as const };
    if (!event) return { error: "Event tidak ditemukan.", status: 404 as const };
    if (event.status === "completed" && !allowArchived) return { error: "Event sudah diarsipkan dan hanya bisa dilihat.", status: 409 as const };
    return { tx };
  };

  return new Elysia({ prefix: "/transactions" }).use(authPlugin)
    .get("/:id/evidence", async ({ user, db, params, status }) => {
      const owned = await ownedOpenTransaction(db, user.id, params.id, true);
      if ("error" in owned) return status(owned.status, { error: owned.error });
      const { data, error } = await db.from("transaction_evidence").select("id, evidence_type, label, link_url, object_key, file_name, content_type, byte_size, created_at")
        .eq("transaction_id", params.id).eq("user_id", user.id).order("created_at", { ascending: true });
      if (error) return status(500, { error: "Gagal membaca bukti pengeluaran." });
      try {
        return await Promise.all((data ?? []).map(async (row: any) => ({
          id: row.id, type: row.evidence_type, label: row.label,
          url: row.evidence_type === "link" ? row.link_url : await storage.readUrl(row.object_key),
          fileName: row.file_name, contentType: row.content_type, byteSize: row.byte_size, createdAt: row.created_at,
        })));
      } catch {
        return status(503, { error: "Bukti file sementara tidak tersedia." });
      }
    }, { params: IdParam })
    .post("/:id/evidence-links", async ({ user, db, params, body, status }) => {
      const owned = await ownedOpenTransaction(db, user.id, params.id);
      if ("error" in owned) return status(owned.status, { error: owned.error });
      const validation = validateEvidenceLink(body.url);
      if (!validation.ok) return status(400, { error: validation.reason });
      const { data, error } = await db.from("transaction_evidence").insert({ transaction_id: params.id, user_id: user.id,
        evidence_type: "link", label: body.label.trim(), link_url: body.url }).select("id, evidence_type, label, link_url, created_at").single();
      if (error) return status(clientError((error as any).code) ? 400 : 500, { error: "Gagal menyimpan tautan bukti." });
      return status(201, { id: data.id, type: data.evidence_type, label: data.label, url: data.link_url, createdAt: data.created_at });
    }, { params: IdParam, body: t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }), label: t.String({ minLength: 1, maxLength: 200, pattern: "\\S" }) }) })
    .post("/:id/evidence-files", async ({ user, db, params, body, status }) => {
      const owned = await ownedOpenTransaction(db, user.id, params.id);
      if ("error" in owned) return status(owned.status, { error: owned.error });
      const file = body.file;
      const validation = validateEvidenceFile(file);
      if (!validation.ok) return status(400, { error: validation.reason });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!evidenceMagicMatches(file.type, bytes)) return status(400, { error: "Isi file tidak cocok dengan format yang dikirim." });
      let objectKey: string | undefined;
      let inserted = false;
      try {
        readR2Config();
        objectKey = await storage.store(user.id, params.id, file, bytes, validation.safeName!);
        const url = await storage.readUrl(objectKey);
        const { data, error } = await db.from("transaction_evidence").insert({ transaction_id: params.id, user_id: user.id,
          evidence_type: "file", label: validation.safeName!, object_key: objectKey, file_name: validation.safeName!,
          content_type: file.type, byte_size: file.size }).select("id, label, file_name, content_type, byte_size, created_at").single();
        if (error) {
          return status(clientError((error as any).code) ? 400 : 500, { error: "Gagal menyimpan bukti file." });
        }
        inserted = true;
        return status(201, { id: data.id, type: "file", label: data.label, fileName: data.file_name,
          contentType: data.content_type, byteSize: data.byte_size, createdAt: data.created_at,
          url });
      } catch {
        return status(503, { error: "Penyimpanan bukti belum tersedia. Periksa konfigurasi Cloudflare R2." });
      } finally {
        if (objectKey !== undefined && !inserted) {
          try { await storage.remove(objectKey); }
          catch { /* Preserve the original failure if cleanup is unavailable. */ }
        }
      }
    }, { params: IdParam, body: t.Object({ file: t.File({ maxSize: 12 * 1024 * 1024 }) }) })
    .delete("/evidence/:id", async ({ user, db, params, status }) => {
      const { data: row, error: readError } = await db.from("transaction_evidence").select("id, transaction_id, object_key")
        .eq("id", params.id).eq("user_id", user.id).maybeSingle();
      if (readError) return status(500, { error: "Gagal membaca bukti." });
      if (!row) return status(404, { error: "Bukti tidak ditemukan." });
      const owned = await ownedOpenTransaction(db, user.id, row.transaction_id);
      if ("error" in owned) return status(owned.status, { error: owned.error });
      if (row.object_key) {
        try { await storage.remove(row.object_key); }
        catch { return status(503, { error: "Gagal menghapus file bukti dari penyimpanan." }); }
      }
      const { data, error } = await db.from("transaction_evidence").delete().eq("id", params.id).eq("user_id", user.id).select("id");
      if (error) return status(500, { error: "Gagal menghapus bukti." });
      if (!data?.length) return status(404, { error: "Bukti tidak ditemukan." });
      return { deleted: true };
    }, { params: IdParam });
}

export const evidenceRoutes = createEvidenceRoutes();
