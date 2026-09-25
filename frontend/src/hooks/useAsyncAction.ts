import { useCallback, useState } from "react";
import { toServiceError } from "@/services";

/**
 * Dedupes the submit/error/busy shape retyped across async form and
 * mutation handlers:
 *
 *   setError(null); setBusy(true);
 *   try { await ...; } catch (caught) { setError(toServiceError(caught).message); } finally { setBusy(false); }
 *
 * `run` wraps an async callback with exactly that try/catch/finally.
 * `setError` is exposed for call sites that need to clear the error
 * outside of a `run` (e.g. when switching form modes).
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setError(toServiceError(caught).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
}
