const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Siriser-AI-Evaluator/api.js'), 'utf8');
const dims = ['alignment','quality','preservation','consistency','realism'];
const cfg = {OPENAI_API_KEY:'test-placeholder',OPENAI_MODEL:'judge-a',PARALLEL:1,MAX_REVIEW:0};
const task = {prompt:'保持原有内容',referenceImages:['https://example.invalid/ref.png'],models:[{id:'A',images:['https://example.invalid/a.png']}]};
const score = (value=7) => ({model:'A',...Object.fromEntries(dims.map(k=>[k,value])),notes:'ok'});
function ok(value=7) { return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores:[score(value)]})}}]})}; }
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
  const env=setup((body,calls)=>{if(calls.length===3)return ok();if(typeof kind==='number')return http(kind);const e=new Error(kind==='fetch'?'Failed to fetch':kind==='timeout'?'请求超时':'aborted');if(kind==='abort')e.name='AbortError';throw e;});
  const result=await env.evaluate();assert.equal(result.length,1);assert.equal(env.calls.length,3);assert.deepEqual(env.waits,[5000,10000]);
  assert.deepEqual(env.calls[0],env.calls[2]);
  const images=env.calls[0].messages[1].content.filter(p=>p.type==='image_url');assert.ok(images.length>=2);for(const im of images)assert.equal(im.image_url.url,env.compressed);
  assert.ok(env.logs.some(l=>l.includes('重试 2/2')));
});
for(const status of [400,401,403]) test(`HTTP ${status} is fatal with no retry, including legacy parameter errors`,async()=>{
 const env=setup(()=>http(status));await assert.rejects(env.evaluate(),e=>e.fatal===true);assert.equal(env.calls.length,1);assert.deepEqual(env.waits,[]);
});
for(const failed of ['judge-a','judge-b']) test(`dual failure of ${failed} falls back to survivor`,async()=>{
 const env=setup(body=>{if(body.model===failed)throw new TypeError('Failed to fetch');return ok();});
 const result=await env.evaluate({OPENAI_MODEL_2:'judge-b'});assert.equal(result[0].alignment,7);assert.equal(env.calls.filter(c=>c.model===failed).length,3);assert.ok(env.logs.some(l=>l.includes(failed==='judge-a'?'评委A降级':'评委B降级')));
});
test('both failed channels stop the task',async()=>{const e=setup(()=>http(503));await assert.rejects(e.evaluate({OPENAI_MODEL_2:'judge-b'}),/两个评委/);assert.equal(e.calls.length,6);});
test('single channel stops after three attempts',async()=>{const e=setup(()=>http(502));await assert.rejects(e.evaluate(),err=>err.channelFailure===true);assert.equal(e.calls.length,3);});
test('healthy dual judges still merge scores',async()=>{const e=setup(b=>ok(b.model==='judge-a'?7:8));const r=await e.evaluate({OPENAI_MODEL_2:'judge-b',DUAL_DIFF_THRESHOLD:3});assert.equal(r.length,1);assert.equal(e.calls.length,2);assert.ok(e.logs.some(l=>l.includes('双模型合并')));});
test('fatal judge cancels other in-flight judge without downgrade',async()=>{
 let aborted=false;const e=setup((b,c,o)=>b.model==='judge-a'?http(403):new Promise((resolve,reject)=>{const stop=()=>{aborted=true;reject(Object.assign(new Error('aborted'),{name:'AbortError'}));};o.signal.addEventListener('abort',stop);if(o.signal.aborted)stop();}));
 await assert.rejects(e.evaluate({OPENAI_MODEL_2:'judge-b'}),err=>err.fatal===true);assert.equal(aborted,true);assert.ok(!e.logs.some(l=>l.includes('降级')));
});
test('non-network failures do not silently downgrade',async()=>{const e=setup(b=>b.model==='judge-a'?http(500):ok());await assert.rejects(e.evaluate({OPENAI_MODEL_2:'judge-b'}),/500/);assert.equal(e.calls.filter(c=>c.model==='judge-a').length,1);});
test('custom API uses same transport retries',async()=>{const e=setup((b,c)=>c.length<3?http(502):{ok:true,status:200,json:async()=>({scores:[score()]})});await e.evaluate({API_URL:'https://example.invalid/score'});assert.deepEqual(e.waits,[5000,10000]);});
test('null-score retry uses surviving judge B, never failed A',async()=>{
 let bCalls=0;const e=setup(b=>{if(b.model==='judge-a')throw new TypeError('Failed to fetch');return ok(++bCalls===1?null:7);});
 const r=await e.evaluate({OPENAI_MODEL_2:'judge-b'});assert.equal(r[0].alignment,7);assert.equal(bCalls,2);assert.equal(e.calls.filter(c=>c.model==='judge-a').length,3);
});
test('fatal error after transient retry stops immediately',async()=>{const e=setup((b,c)=>http(c.length===1?503:401));await assert.rejects(e.evaluate(),err=>err.fatal);assert.equal(e.calls.length,2);assert.deepEqual(e.waits,[5000]);});
test('failed channel skips later batches while survivor finishes all candidates',async()=>{
 const t={...task,models:['A','B','C'].map(id=>({id,images:task.models[0].images}))};let bCalls=0;
 const e=setup(b=>{if(b.model==='judge-a')return http(503);const id=['A','B','C'][bCalls++];return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores:[{...score(),model:id}]})}}]})};});
 const r=await e.evaluate({OPENAI_MODEL_2:'judge-b'},t);assert.equal(r.length,3);assert.equal(bCalls,3);assert.equal(e.calls.filter(c=>c.model==='judge-a').length,3);
});
test('three-image batch also degrades safely',async()=>{
 const e=setup(b=>{if(b.model==='judge-a')return http(502);return ok();});
 const r=await e.evaluate({OPENAI_MODEL_2:'judge-b',BATCH_SIZE:3,PARALLEL:2});assert.equal(r[0].alignment,7);assert.equal(e.calls.filter(c=>c.model==='judge-a').length,3);
});
