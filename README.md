# cpp-intern-radar｜C++ 实习机会云端雷达

给**湖北工业大学 2028 届计算机本科生**定制的实习岗位自动扫描器：每天在**云端（GitHub Actions）**定时跑，
自动采集岗位 → 按学校层次/届次/地点/技术方向打分 → 与历史台账去重 → **把新发现的高价值岗位用 Gmail 发到指定邮箱**。

- **零运行时依赖**：只用 Node.js 内置模块（`fetch`、`tls`、`fs`、`node:crypto`），`npm ci` 几乎瞬间完成。
- **完全跑在云端**：GitHub 的服务器按点执行，本地电脑不用开机、不用常驻进程、不用本机计划任务。
- **自带去重台账**：`state/sent-jobs.json` 记录每一轮已推送过的岗位，不会重复轰炸。
- **邮件可自证**：发送后会校验 SMTP 服务器返回的 `250 OK` 才算成功；失败自动降级为纯文本重试，仍失败则写入 Gmail 草稿。

---

## 一、它解决什么问题

| 痛点 | 本项目的做法 |
| --- | --- |
| 手动刷 BOSS/牛客/实习僧太累 | 智联招聘 + 实习僧**服务端渲染页面**直接解析，云端每天自动跑 |
| 岗位多但大多不匹配 | 方向关键词加权打分（C++/Linux/网络/epoll/基础架构/AI Infra…），标题命中双倍计分 |
| 卡学校、卡届次，白投一场 | 识别 `985/211/硕士及以上` 等门槛词做**降权 + 明确标注**；识别 `2027/2028届/在校生` 做加权 |
| 武汉岗位被外地岗位淹没 | 武汉置顶（地点分最高），武汉不足时用其他城市与远程岗位补足 |
| 反复看到同一批岗位 | `state/sent-jobs.json` 台账去重，同岗位跨平台也只保留一条 |
| 忘了哪个岗位要补什么 | 每个岗位输出「匹配点」+「需补强的 1-3 项能力」+ 学校门槛判断 + 优先投/长期备选/冲刺 |

---

## 二、云端部署（5 步，约 5 分钟）

### 第 1 步：准备 Gmail 应用专用密码

1. 打开 <https://myaccount.google.com/security>，先开启**两步验证**（必须）。
2. 打开 <https://myaccount.google.com/apppasswords>，新建一个应用专用密码（名字随便写，如 `intern-radar`）。
3. 复制那 **16 位密码**（形如 `abcd efgh ijkl mnop`，去掉空格后用）。

> 不要用 Gmail 登录密码 —— Google 已禁止第三方用账号密码发信，必须用应用专用密码。

### 第 2 步：新建 GitHub 仓库并推送本项目

```bash
cd cpp-intern-radar
git init
git add .
git commit -m "chore: init cpp-intern-radar"
git branch -M main
git remote add origin https://github.com/<你的用户名>/cpp-intern-radar.git
git push -u origin main
```

### 第 3 步：配置 Secrets（仓库 → Settings → Secrets and variables → Actions → New repository secret）

| Secret | 是否必填 | 说明 |
| --- | --- | --- |
| `GMAIL_USER` | 必填 | 你的 Gmail 地址，例如 `xxxx@gmail.com` |
| `GMAIL_APP_PASSWORD` | 必填 | 第 1 步生成的 16 位应用专用密码 |
| `MAIL_TO` | 可选 | 收件地址，默认等于 `GMAIL_USER` |
| `MAIL_FROM_NAME` | 可选 | 发件人显示名，默认「C++ 实习雷达」 |

嫌网页点麻烦可以用自带的部署助手（`whoami`/`verify` 等子命令零依赖，只有写 secrets 需要一次性
`npm i --no-save tweetnacl`）：

```bash
node tools/github-deploy.mjs selftest                                  # 先证明加密格式正确，再动真凭据
GH_TOKEN=<PAT> GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx \
  node tools/github-deploy.mjs secrets <owner> <repo>                  # 写入上面三个 secret
```

### 第 4 步：确认 Actions 已启用

仓库 → **Actions** 标签页 → 若提示则点 **"I understand my workflows, go ahead and enable them"**。

### 第 5 步：手动跑一次验证

**Actions → cpp-intern-radar → Run workflow**。约 2-5 分钟后：

- 绿色对勾 = 成功；`output/` 下会多出 `report-<北京时间>.json` 与 `.md`，并被自动提交回仓库。
- 邮箱会收到主题形如 `C++ 后端实习机会｜2026-10-02｜N 个重点岗位` 的邮件。
- **如果本轮没有新岗位（都被台账去重了），会跳过发信并退出 0** —— 这是预期行为，不是故障。

---

## 三、定时规则（北京时间 → UTC）

GitHub 的 `cron` 只认 **UTC**，北京时间要减 8 小时：

