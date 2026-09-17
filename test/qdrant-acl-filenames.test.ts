import { afterEach, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aclPayloadForDocument } from "../src/qdrant-import.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const entry = { documentId: "doc_123", tenant: "shape", scopes: ["project:bright"], access: ["documents"] };
function manifest(documents: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "qmd-acl-paths-")); dirs.push(dir);
  const path = join(dir, "acl.json");
  writeFileSync(path, JSON.stringify({ version: 1, documents }));
  return { QMD_ACL_MANIFEST: path, QMD_ACL_MANIFEST_REQUIRED: "1" };
}
test("preserved underscore filenames resolve exact ACL entry", () => {
  expect(aclPayloadForDocument({ path: "doc_123.md" }, manifest({ "doc_123.md": entry }))).toMatchObject({ external_document_id: "doc_123", scope_keys: ["project:bright"] });
});
test("legacy normalized filenames remain supported", () => {
  expect(aclPayloadForDocument({ path: "doc-123.md" }, manifest({ "doc_123.md": entry }))).toMatchObject({ external_document_id: "doc_123" });
});
test("an exact/normalized collision remains ambiguous and fails closed", () => {
  expect(() => aclPayloadForDocument({ path: "doc-123.md" }, manifest({ "doc_123.md": entry, "doc-123.md": { ...entry, documentId: "other" } }))).toThrow("ambiguous");
});
test("unknown filenames cannot inherit another document's ACL", () => {
  expect(() => aclPayloadForDocument({ path: "unknown.md" }, manifest({ "doc_123.md": entry }))).toThrow("no entry");
});
