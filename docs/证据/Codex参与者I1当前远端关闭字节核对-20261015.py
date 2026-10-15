"""本轮下载 ZIP 的离线只读核对：不提取、不执行、不联网。"""
import json, zipfile, pathlib, stat, hashlib, posixpath, datetime
root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'docs/证据'
r = json.loads((evidence / 'Codex参与者I1当前远端只读基线-20261015.json').read_text(encoding='utf8'))
prior_path = evidence / 'codex-self-closed-1791771204427-c3e0abca-cef8-42f9-a5e5-7a813232a968.verified.json'
prior = json.loads(prior_path.read_text(encoding='utf8'))
assert r['status'] == 'REMOTE_ZIP_OBTAINED_VERIFICATION_PENDING'
p = pathlib.Path(r['archive']['path'])
expected = '4e7a20c0639d40187d23b895e13e6de3976638cd68d2cc27dd49858414127b6d'
assert hashlib.sha256(p.read_bytes()).hexdigest() == r['archive']['sha256'] == r['archive']['platformCodeSha256'] == prior['archiveSha256'] == expected
assert len(prior['files']) == 8
with zipfile.ZipFile(p) as z:
    infos = z.infolist()
    names = [i.filename for i in infos]
    assert len(names) == len(set(names)) and sum(i.file_size for i in infos) <= 150 * 1024 * 1024
    links = []
    for i in infos:
        n = i.filename
        assert '\\' not in n and not n.startswith('/') and '..' not in pathlib.PurePosixPath(n).parts and ':' not in n
        if stat.S_ISLNK(i.external_attr >> 16):
            assert n.startswith('node_modules/.bin/') and i.file_size < 1024
            t = z.read(n).decode('utf8')
            assert not t.startswith('/') and '\\' not in t and ':' not in t
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(n), t))
            assert resolved.startswith('node_modules/') and resolved in names and not stat.S_ISLNK(z.getinfo(resolved).external_attr >> 16)
            links.append(n)
    rows = []
    for f in prior['files']:
        n = f['path']
        assert not stat.S_ISLNK(z.getinfo(n).external_attr >> 16)
        b = z.read(n)
        h = hashlib.sha256(b).hexdigest()
        assert h == f['sha256'] and len(b) == f['bytes']
        rows.append({'path': n, 'bytes': len(b), 'sha256': h, 'matched': True})
    assert sorted(n for n in names if not n.endswith('/') and not n.startswith('node_modules/')) == sorted(f['path'] for f in rows)
    sdk = json.loads(z.read('node_modules/wx-server-sdk/package.json'))
    assert sdk['version'] == '3.0.1'
    report = {'runId': r['runId'], 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'archiveSha256': expected, 'historicalBaseline': prior_path.name, 'files': rows, 'matched': 8, 'wxServerSdk': sdk['version'], 'symlinksInspected': links, 'status': 'CURRENT_REMOTE_MATCHES_REVIEWED_CLOSED_BASELINE', 'extracted': False, 'downloadedCodeExecuted': False, 'platformWritePermissionVerified': False, 'participantIdentityVerified': False}
out = evidence / 'Codex参与者I1当前远端关闭字节核对-20261015.json'
with out.open('x', encoding='utf8') as f:
    f.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'status': report['status'], 'matched': 8, 'wxServerSdk': sdk['version']}, ensure_ascii=False))
