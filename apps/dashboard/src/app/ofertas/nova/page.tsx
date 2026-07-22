import { AdminShell } from "@/components/admin-shell";
import { OfferForm } from "./offer-form";

export default function NewOfferPage() {
  return (
    <AdminShell currentPath="/ofertas/nova" title="Nova oferta">
      <OfferForm />
    </AdminShell>
  );
}
