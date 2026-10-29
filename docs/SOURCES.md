# 上游来源与改写范围

本文件记录 2026-10-29 审阅并用于首版的固定版本。上游声明、静态源码结论与本机自动测试不能替代抖音真实账号验收。

## 实际使用

| 上游与固定版本 | 用途 | 本项目对应位置 | 授权与边界 |
| --- | --- | --- | --- |
| [Yht20927/douyin-cli](https://github.com/Yht20927/douyin-cli/tree/4073159bea585de6d33a4747a475669440737932) | 保留 ImageX 核心原码；参考其抖音端点与参数改写评论读写；本地 Bridge 与 Adapter 为新实现 | `userscript/`、`src/bridge/`、`src/douyin/`；具体原文件映射见 `vendor/douyin-cli/NOTICE.md` | MIT；原文保存在 `licenses/douyin-cli-MIT.txt`。保留 Yht20927 的版权声明。 |
| [Loping151/dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers/tree/b7b58c0ff347d639fabe87d90d6716c4b3cad185)，npm `dsh-nekowhale-stickers@1.1.1` | 原表情索引、成熟搜索评分、素材解析与按需缓存 | `src/stickers/service.js` 调用包的 `core` 导出；不复制或重写搜索与合成算法 | 代码 Apache-2.0；知识元数据 CC BY-NC 4.0；GIF、角色及图稿另属原作者，不能由代码许可证推导素材使用权限。 |
| [kdcadmin/dsh_douyin_tools](https://github.com/kdcadmin/dsh_douyin_tools/tree/02880589e9dfd13f55384c2fd8458785b572e9ed) | 已处理评论账本、避免重复处理和简短口语回复的设计参考 | 本地任务状态与回复策略；不引入 DSH 整包依赖 | MIT；作者 TiAmoSS；原文保存在 `licenses/dsh-douyin-tools-MIT.txt`。未直接复制其工具包或提示词文件。 |
| [ERUIHNIYHBKBNF/dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona) | 活泼、可爱、略傲娇及「本鱼」的人格风格参考 | `prompts/persona.md` 以本项目自己的公开评论边界重新编写 | 仅参考角色风格，未复制提示词原文；以该项目发布的许可和角色素材权利为准。 |

表情代码使用真实 API：`import('dsh-nekowhale-stickers/core')` 的 `StickerKit`，传入 `dataDir`、包自带的 `meta/nekowhale.json` 与 `autoSync`，调用 `search()`、`resolve()`、`file()`。`src/stickers/service.js` 只做本应用字段适配、开关、候选排除和本地文件安全检查。首版仅使用原 GIF，不加载 DSH 插件，不调用模板渲染，不修改图稿、水印或上游署名。

2026-10-29 已通过公开 npm registry 查询确认 1.1.1 已发布，并下载固定 tarball 作离线接口核验：

- tarball：`https://registry.npmjs.org/dsh-nekowhale-stickers/-/dsh-nekowhale-stickers-1.1.1.tgz`
- integrity：`sha512-GJN5I3Kdh2GlRkB9qA0Jp9XZybBEI6T0IXGLdfmYO1AoF0sb8zT/yfrTJMQybtLSzqTSJhe7o3Zfh78GNajhMA==`
- 上游 `LICENSE`、`LICENSE-ASSETS`、`NOTICE` 的原文分别保存在 `licenses/nekowhale-Apache-2.0.txt`、`licenses/nekowhale-LICENSE-ASSETS.txt`、`licenses/nekowhale-NOTICE.txt`；许可证内容通过 GitHub 连接器从固定 SHA 读取。

`autoSync: 'off'` 仅使用本地索引及已缓存 GIF；`lazy` 允许上游从 `https://kiriyuki.com` 更新索引并在实际发送时下载所选 GIF。未下载素材在离线模式下会明确失败。适配器在调用前检查索引声明大小，调用后检查真实文件大小；它没有改写上游下载器，也不承诺限制上游下载过程中的瞬时内存占用。GIF 是否能在抖音按动图显示仍需真实账号验证。

## 仅阅读，没有复制

| 项目 | 采用的启发 | 未直接采用的原因 |
| --- | --- | --- |
| [3441293738/creatorhub @ 9808028b38028347bed5ea073f8941250ad767ad](https://github.com/3441293738/creatorhub/tree/9808028b38028347bed5ea073f8941250ad767ad) | 草稿、持久化任务、账号写入限制、发送结果不确定时停止重试 | 审阅的仓库根目录未发现项目 LICENSE，GitHub 元数据 license 为 null；没有复制其代码或提示词。其文本评论字段也不足以直接支持精确的回复 / @ 触发。 |
| [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 评论与二级回复采集的数据组织参考 | 项目强调非商业学习使用；未复制其代码、浏览器自动化或签名实现，也不是本项目运行依赖。 |

二级回复接口的作品参数参考 MediaCrawler 的 `get_sub_comments`：使用 `item_id`；顶层评论列表继续使用 `aweme_id`。本项目只按这一公开接口用法调整参数，真实抖音返回仍需更新油猴脚本后验证。

## 修改与保留

- `src/stickers/service.js` 为本项目新增适配层；上游 `src/core/kit.ts`、`src/core/search.ts`、`src/core/sync.ts` 与 `meta/nekowhale.json` 保持由固定版本包提供，没有在本仓库内改写。
- 油猴 ImageX 核心保留了固定上游 `scripts/douyin.user.js` 中 111 行连续原码（61 行签名/编码实现及 50 行缓冲/上传实现）；身份读取、评论端点和发布参数采用上游接口知识后改写。这是局部代码保留，不是整套工具包的直接接入。
- `src/bridge/server.js`、`client.js`、`protocol.js` 是本项目新写的受限命令传输层；只参考上游 HTTP 长轮询、关联回执和账号选择思路，没有导入或直接复用其 Router、ConnectionRegistry、BridgeClient 类。`src/douyin/adapter.js` 的归一化、分页续扫、本人作品校验及回执检查也是本项目新实现。
- Agent、状态账本与固定人格提示词由本项目按已确认需求编写，参考上游设计和回复策略；不能将设计参考表述为经过上游生产验证的原实现复用。详细映射见 `vendor/douyin-cli/NOTICE.md`，本项目实现和测试均不代表抖音官方 API 支持。
- 根目录许可如后续新增，仅能覆盖有权许可的项目代码，不能覆盖第三方代码、知识元数据、GIF 或角色形象。

完整署名与素材限制见根目录 `THIRD_PARTY_NOTICES.md`。实际商业使用、素材再分发或对外部署需要另行核对上游素材权利，不因 npm 包可安装而自动获准。

## 本地网页控制台

控制台继续复用本项目的 Worker、DouyinAdapter、Agent、Store 和独占执行锁；没有另写一套抖音发送链路。界面与管理接口为本项目新增集成，成熟依赖按锁文件固定：

| 依赖 | 实际用途 |
| --- | --- |
| React 19.3.1、Ant Design 6.6.8、Ant Design Icons 6.3.4 | 配置表单、状态展示、日志列表、抽屉与交互组件；没有复制未获授权的上游管理页面 |
| Fastify 5.12.7、@fastify/static 10.1.2 | 本地管理接口和已构建静态资源；业务接口、同源会话和 CSRF 校验为本项目集成 |
| Pino 10.4.0 | 结构化日志编码；业务事件、脱敏、有限日志轮转与 SSE 展示为本项目集成 |
| Vite 7.3.7 | 兼容当前 Node.js 20.19+/22.12+ 的前端构建，产物在本机生成 |

`light-my-request` 固定到兼容 Node.js 20 的 6.6.0；未升级为要求 Node.js 22 的 cookie 依赖链。依赖升级与安全检查结果以本轮 [WEB-VERIFICATION.md](WEB-VERIFICATION.md) 为准。组件和日志库的成熟度不等同于本项目新增控制逻辑已完成用户验收。
