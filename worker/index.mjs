import {api} from './api.mjs';
import {handleAuth,resolveIdentity} from './auth.mjs';
import assets from './generated-assets.mjs';
const cityCodes=new Set(JSON.parse(assets['/map-data.json'].body).cities.map(city=>city.code));
const security={
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'same-origin',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com"
};
export default {async fetch(request,env){
 try{
  const response=await handleAuth(request,env)||await api(request,{...env,ALLOWED_CITY_CODES:cityCodes},resolveIdentity);
  if(response){const headers=new Headers(response.headers);for(const[k,v]of Object.entries(security))headers.set(k,v);return new Response(response.body,{status:response.status,headers});}
  const url=new URL(request.url),path=url.pathname==='/'?'/index.html':url.pathname;
  const asset=Object.hasOwn(assets,path)?assets[path]:null;
  if(!asset||!['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404,headers:security});
  return new Response(request.method==='HEAD'?null:asset.body,{headers:{...security,'Content-Type':asset.type,'Cache-Control':'no-cache'}});
 }catch(error){console.error('Request failed',error.name);return new Response(JSON.stringify({error:'服务暂时不可用，请稍后重试'}),{status:500,headers:{...security,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
}};
