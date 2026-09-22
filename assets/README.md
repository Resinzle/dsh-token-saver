# assets

Images referenced by the documentation.

## `sponsor-qr.jpg`

The author's personal payment codes: WeChat Pay on the left, Alipay on the right. Rendered by [`docs/sponsor.md`](../docs/sponsor.md).

Two things about this file:

- **It is a JPEG whose bytes begin `FF D8`, despite the original arriving named `.png`.** The extension says `.jpg` because the bytes say JPEG: a mismatched extension makes some viewers and static hosts fail to render it. Worth checking on any image added here, since file-type sniffing is not universal.
- **It is a payment credential, not decoration.** Do not replace it in a fork, and do not redistribute a copy of someone else's. A tip sent to a code that did not come from this repository does not reach the author, which is why [`docs/sponsor.md`](../docs/sponsor.md) says so on the page itself.

An earlier version of this file sent the reader to a platform-rule checklist before publishing a payment code. That checklist is gone: its answers were never verified against the providers' own terms, and unverified compliance advice invites misplaced reliance.
