import { describe, expect, it } from "vitest";
import NewBracketPage from "./page";
import { NewBracketForm } from "./new-bracket-form";

describe("/dashboard/brackets/new page", () => {
  it("renders the create-bracket form", () => {
    // `NewBracketForm` uses `useActionState`/`useFormStatus`, so - unlike
    // `../../page.tsx`'s `BracketList` - it can't be called directly as a
    // plain function outside of React's render (hooks require a render
    // context). This just checks the page wires to the right component,
    // the same way `<BracketList ... />` element wiring would be checked if
    // `../../page.tsx` used JSX instead of a direct call.
    const result = NewBracketPage();

    expect(result.type).toBe(NewBracketForm);
  });
});
