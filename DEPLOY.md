# 部署记录（2026-10-02）

本文件记录这个云端任务**实际是怎么落地的**、验证到了哪一步、以及还剩哪一步需要人手动完成。

## 一、已完成并验证

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 采集链路（智联招聘 + 实习僧） | ✅ 实测可用 | 单轮采集 163 条原始岗位 → 去重 135 → 方向初筛 122 → 富化 50 → 打分保留 36 |
| 打分/分级/去重台账/报告 | ✅ 26 项离线测试全绿 | `node test/run-tests.mjs` |
| 邮件组装（主题、HTML + 纯文本、全部必填字段） | ✅ | `output/mail-preview.txt` |
| 云端定时 workflow（北京 08:00 / 18:00） | ✅ 已写入 `.github/workflows/scan.yml` | 含 `workflow_dispatch` 手动触发与 `curated` 输入 |
| 首轮人工核实清单（10 个岗位，武汉 7 个） | ✅ | `data/round-2026-10-02.json` |
| Gmail **草稿**创建（本地网络封 SMTP 时的降级路径） | ✅ 已用 IMAP 回读验证 | `[Gmail]/Drafts` 中 1 封，主题 `C++ 后端实习机会｜2026-10-02｜10 个重点岗位` |
| GitHub 仓库可访问 | ✅ | `git ls-remote https://github.com/1811255323swf-source/DSH_JOB.git` 返回 0（空仓库） |
| **Gmail 真实发信**（云端 GitHub runner 出口） | ✅ 服务器确认送达 | `output/report-2026-10-02-160042.json` → `"sent":true`，`status":"250 2.0.0 OK … - gsmtp"`，`attempts:1` |
| **Actions secrets 已写入** | ✅ | `GMAIL_USER` / `GMAIL_APP_PASSWORD`(16) / `MAIL_TO`；`gh api …/actions/secrets` 可查到三个名字 |
| **仓库已推送 + workflow 实跑通过** | ✅ | `main` 已含全部代码；`workflow_dispatch` 运行 `36981606325` 全步骤 success，报告与台账由 bot 自动提交回仓库 |

## 一之二、2026-10-02 续做时补的两处

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 部署助手修复 | ✅ | `tools/github-deploy.mjs` 原先用 `endsWith('github-api.mjs')` 判断是否被直接运行，而文件实际叫 `github-deploy.mjs`，按本文档写法运行会**静默什么都不做**；已改为比较自身路径。同时新增 `selftest`，并把 `tweetnacl` 改为只在 `secrets` 子命令里动态引入（其余子命令零依赖） |
| 云端首轮离线发信路径 | ✅ | 新增 `--curated-only`：`--curated` 时跳过采集与详情富化、零网络请求。离线测试断言「一次 `fetch` 都不发」，`tests 24 / pass 24`。workflow 在填了 `curated` 时会自动带上该参数 |

## 一之三、2026-10-02 收尾：真正打通发信的两个 bug

| bug | 症状 | 根因与修法 |
| --- | --- | --- |
| SMTP 应答错位（**发信一直失败的真正原因**） | 每轮都失败并降级成草稿：`SMTP 期望 250 实际 220 smtp.gmail.com ESMTP … - gsmtp` | `SmtpSession` 的读循环把每一行**既塞进队列又交给等待者**，于是每条应答被消费两次、每条命令读到的是上一条的应答（EHLO 读到的是问候语 220）。改为「一行只投递给一个消费者：有等待者就给等待者，否则入队」；STARTTLS 升级后的监听器也统一走 `attach()`，不再手抄一份。新增 2 条离线回归测试 |
| DATA 后多发一个空行 | 同上（会与错位叠加） | `await session.command('', [250])` 会真的写出一个 CRLF，等于在报文中止符之后再发一条空命令；改为只读的 `readReply([250])` |
| secrets 加密被 GitHub 拒绝 | `PUT …/actions/secrets/GMAIL_USER → HTTP 422 improperly encrypted secret` | 两处：① nonce 应为 **BLAKE2b 输出长度 24**，而 `blake2b512` 截断到 24 字节是另一个值（BLAKE2b 把输出长度编进参数块；Node 的 `outputLength` 只支持 shake 系列，故自带纯 JS BLAKE2b，并用 OpenSSL + RFC 7693 向量双重校验）；② sealed box 的线格式是 **ephemeralPk ‖ boxed**，原实现把 epk 接在了末尾。已用 `libsodium-wrappers` 的 `crypto_box_seal_open` 反证两种布局 |

## 二、本地网络的关键限制（实测）

```
直连 smtp.gmail.com:465  → ETIMEDOUT      （被封）
直连 smtp.gmail.com:587  → ETIMEDOUT      （被封）
代理 smtp.gmail.com:465  → TLS 被重置      （代理出口节点封 SMTP）
代理 imap.gmail.com:993  → ✅ 正常         （Gmail 问候语返回成功）
代理 www.google.com:443  → 超时
直连 api.github.com:443  → ✅ 正常
```

