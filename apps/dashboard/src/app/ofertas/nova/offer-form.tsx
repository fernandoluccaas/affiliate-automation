"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { ArrowLeft, Save } from "lucide-react";
import { marketplaces, shippingStatuses, stockStatuses } from "@affiliate/shared";
import { createManualOfferAction, type CreateOfferState } from "@/lib/actions";
import {
  formatOfferFormError,
  offerFormSchema,
  parseDecimalInput,
  type OfferFormInput,
} from "@/lib/offer-form-schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const defaultValues: OfferFormInput = {
  marketplace: "SHOPEE",
  externalProductId: "",
  title: "",
  description: "",
  category: "",
  imageUrl: "",
  productUrl: "",
  affiliateUrl: "",
  originalPrice: "",
  currentPrice: "",
  couponCode: "",
  couponExpiration: "",
  commissionPercentage: "",
  rating: "",
  salesCount: "",
  freeShipping: undefined,
  shippingStatus: "UNKNOWN",
  stockStatus: "UNKNOWN",
};

export function OfferForm() {
  const [state, setState] = useState<CreateOfferState | null>(null);
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<OfferFormInput>({
    defaultValues,
  });
  const originalPrice = parseDecimalInput(watch("originalPrice"));
  const currentPrice = parseDecimalInput(watch("currentPrice"));
  const calculatedDiscount = useMemo(() => {
    if (
      typeof originalPrice !== "number" ||
      typeof currentPrice !== "number" ||
      originalPrice <= 0 ||
      currentPrice <= 0 ||
      currentPrice > originalPrice
    ) {
      return null;
    }

    return (((originalPrice - currentPrice) / originalPrice) * 100).toFixed(2);
  }, [currentPrice, originalPrice]);

  function onSubmit(values: OfferFormInput) {
    const parsed = offerFormSchema.safeParse(values);

    if (!parsed.success) {
      setState({
        ok: false,
        message: formatOfferFormError(parsed.error) || "Dados da oferta invalidos.",
      });
      return;
    }

    startTransition(async () => {
      const result = await createManualOfferAction(parsed.data);
      setState(result);

      if (result.ok) {
        reset(defaultValues);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Dados do produto</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="Marketplace" required error={errors.marketplace?.message}>
            <Select {...register("marketplace")}>
              {marketplaces.map((marketplace) => (
                <option key={marketplace} value={marketplace}>
                  {marketplace}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ID externo" required error={errors.externalProductId?.message}>
            <Input {...register("externalProductId")} />
            <p className="text-xs text-[var(--muted-foreground)]">
              Identificador unico do produto dentro do marketplace. Utilize o mesmo ID somente
              quando se tratar realmente do mesmo produto.
            </p>
          </Field>
          <Field label="Titulo" required error={errors.title?.message}>
            <Input {...register("title")} />
          </Field>
          <Field label="Categoria" error={errors.category?.message}>
            <Input {...register("category")} />
          </Field>
          <Field className="md:col-span-2" label="Descricao" error={errors.description?.message}>
            <Textarea {...register("description")} />
          </Field>
          <Field label="Imagem" error={errors.imageUrl?.message}>
            <Input {...register("imageUrl")} type="url" />
          </Field>
          <Field label="URL do produto" required error={errors.productUrl?.message}>
            <Input {...register("productUrl")} type="url" />
          </Field>
          <Field label="URL afiliada" error={errors.affiliateUrl?.message}>
            <Input {...register("affiliateUrl")} type="url" />
          </Field>
          <Field label="Estoque" error={errors.stockStatus?.message}>
            <Select {...register("stockStatus")}>
              {stockStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preco e promocao</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Preco original" error={errors.originalPrice?.message}>
            <Input {...register("originalPrice")} inputMode="decimal" />
          </Field>
          <Field label="Preco atual" required error={errors.currentPrice?.message}>
            <Input {...register("currentPrice")} inputMode="decimal" />
          </Field>
          <div className="rounded-md border bg-[var(--background)] px-3 py-2">
            <div className="text-sm font-medium">Desconto calculado</div>
            <div className="mt-1 text-2xl font-semibold">
              {calculatedDiscount === null ? "Indisponivel" : `${calculatedDiscount}%`}
            </div>
          </div>
          <Field label="Cupom" error={errors.couponCode?.message}>
            <Input {...register("couponCode")} />
          </Field>
          <Field label="Validade do cupom" error={errors.couponExpiration?.message}>
            <Input {...register("couponExpiration")} type="datetime-local" />
          </Field>
          <Field label="Comissao (%)" error={errors.commissionPercentage?.message}>
            <Input {...register("commissionPercentage")} inputMode="decimal" />
          </Field>
          <Field label="Avaliacao" error={errors.rating?.message}>
            <Input {...register("rating")} inputMode="decimal" />
          </Field>
          <Field label="Vendas" error={errors.salesCount?.message}>
            <Input {...register("salesCount")} inputMode="numeric" />
          </Field>
          <Field label="Frete" error={errors.shippingStatus?.message}>
            <Select {...register("shippingStatus")}>
              {shippingStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      {state ? (
        <div
          className={
            state.ok
              ? "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
              : "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          }
        >
          {state.message}
        </div>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button asChild variant="outline">
          <Link href="/ofertas">
            <ArrowLeft aria-hidden="true" size={18} />
            Voltar
          </Link>
        </Button>
        <Button type="submit" disabled={pending}>
          <Save aria-hidden="true" size={18} />
          Salvar oferta
        </Button>
      </div>
    </form>
  );
}

type FieldProps = {
  label: string;
  required?: boolean;
  error?: string | undefined;
  className?: string | undefined;
  children: React.ReactNode;
};

function Field({ label, required = false, error, className, children }: FieldProps) {
  return (
    <div className={`grid gap-2 ${className ?? ""}`}>
      <Label>
        {label}{" "}
        <span className="text-xs font-normal text-[var(--muted-foreground)]">
          {required ? "Obrigatorio" : "Opcional"}
        </span>
      </Label>
      {children}
      {error ? <p className="text-sm text-[var(--destructive)]">{error}</p> : null}
    </div>
  );
}
