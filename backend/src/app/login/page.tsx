import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <h1 className="text-2xl font-semibold">Log in</h1>
        <LoginForm />
        <p>
          Don&apos;t have an account? <Link href="/signup">Sign up</Link>
        </p>
      </div>
    </div>
  );
}
