export type ShareTokenStore = {
  read: () => Promise<{ found: boolean; token: string | null }>;
  createIfEmpty: (
    candidate: string,
  ) => Promise<{ found: boolean; token: string | null; created: boolean }>;
};

export type EnsureShareTokenResult =
  | { status: "ready"; token: string }
  | { status: "not-found" }
  | { status: "unavailable" };

export function generateShareToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ensureShareToken(
  store: ShareTokenStore,
  generate: () => string = generateShareToken,
): Promise<EnsureShareTokenResult> {
  const current = await store.read();
  if (!current.found) return { status: "not-found" };
  if (current.token) return { status: "ready", token: current.token };

  const candidate = generate();
  const result = await store.createIfEmpty(candidate);
  if (!result.found) return { status: "not-found" };
  if (result.created && result.token === candidate) {
    return { status: "ready", token: candidate };
  }
  if (result.token) return { status: "ready", token: result.token };
  return { status: "unavailable" };
}
