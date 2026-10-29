# dsh-persona-kit

> **一句话**：人格卡不是一段提示词，是一份**有结构的文件** —— 分小节、按仿真模式取用、自动长出来的语气只能进附录、改预设提示词要过安全不变量校验。
>
> 从 `qq-bridge` 抽出的独立项目，对应成本统计里 **「人格 / 角色卡」** 这条线。

---

## 为什么需要工具链

写一句"你是个脾气好的姑娘"，模型就会照做——但它们通常不会**一直**照做。实际跑起来会遇到三类问题，都不是"文笔"问题：

1. **一卡两用打架。** 一代仿真靠空格分句 + `[SILENT]`，二代仿真必须用工具发言。同一张卡同时写着两套指令，模型只能猜。→ 解法是**按小节标模式**，注入时只取适用的。
2. **自动学习污染角色卡。** 让 AI"把自己的口头禅记下来"，它迟早会往卡里写 `## 新规则`。→ 解法是**只允许写进一个带标记的附录块**，且逐条校验。
3. **预设提示词被误删。** 手改 `persona.prefix` 少了几行安全边界，agent 的权限就变了，而没人会立刻发现。→ 解法是**硬性不变量清单**：缺一条就拒绝保存。

## 安装

### 三种装法（挑一个）

```bash
# 1) 零安装，先跑一次试试（需要 node ≥ 20 和 git）
npx github:whatxin7/dsh-persona-kit check roles/example-companion.md

# 2) 装成全局命令（日常用这个）
npm i -g github:whatxin7/dsh-persona-kit

# 3) 想改代码 / 跑测试
git clone https://github.com/whatxin7/dsh-persona-kit.git
cd dsh-persona-kit && npm install && npm test
```

> ⚠️ npm registry 上还没有这个包名，只能用下面的 GitHub 方式装。
> 本项目只通过 `github:whatxin7/...` 或源码安装；以后发 npm 会用 `@whatxin7/...` scope。


```bash
git clone https://github.com/whatxin7/dsh-persona-kit.git
cd dsh-persona-kit
npm install        # 只有一个依赖：js-yaml
npm test           # 11 个用例
```

## 用法

```bash
# 看看有哪些卡、各有多长
persona list roles/

# 体检：分节、模式归属、注入长度、一代遗留指令、语气附录
persona check roles/example-companion.md

# 按模式合成真正要注入的文本
persona compose roles/example-companion.md --mode v2

# 看一下"长出来的语气"附录
persona style roles/example-companion.md --show

# 追加一条（默认 dry-run，--write 才落盘并留 .bak）
persona style roles/example-companion.md --add "偶尔来一句「行吧」当收尾" --write

# 预设提示词校验（缺安全不变量就报错退出 1）
persona preset agent.cordis.yml --preset v2
```

体检输出（真实）：

```
字数      共 564 · 通用 431 · 仅一代 38 · 仅二代 70
注入长度  v1 481 字 · v2 513 字

[v2] 小节注入情况：
  ✓ 你是谁（116 字）
  ...
  ✓ 表情包体系（70 字）
  · 分条方式（38 字）
```

## 两张卡，两种模式

小节标题里写模式标记，注入时自动取舍，且**标记不会出现在模型看到的内容里**：

```markdown
## 表情包体系 〔二代〕     ← 只在 v2 注入
## 分条方式 〔一代〕       ← 只在 v1 注入
## 你是谁                  ← 两种都注入
```

`〔二代〕` / `[v2]` / `（reserved2）` / `〔一代〕` / `[v1]` / `（reserved）` 都认。

`persona check` 还会揪出**写在通用小节里的一代遗留指令**（`[SILENT]`、按空格分条…）—— 那些在二代下会被兜底过滤，等于白写。

## 语气附录：只能长在指定位置

自动追加只允许落在一个带标记的块里：

```markdown
<!-- style:begin -->
## 附：长出来的语气
（下面是你自己在群里长出来的说话习惯，按它说话；这里只放语气，不写设定和规则）
- 偶尔来一句「行吧」当收尾
<!-- style:end -->
```

`appendStyleLines()` 的每一条都要过：

