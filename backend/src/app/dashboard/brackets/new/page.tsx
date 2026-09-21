import { NewBracketForm } from "./new-bracket-form";

/**
 * `/dashboard/brackets/new` - the "create bracket" form (issue #10).
 *
 * No auth check here: like every other route under `/dashboard`, the
 * signed-in/signed-out gate lives in `src/app/dashboard/layout.tsx` (#6),
 * and the actual creation logic re-checks auth for itself anyway (see
 * `./actions.ts`) since a Server Action is reachable independently of any
 * page that renders it.
 */
export default function NewBracketPage() {
  return <NewBracketForm />;
}
