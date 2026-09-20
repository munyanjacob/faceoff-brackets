import type { PublishFormState } from "./publish-actions";

/**
 * Split out of `./publish-actions.ts` (a "use server" file): Next.js 16 only
 * allows async functions to be exported from a "use server" module - see
 * `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`.
 * `useActionState`'s initial-state argument still needs to live somewhere
 * Client Components can import from, so it lives here instead.
 */
export const initialPublishFormState: PublishFormState = { error: null };
