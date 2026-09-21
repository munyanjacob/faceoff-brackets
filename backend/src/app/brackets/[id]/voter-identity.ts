import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The anonymous voter cookie (issue #22's "browser/session identifier" for
 * a voter without an account on an `ANONYMOUS_ALLOWED` bracket). A random
 * UUID, set httpOnly so client-side JS can't read or tamper with it, and
 * (issue #35) HMAC-signed so it can't trivially be *edited* by the voter
 * either - see `signAnonymousVoterId`/`verifyAnonymousVoterId` below.
 *
 * Only `./vote-actions.ts`'s `castVote` Server Action ever *sets* this
 * cookie (on an actual vote attempt, creating it if absent) - Server
 * Components (like `./page.tsx`) can only read cookies, per the Next.js
 * `cookies()` docs (`node_modules/next/dist/docs/.../functions/cookies.md`:
 * "Setting cookies is not supported during Server Component rendering").
 *
 * Issue #35 adds signing (below) plus rate-limiting in `./vote-actions.ts`.
 * Deliberately still not doing anything beyond that - no IP fallback, no
 * CAPTCHA, no identity verification (out of scope per #35) - and clearing
 * cookies to get a fresh, validly-signed identifier and revote is still
 * explicitly possible; that's inherent to a cookie-based identifier and not
 * something #35 tries to prevent.
 */
export const ANONYMOUS_VOTER_COOKIE = "voter_id";

/**
 * Signing secret for the anonymous voter cookie (issue #35). Read the same
 * way `../../api/cron/advance-rounds/route.ts` reads `CRON_SECRET` - a
 * plain `process.env.*` lookup, documented in `.env.example`.
 *
 * Unlike `CRON_SECRET` (which hard-fails a request with no fallback), an
 * unset `VOTE_COOKIE_SECRET` falls back to a well-known, insecure dev-only
 * value rather than breaking voting locally/in a fresh checkout - anyone
 * relying on real tamper-resistance (i.e. any deployed environment) must
 * set `VOTE_COOKIE_SECRET` themselves, and a loud console warning says so
 * every time the fallback is used.
 */
function voteCookieSecret(): string {
  const secret = process.env.VOTE_COOKIE_SECRET;
  if (secret) {
    return secret;
  }

  console.warn(
    "[voter-identity] VOTE_COOKIE_SECRET is not set - falling back to an " +
      "insecure, well-known dev-only signing secret for the anonymous " +
      "voter cookie. Set VOTE_COOKIE_SECRET in the environment (see " +
      ".env.example) before relying on this cookie being tamper-resistant."
  );
  return "dev-only-insecure-voter-cookie-secret-do-not-use-in-production";
}

const SIGNATURE_SEPARATOR = ".";

function hmacHex(value: string): string {
  return createHmac("sha256", voteCookieSecret()).update(value).digest("hex");
}

/**
 * Signs a raw anonymous voter id (a UUID) into the `id.hexSignature`
 * cookie-value format `castVote` stores. Only `castVote` calls this, when
 * minting a fresh id - never on an id it already read back from a cookie
 * `verifyAnonymousVoterId` just validated, so a valid cookie's identifier
 * portion is never re-signed/rotated on every request.
 */
export function signAnonymousVoterId(id: string): string {
  return `${id}${SIGNATURE_SEPARATOR}${hmacHex(id)}`;
}

/**
 * Verifies a cookie value produced by `signAnonymousVoterId` and, only if
 * the signature is genuinely valid, returns the raw id. Returns `null` for
 * anything else - no cookie, a malformed value, or (the actual point of
 * #35) a value whose id was hand-edited by the voter without also
 * recomputing a valid signature, which they can't do without
 * `VOTE_COOKIE_SECRET`.
 *
 * Also returns `null` for a pre-#35 unsigned cookie (a bare UUID, no
 * `.signature` suffix) - a returning voter with one of those is treated the
 * same as a first-time visitor: `castVote` mints and signs a new id for
 * them. That's a one-time identity reset during the #22 -> #35 rollout, not
 * an ongoing gap - equivalent in effect to the voter having cleared their
 * cookies, which #35 already accepts as out of scope to prevent.
 *
 * Uses `timingSafeEqual` (fixed-length buffers, hex-decoded) rather than
 * `===` so a mismatched signature can't be distinguished by comparison
 * timing - a real cookie-integrity check, not just an obstacle.
 */
export function verifyAnonymousVoterId(cookieValue: string): string | null {
  const separatorIndex = cookieValue.lastIndexOf(SIGNATURE_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const id = cookieValue.slice(0, separatorIndex);
  const providedSignature = cookieValue.slice(separatorIndex + 1);
  const expectedSignature = hmacHex(id);

  const providedBuffer = Buffer.from(providedSignature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  return id;
}

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
  const rawCookieValue = cookieStore.get(ANONYMOUS_VOTER_COOKIE)?.value;
  const anonymousVoterIdentifier = rawCookieValue
    ? verifyAnonymousVoterId(rawCookieValue)
    : null;

  return anonymousVoterIdentifier ? { anonymousVoterIdentifier } : null;
}