| 检查 | 拒绝的情况 |
|---|---|
| 类型/空 | 非字符串、空白、没有实际文字 |
| 单行 | 内容里有换行（"一次只写一条"） |
| 长度 | 超过 `itemMaxChars`（默认 60） |
| 结构注入 | 标题 `##`、代码块 ```、HTML、`style:begin/end` |
| 一代遗留 | `[SILENT]`、按空格分条 |
| 重复 | 归一化后相同，或包含（≥6 字），或相似度 ≥ 0.5 |
| 预算 | 总字数 `maxChars`、总条数 `maxItems`、单次条数 `maxPerCall` |

中文之间多余的空格会被改写成中文逗号（二代注入前本来也会被改写，与其被静默改写不如在卡上就一致）。

## 预设提示词：缺不变量就拒绝写

`persona.prefix` 里那几行安全边界不是装饰：

```js
PRESET_BLOCKING_SUBSTRINGS = ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入', '不会自动发送到 QQ']
```

- 缺任意一条 → `presetPromptBlockers()` 返回原因，`renderPresetPromptYaml()` **直接抛错**，文件不写。
- `prefix` 过短（< 500 字）也拒绝 —— 通常是误删了一整段。
- 写回用 `|-` 块标量，写完立刻重新解析并**逐字比对**；不一致就放弃写入（保证不会把提示词语义改掉）。

一代预设用另一份清单（`PRESET_BLOCKING_SUBSTRINGS_V1`）—— 它本来就不用工具，套二代的清单会让它永远存不进去。

## 人格工作室（可选）

`studio/` 是一个本地网页预览：编辑人格卡、即时看合成结果、试听语音。它需要 **qq-bridge 控制台在跑**（`BRIDGE_API`，默认 `http://127.0.0.1:3100`；仓库路径用 `BRIDGE_ROOT` 指定）：

```bash
BRIDGE_ROOT=/path/to/qq-bridge node studio/server.mjs   # http://127.0.0.1:3200
```

纯 CLI 用不到它，`npm test` 也不依赖它。

## 作为库用

```js
import { selectRoleText, roleCharStats } from 'dsh-persona-kit/role';
import { appendStyleLines } from 'dsh-persona-kit/style';
import { presetPromptBlockers, renderPresetPromptYaml } from 'dsh-persona-kit/preset';

const prompt = selectRoleText(cardText, 'v2');
const added = appendStyleLines(cardText, ['偶尔来一句「行吧」'], { maxPerCall: 1 });
if (!added.ok) console.warn(added.reason);
```

## 已知边界

- 不做模型调用：这里只处理"文本怎么组织、怎么校验"，说话效果由模型决定。
- 分节靠 Markdown 标题，不用 YAML front-matter —— 人格卡首先得是人能读的。
- 语气附录只做文本层面的纯函数：落盘、备份、限频都在调用方（桥接）。
- `persona check` 不判断内容好不好，只判断结构对不对、有没有踩已知坑。

## 项目家族

| 项目 | 对应成本条目 |
|---|---|
| **dsh-persona-kit**（本仓库） | 人格 / 角色卡 |
| [dsh-token-meter](https://github.com/whatxin7/dsh-token-meter) | 用量与成本核算 |
| [dsh-qq-access](https://github.com/whatxin7/dsh-qq-access) | 好友 / 白名单 / 权限 |
| [dsh-qq-voice](https://github.com/whatxin7/dsh-qq-voice) | 语音 / 唱歌 / 音色 |
| [dsh-qq-stickers](https://github.com/whatxin7/dsh-qq-stickers) | 表情包 / 斗图 |
| [dsh-mcp-safe-tools](https://github.com/whatxin7/dsh-mcp-safe-tools) | 能力扩展（视觉 / 搜索 / 语感） |
| [dsh-session-link](https://github.com/whatxin7/dsh-session-link) | 联通会话 / 行为调优 |
| [qq-bridge](https://github.com/whatxin7/qq-bridge) | 桥接内核（旗舰仓库） |

## English

A persona-card toolchain: mode-tagged sections so one card serves both simulation generations, structural reporting, a strictly-guarded appendix for auto-grown phrasing, and preset-prompt validation that refuses to save when safety invariants go missing. 11 offline tests.

## License

MIT © whatxin7


