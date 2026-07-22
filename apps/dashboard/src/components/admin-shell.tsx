import { LogOut } from "lucide-react";
import Link from "next/link";
import { logoutAction } from "@/lib/actions";
import { visibleAdminNavigation } from "@/lib/navigation";
import { requireSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type AdminShellProps = {
  currentPath: string;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
};

export async function AdminShell({ currentPath, title, actions, children }: AdminShellProps) {
  const user = await requireSession();

  return (
    <main className="min-h-screen">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <Link href="/" className="text-xl font-semibold">
              Affiliate Automation
            </Link>
            <p className="text-sm text-[var(--muted-foreground)]">{user.email}</p>
          </div>
          <form action={logoutAction}>
            <Button variant="outline" type="submit">
              <LogOut aria-hidden="true" size={18} />
              Sair
            </Button>
          </form>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[240px_1fr]">
        <aside className="h-fit rounded-md border bg-white p-2">
          <nav className="grid gap-1">
            {visibleAdminNavigation.map((item) => {
              const active =
                currentPath === item.href ||
                (item.href !== "/" && currentPath.startsWith(`${item.href}/`));

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                    active && "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)] hover:text-[var(--primary-foreground)]",
                  )}
                >
                  <item.icon aria-hidden="true" size={18} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <section className="grid min-w-0 gap-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {actions}
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}
