# 大肥鱼抖音评论 Agent

保留 `douyin-cli` 的 ImageX 签名与上传核心代码，适配其抖音端点和参数；本地 Bridge、DouyinAdapter、Agent 与任务队列为本项目的新实现。表情搜索与缓存直接调用固定版本 `dsh-nekowhale-stickers`。没有安装 DSH，也没有复制 creatorhub 或 MediaCrawler 的代码。来源、固定版本、实际复用与新写范围见 [docs/SOURCES.md](docs/SOURCES.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 当前范围

- 只处理手动指定且作者为当前登录账号的作品；不搜索或主动进入他人作品。
- 只理解完整评论文字和当前线程文字，不分析评论图片或视频画面。
- 三类候选：他人回复本账号评论、结构化 @ 本账号、文字明确向大肥鱼提问。不要求前两类一定是问句。
- 历史评论也进入队列；默认每轮最多尝试发布 3 条，两次发送间隔至少 60 秒；均可配置。
- 固定大肥鱼人格，支持文字和可选的一张 nekowhale 原表情。首版发送接口要求非空文字，不启用纯图或模板生成。
- SQLite 持久化评论、任务、续扫游标；按账号＋作品＋实际目标评论去重，发送结果不确定时不自动重试。

**当前是待用户代码 review 与真实账号验收的版本。** 本地模拟通过不代表网页私有接口、账号图片权限、GIF 动画或模型回复效果已通过真实验证。

## 本地准备

Node.js >=20.12、Chrome、Tampermonkey，抖音网页版保持登录。无需 Playwright、DSH 或 ffmpeg。

```bash
npm ci --omit=optional
npm run init
```

若本机 npm 默认仓库不可访问，可仅对本次安装指定 `--registry=https://registry.npmjs.org`，不用修改全局配置。

`init` 不覆盖现有本地配置或密钥；会生成随机 Bridge Token、空的 `.env.local`，以及与配置端口一致的 `runtime/dafeiyu-douyin.user.js`。它不创建 OpenAI/DeepSeek API 密钥。

## 先接通只读浏览器

1. 运行 `npm run bridge`，保留此终端。
2. 在 Tampermonkey 新建脚本，将 `runtime/dafeiyu-douyin.user.js` 的内容粘贴并保存。
3. 从本机 `config.local.json` 复制 `bridge.token`，通过油猴菜单“配置本地 Bridge Token”保存。不要公开此文件或 Token。
4. 打开或刷新已登录的 `https://www.douyin.com/`。此脚本只负责接收本地受限命令，安装后不会自行发评论。
5. 另一个终端运行 `npm run doctor`，从返回的浏览器身份确认 UID，再把它以**字符串**填入 `config.local.json` 的 `accountUid`。
6. 手动添加自己的作品：

```bash
node src/cli.js videos add "https://www.douyin.com/video/你的作品ID"
npm run doctor
npm run inspect
```

`videos` 也可直接填写为作品 ID 或完整链接的字符串数组。不解析短链接，不接受 JSON 数字型长 ID。`doctor` 和 `inspect` 都不调用模型，也不发布评论。

如果调整 Bridge 端口，重新运行 `npm run init` 并更新已安装的油猴脚本。只保留一个连接本项目的抖音标签页，避免不同页面互相替换浏览器会话。

## 确认回复与 @ 字段

`douyin.inboundSchemaConfirmed` 出厂为 `false`。上游丢弃了部分接收端关系字段，我们保留了原始字段，但**没有用真实账号确认字段语义**；因此默认不把候选字段当成已证实的“回复我／@ 我”关系。文字明确向大肥鱼提问仍可通过语义判断进入回复流程。

`inspect` 将完整文字和关系原字段保存为 `runtime/inspect-<作品ID>.json`。对照浏览器中已有的下列评论检查：

- 回复本账号顶层评论，以及回复本账号子回复的样本。
- 真正 @ 本账号、@ 其他人、仅文字写出相同昵称的样本。
- 同一楼中观众互相回复的反例。

当前适配映射使用 `reply_to_reply_id`、`reply_to_uid` / `reply_to_userid`、`text_extra[type=0].user_id`。在已确认 schema 的前提下，子回复的 `reply_to_reply_id` 显式为 0 且 `reply_id` 与查询根评论匹配时，才把该根评论视为直接回复目标；字段缺失不推断。若真实回包不同，应先修改 `src/douyin/adapter.js` 映射并补样本测试；不能只将开关打开。样本验证后才设置 `inboundSchemaConfirmed: true`。pending 任务按当前规则重新判断；此前跳过的评论在关系证据发生变化后会重新评估。

分页遍历每轮从上轮游标继续，完成一轮完整扫描后再从头巡检旧楼新回复；游标持久化，重启可继续。热度排序、跨页移动、删除以及平台未返回的数据仍可能导致遗漏，轮询不能视作平台事件订阅。缺少分页信息或遇到页数上限时会明确记录未完整扫描。

## 自行填写模型服务

编辑 `.env.local`，只填写打算使用的服务密钥：

```dotenv
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
```

在 `config.local.json` 中选择 `model.provider: "deepseek"` 或 `"openai"`；`model.model` 留空使用适配器默认值，也可填写自己账号可用的模型名。可选配置 `baseUrl`、`apiKeyEnv`、`timeoutMs` 和 `maxTokens`。切换 provider 不会自动回退到另一家或产生两次模型调用。密钥不写入 JSON 配置或日志。

默认模型与端点来自供应商公开 API 文档，来源见 [prompts/README.md](prompts/README.md)。账号是否具有模型权限、真实请求是否可用，本次未验证。

提示词可 review；已知回复/@他人的关系、直接父消息和匿名发言者标识会传给模型，避免把整楼的其他对话混为同一人：

- [prompts/persona.md](prompts/persona.md)：固定角色、语气和事实边界。
- [prompts/addressed.md](prompts/addressed.md)：判断是否向大肥鱼提问。
- [prompts/reply.md](prompts/reply.md)：回应当前一条评论，可明确跳过。
- [prompts/sticker.md](prompts/sticker.md)：仅从当前候选中选一张图。

模型不能指定发送账号、作品 ID、目标评论 ID 或本地文件路径；这些由宿主和原始事件绑定。修改提示词后需重启 worker，已处理目标不会因此自动重发。

## 可选表情

`stickers.enabled` 默认关闭。开启后由成熟素材包检索、按需下载原 GIF，模型仅选择候选 ID；近期用过的表情会排除。

- `mode: "optional"`：没有合适候选可以只发文字；下载或校验异常会明确失败，不悄悄忽略错误。
- `mode: "required"`：没取得合适表情则不发送。
- `autoSync: "off"`：只使用本地索引及已缓存素材；`"lazy"`：允许上游按需联网更新、下载。

原素材输出是 GIF。账号图片评论能力、上传结果以及 GIF 是否保留动画需实际验收。文字发送和图片发送均检查回执；图片未附上时记录 `unknown`，不会按成功继续处理。

素材、索引数据和代码许可证不同；不移除图稿、水印或署名，也不由代码开源推导素材使用授权。完整来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 自动执行

下列命令会调用选定模型，并在规则命中、生成结果通过检查后**自动发布评论**：

```bash
npm run once
# 或持续运行
npm start
```

先前的历史评论也在处理范围内；默认每轮最多尝试 3 次发送。结构触发的候选仍可因无可理解文字、模型明确跳过或重复回复而不发送。使用 Ctrl+C 停止。

```bash
npm run status
```

状态解释：`pending` 待处理；`preparing` 生成中；`sending` 已进入发送；`succeeded` 回执确认或已确认平台存在本人对该目标的回复；`failed` 发送前确定失败；`skipped` 已判断跳过；`unknown` 可能已发出、结果或目标未完全确认。不能把 `unknown` 当作未发送。发布回执的作品、楼层和作者身份均须通过核对。

首次历史补回会利用已扫描到的、关系已确认的本人回复，标记其实际目标已处理。只有同一目标被标记，根楼中的其他新回复不会因此被跳过；关闭关系开关或缺少直接关系时不会猜测历史已回。时间统一使用毫秒，历史回填保留真实回复时间，不当作刚刚发出的新评论。

对明确的 `failed`，修正配置或依赖后可手动 `node src/cli.js retry <任务key>`；`unknown` 不开放重试入口，保留已有评论 ID 等信息供平台核查。进程恢复将遗留 `sending` 转为 `unknown`，只将尚未发送的 `preparing` 放回队列。

worker 使用独占进程锁。异常退出留下锁时，确认没有该项目 worker 运行，再手动删除 `runtime/worker.lock`。不自动争抢旧锁，避免两个进程误删对方的活锁。

## 验证与手动验收

```bash
npm run check
npm test
```

自动测试使用本机临时端口、模拟抖音回包和模拟模型；包括真实 SQLite 和真实安装素材包的离线检索。不会调用付费模型、登录抖音或发送真实评论。本项目没有前端构建步骤。

实际命令与验证状态见 [docs/VERIFICATION.md](docs/VERIFICATION.md)，本轮 review 与修复记录见 [docs/REVIEW.md](docs/REVIEW.md)。按 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 进行账号手动验收。本次用户已明确授权修复、提交并推送到指定 GitHub 仓库；真实账号验收仍待执行，不以推送代替验收。
