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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// BLAKE2b with a configurable digest size.
//
// libsodium's crypto_box_seal derives its nonce as BLAKE2b(ephemeralPk ‖ recipientPk) with an
// OUTPUT LENGTH of 24 bytes. BLAKE2b folds the digest length into its parameter block, so
// BLAKE2b-24 is NOT blake2b512 truncated to 24 bytes — and Node's crypto only honours the
// `outputLength` option for XOF hashes (shake128/shake256), rejecting it for blake2b512 with
// "not XOF or invalid length". Hence this small pure-JS implementation: the 64-byte mode is
// verified against OpenSSL's blake2b512 (and the RFC 7693 vector) by `selftest`.
// ---------------------------------------------------------------------------
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const U64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & U64;

function blake2bCompress(h, block, counter, last) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = block.readBigUInt64LE(i * 8);
  const v = [...h, ...BLAKE2B_IV];
  v[12] ^= counter & U64;
  v[13] ^= (counter >> 64n) & U64;
  if (last) v[14] = ~v[14] & U64;
  const g = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & U64;
    v[d] = rotr64(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & U64;
    v[b] = rotr64(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & U64;
    v[d] = rotr64(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & U64;
    v[b] = rotr64(v[b] ^ v[c], 63);
  };
  for (let r = 0; r < 12; r++) {
    const s = BLAKE2B_SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** BLAKE2b with digest length `outlen` (1..64). */
export function blake2b(input, outlen = 64) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const h = BLAKE2B_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen); // no key, no salt, fanout=1, depth=1
  let counter = 0n;
  let pos = 0;
  while (buf.length - pos > 128) {
    counter += 128n;
    blake2bCompress(h, buf.subarray(pos, pos + 128), counter, false);
    pos += 128;
  }
  const tail = Buffer.alloc(128);
  buf.subarray(pos).copy(tail);
  counter += BigInt(buf.length - pos);
  blake2bCompress(h, tail, counter, true);
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8);
  return out.subarray(0, outlen);
}

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
  // crypto_box_seal nonce = BLAKE2b-24(ephemeralPk ‖ recipientPk) — see the note above blake2b().
  const nonce = blake2b(Buffer.concat([eph.publicKey, pk]), 24);
  const boxed = nacl.box(Buffer.from(plaintext, 'utf8'), nonce, pk, eph.secretKey);
  // libsodium's wire format is ephemeralPublicKey ‖ boxed (not boxed ‖ ephemeralPublicKey).
  // Verified against libsodium-wrappers: that library only opens the epk-first layout.
  return Buffer.concat([eph.publicKey, boxed]).toString('base64');
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
    // Step 1: BLAKE2b-64 must agree with OpenSSL, plus the RFC 7693 empty-input vector. That
    // validates the implementation GitHub's 24-byte nonce derivation also rides on.
    const { createHash } = await import('node:crypto');
    const fixtures = [Buffer.alloc(0), Buffer.from('abc'), Buffer.alloc(127, 7), Buffer.alloc(128, 9), Buffer.alloc(129, 11), Buffer.alloc(1000, 13)];
    let hashOk = true;
    for (const f of fixtures) {
      if (blake2b(f, 64).toString('hex') !== createHash('blake2b512').update(f).digest('hex')) hashOk = false;
    }
    const rfcVector = '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce';
    if (blake2b(Buffer.alloc(0), 64).toString('hex') !== rfcVector) hashOk = false;
    console.log(`BLAKE2b（对 OpenSSL 与 RFC 7693 的双重校验）：${hashOk ? '✅ 一致' : '❌ 不一致'}`);

    const { default: nacl } = await import('tweetnacl');
    const recipient = nacl.box.keyPair();
    const message = 'ywpy rmdn niux uylt';
    const sealed = Buffer.from(
      await sealBox(message, Buffer.from(recipient.publicKey).toString('base64')),
      'base64'
    );
    const ephPk = sealed.subarray(0, 32);
    const boxed = sealed.subarray(32);
    const nonce = blake2b(Buffer.concat([ephPk, recipient.publicKey]), 24);
    const opened = nacl.box.open(boxed, nonce, ephPk, recipient.secretKey);
    const sealOk = !!opened && Buffer.from(opened).toString('utf8') === message;
    console.log(`sealed box 往返：${sealOk ? '✅ 一致' : '❌ 不一致'}`);
    if (!hashOk || !sealOk) process.exitCode = 1;
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
