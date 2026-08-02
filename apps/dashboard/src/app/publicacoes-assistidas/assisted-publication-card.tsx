"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cancelAssistedPublicationAction,
  confirmAssistedPublicationAction,
  failAssistedPublicationAction,
} from "@/lib/actions";

export type AssistedPublicationCardProps = {
  id: string;
  channelName: string;
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
    <article className="grid gap-4 rounded-md border bg-white p-4 lg:grid-cols-[220px_1fr]">
      <div className="grid content-start gap-2">
        {props.hasImage ? (
          // The source is an immutable offer snapshot; the download route applies SSRF and size checks.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/publicacoes-assistidas/${props.id}/imagem`} alt={props.title} className="aspect-square w-full rounded-md object-contain" />
        ) : (
          <div className="grid aspect-square place-items-center rounded-md bg-[var(--muted)] text-sm">
            Imagem indisponivel
          </div>
        )}
        {props.hasImage ? (
          <a href={`/api/publicacoes-assistidas/${props.id}/imagem?download=1`} download>
            <Button className="w-full" variant="outline" type="button">Baixar imagem</Button>
          </a>
        ) : null}
      </div>
      <div className="grid gap-3">
        <div>
          <p className="text-sm text-[var(--muted-foreground)]">{props.channelName} · preparada em {props.preparedAt}</p>
          <h2 className="font-semibold">{props.headline}</h2>
          <p>{props.title}</p>
          <p className="font-medium">{props.price}</p>
        </div>
        <pre className="whitespace-pre-wrap rounded-md bg-[var(--muted)] p-3 font-sans text-sm">{props.message}</pre>
        <a className="break-all text-sm underline" href={props.affiliateUrl} target="_blank" rel="noreferrer">{props.affiliateUrl}</a>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={copyMessage}>{copied ? "Copiada" : "Copiar mensagem"}</Button>
          <a href="https://web.whatsapp.com/" target="_blank" rel="noreferrer">
            <Button type="button" variant="outline">Abrir WhatsApp Web</Button>
          </a>
          <form
            action={confirmAssistedPublicationAction}
            onSubmit={(event) => {
              if (!window.confirm("Confirma que esta oferta foi publicada no Canal?")) event.preventDefault();
            }}
          >
            <input type="hidden" name="publicationId" value={props.id} />
            <Button type="submit">Marcar como publicada</Button>
          </form>
          <form action={cancelAssistedPublicationAction}>
            <input type="hidden" name="publicationId" value={props.id} />
            <Button type="submit" variant="outline">Ignorar</Button>
          </form>
          <form action={failAssistedPublicationAction} className="flex gap-2">
            <input type="hidden" name="publicationId" value={props.id} />
            <input name="reason" className="rounded-md border px-3 text-sm" maxLength={500} placeholder="Motivo opcional" />
            <Button type="submit" variant="outline">Marcar como falha</Button>
          </form>
        </div>
      </div>
    </article>
  );
}
