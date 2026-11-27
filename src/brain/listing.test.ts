// Listing generation against a scripted model. Run: npm test
import assert from "node:assert";
import { fitDescription, generateListing } from "./listing.js";
import type { ItemAttributes, PriceSuggestion } from "../types.js";

const attrs: ItemAttributes = {
  brand: "Louboutin", brandInferred: false, productName: null, category: "heels", titleKeywords: [], size: "37.5",
  color: "black", material: "leather", condition: "good", flaws: ["scuffed heel tips"], dimensions: null, originalRetail: null,
};
const price: PriceSuggestion = { suggested: 150, low: 120, high: 180, currency: "USD", basis: "test", sampleSize: 1 };
const reply = (description: string) => JSON.stringify({ title: "Louboutin heels", description });

// The Depop prompt names the cap; a reply within it is used as-is.
{
  const prompts: string[] = [];
  const ask = async (_s: string, messages: { content: unknown }[]) => { prompts.push(JSON.stringify(messages)); return reply("Short."); };
  const out = await generateListing(attrs, price, "depop", ask);
  assert.equal(out.description, "Short.");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /1000 characters/);
}

// Too long: the model is asked once to shorten (keeping condition and flaws), and its rewrite is used.
{
  const replies = [reply("x".repeat(1400)), reply("Rewritten, keeps the scuffed heel tips.")];
  const prompts: string[] = [];
  const ask = async (_s: string, messages: { content: unknown }[]) => { prompts.push(JSON.stringify(messages)); return replies.shift()!; };
  const out = await generateListing(attrs, price, "depop", ask);
  assert.equal(out.description, "Rewritten, keeps the scuffed heel tips.");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /1400 characters/);
  assert.match(prompts[1], /every flaw/);
}

// Still too long after the rewrite: cut at a sentence end, never past the cap.
{
  const replies = [reply("x".repeat(1400)), reply(`${"Sentence one. ".repeat(80)}`)];
  const out = await generateListing(attrs, price, "depop", async () => replies.shift()!);
  assert.ok(out.description.length <= 1000);
  assert.match(out.description, /\.$/);
}

// eBay has no description cap: no rewrite.
{
  let asked = 0;
  const out = await generateListing(attrs, price, "ebay", async () => { asked++; return reply("x".repeat(3000)); });
  assert.equal(asked, 1);
  assert.equal(out.description.length, 3000);
}

assert.equal(fitDescription("One. Two. Three.", 10), "One. Two.");
assert.equal(fitDescription("Para one.\n\nPara two is long.", 12), "Para one.");
assert.equal(fitDescription("x".repeat(20), 10), "x".repeat(10), "no boundary: a hard cut");
assert.equal(fitDescription("Fits.", 10), "Fits.");

console.log("listing.test ok");
