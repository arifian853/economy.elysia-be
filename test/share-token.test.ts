import { describe, expect, test } from "bun:test";
import { generateShareToken, ensureShareToken, type ShareTokenStore } from "../src/share-token";
import { ensureShareCode, generateShareCode, type ShareCodeStore } from "../src/share-code";

describe("public share token", () => {
  test("creates a short code only when the owned event has none", async () => {
    let stored: string | null = null;
    const store: ShareCodeStore = {
      read: async () => ({ found: true, code: stored }),
      createIfEmpty: async (candidate) => {
        if (stored) return { found: true, code: stored, created: false };
        stored = candidate;
        return { found: true, code: candidate, created: true };
      },
    };
    expect(await ensureShareCode(store, () => "Ab3dE5fG7hJ9kLmN2pQ4rS")).toEqual({
      status: "ready",
      code: "Ab3dE5fG7hJ9kLmN2pQ4rS",
    });
  });

  test("reuses an existing short code without rotating shared links", async () => {
    const store: ShareCodeStore = {
      read: async () => ({ found: true, code: "Ab3dE5fG7hJ9kLmN2pQ4rS" }),
      createIfEmpty: async () => { throw new Error("must not rotate"); },
    };
    expect(await ensureShareCode(store)).toEqual({ status: "ready", code: "Ab3dE5fG7hJ9kLmN2pQ4rS" });
  });

  test("does not create a code for an event the owner cannot read", async () => {
    const store: ShareCodeStore = {
      read: async () => ({ found: false, code: null }),
      createIfEmpty: async () => ({ found: false, code: null, created: false }),
    };
    expect(await ensureShareCode(store)).toEqual({ status: "not-found" });
  });

  test("generates compact 22-character share codes from a URL-safe alphabet", () => {
    expect(generateShareCode()).toMatch(/^[A-Za-z0-9]{22}$/);
  });

  test("uses 32 cryptographically random bytes encoded as lowercase hex", () => {
    expect(generateShareToken()).toMatch(/^[a-f0-9]{64}$/);
  });

  test("creates a token only when the owned event is still private", async () => {
    let storedToken: string | null = null;
    const store: ShareTokenStore = {
      read: async () => ({ found: true, token: storedToken }),
      createIfEmpty: async (candidate) => {
        if (storedToken) return { found: true, token: storedToken, created: false };
        storedToken = candidate;
        return { found: true, token: candidate, created: true };
      },
    };
    const token = "b".repeat(64);

    expect(await ensureShareToken(store, () => token)).toEqual({ status: "ready", token });
    const readStoredToken = (): string | null => storedToken;
    expect(readStoredToken()).toBe(token);
  });

  test("reuses an active token instead of rotating it on every open", async () => {
    const store: ShareTokenStore = {
      read: async () => ({ found: true, token: "c".repeat(64) }),
      createIfEmpty: async () => {
        throw new Error("active token should not be replaced");
      },
    };

    expect(await ensureShareToken(store, () => "d".repeat(64))).toEqual({
      status: "ready",
      token: "c".repeat(64),
    });
  });

  test("does not create a share link for an event the owner cannot read", async () => {
    const store: ShareTokenStore = {
      read: async () => ({ found: false, token: null }),
      createIfEmpty: async () => ({ found: false, token: null, created: false }),
    };

    expect(await ensureShareToken(store, () => "e".repeat(64))).toEqual({ status: "not-found" });
  });

  test("uses the token installed by a concurrent share request", async () => {
    const activeToken = "f".repeat(64);
    const store: ShareTokenStore = {
      read: async () => ({ found: true, token: null }),
      createIfEmpty: async () => ({ found: true, token: activeToken, created: false }),
    };

    expect(await ensureShareToken(store, () => "a".repeat(64))).toEqual({
      status: "ready",
      token: activeToken,
    });
  });
});
