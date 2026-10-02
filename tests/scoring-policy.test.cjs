const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.join(__dirname, '../Siriser-AI-Evaluator');
function load() {
  const c = vm.createContext({ console, setTimeout, clearTimeout, AbortController });
  c.self = c; c.window = c;
  vm.runInContext(fs.readFileSync(path.join(dir, 'scoring-policy.js'), 'utf8'), c);
  // Expose internals only in this isolated test context; production exports unchanged.
  vm.runInContext(fs.readFileSync(path.join(dir, 'api.js'), 'utf8').replace('global.SiriserAPI = {', 'global.SiriserAPI = { reviewScores, pickPolicyReview, callOpenAIBatch,'), c);
  return c;
}
const flag = (code, severity = 'major') => ({ code, severity, evidence: '人物躯干相对参考明显横向拉宽' });
const score = (flags = []) => ({ model: 'A', alignment: 10, quality: 10, preservation: 10, consistency: 10, realism: 10, notes: '', flags });
test('major distortion caps five dimensions without mutating source', () => {
  const c = load(), s = score([flag('non_uniform_distortion')]);
  const r = c.SiriserScoringPolicy.apply([s])[0];
  assert.deepEqual([r.alignment,r.quality,r.preservation,r.consistency,r.realism], [6,5,5,5,4]);
  assert.equal(s.realism, 10);
});
test('minor defects, color isolation, nulls and negated legacy notes', () => {
  const p = load().SiriserScoringPolicy;
  assert.equal(p.apply([score([flag('non_uniform_distortion','minor')])])[0].realism, 8);
  const r = p.apply([score([flag('wrong_color')])])[0];
  assert.equal(r.alignment,7); assert.equal(r.quality,10);
  assert.equal(p.apply([{...score(), notes:'未见非等比挤压'}])[0].realism,10);
  assert.equal(p.apply([{...score([flag('identity_changed')]), preservation:null}])[0].preservation,null);
  assert.equal(p.normalize([{code:'unknown',severity:'major',evidence:'x'}, {...flag('wrong_color'),evidence:''}]).length,0);
});
test('dual disagreements enter review even with identical numeric scores', () => {
  const c=load();
  const r=c.SiriserAPI.mergeDualScores([score([flag('identity_changed')])],[score()],3);
  assert.equal(r.needReview.length,1); assert.equal(r.merged[0].flags.length,0);
  assert.equal(r.merged[0].pendingFlags.length,1);
  assert.equal(c.SiriserScoringPolicy.apply(r.merged)[0].preservation,10);
  const agreed=c.SiriserAPI.mergeDualScores([score([flag('identity_changed')])],[score([flag('identity_changed')])],3);
  assert.equal(c.SiriserScoringPolicy.apply(agreed.merged)[0].preservation,4);
});
test('severity disagreement uses minor cap pending review', () => {
  const c=load();
  const r=c.SiriserAPI.mergeDualScores([score([flag('identity_changed')])],[score([flag('identity_changed','minor')])],3);
  assert.equal(r.needReview.length,1);
  assert.equal(c.SiriserScoringPolicy.apply(r.merged)[0].preservation,8);
});
test('review selection is evidence based, not model letter based', () => {
  const c=load();
  assert.equal(c.SiriserAPI.pickPolicyReview([{...score(),model:'S'}]).length,0);
  assert.equal(c.SiriserAPI.pickPolicyReview([score([flag('identity_changed')])]).length,1);
});
test('skipped and failed reviews retain flags and pending evidence', async () => {
  const c=load(), item={...score([flag('wrong_color')]),pendingFlags:[flag('identity_changed')]};
  const task={prompt:'换装',models:[{id:'A',images:[]}],referenceImages:[]};
  let r=await c.SiriserAPI.reviewScores(task,[item],{OPENAI_MODEL_REVIEW:'mock',MAX_REVIEW:0});
  assert.equal(r[0].flags.length,1); assert.equal(r[0].pendingFlags.length,1);
  c.fetch=async()=>{throw Error('offline');};
  r=await c.SiriserAPI.reviewScores(task,[item],{OPENAI_MODEL_REVIEW:'mock',MAX_REVIEW:1});
  assert.equal(r[0].flags.length,1); assert.equal(r[0].pendingFlags.length,1);
});
test('successful review replaces disputed flags; request retains token ceiling', async () => {
  const c=load(); let request;
  c.fetch=async(url,opts)=>{ request=JSON.parse(opts.body); return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores:[score()]})},finish_reason:'stop'}]})}; };
  const r=await c.SiriserAPI.reviewScores({prompt:'换装',referenceImages:[],models:[{id:'A',images:[]}]},[{...score(),pendingFlags:[flag('identity_changed')]}],{OPENAI_MODEL_REVIEW:'mock',MAX_REVIEW:1});
  assert.equal(r[0].flags.length,0); assert.equal(r[0].pendingFlags,undefined);
  assert.equal(request.max_tokens,768);
  assert.match(request.messages[0].content,/允许五维同分/);
});
test('manifest and manual injection load policy before consumers', () => {
  const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const files=m.content_scripts[0].js;
  assert.ok(files.indexOf('scoring-policy.js')<files.indexOf('api.js'));
  assert.match(fs.readFileSync(path.join(dir,'popup.js'),'utf8'),/"scoring-policy.js", "scoring-prompt.js", "api.js"/);
});
