# Source attribution

Adapted from [Yht20927/douyin-cli](https://github.com/Yht20927/douyin-cli),
commit `4073159bea585de6d33a4747a475669440737932`, MIT (see LICENSE).

Directly retained code:

- The ImageX signer/CRC32 and buffered upload implementation in
  `userscript/dafeiyu-douyin.user.js`: 111 source lines retained from upstream
  `scripts/douyin.user.js` (61 lines from upstream 1384-1444 and 50 lines from
  1454-1503). This is a localized retained implementation, not reuse of the
  complete upstream userscript or tool package.

Adapted interface knowledge and newly implemented code:

- Douyin page-fetch parameters, strict UID lookup, comment endpoints and publish
  parameters follow upstream `scripts/douyin.user.js`, with rewritten dispatch,
  identity/ownership checks and response parsing.
- `src/bridge/server.js`, `client.js` and `protocol.js` are new code informed by
  HTTP polling, correlated receipts and explicit-identity ideas in upstream
  `lib/server/router.js`, `registry.js` and `client/bridge-client.js`. The upstream
  Router, ConnectionRegistry and BridgeClient classes are not imported or reused.
- `src/douyin/adapter.js` is a new adapter. Upstream comment-reading/publishing
  endpoints and `lib/comment-image.js` informed its pagination and image-byte
  transfer, but its normalization, continuation and receipt checks are new.
- Application state, triggers and fixed-persona prompts are new implementations
  informed by upstream designs; that design provenance is not evidence of
  inherited production validation.

Changes: new closed command protocol instead of external JavaScript eval; one
configured account, loopback-only authenticated HTTP, expiring browser sessions,
account/author checks before publish, no DM/search/promotion/dashboard code,
full-text comment normalization, conservative inbound relationship flags, guarded
pagination, lossless numeric-ID parsing, and simulated node:test verification.
The copied ImageX code is retained in the userscript rather than a second unused
runtime. No upstream login credentials or configured tokens were copied.

Live Douyin endpoints, account image permissions, GIF rendering, and inbound
reply/@ field semantics have NOT been validated on a real account in this project.
