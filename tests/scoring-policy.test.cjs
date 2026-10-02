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
  vm.runInContext(fs.readFileSync(path.join(dir, 'api.js'), 'utf8').replace('global.SiriserAPI = {', 'global.SiriserAPI = { capReviewList, reviewScores, pickPolicyReview, callOpenAIBatch,'), c);
  return c;
}
const flag = (code, severity = 'major') => ({ code, severity, evidence: '人物躯干相对参考明显横向拉宽' });
const highEvidence = { alignment:'尖领细飘带及金扣均与要求一致', quality:'领袖边界完整且手包接触自然', preservation:'脸型发带手势与参考对应保持', consistency:'人物投影与地面光向相互一致', realism:'皮革纹理自然且手指关节合理' };
const score = (flags = []) => ({ model: 'A', alignment: 10, quality: 10, preservation: 10, consistency: 10, realism: 10, notes: '', flags, highEvidence, _reviewed: true });
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
  assert.equal(c.SiriserScoringPolicy.apply(r.merged)[0].preservation,8);
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
  assert.equal(c.SiriserAPI.pickPolicyReview([{...score([flag('identity_changed')]),_reviewed:false}]).length,1);
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
test('empty or generic evidence cannot pass high score gate; lower scores and null stay', () => {
  const p=load().SiriserScoringPolicy;
  const r=p.apply([{...score(),highEvidence:{},quality:6,realism:null}])[0];
  assert.equal(r.alignment,8); assert.equal(r.preservation,8);
  assert.equal(r.quality,6); assert.equal(r.realism,null);
  assert.match(p.describe(r),/高分缺少逐维核查依据/);
  assert.equal(p.normalizeEvidence({alignment:'未见明显问题',quality:'细节看不清无法核实完整性'}).alignment,undefined);
  assert.equal(Object.keys(p.normalizeEvidence({quality:'细节看不清无法核实完整性'})).length,0);
});
test('evidenced nine allowed; ten needs independent review; API cannot forge review status', () => {
  const c=load(),p=c.SiriserScoringPolicy;
  assert.equal(p.apply([{...score(),_reviewed:false}])[0].alignment,9);
  assert.equal(p.apply([score()])[0].alignment,10);
  const parsed=c.SiriserAPI.normalizeScores({scores:[score()]})[0];
  assert.equal(parsed._reviewed,undefined);
  assert.equal(p.apply([parsed])[0].alignment,9);
});
test('9 plus 10 stays 9; dual missing evidence enters bounded review', () => {
  const c=load();
  const a={...score(),alignment:9,quality:9,preservation:9,consistency:9,realism:9};
  const r=c.SiriserAPI.mergeDualScores([a],[score()],3);
  assert.equal(r.merged[0].alignment,9);
  assert.equal(r.needReview.length,1); // Four or more high dimensions are sampled for review.
  const empty=c.SiriserAPI.mergeDualScores([{...a,highEvidence:{}}],[a],3);
  assert.equal(empty.needReview.length,1);
  assert.equal(c.SiriserScoringPolicy.apply(empty.merged)[0].alignment,8);
});
test('single unsupported highs selected even when flags empty', () => {
  const c=load();
  assert.equal(c.SiriserAPI.pickPolicyReview([{...score(),_reviewed:false,highEvidence:{}}]).length,1);
});
test('review success still requires evidence; missing evidence cannot bypass final gate', async () => {
  const c=load();
  c.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores:[{...score(),highEvidence:{}}]})},finish_reason:'stop'}]})});
  const r=await c.SiriserAPI.reviewScores({prompt:'换装',referenceImages:[],models:[{id:'A',images:[]}]},[score()],{OPENAI_MODEL_REVIEW:'mock',MAX_REVIEW:1});
  assert.equal(r[0]._reviewed,true);
  assert.equal(c.SiriserScoringPolicy.apply(r)[0].alignment,8);
});
test('high score review retains count and deadline limits', () => {
  const c=load();
  const items=['A','B','C','D'].map(model=>({...score(),model,_reviewed:false,highEvidence:{}}));
  assert.equal(c.SiriserAPI.capReviewList(items,{MAX_REVIEW:1},Date.now()+10000).length,1);
  assert.equal(c.SiriserAPI.capReviewList(items,{MAX_REVIEW:3},Date.now()-1).length,0);
  const skipped=c.SiriserScoringPolicy.apply(items);
  assert.equal(skipped.every(s=>s.alignment===8),true);
});
test('wrong model review cannot validate another model full score', async () => {
  const c=load();
  c.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({scores:[{...score(),model:'B'}]})},finish_reason:'stop'}]})});
  const r=await c.SiriserAPI.reviewScores({prompt:'换装',referenceImages:[],models:[{id:'A',images:[]}]},[{...score(),_reviewed:false}],{OPENAI_MODEL_REVIEW:'mock',MAX_REVIEW:1});
  assert.equal(r[0]._reviewed,false);
  assert.equal(c.SiriserScoringPolicy.apply(r)[0].alignment,9);
});
test('body distortion affects quality and realism even under body proportion label', () => {
  const p=load().SiriserScoringPolicy;
  const r=p.apply([score([flag('body_proportion_changed')])])[0];
  assert.equal(r.quality,5); assert.equal(r.realism,4); assert.equal(r.preservation,5);
  const minor=p.apply([score([flag('body_proportion_changed','minor')])])[0];
  assert.equal(minor.realism,8);
});
test('outpainting truncation caps edited quality and realism without preservation penalty', () => {
  const p=load().SiriserScoringPolicy;
  const r=p.apply([score([flag('outpaint_subject_truncated')])])[0];
  assert.equal(r.quality,5); assert.equal(r.realism,5); assert.equal(r.preservation,10);
  assert.equal(p.apply([score([flag('outpaint_subject_truncated','minor')])])[0].quality,8);
  const merged=p.merge([flag('outpaint_subject_truncated')],[flag('outpaint_subject_truncated')]);
  assert.equal(p.apply([{...score(),...merged}])[0].realism,5);
});
test('normal cropping is not inferred as defect from notes; prompt distinguishes it', () => {
  const p=load().SiriserScoringPolicy;
  const r=p.apply([{...score(),notes:'背景人物由最终画面边缘正常裁切'}])[0];
  assert.equal(r.realism,10);
  assert.match(p.prompt,/正常被最终画面边缘裁切/);
  assert.match(p.prompt,/不能只扣preservation/);
});
