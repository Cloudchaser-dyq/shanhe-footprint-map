import {readFile,writeFile,mkdir,readdir,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const assets={};
for(const name of await readdir(path.join(root,'web'))){const type=types[path.extname(name)];if(type)assets['/'+name]={type,body:await readFile(path.join(root,'web',name),'utf8')};}
await writeFile(path.join(root,'worker/generated-assets.mjs'),'export default '+JSON.stringify(assets)+';\n');
await mkdir(path.join(root,'dist/server'),{recursive:true});
await mkdir(path.join(root,'dist/.openai'),{recursive:true});
await build({entryPoints:[path.join(root,'worker/index.mjs')],outfile:path.join(root,'dist/server/index.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
await cp(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
await cp(path.join(root,'drizzle'),path.join(root,'dist/.openai/drizzle'),{recursive:true});
console.log('Built Worker with '+Object.keys(assets).length+' embedded assets.');