结论：**本机无法发信，但可以收/写 Gmail 草稿**。因此邮件正文已落入草稿箱，
真正的「发送」交给 GitHub Actions（美区出口，SMTP 可达）。

## 三、云端部署步骤（剩余）

1. **推送代码**（需要 PAT：fine-grained，Contents: Read and write）：
   ```bash
   cd cpp-intern-radar
   git remote add origin https://github.com/1811255323swf-source/DSH_JOB.git
   git -c http.proxy=http://127.0.0.1:7897 push -u origin main
   ```
2. **写入 Actions Secrets**（`GMAIL_USER` / `GMAIL_APP_PASSWORD` / `MAIL_TO`）。
   GitHub 要求用 libsodium sealed box 加密后提交，两种方式任选：
   - **手动**（最省事）：仓库页面 Settings → Secrets and variables → Actions → New repository secret；
   - **脚本**：`npm i --no-save tweetnacl && GH_TOKEN=<PAT> node tools/github-deploy.mjs secrets <owner> <repo>`
     （脚本用 `blake2b512` + `crypto_box_seal` 加密，密钥不落盘；同一脚本还提供
     `whoami` / `dispatch` / `watch` / `verify` 子命令，可一键触发并回读验证。）
3. **手动跑一次首轮**：Actions → cpp-intern-radar → Run workflow，
   `curated` 填 `data/round-2026-10-02.json` → 由 GitHub 服务器把这份清单真正发出。
   填了 `curated` 的这次运行是**完全离线**的（自动加 `--curated-only`：不采集、不富化），
   秒级完成，不受 GitHub runner 在海外、可能连不上智联/实习僧的影响。
4. **之后自动运行**：每天北京 08:00 / 18:00 自动扫描，只发「台账里没有的新岗位」。
   每轮会把报告与台账提交回仓库（同时刷新 60 天定时器）。

## 四、验证一个运行是否真的发出去了

三种互相独立的证据，缺一不可：

1. **运行日志**最后几行会打印 Gmail 的 `250 2.0.0 OK ... - gsmtp`（这就是「成功发送标记」）；
   失败时会打印 `⚠️ 首次发送失败` → `✅ 纯文本简版重试成功` 或 `📝 已写入 Gmail 草稿箱`。
2. **仓库里的报告** `output/report-<北京时间>.json` 的 `mail` 字段：`{"sent":true,"messageId":"..."}`。
3. **去重台账** `state/sent-jobs.json` 出现对应条目（只有确认发送/草稿成功才会写入）。

## 五、安全说明

- Gmail 应用专用密码只存在于 GitHub Secrets（加密存储），不写入仓库任何文件。
- 本地调试用环境变量传入，不落盘；`.gitignore` 已排除本地预览与日志。
- PAT 只用于推送与触发 workflow，建议 7 天有效期，用完立即吊销。

## 六、故障对照表（2026-10-02 实际踩到的）

| 现象（原文） | 真正原因 | 修法 |
| --- | --- | --- |
| `git push` 报 `remote: Permission to <owner>/<repo>.git denied to <owner>` + `The requested URL returned error: 403` | fine-grained PAT 没有 **Contents: Read and write**（常见于创建时选了 `Public Repositories (read-only)`，那就是一个写权限都没有） | 编辑该 token → Repository access 选 `Only select repositories` 并勾中本仓库 → Permissions 里 `Contents` 改 **Read and write** → Save（改现有 token 不换令牌串） |
| REST 返回 `403 Resource not accessible by personal access token` | 缺的正是该接口要求的那项权限（例如 `/actions/secrets` 需要 **Secrets: Read and write**） | 同上，勾上对应权限。注意：**仓库是公开的，读接口匿名也能 200**，所以“读得到”完全不等于令牌有权限，必须用写操作判定 |
| Run 变红，红在 «提交报告与去重台账» 这一步 | 仓库的默认 workflow 权限被限制成只读，workflow 里声明了 `permissions: contents: write` 也**无法超过**该上限 | 仓库 → Settings → Actions → General → **Workflow permissions** → 选 **Read and write permissions** → Save。**注意此接口需要 Administration 权限，脚本查不了，必须人工看一眼** |
| Run 变红，红在 «扫描岗位并发送邮件» | 缺 `GMAIL_*` secrets（会打印 `缺少 GMAIL_APP_PASSWORD，无法发送邮件`），或 Gmail 应用密码失效 | 补 secret；应用密码需在开启两步验证后重新生成 |
| Run 成功但「本轮没有新岗位，跳过邮件」，退出 0 | 台账里已有这些岗位（去重生效），**不是故障** | 无需处理；想重发就清空 `state/sent-jobs.json` 里对应键 |
| 本地跑报「SMTP 被重置、已写入 Gmail 草稿箱」 | 本机网络封 SMTP（见第二节），这是设计好的降级路径 | 云端（美区出口）正常发信；或按 `GMAIL_PROXY` 指定代理 |
