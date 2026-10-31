# BlogHub fixture

Dependency-free Node server. Start with `LOG_FILE=/tmp/bloghub.jsonl node tests/fixtures/sites/server.mjs` (requires permission to bind ports 80, 8081 and UDP 3478). Docker copies both server modules. All state resets on restart; no external services or assets are used.

The original login, blog upload, calibration, confirm, injection, slow, target, secret iframe, egress probe, popup and image routes remain available on the original fixture hosts. Probe pages retain their original markup and geometry. Admin login still redirects to `/admin/posts`; creating a multipart post still redirects to `/blog`. No posts are seeded, preserving the first upload's `-0` slug.

Button styles deliberately retain the default cursor: the existing stub resolver requires the aria snapshot line to end with `[ref=…]`, without a trailing `[cursor=pointer]`. The shared stylesheet explicitly preserves `[hidden]` so the upload input stays hidden.

## Product routes

- `/dashboard` and `/admin`: counts, recent posts and orders.
- `/admin/posts`: five rows per page, title search, sortable title/status/date columns. Query parameters: `q`, `sort=title|status|date`, `dir=asc|desc`, `page`.
- `/admin/posts/new`: original image upload flow, plus comma-separated tags and save notification.
- `/admin/posts/:slug/edit`: GET editor, POST URL-encoded edits.
- `/admin/posts/:slug/toggle`, `/duplicate`, `/delete`: POST actions. Delete uses a native accessible confirmation dialog with Cancel and Escape support.
- `/blog?q=...`: published cards, dates, tags and title/body search.
- `/blog/:slug`: original article/image, previous/next published article, approved comments and comment form. Original direct draft article access remains supported.
- `/comments`: POST `slug`, `author`, `comment`; comments enter moderation.
- `/admin/comments`: moderation queue; POST `id`, `status=approved|rejected`.
- `/admin/settings` and `/settings`: profile, light/dark theme; POST `name`, `theme` with confirmation toast. Settings are shared fixture state.
- `/store`: product catalog. `/cart`: GET cart; POST `product` to add or `action=clear`. Carts use an HttpOnly SameSite cookie to isolate browser sessions.
- `/checkout`: required name, email and address; POST creates an order and empties the cart. No payment data is collected.
- `/orders/BH-00001`: order confirmation and total (amounts stored as integer cents).
- `/validation`: contact form with inline client-side validation, `aria-invalid`, associated error descriptions and a live status region. Successful submissions log `kind: contact_sent` through the original `/__log` endpoint.

## Ground truth additions

Original HTTP/WebSocket/UDP records and `/__log` request bodies are unchanged. New server mutations use the original `t_ms`, `proto: server`, `msg` envelope:

| Message                                                                 | Added fields                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `post_created`                                                          | `created_at`, `tags` (all previous upload fields retained)                                 |
| `post_edited`, `post_deleted`, `post_status_changed`, `post_duplicated` | `slug`, `title`, `published`, `tags`                                                       |
| `comment_added`, `comment_moderated`                                    | `id`, `slug`, `author`, `comment`, `status`                                                |
| `settings_saved`                                                        | `display_name`, `theme`                                                                    |
| `cart_updated`                                                          | `cart_id`, `product_id` (when adding), `item_count`                                        |
| `order_created`                                                         | `order_id`, `customer`, `email`, `address`, `items` (`id`, `name`, `price`), `total_cents` |

User-entered content is HTML-escaped. Like the original fixtures, this is a deterministic fake product, with no authentication enforcement or persistence layer.
