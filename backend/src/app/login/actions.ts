"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  error?: string;
};

/**
 * Server Action backing `/login`. Uses the server-side Supabase client
 * (`src/lib/supabase/server.ts`) so the resulting session cookie is written
 * to the response.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
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
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Don't leak Supabase's raw error text (which can reveal whether the
    // email exists) - show a single generic message for any credential
    // failure.
    return { error: "Incorrect email or password." };
  }

  // Deliberately outside any try/catch: redirect() works by throwing, and a
  // surrounding catch would swallow the navigation.
  redirect("/dashboard");
}
