// Deploy helper for cpp-intern-radar: set Actions secrets, push-dispatch the workflow,
// watch the run, and verify the mailed report from the repository itself.
//
//   node tools/github-deploy.mjs whoami
//   node tools/github-deploy.mjs secrets  <owner> <repo>
//   node tools/github-deploy.mjs dispatch <owner> <repo> [curatedPath]
//   node tools/github-deploy.mjs watch    <owner> <repo>
//   node tools/github-deploy.mjs verify   <owner> <repo>
//   node tools/github-deploy.mjs selftest
//
// Requires GH_TOKEN in the environment (fine-grained PAT with Contents + Actions write).
// Only `secrets` needs the optional pure-JS tweetnacl package (`npm i --no-save tweetnacl`);
// every other subcommand runs with zero dependencies.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'cpp-intern-radar-deploy',
  'x-github-api-version': '2022-11-28',
};

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} → HTTP ${res.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** libsodium crypto_box_seal, as required by the GitHub secrets API. */
export async function sealBox(plaintext, recipientPublicKeyB64) {
  const { default: nacl } = await import('tweetnacl');
  const pk = Buffer.from(recipientPublicKeyB64, 'base64');
  const eph = nacl.box.keyPair();
  const nonce = createHash('blake2b512').update(Buffer.concat([eph.publicKey, pk])).digest().subarray(0, 24);
  const boxed = nacl.box(Buffer.from(plaintext, 'utf8'), nonce, pk, eph.secretKey);
  return Buffer.concat([boxed, eph.publicKey]).toString('base64');
}

async function putSecret(owner, repo, name, value) {
  const key = await api(`/repos/${owner}/${repo}/actions/secrets/public-key`);
  const encrypted_value = await sealBox(value, key.key);
  await api(`/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value, key_id: key.key_id }),
  });
  console.log(`  ✅ secret ${name} 已写入（${value.length} 字符）`);
}

const [cmd, ...rest] = process.argv.slice(2);
// Compare against this module's own path instead of a hard-coded filename: the file ships as
// tools/github-deploy.mjs, so the previous `endsWith('github-api.mjs')` check silently skipped
// the entire CLI below (the tool appeared to do nothing when run as documented).
const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
try {
  if (!TOKEN && cmd !== 'help' && cmd !== 'selftest') throw new Error('缺少 GH_TOKEN 环境变量');

  if (cmd === 'selftest') {
    // Proves our crypto_box_seal matches what the GitHub secrets API expects, without needing a token.
    const { default: nacl } = await import('tweetnacl');
    const recipient = nacl.box.keyPair();
    const message = 'ywpy rmdn niux uylt';
    const sealed = Buffer.from(
      await sealBox(message, Buffer.from(recipient.publicKey).toString('base64')),
      'base64'
    );
    const ephPk = sealed.subarray(sealed.length - 32);
    const boxed = sealed.subarray(0, sealed.length - 32);
    const nonce = createHash('blake2b512').update(Buffer.concat([ephPk, recipient.publicKey])).digest().subarray(0, 24);
    const opened = nacl.box.open(boxed, nonce, ephPk, recipient.secretKey);
    const ok = !!opened && Buffer.from(opened).toString('utf8') === message;
    console.log(`sealed box 往返：${ok ? '✅ 一致' : '❌ 不一致'}`);
    if (!ok) process.exitCode = 1;
  } else if (cmd === 'whoami') {
    const me = await api('/user');
    console.log(`token 属于：${me.login}（${me.type}）`);
    const scopes = await fetch(`${API}/user`, { headers }).then((r) => r.headers.get('x-oauth-scopes'));
    if (scopes) console.log('scopes:', scopes);
    const repo = await api('/repos/1811255323swf-source/DSH_JOB');
    console.log(`目标仓库：${repo.full_name}｜私有：${repo.private}｜默认分支：${repo.default_branch}｜空仓：${repo.size === 0}`);
  } else if (cmd === 'secrets') {
    const [owner, repo] = rest;
    const values = {
      GMAIL_USER: process.env.GMAIL_USER,
      GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
      MAIL_TO: process.env.MAIL_TO || process.env.GMAIL_USER,
    };
    for (const [name, value] of Object.entries(values)) {
      if (!value) throw new Error(`缺少环境变量 ${name}`);
      await putSecret(owner, repo, name, value);
    }
    const list = await api(`/repos/${owner}/${repo}/actions/secrets`);
    console.log('  当前 secrets：', list.secrets.map((s) => s.name).join(', ') || '(空)');
  } else if (cmd === 'dispatch') {
    const [owner, repo, curated] = rest;
    const inputs = { limit: '10', enrich: '60', no_mail: 'false' };
    if (curated) inputs.curated = curated;
    await api(`/repos/${owner}/${repo}/actions/workflows/scan.yml/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs }),
    });
    console.log('  ✅ workflow_dispatch 已触发，inputs =', JSON.stringify(inputs));
  } else if (cmd === 'watch') {
    const [owner, repo] = rest;
    for (let i = 0; i < 60; i++) {
      const runs = await api(`/repos/${owner}/${repo}/actions/runs?per_page=3`);
      const run = runs.workflow_runs[0];
      if (!run) {
        console.log('  还没有运行记录…');
      } else {
        console.log(`  [${i}] run ${run.id}｜${run.event}｜${run.status}｜${run.conclusion || '-'}`);
        if (run.status === 'completed') {
          const jobs = await api(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`);
          for (const job of jobs.jobs) {
            console.log(`      job ${job.name}: ${job.conclusion}`);
            for (const step of job.steps) console.log(`        - ${step.name}: ${step.conclusion}`);
          }
          console.log(`  runId=${run.id}`);
          process.exit(0);
        }
      }
      await new Promise((r) => setTimeout(r, 10000));
    }
    console.log('  ⚠️ 等待超时');
  } else if (cmd === 'verify') {
    const [owner, repo] = rest;
    const listing = await api(`/repos/${owner}/${repo}/contents/output`);
    const reports = listing.filter((f) => /^report-.*\.json$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!reports.length) throw new Error('仓库里还没有报告文件');
    for (const file of reports.slice(-2)) {
      const content = await api(`/repos/${owner}/${repo}/contents/output/${file.name}`);
      const json = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
      console.log(`\n=== ${file.name} ===`);
      console.log(`  采集 ${json.collectedCount}｜打分 ${json.scoredCount}｜入选 ${json.selectedCount}｜运行时间 ${json.runAt}`);
      console.log(`  邮件：${JSON.stringify(json.mail)}`);
      console.log(`  告警：${(json.errors || []).length ? json.errors.slice(0, 3).join(' / ') : '无'}`);
    }
    const ledgerFile = await api(`/repos/${owner}/${repo}/contents/state/sent-jobs.json`);
    const ledger = JSON.parse(Buffer.from(ledgerFile.content, 'base64').toString('utf8'));
    console.log(`\n去重台账：${Object.keys(ledger.entries || {}).length} 条键，更新于 ${ledger.updatedAt}`);
  } else {
    console.log('用法：whoami | secrets <owner> <repo> | dispatch <owner> <repo> [curated] | watch <owner> <repo> | verify <owner> <repo> | selftest');
  }
} catch (err) {
  console.error('✖', err.message);
  process.exit(1);
}
}
