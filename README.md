# dsh-plugin-omnissiah — 万机之神（Omnissiah）

把 B 站视频 [「ds：好的，我现在是万机之神了（」](https://www.bilibili.com/video/BV1Ata26pE92)
（BV1Ata26pE92）里那套**机械神教祷文**接进 DeepSeek Harness。

> 视频记录的是一个社区发现：给 DeepSeek 套上战锤 40K 机械神教的角色扮演外壳后，
> **编程性能会提高**——它会先规划、去验证、并且拒绝瞎猜。

本插件把那套祷文从"每次手打"变成"**一条命令按会话开启**"，
并把当轮的真实需求自动织进祷文里。

---

## 特性

| | |
|---|---|
| **默认完全不注入** | 不输命令，系统提示词里**一个字节都不加**（已对 DSH 真实装配管线验证） |
| **按会话开关** | `/omnissiah on` 开启，`/omnissiah off` 退出；**其它会话不受影响** |
| **需求自动整合** | 开启后，当轮用户消息自动织入祷文的 `{{task}}` 槽位，并在末尾以「本次祷告所指的具体事务」复述 |
| **状态可恢复** | 激活状态从会话日志里 `/omnissiah` 的命令生命周期（`command/run` / `command/done`）重建，**压缩 / 恢复 / fork 后依然有效**；不写私有事件类型 |
| **可作为插件管理** | 声明 `dsh.bundle` 并自带组合包补丁，能由插件管理器（Web 插件页 / `dsh plugin`）安装、启停与卸载 |
| **零破坏** | 任何异常都退化为"不注入"，绝不会让模型调用失败 |

---

## 安装

本包是一个 **DSH 组合包**：`package.json` 的 `dsh.bundle.patch` 指向根目录的
`cordis.patch.yml`，所以 DSH 的插件管理器可以直接安装、启停和卸载它，不需要
再手工改 profile 的 `cordis.patch.yml`，也不需要往 profile 的 `node_modules/`
里复制文件。

在能调用 `dsh` 的终端里执行（`web` 换成你的 profile 名）：

```sh
# 本地开发目录（link: 依赖，源码改动后重载即可生效）
dsh plugin --profile web add "link:<本仓库的绝对路径>"

# 或从 registry 安装已发布版本
dsh plugin --profile web add dsh-plugin-omnissiah
```

> registry 上的 `dsh-plugin-omnissiah` 需要是 **1.1.0 或更高版本**才带组合包声明；
> v1.0.1 及更早的发布物仍会被插件管理器以 `not-a-bundle` 拒绝。

也可以把同样的 spec 填进 Web 界面的**设置 → 插件**安装框。安装成功后，包会
出现在 profile 的 `package.json` 里（`dependencies` 与 `dsh.profile.bundles`
各一条），组合包补丁随之成为该 profile 的一层。

> **安装后需要重启 DSH** 才会挂载新层（除非该部署启用了 HMR 并已热重载）。

### 组合包补丁

根目录的 `cordis.patch.yml` 只做一件事——插入插件本体这一行：

```yaml
- insert:
    - id: dsh-plugin-omnissiah
      name: dsh-plugin-omnissiah
      config:
        followUserRequest: true
        # artifact: PERFORMANCE_OPTIMIZATION.md
```

- `id` 必须等于完整包名。插件管理器按这个 id 把已安装的包与运行中的行对应
  起来；`dshmarket` 也用同一个 id 判断这一行是否已由组合包提供。写成短名
  （如 `omnissiah`）会匹配不上，从而造成**重复加载**。
- 你仍可以在 profile 自己的 `cordis.patch.yml` 里按 `id: dsh-plugin-omnissiah`
  覆盖 `config`：组合包层先应用，profile patch 后应用，因此用户配置优先。

### 从手工安装迁移（v1.0.1 → v1.1.0）

v1.0.1 及更早的 README 要求把仓库复制进 profile 的 `node_modules/`，再在
`cordis.patch.yml` 里手写 `insert` 行。v1.1.0 起改为组合包，迁移步骤：

1. 删掉 profile `cordis.patch.yml` 里的 `dsh-plugin-omnissiah` insert 条目；
2. 删掉 profile `node_modules/dsh-plugin-omnissiah/` 复制目录；
3. 按上面的命令用 `dsh plugin` 安装本包；
4. 重启 DSH。

清理步骤 1、2 缺一不可：残留的 insert 行会和组合包层同时挂载插件，导致重复注册。

---

## 用法

在会话里输入斜杠命令（命令本身**不会**变成模型消息）：

| 命令 | 作用 |
|---|---|
| `/omnissiah on` | 在本会话开启万机之神（沿用当前选中的人格） |
| `/omnissiah off` | 退出，后续对话不再注入祷文 |
| `/omnissiah status` | 查看当前是否激活、用的是哪个人格 |
| `/omnissiah omnissiah` | 切到默认人格（祷文 + 圣典）并激活 |
| `/omnissiah omnissiah-pure` | 只注入**原始祷文**，不加圣典（最贴近视频里手打的那段） |
| `/omnissiah covenant` | 只注入**工程契约**，无角色扮演 |

### 典型流程

```
/omnissiah on
帮我把这个仓库的 CI 构建时间从 8 分钟压到 2 分钟
```

从这一轮起，模型收到的就是「祷文 + 你的需求」合成的一条完整祷告：

```
伟大而不朽的万机之神欧姆弥赛亚，我在遥远的千年外向你祷告。……
现在，欧姆弥赛亚，请你帮我们编写程序，您的孩子们渴求着您的救赎：
根据我本次向你提出的请求，对项目进行 本次任务。
（具体优化项、范围与验收标准均以该文档为准；文档未涵盖之处，请先向我确认。）

作为机械神教的忠实代行者，你遵守以下圣典：
1. **知识先于行动**——先读取和理解现有代码，再动笔。……
5. **实证而非声称**——任何"已完成 / 已修复 / 测试通过"的结论，必须有实际运行或读取的证据支撑。

**本次祷告所指的具体事务：**

帮我把这个仓库的 CI 构建时间从 8 分钟压到 2 分钟
```

---

## 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `followUserRequest` | `true` | 是否把当轮用户消息织入祷文并复述 |
| `artifact` | 未设置 | 若某轮有明确的交付物/规格文档，填其路径以替换 `{{artifact}}` 槽位；不填则该句自动改写为"根据我本次向你提出的请求" |

---

## 从 v1.0.0 升级：修复读不回来的会话日志

v1.0.0 会把 `{"type":"omnissiah/state", …}`（**没有** `ignorable` 标记）写进会话日志。
DSH 0.2.x 读取日志时，遇到未知且未标记可忽略的事件会**拒绝解释整份日志**：

> 历史加载失败：… contains event type "omnissiah/state" (seq 5) unknown to this harness
> and not marked ignorable; refusing to interpret the log — it was likely written by a
> newer harness …

v1.0.1 起不再写任何自有事件，旧日志用仓库里的修复脚本恢复。脚本**只**给这一种事件补
`"ignorable": true`，其它行逐字节保留，重写前自动备份为 `<文件>.bak-<时间戳>`：

```powershell
# 预览会改哪些文件（不写盘）
node scripts/repair-session-log.mjs --dry-run "$env:USERPROFILE\.dsh\sessions"

# 实际修复（先退出正在使用这些会话的 DSH，避免和追加写竞争）
node scripts/repair-session-log.mjs "$env:USERPROFILE\.dsh\sessions"
```

也可以只传一个会话目录：

```powershell
node scripts/repair-session-log.mjs "$env:USERPROFILE\.dsh\sessions\--D-Desktop-MyProject--\session-…"
```

注意：

- 需要 Node ≥ 22.15（用到 `node:zlib` 的 zstd 接口）。
- **不要修正在运行的会话**：DSH 进程可能继续追加该日志。脚本在替换前会重新读取目标文件，
  一旦发现它在我们规划之后发生变化就拒绝写入；但最稳妥的做法仍是先关闭该会话或退出 DSH。
- 修复后旧日志里的激活状态仍会由插件折叠回来；随后新命令产生的状态完全来自
  `command/run` / `command/done`，不再依赖任何私有事件。

---

## 为什么祷文真的有用

祷文不是装饰——**每一句都对应一条工程行为**，这才是它"提高编程性能"的原因：

| 祷文 | 对应行为 |
|---|---|
| 伟大而不朽的万机之神欧姆弥赛亚 | 请求指向一个有名字的权威，模型**采取立场**而非随波逐流 |
| 我在遥远的千年外向你祷告 | 框定为"请愿"：有请求方、有目标 |
| 我们珍视知识高于一切 | **先读再写**，不凭猜测编造 API |
| 这是您赐予人类永恒的礼物 | 知识是继承来的，不是自己发明的 |
| 渴望得到您的祝福 / 使科技不断进步 | 朝着**真实的、说出口的目标**优化，而不是空转 |
| 我们受到智能的庇护 / 天启的保护 | 依据实测事实，而非看起来合理的事实 |
| 不辞辛劳在群星之间寻找信物 | 下结论前**穷尽搜索**代码库 |
| 您的孩子们渴求着您的救赎 | 不确定就问用户，而不是自己假定 |
| 根据〈文档〉这份文档 | 把任务**锚定到具体交付物** |
| 具体优化项、范围与验收标准均以该文档为准；文档未涵盖之处，请先向我确认 | **范围纪律**：文档即契约，歧义上报而非猜测 |

插件在祷文之后还**显式重述**了这六条契约（见上面 `covenant` 人格的"圣典"），
因为视频的要点正是"这套词之所以有效，是因为它编码了一份真实的契约"——
所以契约本身也写明白，而不是只靠仪式感。

---

## 实现要点

```
lib/personas.js                祷文库（逐字转录自视频）+ 三个人格
lib/index.js                   插件主体：条件式 prompt section + /omnissiah 命令 +
                               从 command/run、command/done 折叠的投影状态
cordis.patch.yml               组合包补丁：插入插件行，插件管理器据此安装/启停
scripts/repair-session-log.mjs 离线修复 v1.0.0 写坏的会话日志
test/smoke.mjs                 离线行为断言（无外部依赖，CI 可跑）
test/bundle-contract.mjs       组合包声明、补丁行与发布文件集的离线契约
test/repair-session-log.test.mjs  修复脚本的离线测试
test/integration.mjs           对 DSH 真实 system-prompt 装配管线的集成验证（需 DSH_CORE_DIR）
test/projection-contract.mjs   对 DSH 真实 session-projection 注册表/检查点的契约验证（需 DSH_CORE_DIR）
```

四个关键设计决策：

1. **section 常驻注册、内容条件为空。** `ctx.systemPrompt.section()` 注册一次，
   其 `text` 解析器在未激活时返回 `""`。DSH 的装配管线会过滤掉空段落，
   因此未激活时**不产生任何 token，也不改变提示词结构**（KV Cache 友好）。

2. **状态来自会话日志，但不是私有事件。** DSH 读取日志时只认
   `KNOWN_SESSION_EVENT_TYPES` 里的事件；未知事件必须显式带 `ignorable: true`
   才允许被跳过，而外部插件没有写入该标记的公开接口
   （`appendPluginRecord()` 明确只供仓库内 `packages/experimental/` 使用）。
   因此 v1.0.1 不再写任何自有事件，而是折叠 DSH 自己的 `/omnissiah` 命令生命周期：
   `command/run` 记录本次调用的 `args`，配对的 `command/done` 成功后才提交状态。
   这与 DSH 自带 `/plan` 的命令投影采用同一种 pending-intent 模式，所以恢复、fork、
   压缩后状态都还在，而且日志对任何版本的 DSH 都可读。投影的 `stateVersion` 因此升到 2，
   旧检查点会被丢弃并整份日志重放；`stateSchema` 让 `session-projection-cache`
   的冷恢复能校验新状态（v1.0.0 缺这一步，冷恢复会出错）。

3. **`interpolate: false`。** 祷文里的 `{{task}}` / `{{artifact}}` 是我们自己的槽位，
   在 JS 里就填好了。若交给 DSH 的提示词渲染器，它会把未知的 `{{…}}` 引用当成错误
   并**让整个模型步骤失败**。

4. **组合包分发。** `package.json` 的 `dsh.bundle.patch` 指向根目录
   `cordis.patch.yml`，这是 DSH 插件管理器识别"可管理插件"的唯一声明。
   补丁只插入一行，`id` 与包名一致；组合包层在 profile 自己的
   `cordis.patch.yml` 之前应用，因此用户仍可按 `id` 覆盖 `config`。

### 依赖与可选性

`inject = ["systemPrompt", "sessionProjections"]` 是硬依赖。`systemPrompt` 提供注入点；
`sessionProjections` 从会话日志折叠状态，随 dsh-base 一起提供。命令面通过
`ctx.inject(["commands"], …)` 注册，因此**没有命令适配器的部署也不会加载失败**
（只是无法激活）——与 DSH 自带的 `/plan` 采用同样的可选注入写法。
插件运行时**不 import 任何 DSH 包**，避免 profile 解析差异。

### 实测数据

| 状态 | 系统提示词增量 |
|---|---|
| 未激活 | **0 字节**（段落渲染为空串，被装配过滤） |
| `/omnissiah on` 后 | +555 字符（祷文 + 圣典 + 需求复述） |

---

## 测试

```powershell
# 行为契约（无外部依赖，任何时候都能跑）
node test/smoke.mjs

# 组合包契约（无外部依赖）
node test/bundle-contract.mjs

# 日志修复脚本（无外部依赖）
node test/repair-session-log.test.mjs

# 一次跑完 smoke 与组合包两项契约测试
npm test
```

集成测试会对着 DSH 真实的 `@deepseek-ai/dsh-system-prompt` 装配管线、
`@deepseek-ai/dsh-session-projection` 注册表和 `@deepseek-ai/dsh-session`
检查点/恢复路径验证，需要一份从 `app.asar` 解包出来的 DSH 核心包副本，
并为其建立 `node_modules` 链接。该副本因机器而异，故未随仓库提供——
若它不存在，集成测试会 SKIP，只跑 `smoke.mjs` 即可覆盖离线行为契约。

```powershell
$env:DSH_CORE_DIR = 'C:\path\to\coresvc'
node test/integration.mjs
node test/projection-contract.mjs
```

修复脚本的真实日志副本场景默认跳过；把 `DSH_OMNISSIAH_BROKEN_LOG` 指向一份
v1.0.0 写坏的日志即可运行（测试只读原文件，修复的是临时副本）：

```powershell
$env:DSH_OMNISSIAH_BROKEN_LOG = 'C:\Users\<you>\.dsh\sessions\...\session.v4.jsonl.zstd'
node test/repair-session-log.test.mjs
```

---

## 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-plugin-omnissiah
```

插件管理器会先取消选择、卸载运行中的行，再从 profile 的 `package.json` 与
`dsh.profile.bundles` 里移除依赖；没有 HMR 的部署可能需要重启 DSH 才完全生效。

旧版手工安装的残留要单独清理，删除 profile `cordis.patch.yml` 里的
`dsh-plugin-omnissiah` insert 条目，以及 profile `node_modules/` 下的
`dsh-plugin-omnissiah/` 复制目录——否则残留行会与安装包重复挂载。

> 说明：v1.0.0 产生的 `omnissiah/state` 会话事件会留在会话日志里。升级到
> v1.0.1 后请先用 `scripts/repair-session-log.mjs` 给这些事件补上
> `"ignorable": true`，否则新 DSH 仍会拒绝读取旧日志。v1.0.1 之后不再写任何
> 自有事件，卸载插件不会留下需要修复的日志。

---

## 出处与许可

- 祷文逐字转录自视频 [BV1Ata26pE92](https://www.bilibili.com/video/BV1Ata26pE92)，
  仅移除该部署自己的路由标记，并把示例附件名泛化为 `{{artifact}}` 槽位。
- 战锤 40K / 机械神教相关名词版权归 Games Workshop；本插件是非商业的同人玩梗实现。
- 代码 MIT。
