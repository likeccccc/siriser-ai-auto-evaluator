const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Siriser-AI-Evaluator/api.js'), 'utf8');
const dims = ['alignment','quality','preservation','consistency','realism'];
const cfg = {OPENAI_API_KEY:'test-placeholder',OPENAI_MODEL:'judge-a',PARALLEL:1,MAX_REVIEW:0};
const image = 'https://example.invalid/a.png';
const task = {prompt:'保持原有内容',referenceImages:['https://example.invalid/ref.png'],models:[{id:'A',images:[image]}]};
const score = (id='A', value=7) => ({model:id,...Object.fromEntries(dims.map(k=>[k,value])),notes:'ok'});
function requestedIds(body) {
  const prompt = body.messages?.[1]?.content?.find?.((x) => x.type === 'text')?.text || '';
  return (prompt.match(/模型列表：([^\n]+)/)?.[1] || 'A').split(',').map((x) => x.trim());
}
function ok(value=7, ids=['A']) {
  const scores = ids.map((id) => score(id, value));
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores})}}]})};
}
function http(status) {return {ok:false,status,text:async()=> 'response_format unsupported',body:{cancel:async()=>{}}};}
function setup(handler) {
  const calls=[], waits=[], logs=[], timers=new Map(); let n=0;
  const compressed='data:image/jpeg;base64,'+'a'.repeat(30000);
  const context={AbortController,console,URL,Map,Set,Date,
    setTimeout(fn,ms){const id=++n;timers.set(id,fn); if(ms<60000){waits.push(ms);queueMicrotask(()=>{if(timers.delete(id))fn();});}return id;},
    clearTimeout(id){timers.delete(id);},
    chrome:{runtime:{sendMessage:async m=>m.type==='SIRISER_BG_PING'?{ok:true}:{ok:true,dataUrl:compressed}}},
    SIRISER_PAGE_LOG:msg=>logs.push(msg),
    fetch:async (url,options)=>{const body=JSON.parse(options.body);calls.push(body);return handler(body,calls,options);}
  };
  context.window=context;vm.runInNewContext(source,context);
  return {evaluate:(extra={},t=task)=>context.SiriserAPI.evaluate(t,{...cfg,...extra}),calls,waits,logs,compressed};
}
for(const kind of ['fetch','abort','timeout',502,503]) test(`retries ${kind} twice at 5s/10s, keeps compressed payload`,async()=>{
  const env=setup((body,calls)=>{if(calls.length===3)return ok(7,requestedIds(body));if(typeof kind==='number')return http(kind);const e=new Error(kind==='fetch'?'Failed to fetch':kind==='timeout'?'请求超时':'aborted');if(kind==='abort')e.name='AbortError';throw e;});
  const result=await env.evaluate();assert.equal(result.length,1);assert.equal(env.calls.length,3);assert.deepEqual(env.waits,[5000,10000]);
  assert.deepEqual(env.calls[0],env.calls[2]);
  const images=env.calls[0].messages[1].content.filter(p=>p.type==='image_url');assert.ok(images.length>=2);for(const im of images)assert.equal(im.image_url.url,env.compressed);
  assert.ok(env.logs.some(l=>l.includes('重试 2/2')));
});
for(const status of [400,401,403]) test(`HTTP ${status} is fatal with no retry, including legacy parameter errors`,async()=>{
 const env=setup(()=>http(status));await assert.rejects(env.evaluate(),e=>e.fatal===true);assert.equal(env.calls.length,1);assert.deepEqual(env.waits,[]);
});
for(const failed of ['judge-a','judge-b']) test(`dual ${failed} network failure is refilled and valid survivor is retained`,async()=>{
 const env=setup((body,calls)=>{if(body.model===failed)return http(503);return ok(7,requestedIds(body));});
 const result=await env.evaluate({OPENAI_MODEL_2:'judge-b'});assert.equal(result[0].alignment,7);
 assert.equal(env.calls.filter(c=>c.model===failed).length,6);
 assert.ok(env.logs.some(l=>l.includes('开始补缺')));
 assert.ok(env.logs.some(l=>l.includes('单评委结果降级')));
});
test('both judges failing one candidate resolves with per-image failure, not task failure',async()=>{
 const env=setup(()=>http(503));
 const result=await env.evaluate({OPENAI_MODEL_2:'judge-b'});
 assert.equal(result.length,1);assert.equal(result[0].alignment,null);assert.equal(result[0]._networkFailedBoth,true);
 assert.equal(result[0]._failure.length,2);assert.ok(result[0]._failure.every(f=>f.imageId==='A'&&f.reason.includes('503')));
 assert.equal(env.calls.length,12);assert.ok(env.logs.some(l=>l.includes('两个评委补缺仍失败 A')));
});
test('single judge marks failed candidate missing and completes evaluation',async()=>{
 const e=setup(()=>http(502));const r=await e.evaluate();assert.equal(r.length,1);assert.equal(r[0].alignment,null);assert.equal(e.calls.length,6);
});
test('healthy dual judges still merge scores',async()=>{const e=setup(b=>ok(b.model==='judge-a'?7:8,requestedIds(b)));const r=await e.evaluate({OPENAI_MODEL_2:'judge-b',DUAL_DIFF_THRESHOLD:3});assert.equal(r.length,1);assert.equal(e.calls.length,2);assert.ok(e.logs.some(l=>l.includes('双模型合并')));});
test('fatal judge cancels other in-flight judge without downgrade',async()=>{
 let aborted=false;const e=setup((b,c,o)=>b.model==='judge-a'?http(403):new Promise((resolve,reject)=>{const stop=()=>{aborted=true;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};o.signal.addEventListener('abort',stop);if(o.signal.aborted)stop();}));
 await assert.rejects(e.evaluate({OPENAI_MODEL_2:'judge-b'}),err=>err.fatal===true);assert.equal(aborted,true);assert.ok(!e.logs.some(l=>l.includes('降级')));
});
test('non-network failures do not silently downgrade',async()=>{const e=setup(b=>b.model==='judge-a'?http(500):ok(7,requestedIds(b)));await assert.rejects(e.evaluate({OPENAI_MODEL_2:'judge-b'}),/500/);assert.equal(e.calls.filter(c=>c.model==='judge-a').length,1);});
test('custom API uses same transport retries',async()=>{const e=setup((b,c)=>c.length<3?http(502):{ok:true,status:200,json:async()=>({scores:[score()]})});await e.evaluate({API_URL:'https://example.invalid/score'});assert.deepEqual(e.waits,[5000,10000]);});
test('first-round image failure does not stop the judge; refill requests only missing image',async()=>{
 const ids=['A','B','C','D','E'];const t={...task,models:ids.map(id=>({id,images:[image]}))};
 const failedA=new Map();
 const e=setup((body)=>{
   const requested=requestedIds(body);const id=requested[0];
   if(body.model==='judge-a'&&id==='C'){
     const key=`${body.model}:${id}`;const n=(failedA.get(key)||0)+1;failedA.set(key,n);
     if(n<=3)return http(503);
   }
   return ok(body.model==='judge-a'?7:8,requested);
 });
 const result=await e.evaluate({OPENAI_MODEL_2:'judge-b',PARALLEL:2},t);
 assert.equal(result.length,5);assert.equal(result.find(x=>x.model==='C').alignment,7);
 const aRequests=e.calls.filter(c=>c.model==='judge-a').map(requestedIds);
 assert.ok(aRequests.some(xs=>xs.includes('D'))&&aRequests.some(xs=>xs.includes('E')),'later candidates must be scored');
 assert.equal(aRequests.filter(xs=>xs.length===1&&xs[0]==='A').length,1);
 assert.equal(aRequests.filter(xs=>xs.length===1&&xs[0]==='B').length,1);
 assert.equal(aRequests.filter(xs=>xs.length===1&&xs[0]==='C').length,4,'C gets three first-round attempts plus one refill request (it succeeds on first attempt)');
 assert.ok(e.logs.some(l=>l.includes('评委A完成：4/5，missing=C')));
 assert.ok(e.logs.some(l=>l.includes('开始补缺：judge-a × C')));
 assert.ok(e.logs.some(l=>l.includes('补缺成功 C → 恢复双评委合并')));
});
test('18-image dual scoring continues after C fails; successful images are never refetched',async()=>{
 const ids=Array.from({length:18},(_,i)=>String.fromCharCode(65+i+(i>=8?1:0))); // A,B,C,D...H,J...S
 const t={...task,models:ids.map(id=>({id,images:[image]}))};
 const seen=new Map();
 const e=setup((body)=>{
   const requested=requestedIds(body);const id=requested[0];const key=`${body.model}:${id}`;const n=(seen.get(key)||0)+1;seen.set(key,n);
   if(body.model==='judge-a'&&id==='C'&&n<=6)return http(503); // three first-round attempts + three refill attempts
   return ok(7,requested);
 });
 const result=await e.evaluate({OPENAI_MODEL_2:'judge-b',PARALLEL:2},t);
 assert.equal(result.length,18);assert.notEqual(result.find(x=>x.model==='C').alignment,null);
 for(const id of ids.filter(x=>x!=='C'))assert.equal(seen.get(`judge-a:${id}`),1,`${id} should not be requested again`);
 assert.equal(seen.get('judge-a:C'),6); // first round 3 attempts + one refill round (3 transport attempts)
 assert.ok(e.logs.some(l=>l.includes('评委A完成：17/18，missing=C')));
 assert.ok(e.logs.some(l=>l.includes('开始补缺：judge-a × C')));
 assert.ok(e.logs.some(l=>l.includes('补缺失败 C → 使用 judge-b 单评委结果降级')));
});
