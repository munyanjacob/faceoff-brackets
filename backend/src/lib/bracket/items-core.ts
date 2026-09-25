import { prisma } from "@/lib/prisma";
import { validateBracketItemForm } from "@/app/dashboard/brackets/[id]/edit/validation";
import { uploadBracketItemImage } from "@/app/dashboard/brackets/[id]/edit/image-upload";

/**
 * The `BracketItem` add/update/remove business rules (issue #11, extended
 * by #12) shared between `../../app/dashboard/brackets/[id]/edit/
 * actions.ts`'s `addItem`/`updateItem`/`removeItem` Server Actions and
 * `../../app/api/brackets/[bracketId]/items/route.ts` +
 * `items/[itemId]/route.ts`'s REST route handlers (issue #77) - previously
 * the ownership/DRAFT-gated item lookup, validation-error mapping, and
 * image-upload-then-persist logic was re-derived in both.
 *
 * Takes the already ownership-looked-up `Bracket` row (each entry point
 * still owns its own auth/ownership lookup - see `publish-core.ts`'s
 * doc-comment for the identical reasoning) and a `FormData` - both entry
 * points already read a `BracketItem` add/edit as `FormData`
 * (`validateBracketItemForm`'s own long-standing input shape, kept as-is by
 * the REST routes via `request.formData()` since it's the natural fit for
 * an endpoint that can also carry an uploaded image file), so there's no
 * JSON-vs-FormData translation needed here.
 */

export const IMAGE_UPLOAD_ERROR = "Failed to upload the image. Please try again.";

/** The row shape every function here needs from the owning `Bracket` -
 * inferred from `prisma.bracket.findFirst`'s own return type, the same
 * pattern `@/lib/api/require-owned-bracket`'s `OwnedBracket` and
 * `./publish-core.ts`'s `PublishableBracket` use. */
export type ItemOwningBracket = NonNullable<
  Awaited<ReturnType<typeof prisma.bracket.findFirst>>
>;

type AddItemOutcome =
  | { kind: "notDraft" }
  | { kind: "validationError"; message: string }
  | { kind: "imageUploadFailed" }
  | { kind: "created"; item: Awaited<ReturnType<typeof prisma.bracketItem.create>> };

/**
 * Order mirrors both entry points exactly: DRAFT status (409/`NOT_DRAFT`)
 * -> form validation (400) -> image upload, if any (502/
 * `IMAGE_UPLOAD_FAILED`) -> create. Only a validated, non-null `image`
 * triggers an upload; a rejected title never reaches this (validation ran
 * first), so a bad title can never trigger a needless upload.
 */
export async function addBracketItemCore(
  bracket: ItemOwningBracket,
  formData: FormData
): Promise<AddItemOutcome> {
  if (bracket.status !== "DRAFT") {
    return { kind: "notDraft" };
  }

  const validated = validateBracketItemForm(formData);
  if (!validated.ok) {
    return { kind: "validationError", message: validated.error };
  }

  let imageUrl: string | null = null;
  if (validated.data.image) {
    try {
      imageUrl = await uploadBracketItemImage(bracket.id, validated.data.image);
    } catch {
      return { kind: "imageUploadFailed" };
    }
  }

  const item = await prisma.bracketItem.create({
    data: {
      bracketId: bracket.id,
      title: validated.data.title,
      description: validated.data.description,
      imageUrl,
    },
  });

  return { kind: "created", item };
}

type FindOwnedItemOutcome =
  | { kind: "notDraft" }
  | { kind: "itemNotFound" }
  | { kind: "found"; item: NonNullable<Awaited<ReturnType<typeof prisma.bracketItem.findFirst>>> };

/**
 * The DRAFT-status + item-lookup pipeline shared by `updateBracketItemCore`
 * and `removeBracketItemCore` - scoped to `bracketId` (never `itemId`
 * alone), so an item id can never be used to reach into a bracket the
 * caller doesn't own, or a different bracket of their own.
 */
async function requireDraftItem(
  bracket: ItemOwningBracket,
  itemId: string
): Promise<FindOwnedItemOutcome> {
  if (bracket.status !== "DRAFT") {
    return { kind: "notDraft" };
  }

  const item = await prisma.bracketItem.findFirst({
    where: { id: itemId, bracketId: bracket.id },
  });

  if (!item) {
    return { kind: "itemNotFound" };
  }

  return { kind: "found", item };
}

type UpdateItemOutcome =
  | { kind: "notDraft" }
  | { kind: "itemNotFound" }
  | { kind: "validationError"; message: string }
  | { kind: "imageUploadFailed" }
  | { kind: "updated"; item: Awaited<ReturnType<typeof prisma.bracketItem.update>> };

/**
 * Order mirrors both entry points exactly: DRAFT status (409) -> item
 * lookup scoped to `bracketId` (404) -> form validation (400) -> image
 * upload, if any (502) -> update.
 *
 * When no new file was chosen, `imageUrl` stays `undefined`, so the spread
 * below omits the key entirely and Prisma leaves the existing `image_url`
 * untouched - the image is optional and replacing it only happens when a
 * new file is actually uploaded.
 */
export async function updateBracketItemCore(
  bracket: ItemOwningBracket,
  itemId: string,
  formData: FormData
): Promise<UpdateItemOutcome> {
  const lookup = await requireDraftItem(bracket, itemId);
  if (lookup.kind !== "found") {
    return lookup;
  }

  const validated = validateBracketItemForm(formData);
  if (!validated.ok) {
    return { kind: "validationError", message: validated.error };
  }

  let imageUrl: string | undefined;
  if (validated.data.image) {
    try {
      imageUrl = await uploadBracketItemImage(bracket.id, validated.data.image);
    } catch {
      return { kind: "imageUploadFailed" };
    }
  }

  const item = await prisma.bracketItem.update({
    where: { id: lookup.item.id },
    data: {
      title: validated.data.title,
      description: validated.data.description,
      ...(imageUrl ? { imageUrl } : {}),
    },
  });

  return { kind: "updated", item };
}

type RemoveItemOutcome =
  | { kind: "notDraft" }
  | { kind: "itemNotFound" }
  | { kind: "removed"; item: NonNullable<Awaited<ReturnType<typeof prisma.bracketItem.findFirst>>> };

/** Order mirrors both entry points exactly: DRAFT status (409) -> item
 * lookup scoped to `bracketId` (404) -> delete. */
export async function removeBracketItemCore(
  bracket: ItemOwningBracket,
  itemId: string
): Promise<RemoveItemOutcome> {
  const lookup = await requireDraftItem(bracket, itemId);
  if (lookup.kind !== "found") {
    return lookup;
  }

  await prisma.bracketItem.delete({ where: { id: lookup.item.id } });

  return { kind: "removed", item: lookup.item };
}
