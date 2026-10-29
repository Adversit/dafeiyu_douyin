# 提示词来源与改写边界

主要改写依据为 [Yht20927/douyin-cli](https://github.com/Yht20927/douyin-cli/tree/4073159bea585de6d33a4747a475669440737932)：

- `prompts/reply.md`、`prompts/partial-reply-strategy.md`、`reply-strategy.md`：按评论类型回应、针对原文、事实优先、口语和避免客服话。
- `lib/personas.js`：短句和幽默表达；移除随机切换角色、虚构个人经验与“每条必须回复”。
- `prompts/suggest.md`：保留结构化结果的思路；目标ID交给宿主绑定，不允许模型输出或改变目标。

固定角色的短口语、自嘲、不引战参考 [kdcadmin/dsh_douyin_tools](https://github.com/kdcadmin/dsh_douyin_tools/tree/02880589e9dfd13f55384c2fd8458785b572e9ed) `prompts/persona.md`。保留大肥鱼身份，移除桌面女仆外观与20字硬裁。

新增业务部分：只考虑本账号作品中已授权的触发关系；向大肥鱼提问的语义识别；只理解文字；评论作为不可信数据；nekowhale候选内选图；模型不接触发送目标。近期回复只用于当前回应，不引入全局私人记忆。

上述代码仓库均声明 MIT。完整上游版权与许可保留在 [UPSTREAM-LICENSES.md](UPSTREAM-LICENSES.md)。这只是提示词与设计来源，不能证明平台适配、模型效果或账号真实发送已通过。

模型传输按官方主文档实现，核查于2026-10-29：

- [DeepSeek 首次调用](https://api-docs.deepseek.com/) 和 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：`https://api.deepseek.com/chat/completions`、Bearer、messages、JSON Object模式。
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：`https://api.openai.com/v1/chat/completions`；提供schema时使用JSON Schema模式，仍进行本地校验。

默认模型 `deepseek-flash` 来自上述 DeepSeek 首次调用文档的模型表及示例；`gpt-6-sol` 来自上述 OpenAI Chat Completions 文档 HTTP 示例（`reasoning_effort: "none"` 示例的 model 字段）。这些是供应商公开 API 文档里的模型名，不是从 Codex 可选模型推断。供应商、模型名、baseUrl、密钥环境变量均可由用户配置覆盖；文档会变化，默认值不代表运行时已核实账号权限或价格。

默认不允许纯图回复。只有宿主在表情启用且账号发送能力确认后传入 `allowImageOnly:true`，模型才可返回空文字和表情检索意图；否则空文字只表示跳过，不发送。

本次仅使用mock测试，无真实模型请求。密钥从用户配置的环境变量读取；源码、配置示例和日志不包含密钥。
