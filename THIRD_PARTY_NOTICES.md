# Third-party notices

This project includes adaptations of upstream code and uses the separately licensed sticker library described below. A project-level license, if added, does not replace these terms or grant rights to sticker artwork or character designs.

## douyin-cli

- Source: https://github.com/Yht20927/douyin-cli
- Reviewed version: `4073159bea585de6d33a4747a475669440737932`
- Copyright (c) 2026 Yht20927
- License: MIT; full unchanged text: `licenses/douyin-cli-MIT.txt`.
- Browser bridge and comment interactions are adapted for this application's explicit video allowlist, account checks, typed commands and correlated receipts. See `vendor/douyin-cli/NOTICE.md` for the source-to-adaptation mapping.

## dsh-nekowhale-stickers

- Source: https://github.com/Loping151/dsh-nekowhale-stickers
- Reviewed source: `b7b58c0ff347d639fabe87d90d6716c4b3cad185`; runtime package: `dsh-nekowhale-stickers@1.1.1`.
- Copyright 2026 Loping151.
- Source code: Apache License 2.0, reproduced unchanged in `licenses/nekowhale-Apache-2.0.txt`.
- Knowledge metadata, including tags and descriptions: CC BY-NC 4.0, as declared in the unchanged `licenses/nekowhale-LICENSE-ASSETS.txt`. Full legal code: https://creativecommons.org/licenses/by-nc/4.0/legalcode .
- The original upstream NOTICE is preserved unchanged in `licenses/nekowhale-NOTICE.txt`.

Sticker artwork and templates are by **可以叫我云大人 / 雾雪**:

- Bilibili: https://space.bilibili.com/103739
- Website: https://kiriyuki.com

大肥鱼 character design is based on ZipZipPipe (https://space.bilibili.com/4168597) and 上善无形 (https://space.bilibili.com/4456176); GPT娘 design is based on ZipZipPipe.

The GIFs are fetched from kiriyuki.com at runtime and are **not** licensed by the source-code license. The upstream asset notice states that the artwork remains the property of its authors, permits non-commercial sharing with the original author and website links, and excludes paid or other commercial use. This application does not remove watermarks or replace attribution. Its sticker adapter carries the upstream attribution alongside candidates and local file results. No GIF artwork is bundled in this repository.

## dsh_douyin_tools

- Source: https://github.com/kdcadmin/dsh_douyin_tools
- Reviewed version: `02880589e9dfd13f55384c2fd8458785b572e9ed`
- Copyright (c) 2026 TiAmoSS.
- License: MIT; full unchanged text: `licenses/dsh-douyin-tools-MIT.txt`.
- The processed-comment ledger and short conversational reply workflow were studied as design references. The DSH plugin and its tools are not runtime dependencies; no upstream prompt or tool file is copied wholesale.

## Other references

CreatorHub and MediaCrawler were read for workflow and collection design. No code, prompt, signature implementation or other files from either project are included. A project license was not found in CreatorHub's reviewed root tree; MediaCrawler states a non-commercial learning scope. These references are not represented as granting rights to this project's implementations.

For the pinned versions, integration details and current verification limits, see `docs/SOURCES.md`. Installed transitive dependencies retain their own licenses in their distributed packages.
# 本地控制台依赖

新增控制台通过固定版本 npm 包使用 React、Ant Design、Fastify、Pino 和 Vite；具体版本与使用边界见 [docs/SOURCES.md](docs/SOURCES.md)。这些包保留各自随包分发的许可证；页面、业务事件及本地控制接口为本项目集成，不宣称直接沿用了上游抖音项目的管理页面。
