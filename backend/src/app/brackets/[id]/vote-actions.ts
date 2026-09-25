"use server";

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  castVoteCore,
  type CastVoteResult,
} from "@/lib/vote/cast-vote-core";
import {
  ANONYMOUS_VOTER_COOKIE,
  ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
  signAnonymousVoterId,
} from "./voter-identity";
import { UNEXPECTED_ERROR } from "./vote-form-state";

/**
 * The "Vote" Server Action on `/brackets/[id]` (issue #22), invoked via
 * `useActionState` from `./vote-button.tsx` - one bound instance per
 * (matchup, item) pair, the same `Function.prototype.bind` pattern as
 * `../../dashboard/brackets/[id]/edit/item-row.tsx`'s
 * `updateItem.bind(null, bracketId, item.id)`.
 *
 * A thin adapter (issue #77) over `../../../lib/vote/cast-vote-core.ts`'s
 * `castVoteCore`, which owns the actual 9-step vote rule list shared with
 * this action's REST sibling, `../../api/matchups/[matchupId]/votes/
 * route.ts`. This file's only remaining jobs: pull `userId`/the raw
 * anonymous-cookie value out of the cookie-bound Supabase session and
 * `next/headers` `cookies()` (this entry point's own identity source, per
 * spec §6), pull `comment` out of `FormData`, translate `castVoteCore`'s
 * result into `VoteFormState`, and this entry point's own side effects
 * (setting the anonymous-voter cookie with *its* attributes, and
 * `revalidatePath`) - genuinely different from the REST route's per-request
 * `Response` cookie and lack of `revalidatePath` (spec §7.6/§8.3).
 *
 * `votedItemId` on the returned state is not just "did a new vote get
 * created" - it also covers "you already had a vote here" (found by the
 * proactive check, or recovered from a caught unique-constraint violation).
 * Both cases report the same non-error, "here's your existing choice"
 * result, matching issue #22's "the UI shows the voter's existing choice
 * rather than an unhelpful error" criterion.
 */
export type VoteFormState = {
  error: string | null;
  votedItemId: string | null;
};

export async function castVote(
  matchupId: string,
  itemId: string,
  _prevState: VoteFormState,
  formData: FormData
): Promise<VoteFormState> {
  try {
    return await castVoteUnsafe(matchupId, itemId, formData);
  } catch (err) {
    unstable_rethrow(err);
    return { error: UNEXPECTED_ERROR, votedItemId: null };
  }
}

async function castVoteUnsafe(
  matchupId: string,
  itemId: string,
  formData: FormData
): Promise<VoteFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const cookieStore = await cookies();
  const rawAnonymousCookieValue = cookieStore.get(ANONYMOUS_VOTER_COOKIE)?.value;

  // `formData.get(...)` returns `null` when the field is absent entirely (a
  // non-JS form submission that never included it, or a test harness's bare
  // `new FormData()`) - treated the same as an empty string, matching
  // `castVoteCore`'s "" default for "no comment supplied".
  const rawComment = formData.get("comment");
  const comment = typeof rawComment === "string" ? rawComment : "";

  const result = await castVoteCore({
    matchupId,
    itemId,
    comment,
    userId: user?.id ?? null,
    rawAnonymousCookieValue,
  });

  applyAnonymousCookie(cookieStore, result);

  const { outcome } = result;
  if (outcome.kind === "error") {
    return { error: outcome.error.message, votedItemId: null };
  }

  revalidatePath(`/brackets/${outcome.bracketId}`);
  revalidatePath(`/brackets/${outcome.bracketId}/matchups/${matchupId}`);
  // Unlike the REST route's CastVoteResponse, VoteFormState allows
  // `votedItemId: null` - see `insertVoteWithRaceRecovery`'s doc-comment in
  // cast-vote-core.ts for why the two entry points deliberately disagree
  // here. `outcome.votedItemId` is already `string | null`, so this is a
  // direct pass-through rather than the REST route's own `?? itemId`
  // fallback.
  return { error: null, votedItemId: outcome.votedItemId };
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function applyAnonymousCookie(cookieStore: CookieStore, result: CastVoteResult): void {
  if (!result.newAnonymousVoterId) {
    return;
  }
  cookieStore.set(
    ANONYMOUS_VOTER_COOKIE,
    signAnonymousVoterId(result.newAnonymousVoterId),
    {
      httpOnly: true,
      sameSite: "lax",
      maxAge: ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS,
      path: "/",
    }
  );
}
