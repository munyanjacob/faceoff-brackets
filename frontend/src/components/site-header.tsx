import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { authService } from "@/services";

export function SiteHeader() {
  const { session } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await authService.logout();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="text-stencil text-lg text-foreground">
          BRACKET<span className="text-primary">ARENA</span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link to="/discover">
            <Button variant="ghost" size="sm">
              Discover
            </Button>
          </Link>
          {session ? (
            <>
              <Link to="/dashboard">
                <Button variant="ghost" size="sm">
                  My brackets
                </Button>
              </Link>
              <Button variant="outline" size="sm" onClick={signOut}>
                Sign out
              </Button>
            </>
          ) : (
            <Link to="/auth">
              <Button size="sm">Sign in</Button>
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
