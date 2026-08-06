import { LoginForm } from "./login-form";
import { ThemeToggle } from "@/components/theme-toggle";

export default function LoginPage() {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span
            className="mx-auto grid size-11 place-items-center rounded-xl bg-[var(--primary)] font-bold text-[var(--primary-foreground)]"
            aria-hidden="true"
          >
            AA
          </span>
          <p className="mt-3 text-sm font-semibold">Affiliate Automation</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
