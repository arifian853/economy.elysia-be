import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { createEvidenceRoutes } from "../src/routes/evidence";

const transactionId = "00000000-0000-0000-0000-000000000001";
const userId = "owner-1";

type EvidenceState = {
  inserts: Record<string, unknown>[];
  insertError?: { code: string };
  insertThrows?: boolean;
};

class EvidenceQuery {
  inserted: Record<string, unknown> | null = null;
  constructor(private readonly table: string, private readonly state: EvidenceState) {}
  select(_fields?: string) { return this; }
  eq(_key: string, _value: unknown) { return this; }
  order(_key: string, _opts?: unknown) { return this; }
  insert(row: Record<string, unknown>) { this.inserted = row; this.state.inserts.push(row); return this; }
  async maybeSingle() {
    if (this.table === "transactions") return { data: { id: transactionId, event_id: "event-1" }, error: null };
    if (this.table === "events") return { data: { status: "active" }, error: null };
    return { data: null, error: null };
  }
  async single() {
    if (this.state.insertThrows) throw new Error("Insert unavailable");
    return { data: { id: "evidence-1", ...this.inserted, created_at: "2026-10-01T00:00:00Z" }, error: this.state.insertError ?? null };
  }
}

function makeApp() {
  const state = { inserts: [] as Record<string, unknown>[] };
  const db = { from: (table: string) => new EvidenceQuery(table, state) };
  const auth = new Elysia({ name: `evidence-test-${Math.random()}` }).resolve({ as: "scoped" }, () => ({ user: { id: userId }, db }));
  return { app: new Elysia().use(createEvidenceRoutes(auth as never)), state };
}

async function post(app: { handle(request: Request): Promise<Response> }, payload: unknown) {
  return app.handle(new Request(`http://localhost/transactions/${transactionId}/evidence-links`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
}

describe("expense evidence API", () => {
  test("saves a validated HTTPS evidence link attached to the owned transaction", async () => {
    const { app, state } = makeApp();
    const response = await post(app, { url: "https://receipt.example/abc", label: "Nota" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ type: "link", label: "Nota", url: "https://receipt.example/abc" });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ transaction_id: transactionId, user_id: userId, evidence_type: "link" });
  });

  test("uploads a validated file through private storage and records only its metadata", async () => {
    const { app, state } = makeApp();
    const original = {
      account: process.env.CLOUDFLARE_R2_ACCOUNT_ID,
      access: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secret: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      bucket: process.env.CLOUDFLARE_R2_BUCKET,
    };
    process.env.CLOUDFLARE_R2_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "test-key";
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.CLOUDFLARE_R2_BUCKET = "test-bucket";
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "receipt.png", { type: "image/png" }));
    const db = { from: (table: string) => new EvidenceQuery(table, state) };
    const auth = new Elysia({ name: `upload-auth-${Math.random()}` }).resolve({ as: "scoped" }, () => ({ user: { id: userId }, db }));
    const remove = mock(async () => undefined);
    const uploadApp = new Elysia().use(createEvidenceRoutes(
      auth as never,
      { store: async () => "private/object-key", readUrl: async () => {
        expect(state.inserts).toHaveLength(0);
        return "https://signed.example/file";
      }, remove },
    ));
    try {
      const response = await uploadApp.handle(new Request(`http://localhost/transactions/${transactionId}/evidence-files`, { method: "POST", body: form }));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ type: "file", fileName: "receipt.png", url: "https://signed.example/file" });
      expect(state.inserts[0]).toMatchObject({ transaction_id: transactionId, user_id: userId, evidence_type: "file", object_key: "private/object-key" });
      expect(state.inserts[0]).not.toHaveProperty("url");
      expect(state.inserts[0]).not.toHaveProperty("link_url");
      expect(remove).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries({
        CLOUDFLARE_R2_ACCOUNT_ID: original.account,
        CLOUDFLARE_R2_ACCESS_KEY_ID: original.access,
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: original.secret,
        CLOUDFLARE_R2_BUCKET: original.bucket,
      })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test("rejects insecure links without inserting evidence", async () => {
    const { app, state } = makeApp();
    const response = await post(app, { url: "javascript:alert(1)", label: "Receipt" });
    expect(response.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  test.each([
    { failure: "URL signing fails", signFails: true, insertError: undefined, insertThrows: false, cleanupFails: false, expectedStatus: 503 },
    { failure: "URL signing and cleanup fail", signFails: true, insertError: undefined, insertThrows: false, cleanupFails: true, expectedStatus: 503 },
    { failure: "the insert returns a client error", signFails: false, insertError: { code: "23514" }, insertThrows: false, cleanupFails: false, expectedStatus: 400 },
    { failure: "the insert returns a server error", signFails: false, insertError: { code: "XX000" }, insertThrows: false, cleanupFails: false, expectedStatus: 500 },
    { failure: "the insert throws", signFails: false, insertError: undefined, insertThrows: true, cleanupFails: false, expectedStatus: 503 },
  ])("attempts object cleanup when $failure", async ({ signFails, insertError, insertThrows, cleanupFails, expectedStatus }) => {
    const original = {
      CLOUDFLARE_R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID,
      CLOUDFLARE_R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      CLOUDFLARE_R2_BUCKET: process.env.CLOUDFLARE_R2_BUCKET,
    };
    Object.assign(process.env, {
      CLOUDFLARE_R2_ACCOUNT_ID: "test-account", CLOUDFLARE_R2_ACCESS_KEY_ID: "test-key",
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: "test-secret", CLOUDFLARE_R2_BUCKET: "test-bucket",
    });
    const state: EvidenceState = { inserts: [], insertError, insertThrows };
    const db = { from: (table: string) => new EvidenceQuery(table, state) };
    const auth = new Elysia({ name: `signing-failure-auth-${Math.random()}` }).resolve({ as: "scoped" }, () => ({ user: { id: userId }, db }));
    const objectKey = "private/object-key";
    const storage = {
      store: mock(async () => objectKey),
      readUrl: mock(async () => {
        if (signFails) throw new Error("Signing unavailable");
        return "https://signed.example/file";
      }),
      remove: mock(async () => {
        if (cleanupFails) throw new Error("Cleanup unavailable");
      }),
    };
    const app = new Elysia().use(createEvidenceRoutes(auth as never, storage));
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "receipt.png", { type: "image/png" }));
    try {
      const response = await app.handle(new Request(`http://localhost/transactions/${transactionId}/evidence-files`, { method: "POST", body: form }));
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: expectedStatus === 503
        ? "Penyimpanan bukti belum tersedia. Periksa konfigurasi Cloudflare R2."
        : "Gagal menyimpan bukti file." });
      expect(storage.store).toHaveBeenCalledTimes(1);
      expect(storage.readUrl).toHaveBeenCalledWith(objectKey);
      expect(storage.remove).toHaveBeenCalledTimes(1);
      expect(storage.remove).toHaveBeenCalledWith(objectKey);
      expect(state.inserts).toHaveLength(signFails ? 0 : 1);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
});
