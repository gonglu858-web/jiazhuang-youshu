#!/usr/bin/env node
// 生成施工安排独立测试副本的业务实现副本，并记录来源与哈希。
//
// 方案 §4.1：复用已验收业务实现，不建立第二套业务规则。
// - 副本由脚本从 memberAccess 生成，**不手工维护**，避免逐渐分叉。
// - 生成时记录源文件 SHA-256 与副本 SHA-256，二者必须一致。
// - 产物只写入 scheduleSandbox/vendor/，**不混入 memberAccess 部署目录**。
// - 已存在副本与源不一致时直接失败，不静默覆盖。
//
// 用法：node miniapp/scripts/build-sandbox.cjs [--check]
//   默认生成副本并写入 manifest；--check 只校验不写入（CI/测试用）。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 生成来源：已通过 V1–V3 本地验收的业务源码。
const SOURCE_DIR = path.join(__dirname, '..', 'cloudfunctions', 'memberAccess');
const VENDOR_DIR = path.join(__dirname, '..', 'cloudfunctions', 'scheduleSandbox', 'vendor');
const MANIFEST = path.join(VENDOR_DIR, 'MANIFEST.json');
const SOURCE_FILES = ['service.js', 'schedule-service.js'];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readSource(name) {
  const file = path.join(SOURCE_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少已验收源文件：${file}`);
  }
  return fs.readFileSync(file);
}

function buildManifest() {
  const entries = {};
  for (const name of SOURCE_FILES) {
    const sourceBuffer = readSource(name);
    const vendorPath = path.join(VENDOR_DIR, name);
    let vendorHash = null;
    if (fs.existsSync(vendorPath)) {
      vendorHash = sha256(fs.readFileSync(vendorPath));
    }
    entries[name] = {
      source: path.relative(path.join(__dirname, '..'), path.join(SOURCE_DIR, name)).split(path.sep).join('/'),
      vendor: path.relative(path.join(__dirname, '..'), vendorPath).split(path.sep).join('/'),
      sourceSha256: sha256(sourceBuffer),
      vendorSha256: vendorHash
    };
  }
  return entries;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const entries = buildManifest();

  if (checkOnly) {
    const problems = [];
    for (const [name, entry] of Object.entries(entries)) {
      if (!entry.vendorSha256) problems.push(`${name} 缺少生成的副本`);
      else if (entry.vendorSha256 !== entry.sourceSha256) problems.push(`${name} 副本与已验收源不一致`);
    }
    if (problems.length) {
      console.error('build-sandbox --check 失败：');
      for (const p of problems) console.error('  - ' + p);
      process.exitCode = 1;
      return;
    }
    console.log(`build-sandbox --check 通过：${SOURCE_FILES.length} 个文件副本与已验收源一致。`);
    for (const [name, entry] of Object.entries(entries)) {
      console.log(`  ${name}  sha256=${entry.sourceSha256}`);
    }
    return;
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const written = [];
  for (const name of SOURCE_FILES) {
    const sourceBuffer = readSource(name);
    const vendorPath = path.join(VENDOR_DIR, name);
    if (fs.existsSync(vendorPath)) {
      const existing = fs.readFileSync(vendorPath);
      if (sha256(existing) === sha256(sourceBuffer)) {
        written.push({ name, action: 'unchanged', sha256: sha256(sourceBuffer) });
        continue;
      }
      throw new Error(
        `副本已存在且与源不一致，拒绝覆盖：${vendorPath}\n` +
        '请先人工确认差异来源，再删除副本重新生成。'
      );
    }
    fs.writeFileSync(vendorPath, sourceBuffer);
    written.push({ name, action: 'created', sha256: sha256(sourceBuffer) });
  }

  const manifest = {
    generatedFrom: 'cloudfunctions/memberAccess',
    note: '本目录由 miniapp/scripts/build-sandbox.cjs 生成，请勿手工编辑。',
    files: entries
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  for (const item of written) {
    console.log(`${item.action}: vendor/${item.name}  sha256=${item.sha256}`);
  }
  console.log('manifest: vendor/MANIFEST.json');
}

main();
