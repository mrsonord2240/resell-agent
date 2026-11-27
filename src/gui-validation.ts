import type { DraftBundle, ListingDraft, Platform } from "./types.js";

export const GUI_PLATFORMS: readonly Platform[] = ["ebay", "poshmark", "depop"];

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_CATEGORY_LENGTH = 32;

function cloneDraft(draft: DraftBundle): DraftBundle {
  return JSON.parse(JSON.stringify(draft)) as DraftBundle;
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && GUI_PLATFORMS.includes(value as Platform);
}

/**
 * Validate the platform list at the API boundary. An omitted list is handled
 * by the caller (the CLI intentionally retains its historical default).
 */
export function validatePlatformSelection(value: unknown): Platform[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Select at least one platform.");
  }

  const seen = new Set<Platform>();
  const result: Platform[] = [];
  for (const candidate of value) {
    if (!isPlatform(candidate)) {
      throw new Error(`Unsupported platform: ${String(candidate)}`);
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  if (!result.length) throw new Error("Select at least one platform.");
  return result;
}

function editableText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (!result) throw new Error(`${name} cannot be empty.`);
  if (result.length > maxLength) throw new Error(`${name} is too long.`);
  return result;
}

function editablePrice(value: unknown, allowZero: boolean): number {
  const minimum = allowZero ? 0 : Number.MIN_VALUE;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > 1_000_000) {
    throw new Error(allowZero
      ? "Price must be a finite non-negative number no greater than 1,000,000."
      : "Price must be a finite positive number no greater than 1,000,000.");
  }
  return Math.round(value * 100) / 100;
}

// Sanity bounds for hand-edited eBay item specifics; eBay's own limits still apply at publish.
const MAX_SPECIFICS = 60;
const MAX_SPECIFIC_VALUES = 30;
const MAX_SPECIFIC_TEXT = 100;

/** The whole eBay item-specifics map as Sam left it: names and values trimmed, empty values dropped, a name with none removed. */
function editableItemSpecifics(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("eBay item specifics must be an object.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SPECIFICS) throw new Error(`eBay accepts at most ${MAX_SPECIFICS} item specifics here.`);
  // No prototype: a specific named "constructor" or "__proto__" is just a name.
  const out: Record<string, string[]> = Object.create(null);
  for (const [rawName, rawValues] of entries) {
    const name = rawName.trim();
    if (!name) throw new Error("An eBay item specific name cannot be empty.");
    if (name.length > MAX_SPECIFIC_TEXT) throw new Error(`eBay item specific "${name.slice(0, 40)}" has a name that is too long.`);
    if (!Array.isArray(rawValues) || rawValues.some((v) => typeof v !== "string")) {
      throw new Error(`eBay item specific "${name}" must be a list of text values.`);
    }
    const values = (rawValues as string[]).map((v) => v.trim()).filter(Boolean);
    if (values.length > MAX_SPECIFIC_VALUES) throw new Error(`eBay item specific "${name}" has too many values.`);
    if (values.some((v) => v.length > MAX_SPECIFIC_TEXT)) throw new Error(`eBay item specific "${name}" has a value that is too long.`);
    if (!values.length) continue;
    out[name] = [...new Set([...(out[name] ?? []), ...values])];
  }
  return out;
}

/**
 * Merge only fields the review UI is allowed to edit into a server-owned
 * DraftBundle. Unknown fields are deliberately ignored; malformed editable
 * fields fail closed instead of partially changing the draft.
 */
export function mergeEditableListingFields(
  storedDraft: DraftBundle,
  submitted: unknown
): DraftBundle {
  if (!Array.isArray(submitted)) throw new Error("Listing edits must be an array.");

  const merged = cloneDraft(storedDraft);
  const byPlatform = new Map<Platform, ListingDraft>(
    merged.listings.map((listing) => [listing.platform, listing])
  );

  for (const patch of submitted) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("Each listing edit must be an object.");
    }
    const input = patch as Record<string, unknown>;
    if (!isPlatform(input.platform)) throw new Error(`Unsupported platform: ${String(input.platform)}`);
    const listing = byPlatform.get(input.platform);
    if (!listing) throw new Error(`No stored draft listing exists for ${input.platform}.`);

    if (Object.hasOwn(input, "title")) {
      listing.title = editableText(input.title, `${input.platform} title`, MAX_TITLE_LENGTH);
    }
    if (Object.hasOwn(input, "description")) {
      listing.description = editableText(input.description, `${input.platform} description`, MAX_DESCRIPTION_LENGTH);
    }
    if (Object.hasOwn(input, "price")) listing.price = editablePrice(input.price, input.platform !== "ebay");
    if (Object.hasOwn(input, "categoryId")) {
      if (input.platform !== "ebay") throw new Error("Only eBay may set categoryId.");
      if (typeof input.categoryId !== "string") throw new Error("eBay categoryId must be text.");
      const categoryId = input.categoryId.trim();
      if (!categoryId || categoryId.length > MAX_CATEGORY_LENGTH || !/^\d+$/.test(categoryId)) {
        throw new Error("eBay categoryId must be a numeric category id.");
      }
      listing.categoryId = categoryId;
    }
    if (Object.hasOwn(input, "itemSpecifics")) {
      if (input.platform !== "ebay") throw new Error("Only eBay has item specifics.");
      const specifics = editableItemSpecifics(input.itemSpecifics);
      if (Object.keys(specifics).length) listing.itemSpecifics = specifics;
      else delete listing.itemSpecifics;
    }
  }

  return merged;
}

export function stableGuiSku(draftId: string, configuredPrefix = ""): string {
  const safeId = draftId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  const prefix = configuredPrefix.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
  const sku = `${prefix ? `${prefix}-` : "resale-gui-"}${safeId}`;
  return sku.slice(0, 50);
}
