import { expect, test } from "vitest";
import { scopedDocumentSnippet } from "../src/search-snippet.js";

test("name in filename metadata does not displace the actual document passage", () => {
  const body = '---\ntitle: Zorzal.pdf\nqmd:\n  metadata:\n    status: executed\n---\n\n# TRANSFER NOTICE\n\nAssignment of Lucas Zorzal interests.\nSigned today.\n';
  const result = scopedDocumentSnippet(body, "Zorzal", 0, body.length);
  expect(result.line).toBe(10);
  expect(result.snippet).toContain("10: Assignment of Lucas Zorzal interests.");
  expect(result.snippet).not.toMatch(/metadata:|qmd:|@@|title:/);
});

test("a selected later chunk keeps absolute line numbers", () => {
  const body = '---\nqmd:\n  metadata:\n    status: executed\n---\n' + 'Context line.\n'.repeat(60) + 'Lucas Zorzal subscription.\n';
  const result = scopedDocumentSnippet(body, "Zorzal", body.indexOf("Lucas"), 26);
  expect(result.line).toBe(66);
  expect(result.snippet).toContain("66: Lucas Zorzal subscription.");
});
