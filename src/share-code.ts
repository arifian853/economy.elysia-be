export type ShareCodeStore = {
  read: () => Promise<{ found: boolean; code: string | null }>;
  createIfEmpty: (
    candidate: string,
  ) => Promise<{ found: boolean; code: string | null; created: boolean }>;
};

export type EnsureShareCodeResult =
  | { status: "ready"; code: string }
  | { status: "not-found" }
  | { status: "unavailable" };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const CODE_LENGTH = 22;

export function generateShareCode(): string {
  const bytes = new Uint8Array(32);
  let code = "";
  while (code.length < CODE_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 248) code += ALPHABET[byte % ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

export async function ensureShareCode(
  store: ShareCodeStore,
  generate: () => string = generateShareCode,
): Promise<EnsureShareCodeResult> {
  const current = await store.read();
  if (!current.found) return { status: "not-found" };
  if (current.code) return { status: "ready", code: current.code };

  const candidate = generate();
  const result = await store.createIfEmpty(candidate);
  if (!result.found) return { status: "not-found" };
  if (result.created && result.code === candidate) return { status: "ready", code: candidate };
  if (result.code) return { status: "ready", code: result.code };
  return { status: "unavailable" };
}
