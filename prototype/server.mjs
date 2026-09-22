import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1');const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));if(!path.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403);return res.end('Forbidden');}const bytes=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end('Not found');}});
server.listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173'));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
