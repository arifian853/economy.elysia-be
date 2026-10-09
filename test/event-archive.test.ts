import { describe, expect, test } from "bun:test";
import { getArchiveConflict } from "../src/event-archive";

describe("completed-event archive rules", () => {
  test("completed events reject every ledger mutation", () => {
    expect(getArchiveConflict("completed")).toBe("Event sudah diarsipkan dan hanya bisa dilihat.");
  });

  test("upcoming and active events remain editable", () => {
    expect(getArchiveConflict("upcoming")).toBeNull();
    expect(getArchiveConflict("active")).toBeNull();
  });

});
