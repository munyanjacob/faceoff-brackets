import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import { authService, toServiceError } from "@/services";
import { pageMeta } from "@/lib/pageMeta";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: pageMeta({
      title: "Sign in — Bracket Arena",
      description: "Sign in or create an account to build voting brackets.",
      ogDescription: "Sign in or create an account to build brackets.",
    }),
  }),
  component: AuthPage,
});

function AuthPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (session) navigate({ to: "/dashboard", replace: true });
  }, [session, navigate]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await authService.login(email, password);
        navigate({ to: "/dashboard" });
      } else {
        const result = await authService.signup(email, password);
        setNotice(result.message);
      }
    } catch (caught) {
      setError(toServiceError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 pb-24 pt-16">
      <p className="label-kicker">{mode === "login" ? "Welcome back" : "Join the arena"}</p>
      <h1 className="text-stencil mt-3 text-4xl">
        {mode === "login" ? "Sign in" : "Create account"}
      </h1>

      <form onSubmit={submit} className="arena-panel mt-8 space-y-5 p-6">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {notice && <p className="text-sm text-success">{notice}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>

      <button
        type="button"
        className="mt-6 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        onClick={() => {
          setMode(mode === "login" ? "signup" : "login");
          setError(null);
          setNotice(null);
        }}
      >
        {mode === "login"
          ? "No account yet? Create one"
          : "Already have an account? Sign in instead"}
      </button>
    </div>
  );
}
