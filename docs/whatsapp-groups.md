# Grupos do WhatsApp

## Supported mode: ASSISTED

The stable integration shares the existing offer scheduler and Channel policies. Each `WHATSAPP_GROUPS` record represents one owner-administered group and prepares one immutable Publication per group and Offer version with status `AWAITING_MANUAL_PUBLICATION`. It does not control WhatsApp Web or claim that a message was delivered.

The formatter preserves the stored title, prices, coupon, shipping fact and affiliate URL. A typical snapshot is:

```text
PROMOO MERCADO LIVRE 😮‍💨🤌

*Smartphone OPPO A6T 128GB 4GB RAM Violeta*

De: ~R$ 1.299,00~

Por: *R$ 887,78* ✅

🚚 Frete grátis

🛒 *Compre aqui:*
https://meli.la/XXXXXXXX
```

The affiliate URL is mandatory before scheduling and appears once. The page always renders the saved snapshot, so refreshing it cannot rotate the headline.

## Manual workflow

1. Create a Grupo do WhatsApp in `/canais` and select Assistido. Configure the exact visible group name.
2. Run the worker once or wait for the publication cadence.
3. Open `/publicacoes-assistidas`.
4. Copy the message by clicking the Clipboard button and download the image if available.
5. Open WhatsApp Web, manually select the correct group and publish.
6. Confirm publication. The system records `PUBLISHED`, `publishedAt`, the snapshotted group name, destination type `GROUP`, authenticated user and `publicationMode=ASSISTED`; `externalId` remains null.

Several groups can coexist with independent rules and idempotency. Awaiting rows reserve daily slots only in their own group. The environment fallback cap remains 5 per Channel; the recommended initial per-group configuration is daily limit 3, minimum interval 60 minutes and maximum 3 pending publications. Ignored rows become `CANCELLED`; reported failures become `PUBLICATION_FAILED`.

## Legacy conversion

`WHATSAPP_CHANNEL` remains in PostgreSQL because its migration was already applied, but it cannot create new assisted Publications. Existing records are converted only after an authenticated user clicks `Converter para Grupo do WhatsApp` in `/canais`. The action updates `Channel.type` and configuration on the same ID, so Publications, snapshots, rules and history stay related. `WHATSAPP_GROUPS_API` is not used.

## Media safety

Remote media must be HTTPS, have an image content type and remain below the configured size. Local/private literal destinations and redirects to them are rejected. A missing image does not create another Publication; text remains available.

## WEB_EXPERIMENTAL

The repository currently prohibits unofficial WhatsApp Web automation. Therefore this mode is represented only by a disabled contract returning `WHATSAPP_WEB_AUTOMATION_NOT_AUTHORIZED`. Feature flags cannot override repository policy. There is no Playwright installation, QR capture, profile, cookie/local-storage handling, selector automation, dry run or real automatic send.

If a future repository-level authorization is added, it must use `groupDisplayName` and `destinationType=GROUP` behind the existing publisher contract without changing offer selection or creating a second pipeline.
