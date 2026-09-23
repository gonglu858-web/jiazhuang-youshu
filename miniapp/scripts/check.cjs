// 无第三方依赖。可选传入开发者工具已有 wcc-exec 目录，校验原生模板/样式。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../miniprogram');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error || result.stderr || result.stdout}`);
}
const files = walk(root);
for (const file of files) {
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file.endsWith('.js')) run(process.execPath, ['--check', file]);
}
const config = JSON.parse(fs.readFileSync(path.resolve(root, '../project.config.json'), 'utf8'));
if (config.miniprogramRoot !== 'miniprogram/') throw new Error('小程序根目录配置不符');
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['.js', '.json', '.wxml']) if (!fs.existsSync(path.join(root, page + ext))) throw new Error(`页面文件缺失：${page}${ext}`);
console.log(`JSON、JavaScript 语法和 ${app.pages.length} 个页面路由检查通过。`);
if (process.argv[2]) {
  const compiler = path.resolve(process.argv[2]);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renovation-miniapp-check-'));
  for (const ext of ['.wxml', '.wxss']) {
    const targets = files.filter(file => file.endsWith(ext)).map(file => path.relative(root, file).replaceAll('\\', '/'));
    run(path.join(compiler, ext === '.wxml' ? 'wcc.exe' : 'wcsc.exe'), [...targets, '-o', path.join(temp, ext === '.wxml' ? 'wxml.js' : 'wxss.js')]);
    console.log(`${targets.length} 个 ${ext} 文件通过本机微信编译器检查。`);
  }
} else console.log('未提供微信编译器目录；跳过 WXML/WXSS 编译，不视作已通过。');
