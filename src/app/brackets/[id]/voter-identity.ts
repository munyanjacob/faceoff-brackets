import { cookies } from "next/headers";

/**
 * The anonymous voter cookie (issue #22's "browser/session identifier" for
 * a voter without an account on an `ANONYMOUS_ALLOWED` bracket). A random
 * UUID, set httpOnly so client-side JS can't read or tamper with it.
 *
 * Only `./vote-actions.ts`'s `castVote` Server Action ever *sets* this
 * cookie (on an actual vote attempt, creating it if absent) - Server
 * Components (like `./page.tsx`) can only read cookies, per the Next.js
 * `cookies()` docs (`node_modules/next/dist/docs/.../functions/cookies.md`:
 * "Setting cookies is not supported during Server Component rendering").
 *
 * No signing, rotation, or rate-limiting beyond this basic identifier -
 * that hardening is explicitly out of scope for #22 and tracked in the
 * post-mvp issue #35.
 */
export const ANONYMOUS_VOTER_COOKIE = "voter_id";

/** One year, in seconds - long enough that a returning anonymous voter on
 * a still-running bracket keeps the same identifier across visits. */
export const ANONYMOUS_VOTER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type VoterLookupKey =
  | { userId: string }
  | { anonymousVoterIdentifier: string };

/**
 * Read-only version of "who is this voter" for `./page.tsx`: used only to
 * look up whether they already have a `Vote` on the current matchup (issue
 * #22's "shows the voter's existing choice" criterion), never to create the
 * anonymous cookie - a first-time anonymous visitor has no cookie yet and
 * therefore, correctly, no existing vote to find.
 *
 * Returns `null` when there is no possible identity to look a vote up by
 * (signed out, no anonymous cookie yet).
 */
export async function currentVoterLookupKey(
  userId: string | null
): Promise<VoterLookupKey | null> {
  if (userId) {
    return { userId };
  }

  const cookieStore = await cookies();
  const anonymousVoterIdentifier = cookieStore.get(
    ANONYMOUS_VOTER_COOKIE
  )?.value;

  return anonymousVoterIdentifier ? { anonymousVoterIdentifier } : null;
}
