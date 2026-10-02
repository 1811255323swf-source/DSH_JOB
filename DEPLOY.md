# 部署记录（2026-10-02）

本文件记录这个云端任务**实际是怎么落地的**、验证到了哪一步、以及还剩哪一步需要人手动完成。

## 一、已完成并验证

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 采集链路（智联招聘 + 实习僧） | ✅ 实测可用 | 单轮采集 163 条原始岗位 → 去重 135 → 方向初筛 122 → 富化 50 → 打分保留 36 |
| 打分/分级/去重台账/报告 | ✅ 21 项离线测试全绿 | `node test/run-tests.mjs` |
| 邮件组装（主题、HTML + 纯文本、全部必填字段） | ✅ | `output/mail-preview.txt` |
| 云端定时 workflow（北京 08:00 / 18:00） | ✅ 已写入 `.github/workflows/scan.yml` | 含 `workflow_dispatch` 手动触发与 `curated` 输入 |
| 首轮人工核实清单（10 个岗位，武汉 7 个） | ✅ | `data/round-2026-10-02.json` |
| Gmail **草稿**创建（本地网络封 SMTP 时的降级路径） | ✅ 已用 IMAP 回读验证 | `[Gmail]/Drafts` 中 1 封，主题 `C++ 后端实习机会｜2026-10-02｜10 个重点岗位` |
| GitHub 仓库可访问 | ✅ | `git ls-remote https://github.com/1811255323swf-source/DSH_JOB.git` 返回 0（空仓库） |

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
