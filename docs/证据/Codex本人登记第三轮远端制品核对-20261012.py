"""本次登记/关闭 ZIP 只读检查，不提取或执行。"""
import json, zipfile, pathlib, stat, hashlib, posixpath, datetime, sys
root=pathlib.Path(__file__).resolve().parents[2]
mode=sys.argv[1]
assert mode in ('registration','closed') and len(sys.argv)==2
start=json.loads((root/f'docs/证据/Codex本人登记第三轮执行-20261012.{mode}.started.json').read_text(encoding='utf8'))
r=json.loads(pathlib.Path(start['output']).read_text(encoding='utf8'))
prep=json.loads((root/'docs/证据/Codex本人登记第三轮具体包准备-20261012.json').read_text(encoding='utf8'))
p=pathlib.Path(r['archive']['path'])
assert hashlib.sha256(p.read_bytes()).hexdigest()==r['archive']['sha256']==r['archive']['platformCodeSha256']
prefix=mode+'-project/cloudfunctions/scheduleSandbox/'
expected=[f for f in prep['files'] if f['path'].startswith(prefix)]
assert len(expected)==8
with zipfile.ZipFile(p) as z:
 infos=z.infolist();names=[i.filename for i in infos]
 assert len(names)==len(set(names)) and sum(i.file_size for i in infos)<=150*1024*1024
 links=[]
 for i in infos:
  n=i.filename
  assert '\\' not in n and not n.startswith('/') and '..' not in pathlib.PurePosixPath(n).parts and ':' not in n
  if stat.S_ISLNK(i.external_attr>>16):
   assert n.startswith('node_modules/.bin/') and i.file_size<1024
   t=z.read(n).decode('utf8');assert not t.startswith('/') and '\\' not in t and ':' not in t
   resolved=posixpath.normpath(posixpath.join(posixpath.dirname(n),t))
   assert resolved.startswith('node_modules/') and resolved in names and not stat.S_ISLNK(z.getinfo(resolved).external_attr>>16)
   links.append(n)
 rows=[]
 for f in expected:
  n=f['path'][len(prefix):];assert not stat.S_ISLNK(z.getinfo(n).external_attr>>16)
  b=z.read(n);h=hashlib.sha256(b).hexdigest()
  assert h==f['sha256'] and b==(pathlib.Path(prep['assemblyDir'])/f['path']).read_bytes()
  rows.append({'path':n,'bytes':len(b),'sha256':h,'matched':True})
 assert sorted(n for n in names if not n.endswith('/') and not n.startswith('node_modules/'))==sorted(v['path'] for v in rows)
 sdk=json.loads(z.read('node_modules/wx-server-sdk/package.json'));assert sdk['version']=='3.0.1'
 e={'runId':r['runId'],'mode':mode,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archiveSha256':r['archive']['sha256'],'files':rows,'matched':8,'wxServerSdk':'3.0.1','symlinksInspected':links,'status':'REMOTE_EIGHT_FILES_MATCH_APPROVED_INPUT','extracted':False,'downloadedCodeExecuted':False}
out=root/('docs/证据/'+r['runId']+'.verified.json')
with out.open('x',encoding='utf8') as f:f.write(json.dumps(e,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(out),'mode':mode,'matched':8,'status':e['status']},ensure_ascii=False))
