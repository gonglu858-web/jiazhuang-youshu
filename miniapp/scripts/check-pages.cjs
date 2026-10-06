// 页面结构检查（辅助检查，**不等价于**微信开发者工具编译）。
//
// 范围（Codex 复核 S6 要求写明）：
// - 校验每条路由的**必要文件齐全**（.js / .wxml / .json，缺一即失败）；
// - 解析 WXML 标签配对与属性引号（先掩掉 {{}} 表达式，避免表达式内 > 误判）；
// - 校验 WXSS 花括号与注释；
// - 解析页面 JS 语法与页面 JSON 合法性。
//
// **不等价于**：微信开发者工具的 wcc/wcsc 真实编译，也不等价于真机运行。
// 原 `scripts/check.cjs` 在本机因 Windows spawnSync EBUSY 无法拉起子进程，
// 因此本脚本作为**辅助**检查使用，不能替代原检查，也不替代真实编译。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MP = path.join(__dirname, '..', 'miniprogram');

function listPages() {
  const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  return appJson.pages;
}

// WXML 中真正的自闭合标签（没有结束标签）
const VOID_TAGS = new Set(['image', 'input', 'icon', 'progress', 'slider', 'switch', 'import', 'include', 'wxs']);

function checkWxml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  // 去掉注释
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  // 属性扫描前先把 {{...}} 表达式替换为占位符，
  // 避免表达式内部的 > 被误当作标签结束（既有页面合法写法）。
  const masked = clean.replace(/\{\{[^}]*\}\}/g, m => ' '.repeat(m.length));
  const stack = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(masked)) !== null) {
    const [full, name, attrs, selfClose] = m;
    if (full.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) problems.push(`标签不配对：期望 </${top}>，实际 </${name}>`);
    } else if (!selfClose && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
    // 属性中的引号必须成对
    const quotes = (attrs.match(/"/g) || []).length;
    if (quotes % 2 !== 0) problems.push(`属性引号不成对：${full}`);
  }
  if (stack.length) problems.push(`未闭合标签：${stack.join(',')}`);
  return problems;
}

function checkWxss(file) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const ch of clean) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) { problems.push('存在多余的 }'); break; }
  }
  if (depth !== 0) problems.push(`花括号不配对，剩余 ${depth} 个未闭合`);
  return problems;
}

function main() {
  const pages = listPages();
  console.log(`路由数：${pages.length}`);
  let failed = 0;
  let wxmlCount = 0;
  let wxssCount = 0;
  for (const page of pages) {
    const base = path.join(MP, page);
    // **必要文件缺失必须失败**（Codex 复核 S6）：每条路由至少要有
    // .js / .wxml / .json；.wxss 可选但本项目所有页面都有。
    for (const ext of ['js', 'wxml', 'json']) {
      const required = `${base}.${ext}`;
      if (!fs.existsSync(required)) {
        failed++;
        console.log(`✖ 缺少必要文件：${page}.${ext}`);
      }
    }
    for (const [ext, checker, isVoid] of [['wxml', checkWxml, false], ['wxss', checkWxss, true]]) {
      const file = `${base}.${ext}`;
      if (!fs.existsSync(file)) continue;
      const problems = checker(file);
      if (isVoid) wxssCount++; else wxmlCount++;
      if (problems.length) {
        failed++;
        console.log(`✖ ${page}.${ext}`);
        for (const p of problems) console.log(`   ${p}`);
      }
    }
    // JSON 合法性
    const jsonFile = `${base}.json`;
    if (fs.existsSync(jsonFile)) {
      try {
        JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      } catch (error) {
        failed++;
        console.log(`✖ ${page}.json 解析失败：${error.message}`);
      }
    }
    // JS 语法
    const jsFile = `${base}.js`;
    if (fs.existsSync(jsFile)) {
      try {
        new (require('node:vm').Script)(fs.readFileSync(jsFile, 'utf8'), { filename: jsFile });
      } catch (error) {
        failed++;
        console.log(`✖ ${page}.js 语法错误：${error.message}`);
      }
    }
  }
  console.log(`WXML 解析：${wxmlCount} 个；WXSS 解析：${wxssCount} 个`);
  if (failed) {
    console.log(`失败：${failed}`);
    process.exitCode = 1;
  } else {
    console.log('全部页面结构检查通过。');
  }
}

main();