| 期望（北京） | cron（UTC） | 说明 |
| --- | --- | --- |
| 08:23 | `23 0 * * *` | 早报（避开 UTC 00:00 这个全天最挤的时刻） |
| 10:23 | `23 2 * * *` | 美国深夜，低负载 |
| 12:37 | `37 4 * * *` | 美国深夜，低负载 |
| 16:47 | `47 8 * * *` | 美国凌晨，低负载 |
| 18:37 | `37 10 * * *` | 晚报（美国上班前，较空） |
| 21:53 | `53 13 * * *` | 小时中段，避开整点 |
| 每 6 小时 | `0 */6 * * *` | 仅供参考；**整点仍是拥挤时段，不建议** |

**默认一天 6 个点**，全部落在小时中段（分钟 17/23/37/47/53），并尽量压在 UTC 02:00–09:00 这段美国深夜的低负载窗口。

> 为什么不用整点：GitHub 官方说明 `schedule` 的负载高峰就是「每个小时的整点」，此时任务会延迟几分钟到几十分钟，
> 极端情况**整次跳过**（2026-10-02 实测北京 18:00 那次盯了 95 分钟都没触发）。
> 铺 6 个点是为了互为兜底：某次被跳过，几小时内还有下一次。
> 多跑不会轰炸你 —— `state/sent-jobs.json` 台账会去重，**只有出现新岗位才会发邮件**。

改法：编辑 `.github/workflows/scan.yml` 的 `on.schedule`。

> GitHub 的定时触发**经常延迟 5～15 分钟**，高峰期更久，偶尔会跳过某次，这是 GitHub 官方行为。
> 仓库连续 60 天无提交时定时任务会被自动暂停 —— 本项目每轮都会提交报告与台账，正常不会触发。

---

## 四、筛选规则（可调）

全部规则都在 `config/` 下，改完直接提交即可生效：

- `config/profile.json`：候选人画像（学校层次、届次、现有技能、正在补的技能、地点优先级、公司类型偏好）。
- `config/keywords.json`：
  - `direction.strong/medium/weak`：方向关键词（**标题命中按双倍计分**）；
  - `negative.hardExclude`：硬排除（纯前端、销售、纯测试、纯运维、实施、驻场、少儿编程…）；
  - `schoolGate.high/low`：学校与学历门槛词（用于降权 + 明确标注，**不是直接丢弃**）；
  - `weights`：各项权重与「武汉置顶 / 中小厂加分 / 大厂降权」策略。
- `config/sources.json`：采集源与关键词×城市组合（当前覆盖智联招聘与实习僧，多城市、多技术方向）。

### 分级逻辑

| 标记 | 含义 |
| --- | --- |
| **优先投** | 方向分与总分都高、地点在武汉或可远程、学校门槛友好 |
| **长期备选** | 匹配度不错，但时长 ≥6 个月且每周 ≥3 天（与寒假约 1 个多月的短期计划冲突），适合按长期实习准备 |
| **冲刺** | 方向高度匹配，但存在 985/211、硕士、强背景等门槛 —— 会明确标注门槛，不作为主推 |

每轮目标输出 **6-10 个**：武汉优先，中小厂占多数，大厂每轮最多 1 个。

---

## 五、本地使用

```bash
cd cpp-intern-radar
node test/run-tests.mjs                     # 离线测试（不联网，秒级）
node src/main.js --task scan --dry-run      # 只打印执行计划
node src/main.js --task scan --no-mail      # 真跑一轮，不发邮件
node src/main.js --task scan                # 真跑一轮并发邮件（需环境变量）

# 人工核实清单轮：完全不联网（跳过采集与详情富化），秒级出报告——云端首轮发信走这条
node src/main.js --task scan --curated data/round-2026-10-02.json --curated-only

# Windows PowerShell 临时带上凭据：
$env:GMAIL_USER="you@gmail.com"; $env:GMAIL_APP_PASSWORD="abcdefghijklmnop"; node src/main.js --task scan
```

常用参数：`--limit 10`（最多输出岗位数）、`--min 6`（最少补足数）、`--enrich 50`（详情页富化上限）、
`--out <dir>`（报告目录）、`--curated <file>`（人工核实轮清单）、`--curated-only`（配合 `--curated`：
跳过采集与详情富化、零网络请求；GitHub runner 在海外，未必连得上智联/实习僧）、
`--dump-mail <file>`（只生成邮件预览不发送）、`--no-mail`、`--dry-run`。

**代理支持**：如果所在网络封了 Gmail 的 SMTP/IMAP 端口（国内很常见），设置环境变量即可走本地代理：

```powershell
$env:GMAIL_PROXY="http://127.0.0.1:7897"   # 支持 http:// 与 socks5://
```

自带 HTTP CONNECT 与 SOCKS5 两种隧道实现，会自动回退。注意：部分代理出口节点本身封禁 SMTP 端口，
这时发信会失败 —— 本地会**自动降级为写入 Gmail 草稿**，而云端（GitHub Actions，美区出口）通常可以直接发出。

