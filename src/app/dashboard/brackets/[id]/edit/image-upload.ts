import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * Uploads a validated `BracketItem` image (issue #12, `./validation.ts`) to
 * Supabase Storage and returns its public URL, for `./actions.ts` to save
 * onto `BracketItem.image_url`.
 *
 * Deliberately builds its own `@supabase/supabase-js` client with the
 * service-role key, rather than using `@/lib/supabase/server`'s
 * request-scoped (anon-key + user-session) client:
 *
 * - `./actions.ts` has already re-derived the signed-in creator and
 *   confirmed they own `bracketId`'s (draft) bracket - see
 *   `requireOwnedBracket` there - before this is ever called, so
 *   authorization is already enforced at the Server Action boundary. That
 *   matches how the rest of this app already treats authorization: Prisma
 *   itself connects directly to Postgres and does not go through
 *   Supabase/Postgres RLS either, so ownership checks live in application
 *   code (`./actions.ts`), not in per-row database policies.
 * - Confirmed against the live project (see the issue #12 comment): the
 *   `bracket-item-images` bucket has no `storage.objects` INSERT policy for
 *   the `anon`/`authenticated` roles, so an anon-key client's upload fails
 *   with "new row violates row-level security policy" regardless of the
 *   caller's actual ownership. The service-role key bypasses Storage RLS
 *   the same way Prisma's direct connection bypasses Postgres RLS.
 *
 * The `bracket-item-images` bucket must exist (public-read, 5MB cap,
 * image/png + image/jpeg + image/webp only) - see the issue #12 comment for
 * how it was provisioned.
 */
const BUCKET_NAME = "bracket-item-images";

const FILE_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function createStorageClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function uploadBracketItemImage(
  bracketId: string,
  file: File
): Promise<string> {
  const extension = FILE_EXTENSIONS_BY_MIME_TYPE[file.type] ?? "bin";
  // Namespaced by bracketId (never trusts a client-supplied path) with a
  // random, non-guessable filename - a new object per upload, so replacing
  // an item's image (issue #12's last acceptance criterion) never collides
  // with or has to overwrite the previous file. The old object is left
  // orphaned, which the issue explicitly marks out of scope to clean up.
  const path = `${bracketId}/${randomUUID()}.${extension}`;

  const supabase = createStorageClient();
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(path, file, { contentType: file.type });

  if (uploadError) {
    throw new Error(
      `Failed to upload bracket item image: ${uploadError.message}`
    );
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET_NAME).getPublicUrl(path);

  return publicUrl;
}
