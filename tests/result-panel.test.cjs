const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../Siriser-AI-Evaluator/content.js'),'utf8');
function element() {
  const classes=new Set(),events={},attrs={}; let capture;
  return {style:{},events,attrs,textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
    addEventListener:(name,fn)=>events[name]=fn,setAttribute:(k,v)=>attrs[k]=v,
    setPointerCapture:id=>capture=id,hasPointerCapture:id=>capture===id,releasePointerCapture:()=>capture=undefined,
    closest:()=>null};
}
function setup() {
  const panel=element(),header=element(),toggle=element(),title=element(),win={innerWidth:1000,innerHeight:800,events:{},addEventListener(n,f){this.events[n]=f;}};
  panel.classList.add('open');
  panel.querySelector=s=>s==='.sir-r-h'?header:toggle;
  header.querySelector=()=>title;
  panel.getBoundingClientRect=()=>({left:parseFloat(panel.style.left)||500,top:parseFloat(panel.style.top)||200,width:panel.classList.contains('collapsed')?280:400,height:panel.classList.contains('collapsed')?60:480});
  const a=source.indexOf('  function bindResultPanelControls('),b=source.indexOf('  function showResultPanel(',a);
  vm.runInNewContext(source.slice(a,b)+'\nbindResultPanelControls(panel);',{panel,window:win});
  const event=(x,y,target=header)=>({clientX:x,clientY:y,button:0,isPrimary:true,pointerId:1,target,preventDefault(){}});
  return {panel,header,toggle,title,win,event};
}
test('collapse keeps panel reachable and expands without replacing results',()=>{
  const {panel,toggle,title}=setup();
  toggle.events.click();
  assert.equal(panel.classList.contains('open'),true);
  assert.equal(panel.classList.contains('collapsed'),true);
  assert.equal(toggle.textContent,'展开'); assert.equal(toggle.attrs['aria-expanded'],'false');
  panel._resultControls.expand();
  assert.equal(panel.classList.contains('collapsed'),false);
  assert.equal(toggle.textContent,'收起'); assert.match(title.textContent,/核对/);
});
test('drag is bounded; pointer cancel stops moving',()=>{
  const {panel,header,event}=setup();
  header.events.pointerdown(event(520,220));
  header.events.pointermove(event(-1000,-1000));
  assert.equal(panel.style.left,'8px'); assert.equal(panel.style.top,'8px');
  header.events.pointermove(event(5000,5000));
  assert.equal(panel.style.left,'592px'); assert.equal(panel.style.top,'312px');
  header.events.pointercancel(event(5000,5000));
  header.events.pointermove(event(0,0));
  assert.equal(panel.style.left,'592px'); assert.equal(header.classList.contains('dragging'),false);
});
test('buttons do not initiate drag; resize clamps existing placement',()=>{
  const {panel,header,win,event}=setup();
  header.events.pointerdown(event(0,0,{closest:()=>({})}));
  header.events.pointermove(event(50,50));
  assert.equal(panel.style.left,undefined);
  panel.style.left='800px'; panel.style.top='700px';
  win.innerWidth=600; win.innerHeight=600; win.events.resize();
  assert.equal(panel.style.left,'192px'); assert.equal(panel.style.top,'112px');
});
test('result menu recovery wired and close button replaced',()=>{
  assert.match(source,/data-act="results"/);
  assert.match(source,/if \(act === "results"\)/);
  assert.match(source,/data-r="collapse"/);
  const start=source.indexOf('  function showResultPanel(');
  assert.doesNotMatch(source.slice(start,source.indexOf('  // ── 诊断',start)),/data-r="close"/);
});
