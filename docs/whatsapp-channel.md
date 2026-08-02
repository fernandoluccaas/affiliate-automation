# Canal do WhatsApp

## Supported mode: ASSISTED

The stable integration shares the existing offer scheduler and Channel policies. It prepares one immutable Publication per Channel and Offer version with status `AWAITING_MANUAL_PUBLICATION`. It does not control WhatsApp Web or claim that a message was delivered.

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

1. Create a Canal do WhatsApp in `/canais` and select Assistido.
2. Run the worker once or wait for the publication cadence.
3. Open `/publicacoes-assistidas`.
4. Copy the message by clicking the Clipboard button and download the image if available.
5. Open WhatsApp Web and publish manually in the correct Canal.
6. Confirm publication. The system records `PUBLISHED`, `publishedAt`, the authenticated user and `publicationMode=ASSISTED`; `externalId` remains null.

Awaiting rows reserve daily slots. The default pending cap is 5 per channel. Ignored rows become `CANCELLED`; reported failures become `PUBLICATION_FAILED`. Neither is automatically retried.

## Media safety

Remote media must be HTTPS, have an image content type and remain below the configured size. Local/private literal destinations and redirects to them are rejected. A missing image does not create another Publication; text remains available.

## WEB_EXPERIMENTAL

The repository currently prohibits unofficial WhatsApp Web automation. Therefore this mode is represented only by a disabled contract returning `WHATSAPP_WEB_AUTOMATION_NOT_AUTHORIZED`. Feature flags cannot override repository policy. There is no Playwright installation, QR capture, profile, cookie/local-storage handling, selector automation, dry run or real automatic send.

If a future repository-level authorization is added, it must be implemented as a publisher delivery adapter behind the existing contract without changing offer selection or creating a second pipeline.
