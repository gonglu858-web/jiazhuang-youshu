"""仅检查已下载 ZIP，不解压、不执行其中代码；stdout 不含签名链接或凭据。"""
import json, zipfile, pathlib, stat, hashlib, posixpath, datetime

root = pathlib.Path(__file__).resolve().parents[2]
start = json.loads((root / 'docs/证据/Codex关闭基线单次部署-20261011.started.json').read_text(encoding='utf8'))
r = json.loads(pathlib.Path(start['output']).read_text(encoding='utf8'))
p = root / r['archive']['path']
prep = json.loads((root / 'docs/证据/Codex关闭基线部署准备-20261011.json').read_text(encoding='utf8'))
assert hashlib.sha256(p.read_bytes()).hexdigest() == r['archive']['sha256'] == r['archive']['platformCodeSha256']
with zipfile.ZipFile(p) as z:
    infos = z.infolist()
    names = [i.filename for i in infos]
    assert len(names) == len(set(names))
    assert sum(i.file_size for i in infos) <= 150 * 1024 * 1024
    links = []
    for i in infos:
        n = i.filename
        assert '\\' not in n and not n.startswith('/') and '..' not in pathlib.PurePosixPath(n).parts and ':' not in n
        if stat.S_ISLNK(i.external_attr >> 16):
            # npm 在 Linux 生成 .bin 软链接；只读取链接文本并核对归属，永不提取或运行。
            assert n.startswith('node_modules/.bin/') and i.file_size < 1024
            target = z.read(n).decode('utf8')
            assert not target.startswith('/') and '\\' not in target and ':' not in target
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(n), target))
            assert resolved.startswith('node_modules/') and resolved in names
            assert not stat.S_ISLNK(z.getinfo(resolved).external_attr >> 16)
            links.append({'path': n, 'relativeTarget': target, 'targetExistsInsideArchive': True})
    rows = []
    for f in prep['files']:
        assert f['path'] in names and not stat.S_ISLNK(z.getinfo(f['path']).external_attr >> 16)
        b = z.read(f['path'])
        h = hashlib.sha256(b).hexdigest()
        assert h == f['sha256'] and b == (root / f['sourceKey']).read_bytes()
        rows.append({'path': f['path'], 'bytes': len(b), 'sha256': h, 'matched': True})
    root_files = [n for n in names if not n.endswith('/') and not n.startswith('node_modules/')]
    assert sorted(root_files) == sorted(f['path'] for f in prep['files'])
    sdk = json.loads(z.read('node_modules/wx-server-sdk/package.json'))
    assert sdk['version'] == '3.0.1'
    packages = []
    for i in infos:
        if i.filename.startswith('node_modules/') and i.filename.endswith('/package.json'):
            try:
                q = json.loads(z.read(i.filename))
                name, version = q.get('name'), q.get('version')
                if isinstance(name, str) and isinstance(version, str):
                    packages.append({'path': i.filename, 'name': name, 'version': version,
                                     'sha256': hashlib.sha256(z.read(i.filename)).hexdigest()})
            except (ValueError, UnicodeError):
                pass
    e = {'schema': 'closed-baseline-remote-verification/1', 'runId': r['runId'],
         'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'scriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
         'archiveSha256': r['archive']['sha256'], 'platformArchiveSha256Matches': True,
         'entryCount': len(infos), 'uncompressedBytes': sum(i.file_size for i in infos),
         'entryPathsInsideArchive': True, 'symlinks': links, 'archiveExtracted': False,
         'downloadedCodeExecuted': False, 'files': rows, 'extraNonDependencyFiles': [],
         'wxServerSdkVersion': sdk['version'], 'packageManifests': packages,
         'sourceClosedConfigByteIdentical': True, 'status': 'CLOSED_CODE_AND_RUNTIME_CONFIGURATION_VERIFIED',
         'limitations': ['未调用云函数；真实调用权限、冷启动与业务运行时未验证。',
                        '依赖包已安装并从远端读取版本，不等于全部依赖运行已验证。',
                        'GetFunction的CodeSize=0与实际下载约4.9MB并存，保留原值不作容量结论。']}
out = root / 'docs/证据/Codex关闭基线远端代码核对-20261011.json'
with out.open('x', encoding='utf8') as f:
    f.write(json.dumps(e, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'matched': len(rows), 'sdkVersion': sdk['version'], 'packageManifests': len(packages),
                  'symlinksInspectedNotExtracted': len(links), 'status': e['status']}, ensure_ascii=False))
