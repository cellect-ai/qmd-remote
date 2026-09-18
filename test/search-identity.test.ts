import { expect, test } from "vitest";
import { identityCoverage, documentIdentity, documentTypeBoost } from "../src/search-identity.js";
test("person and project both matter, not just repeated subscription boilerplate", () => {
  const scores = identityCoverage("I need subscription agreement for Lucas Zorzal for Jersey and Bright", [
    "Lucas Silva Zorzal Jersey Avenue Bright subscription_agreement",
    "Lucas Silva Zorzal 236 Montgomery subscription_agreement",
    "Bruno Maeda Jersey Bright subscription_agreement",
  ]);
  expect(scores[0]).toBeGreaterThan(scores[1]!);
  expect(scores[0]).toBeGreaterThan(scores[2]!);
});
test("requested type distinguishes an agreement from correspondence without hiding void agreements", () => {
  const query = "subscription agreement for Lucas Zorzal Jersey Bright";
  expect(documentTypeBoost(query, {type:"subscription_agreement", status:"void"})).toBe(0.1);
  expect(documentTypeBoost(query, {type:"subscription_void_confirmation", status:"executed"})).toBe(0);
  expect(documentTypeBoost("zorzal void subscription agreement", {type:"subscription_void_confirmation"})).toBe(0.1);
  expect(documentTypeBoost("zorzal void subscription agreement", {type:"subscription_agreement"})).toBe(0);
  expect(documentTypeBoost("zorzal", {type:"subscription_agreement"})).toBe(0);
});
test("an explicit void request distinguishes a void confirmation from an executed agreement", () => {
  const scores=identityCoverage("zorzal void subscription agreement", ["Zorzal void-subscription-agreement", "Zorzal subscription-agreement"]);
  expect(scores[0]).toBeGreaterThan(scores[1]!);
});
test("unknown words do not manufacture identity evidence", () => {
  expect(identityCoverage("Quuxzzxnonexistentperson", ["tax return", "subscription agreement"])).toEqual([0,0]);
});
test("source filename and authoritative parties survive misleading OCR headings", () => {
  expect(documentIdentity("SIGN HERE", '---\ntitle: "lucas-zorzal-subscription.pdf"\n---\nText', {parties:["Lucas Zorzal"]})).toContain("lucas-zorzal-subscription.pdf");
});
