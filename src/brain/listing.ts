import { complete, parseJson, type Msg } from "./anthropic.js";
import { DESCRIPTION_LIMITS, type ItemAttributes, type ListingDraft, type Platform, type PriceSuggestion } from "../types.js";

const VOICE: Record<Platform, string> = {
  ebay:
    "eBay: keyword-dense title up to 80 chars (brand, item, size, color, key terms buyers search). " +
    "Description is factual, scannable, states condition and every flaw plainly. No hype.",
  poshmark:
    "Poshmark: warmer, social tone. Shorter title. Description can use a couple of tasteful emojis, " +
    "mention styling, still states condition and flaws honestly.",
  depop:
    "Depop: casual and style-forward, but still honest. Keep the title search-friendly, " +
    "mention fit, vibe, measurements, condition, and flaws plainly. Avoid hype or invented details.",
};

const SYSTEM = `You write second-hand resale listings. Given item attributes and a target price,
write a listing for the requested platform. State condition and flaws honestly.
Never invent details not present in the attributes.
Reply with ONLY JSON: { "title": string, "description": string }`;

/** Cuts at the last sentence or paragraph end that fits; a hard cut only when there is none. */
export function fitDescription(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit + 1);
  const sentence = Math.max(...[". ", "! ", "? ", ".\n", "!\n", "?\n"].map((end) => head.lastIndexOf(end)));
  const para = head.lastIndexOf("\n\n");
  const cut = sentence >= 0 && sentence + 1 <= limit ? sentence + 1 : para > 0 ? para : limit;
  return text.slice(0, cut).trimEnd();
}

type Ask = (system: string, messages: Msg[], maxTokens?: number) => Promise<string>;
type Reply = { title: string; description: string };

export async function generateListing(
  attrs: ItemAttributes,
  price: PriceSuggestion,
  platform: Platform,
  ask: Ask = complete
): Promise<ListingDraft> {
  const limit = DESCRIPTION_LIMITS[platform];
  const messages: Msg[] = [
    {
      role: "user",
      content:
        `Platform rules: ${VOICE[platform]}` +
        (limit ? ` The description must be at most ${limit} characters, spaces and line breaks included.` : "") +
        `\n\nAttributes: ${JSON.stringify(attrs)}\n` +
        `Target price: ${price.suggested} ${price.currency}\n\n` +
        `Write the listing as JSON.`,
    },
  ];
  const raw = await ask(SYSTEM, messages, 2500);
  const { title } = parseJson<Reply>(raw);
  let { description } = parseJson<Reply>(raw);
  if (limit && description.length > limit) {
    // One rewrite before any cut: a cut could drop the flaws, which buyers must see.
    const retry = await ask(
      SYSTEM,
      [
        ...messages,
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That description is ${description.length} characters; the limit is ${limit}. Rewrite it under ${limit} characters. Keep the condition and every flaw; cut styling and filler first. Reply with the same JSON.`,
        },
      ],
      2500
    );
    description = parseJson<Reply>(retry).description || description;
  }
  if (limit) description = fitDescription(description, limit);
  return {
    platform,
    title: title.slice(0, platform === "ebay" ? 80 : 120),
    description,
    price: price.suggested,
    condition: attrs.condition,
  };
}
