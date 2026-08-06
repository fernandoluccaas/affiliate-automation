import { LogOut } from "lucide-react";
import { logoutAction } from "@/lib/actions";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AdminShellClient } from "@/components/admin-shell-client";

export type AdminShellProps = {
  currentPath: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
};

export async function AdminShell({
  currentPath,
  title,
  description,
  actions,
  children,
}: AdminShellProps) {
  const user = await requireSession();

  const logout = (
    <form action={logoutAction}>
      <Button variant="ghost" type="submit" className="w-full justify-start">
        <LogOut aria-hidden="true" size={17} />
        Sair
      </Button>
    </form>
  );

  return (
    <AdminShellClient
      currentPath={currentPath}
      title={title}
      {...(description ? { description } : {})}
      {...(actions ? { actions } : {})}
      userEmail={user.email}
      logout={logout}
    >
      {children}
    </AdminShellClient>
  );
}
