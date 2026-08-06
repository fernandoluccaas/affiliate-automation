"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cancelAssistedPublicationAction,
  confirmAssistedPublicationAction,
  failAssistedPublicationAction,
} from "@/lib/actions";
import { assistedGroupConfirmationPrompt } from "@/lib/assisted-publications";
import { StatusBadge } from "@/components/ui/status-badge";

export type AssistedPublicationCardProps = {
  id: string;
  groupDisplayName: string;
  status: string;
  marketplace: string;
  headline: string;
  title: string;
  price: string;
  message: string;
  affiliateUrl: string;
  hasImage: boolean;
  preparedAt: string;
};

export function AssistedPublicationCard(props: AssistedPublicationCardProps) {
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    await navigator.clipboard.writeText(props.message);
    setCopied(true);
  }

  return (
    <article className="grid gap-5 rounded-[var(--radius-lg)] border bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] lg:grid-cols-[220px_1fr]">
      <div className="grid content-start gap-2">
        {props.hasImage ? (
          // The source is an immutable offer snapshot; the download route applies SSRF and size checks.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/publicacoes-assistidas/${props.id}/imagem`}
            alt={props.title}
            className="aspect-square w-full rounded-md object-contain"
          />
        ) : (
          <div className="grid aspect-square place-items-center rounded-md bg-[var(--muted)] text-sm">
            Imagem indisponível
          </div>
        )}
        {props.hasImage ? (
          <a
            href={`/api/publicacoes-assistidas/${props.id}/imagem?download=1`}
            download
          >
            <Button className="w-full" variant="outline" type="button">
              Baixar imagem
            </Button>
          </a>
        ) : null}
      </div>
      <div className="grid gap-3">
        <div>
          <p className="text-sm font-medium">Grupo: {props.groupDisplayName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--muted-foreground)]">
            <span>{props.marketplace}</span>
            <StatusBadge status={props.status} />
            <span>Preparada em {props.preparedAt}</span>
          </div>
          <h2 className="font-semibold">{props.headline}</h2>
          <p>{props.title}</p>
          <p className="font-medium">{props.price}</p>
        </div>
        <pre className="whitespace-pre-wrap rounded-md bg-[var(--muted)] p-3 font-sans text-sm">
          {props.message}
        </pre>
        <a
          className="break-all text-sm underline"
          href={props.affiliateUrl}
          target="_blank"
          rel="noreferrer"
        >
          {props.affiliateUrl}
        </a>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={copyMessage}>
            {copied ? "Copiada" : "Copiar mensagem"}
          </Button>
          <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer">
            <Button type="button" variant="outline">
              Abrir WhatsApp Web
            </Button>
          </a>
          {props.status === "AWAITING_MANUAL_PUBLICATION" ? (
            <form
              action={confirmAssistedPublicationAction}
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    assistedGroupConfirmationPrompt(props.groupDisplayName),
                  )
                )
                  event.preventDefault();
              }}
            >
              <input type="hidden" name="publicationId" value={props.id} />
              <Button type="submit">Marcar como publicada</Button>
            </form>
          ) : null}
          {props.status === "AWAITING_MANUAL_PUBLICATION" ? (
            <form action={cancelAssistedPublicationAction}>
              <input type="hidden" name="publicationId" value={props.id} />
              <Button type="submit" variant="outline">
                Ignorar
              </Button>
            </form>
          ) : null}
          {props.status === "AWAITING_MANUAL_PUBLICATION" ? (
            <form action={failAssistedPublicationAction} className="flex gap-2">
              <input type="hidden" name="publicationId" value={props.id} />
              <input
                name="reason"
                className="rounded-md border px-3 text-sm"
                maxLength={500}
                placeholder="Motivo opcional"
              />
              <Button type="submit" variant="outline">
                Marcar como falha
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </article>
  );
}
