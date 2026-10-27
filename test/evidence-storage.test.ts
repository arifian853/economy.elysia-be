import { describe, expect, test } from "bun:test";
import { validateEvidenceFile, validateEvidenceLink } from "../src/evidence-storage";

describe("evidence validation", () => {
  test("accepts secure links and rejects unsafe or malformed schemes", () => {
    expect(validateEvidenceLink("https://receipt.example/123").ok).toBe(true);
    expect(validateEvidenceLink("javascript:alert(1)").ok).toBe(false);
    expect(validateEvidenceLink("http://receipt.example/123").ok).toBe(false);
    expect(validateEvidenceLink("https://user:pass@example.com").ok).toBe(false);
    expect(validateEvidenceLink("not a url").ok).toBe(false);
  });

  test("allows supported receipt images/PDFs and enforces 12 MiB size", () => {
    expect(validateEvidenceFile({ name: "receipt.jpg", type: "image/jpeg", size: 1000 }).ok).toBe(true);
    expect(validateEvidenceFile({ name: "receipt.pdf", type: "application/pdf", size: 1000 }).ok).toBe(true);
    expect(validateEvidenceFile({ name: "payload.svg", type: "image/svg+xml", size: 1000 }).ok).toBe(false);
    expect(validateEvidenceFile({ name: "huge.jpg", type: "image/jpeg", size: 12 * 1024 * 1024 + 1 }).ok).toBe(false);
    expect(validateEvidenceFile({ name: "bad.jpg", type: "image/jpeg", size: 0 }).ok).toBe(false);
  });
});
