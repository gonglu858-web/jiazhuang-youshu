"""本轮下载 ZIP 的离线只读核对：不提取、不执行、不联网。"""
import json, zipfile, pathlib, stat, hashlib, posixpath, datetime, sys
mode=sys.argv[1]
assert mode in ("candidate","closed") and len(sys.argv)==2
root = pathlib.Path(__file__).resolve().parents[2]
evidence = root / 'docs/证据'
r=json.loads((evidence / ('Codex参与者I2夜间版本核对轮部署关闭-20261020.'+mode+'.json')).read_text(encoding='utf8'))
prep=json.loads((evidence/'Codex参与者I2夜间版本核对轮包准备-20261020.json').read_text(encoding='utf8'))
assert r['status']=='REMOTE_ZIP_OBTAINED_VERIFICATION_PENDING'
p=pathlib.Path(r['archive']['path'])
expected=r['archive']['platformCodeSha256']
assert hashlib.sha256(p.read_bytes()).hexdigest()==r['archive']['sha256']==expected
prefix='server/scheduleSandbox/' if mode=='candidate' else 'close/server/scheduleSandbox/'
prior={'files':[{'path':f['rel'][len(prefix):], 'bytes':f['bytes'], 'sha256':f['sha256']} for f in prep['files'] if f['rel'].startswith(prefix)]}
assert len(prior['files'])==(4 if mode=='candidate' else 8)
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
    db=json.loads(z.read('node_modules/@cloudbase/database/package.json'))
    assert db['version']=='1.4.1'
    report = {'runId': r['runId'], 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'archiveSha256': expected, 'mode':mode,'roundId':prep['plan']['checkRoundId'],'databaseVersion':db['version'], 'files': rows, 'matched': len(rows), 'wxServerSdk': sdk['version'], 'symlinksInspected': links, 'status': 'REMOTE_FILES_MATCH_FROZEN_I2_PACKAGE', 'extracted': False, 'downloadedCodeExecuted': False, 'platformWritePermissionVerified': False, 'participantIdentityVerified': False}
out = evidence / ('Codex参与者I2夜间版本核对轮字节核对-20261020.'+mode+'.json')
with out.open('x', encoding='utf8') as f:
    f.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'status': report['status'], 'matched': len(rows), 'wxServerSdk': sdk['version']}, ensure_ascii=False))
