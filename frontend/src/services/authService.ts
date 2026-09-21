import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { ServiceError } from "./serviceError";

/**
 * Auth talks to the auth provider directly (specification §6) — the bracket
 * API only ever verifies the bearer token it issues.
 */
export const authService = {
  async signup(email: string, password: string): Promise<{ message: string }> {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) {
      // The one path that isn't genericized — surface the provider's reason.
      throw new ServiceError("SIGNUP_REJECTED", error.message, 400);
    }
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      throw new ServiceError(
        "EMAIL_ALREADY_REGISTERED",
        "This email is already registered. Try logging in instead.",
        409,
      );
    }
    return { message: "Check your email to confirm your account before logging in." };
  },

  async login(email: string, password: string): Promise<{ session: Session }> {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      throw new ServiceError("INVALID_CREDENTIALS", "Incorrect email or password.", 401);
    }
    return { session: data.session };
  },

  async logout(): Promise<void> {
    await supabase.auth.signOut();
  },

  async getSession(): Promise<Session | null> {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  onAuthStateChange(cb: (session: Session | null) => void): () => void {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
    return () => data.subscription.unsubscribe();
  },
};
