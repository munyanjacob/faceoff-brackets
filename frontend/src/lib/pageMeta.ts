// Site-wide constants baked into every page's meta tags so each route stays
// self-contained instead of relying on inheriting them from the root route's
// head(). See issues #85 (dedupe the repeated head() shape) and #86 (replace
// the leftover "Lovable" scaffold branding).
const SITE_AUTHOR = "Bracket Arena";
const TWITTER_SITE = "@BracketArena";

export interface PageMetaOptions {
  /** Page title. Also used as the og:title. */
  title: string;
  /** Page description, rendered as the `description` and (by default) `og:description` meta tags. */
  description: string;
  /** Overrides the og:description when it should differ from `description`. */
  ogDescription?: string;
  /** Absolute URL of a social preview image. Adds og:image/twitter:image and defaults twitter:card to "summary_large_image". */
  image?: string;
  /** Overrides the twitter:card value that would otherwise be inferred from `image`. */
  twitterCard?: "summary" | "summary_large_image";
}

/**
 * Builds the shared `meta` array for a route's `head()`. Every route in
 * `src/routes/*.tsx` repeated the same title/description/og/twitter shape —
 * this centralizes it so routes only pass the copy that actually varies.
 */
export function pageMeta({
  title,
  description,
  ogDescription,
  image,
  twitterCard,
}: PageMetaOptions) {
  const meta: Array<Record<string, string>> = [
    { title },
    { name: "description", content: description },
    { name: "author", content: SITE_AUTHOR },
    { property: "og:title", content: title },
    { property: "og:description", content: ogDescription ?? description },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: twitterCard ?? (image ? "summary_large_image" : "summary") },
    { name: "twitter:site", content: TWITTER_SITE },
  ];

  if (image) {
    meta.push({ property: "og:image", content: image }, { name: "twitter:image", content: image });
  }

  return meta;
}
