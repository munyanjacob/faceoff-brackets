import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authService } from "@/services";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const unsubscribe = authService.onAuthStateChange((next) => {
      if (active) setSession(next);
    });
    authService.getSession().then((next) => {
      if (!active) return;
      setSession(next);
      setLoading(false);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { session, loading };
}