**退出码**：`0` 成功或按规则跳过发信｜`1` 邮件发送失败或采集错误过多（workflow 变红并触发 GitHub 邮件告警）｜`2` 参数错误。

---

## 六、目录结构

```
cpp-intern-radar/
├─ .github/workflows/scan.yml   # 云端定时器（一天 6 个低负载时刻，见第三节）
├─ config/
│  ├─ profile.json              # 候选人画像与规则开关
│  ├─ keywords.json             # 方向词/排除词/学校门槛词/权重
│  └─ sources.json              # 采集源（关键词 × 城市）
├─ src/
│  ├─ main.js                   # CLI 入口与编排（采集→富化→打分→去重→发信→报告）
│  ├─ collect/zhaopin.js        # 智联招聘：SSR 列表页 + 详情页
│  ├─ collect/shixiseng.js      # 实习僧：SSR 卡片 + 详情页（含字体混淆处理）
│  ├─ filter/score.js           # 打分、分级、跨平台去重、排序、入选策略
│  ├─ dedupe/ledger.js          # state/sent-jobs.json 台账
│  ├─ mail/compose.js           # 邮件主题与正文（HTML + 纯文本）
│  ├─ mail/smtp.js              # 零依赖 SMTP 客户端（465 隐式 TLS / 587 STARTTLS）
│  ├─ mail/imap-draft.js        # 发送失败时写入 [Gmail]/Drafts 的降级路径
│  ├─ report/write.js           # output/report-<北京时间>.json|md
│  └─ lib/{http,time}.js        # 抓取封装、北京时间换算
├─ test/run-tests.mjs           # 21 项离线测试（解析/打分/去重/邮件/MIME）
├─ state/sent-jobs.json         # 去重台账（由云端自动提交）
└─ output/                      # 每轮报告（由云端自动提交）
```

---

## 七、邮件发送的判定与降级

1. **正常发送**：SMTP 走 `smtp.gmail.com:465`，`DATA` 后必须收到 `250 ... OK`，并把服务器原始应答写进报告；只有拿到这个标记才算「已发送」。
2. **首次失败**：立刻用**纯文本简版**（保留岗位名、地点、核心要求、链接）重试一次。
3. **仍失败**：通过 IMAP 把完整邮件写入 Gmail **草稿箱 `[Gmail]/Drafts`**，并在报告与任务结果里明确说明「未发送，已存草稿」。
4. 只有确认发送/草稿成功，才会把本轮岗位写进去重台账 —— 避免「没发出去却被记为已推送」。

---

## 八、已知限制（诚实说明）

- **招聘平台的机器人防护**：BOSS 直聘、前程无忧、猎聘的搜索页是 JS 渲染或有 WAF，本项目**不依赖**它们；智联与实习僧的列表/详情页是服务端渲染，可稳定解析。
- **云端出口 IP 在海外**：GitHub Actions 运行在海外机房，部分国内站点可能限流或拒绝。项目已内置重试与多源容错；若某个源在云端持续失败，报告里的「运行告警」会写清楚，可在本地补跑（本地跑通、云端发信的模式也支持）。
- **不是所有岗位都能自动发现**：公司官网、公众号、高校就业网里的岗位需要人工/半自动补充，本项目先覆盖可稳定抓取的平台，其余靠每轮人工调研合并。
- **薪资字段**：实习僧用字体混淆数字，本项目不解析薪资，避免给出错数据。
- **合规**：仅抓取公开可访问的招聘页面用于个人求职，请求频率已做限速（默认每次请求间隔 0.6s）。

---

## 九、常见问题

**Q1：收到邮件说「0 个岗位」？**
说明本轮入选岗位都被台账判定为已推送。想强制重发，删掉 `state/sent-jobs.json` 里对应条目即可。

**Q2：想加城市或关键词？**
编辑 `config/sources.json`：智联的城市码在 URL 的 `jl=` 参数里（武汉 `736`、北京 `530`、上海 `538`、深圳 `765`、杭州 `653`、广州 `763`、南京 `635`、成都 `801`、西安 `854`、苏州 `639`，全国 `489`）。

**Q3：怎么改成「只在有新岗位时才提交」？**
`output/` 里的报告带时间戳，所以每轮都会有 diff。若不在意 60 天暂停计时，可在 `src/report/write.js` 里改成固定文件名。

**Q4：Private 仓库要花钱吗？**
GitHub Free 的 Private 仓库每月 2000 分钟 Actions 额度；本项目单次不到 5 分钟，每天两次约 300 分钟/月，够用。Public 仓库不限时长。

**Q5：为什么邮件主题带日期？**
便于在邮箱里按天归档，也方便确认定时任务是否按天运行。

---

## 十、许可

个人求职用途，可自由修改。
