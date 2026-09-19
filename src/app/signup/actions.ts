"use server";

import { createClient } from "@/lib/supabase/server";

export type SignupState = {
  error?: string;
  message?: string;
};

/**
 * Server Action backing `/signup`. Uses the server-side Supabase client
 * (`src/lib/supabase/server.ts`) because only it can read/write the
 * session cookie.
 */
export async function signup(
  _prevState: SignupState,
  formData: FormData
): Promise<SignupState> {
  const email = formData.get("email");
  const password = formData.get("password");

  if (
    typeof email !== "string" ||
    email.trim() === "" ||
    typeof password !== "string" ||
    password === ""
  ) {
    return { error: "Enter an email and password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    // e.g. Supabase's password policy rejecting a weak password.
    return { error: error.message };
  }

  // Supabase's anti-enumeration protection: signUp() for an email that's
  // already registered and confirmed does not throw. Instead it returns a
  // success response with an obfuscated user whose `identities` array is
  // empty (no new identity was created). Detect that case so we don't claim
  // an account was created when nothing actually changed.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return {
      message:
        "This email is already registered. Try logging in instead.",
    };
  }

  return {
    message: "Check your email to confirm your account before logging in.",
  };
}
