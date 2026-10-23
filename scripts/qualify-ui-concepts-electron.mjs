// PR116 Phase D: real-Electron qualification of UI concept previews.
// Set UI_CONCEPT_SCREENSHOTS=<dir> to keep light/dark/expanded screenshots.
import { build } from "vite"
import react from "@vitejs/plugin-react"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(join(tmpdir(), "north-star-ui-concepts-"))
const screenshots = process.env.UI_CONCEPT_SCREENSHOTS
  ? resolve(process.env.UI_CONCEPT_SCREENSHOTS)
  : null
try {
  await build({
    configFile: false,
    root: resolve("scripts/fixtures"),
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    build: {
      outDir: join(temporary, "renderer"),
      emptyOutDir: true,
      rollupOptions: { input: resolve("scripts/fixtures/ui-concepts.html") },
    },
  })
  const main = join(temporary, "main.cjs")
  await writeFile(
    main,
    `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync, mkdirSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(temporary, "user-data"))});
const shots = ${JSON.stringify(screenshots)};
app.whenReady().then(async () => {
  const window = new BrowserWindow({width:420,height:850,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  const errors=[];
  window.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message) });
  const js = expression => window.webContents.executeJavaScript(expression, true);
  const wait = async expression => { for(let i=0;i<200;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+expression) };
  const pause = ms => new Promise(r=>setTimeout(r,ms));
  const shot = async name => { if(!shots) return; mkdirSync(shots,{recursive:true}); writeFileSync(shots+'/'+name+'.png',(await window.webContents.capturePage()).toPNG()) };
  const key = async keyCode => { window.webContents.sendInputEvent({type:'keyDown',keyCode}); window.webContents.sendInputEvent({type:'keyUp',keyCode}); await pause(80) };
  const click = (label, scope='document') => js("(()=>{const b=[..."+scope+".querySelectorAll('button')].find(b=>b.textContent==="+JSON.stringify(label)+");b.click();return true})()");
  const fig = i => "document.querySelectorAll('figure')["+i+"]";
  const pageFits = "document.documentElement.scrollWidth<=innerWidth && document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1";
  const helpers = "window.rgb=c=>{const x=document.createElement('canvas').getContext('2d');x.fillStyle=c;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data].slice(0,3)};window.lum=c=>{const v=rgb(c).map(n=>{n/=255;return n<=0.03928?n/12.92:((n+0.055)/1.055)**2.4});return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2]};window.contrast=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05)};window.frameContrast=f=>{const frame=f.querySelector('[aria-label=\\"UI concept preview\\"]');const t=frame.querySelector('h4,p,td');return contrast(getComputedStyle(t).color,getComputedStyle(frame).backgroundColor)};true";
  const checks=[];
  try {
    await window.loadFile(${JSON.stringify(join(temporary, "renderer/ui-concepts.html"))});
    await wait("document.querySelectorAll('[aria-label=\\"UI concept preview\\"]').length===6");
    await js(helpers);
    const reads = await js("window.qualification.reads()");
    assert.equal(reads, 6);
    assert.equal(await js(pageFits), true, 'narrow width without page overflow'); checks.push('narrow-width','long-unbroken-text');
    assert.equal(await js("document.querySelectorAll('form').length"), 0);
    await shot('light-narrow');

    // Revision: the original stays viewable beside the revision.
    assert.ok(await js(fig(2)+".textContent.includes('Revision 1') && "+fig(2)+".textContent.includes('Dashboard concept')"));
    assert.ok(await js(fig(3)+".textContent.includes('Revision 2') && "+fig(3)+".textContent.includes('Dashboard v2')"));
    assert.notEqual(await js("getComputedStyle("+fig(3)+".querySelector('h4')).fontSize"), await js("getComputedStyle("+fig(2)+".querySelector('h4')).fontSize"), 'typeScale token applies');
    checks.push('revision-history','type-scale-token');

    // Settings: local tabs/switch, demo buttons do nothing outside the preview.
    const viewport = "document.querySelector('[data-slot=message-scroller-viewport]')";
    await js(fig(0)+".scrollIntoView()"); await pause(100);
    const top = await js(viewport+".scrollTop");
    await js(fig(0)+".querySelector('[role=switch]').click()");
    assert.equal(await js(fig(0)+".querySelector('[role=switch]').getAttribute('aria-checked')"), 'false');
    await js(fig(0)+".querySelector('[role=tab]').focus()");
    await key('Right');
    const keyboardTabs = await js(fig(0)+".querySelectorAll('[role=tab]')[1].getAttribute('aria-selected')==='true'");
    if (!keyboardTabs) await js(fig(0)+".querySelectorAll('[role=tab]')[1].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    await js("(()=>{const t="+fig(0)+".querySelectorAll('[role=tab]')[1];t.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));t.click();return true})()");
    await wait(fig(0)+".querySelectorAll('[role=tab]')[1].getAttribute('aria-selected')==='true'");
    await click('Save preferences', fig(0));
    assert.ok(Math.abs(await js(viewport+".scrollTop")-top) < 4, 'transcript scroll unchanged by local interaction');
    assert.equal(await js("location.protocol"), 'file:');
    checks.push('local-tabs-switch','tab-state-retained','no-submit','scroll-unchanged', keyboardTabs ? 'native-arrow-tabs' : 'native-arrow-tabs-unverified');

    // Typing stays local and never reaches app-wide key listeners.
    await js("window.globalKeys=0;window.addEventListener('keydown',()=>window.globalKeys++);true");
    await js("(()=>{const t="+fig(0)+".querySelectorAll('[role=tab]')[0];t.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));t.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));t.click();return true})()");
    await wait(fig(0)+".querySelector('input')");
    assert.equal(await js(fig(0)+".querySelector('[role=switch]').getAttribute('aria-checked')"), 'false', 'demo state survives tab switching');
    await js(fig(0)+".querySelector('input').focus()");
    for (const ch of 'ana') window.webContents.sendInputEvent({type:'char',keyCode:ch});
    await key('A');
    await pause(100);
    const typed = await js(fig(0)+".querySelector('input').value");
    assert.equal(await js("window.globalKeys"), 0, 'keys contained in concept');
    checks.push(typed.startsWith('ana') ? 'native-typing' : 'native-typing-unverified', 'key-containment');

    // List/detail declared state.
    await click('Open Ana', fig(1));
    await wait(fig(1)+".textContent.includes(\\"Preview state: Ana's conversation\\")");
    assert.ok(await js(fig(1)+".textContent.includes('Invoice from Ana')"));
    await click('Back to list', fig(1));
    await wait(fig(1)+".textContent.includes('Preview state: Initial')");
    checks.push('declared-state');

    // Expanded dialog: presets, focus in, Escape, focus return.
    await js("(()=>{const b=[..."+fig(1)+".querySelectorAll('button')].find(b=>b.textContent==='Expand');b.focus();b.click();return true})()");
    await wait("!!document.querySelector('[role=dialog] [aria-label=\\"Preview width\\"]')");
    assert.ok(await js("document.querySelector('[role=dialog]').contains(document.activeElement)"), 'dialog initial focus');
    await click('Mobile', "document.querySelector('[role=dialog]')");
    await pause(100);
    assert.ok(await js("document.querySelector('[role=dialog] [aria-label=\\"UI concept preview\\"]').getBoundingClientRect().width<=376"), 'mobile preset width');
    await shot('expanded-mobile');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(await js("document.activeElement.textContent"), 'Expand');
    checks.push('viewport-presets','dialog-escape','focus-initial-return');

    // Feedback: exact revision, once, no artifact reads.
    await click('Use this direction', fig(3));
    await click('Added to your message', fig(3)).catch(()=>{});
    assert.equal(await js("JSON.stringify(window.qualification.choices)"), JSON.stringify([{artifactId:'dashboard',revision:2}]));
    assert.equal(await js("window.qualification.reads()"), reads, 'interactions never refetch');
    checks.push('choice-exact-revision-once','no-refetch');

    // Alternatives: one figure, switch inline, dialog follows, choice names it.
    assert.equal(await js(fig(5)+".querySelectorAll('[aria-label=\\"UI concept preview\\"]').length"), 1);
    await click('3. Split view', fig(5));
    await wait(fig(5)+".querySelector('h4').textContent==='Split view layout'");
    await js("[..."+fig(5)+".querySelectorAll('button')].find(b=>b.textContent==='Expand').click()");
    await wait("!!document.querySelector('[role=dialog] h4')");
    assert.equal(await js("document.querySelector('[role=dialog] h4').textContent"), 'Split view layout', 'dialog opens on the selected alternative');
    await click('4. Timeline', "document.querySelector('[role=dialog]')");
    await click('Use “Timeline”', "document.querySelector('[role=dialog]')");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(await js(fig(5)+".querySelector('h4').textContent"), 'Timeline layout', 'inline view follows the dialog selection');
    assert.equal(await js("JSON.stringify(window.qualification.choices.at(-1))"), JSON.stringify({artifactId:'ideas',revision:1,alternative:{id:'idea4',label:'Timeline'}}));
    checks.push('alternatives-switch','alternatives-dialog-sync','alternative-choice');

    // Themes and enlarged text.
    for (const theme of ['light','dark']) {
      // Measure final colors: a throttled (occluded) window can leave
      // transition-colors rows mid-transition.
      await js("(()=>{const st=document.createElement('style');st.id='no-transitions';st.textContent='*{transition:none!important}';document.head.append(st);document.documentElement.classList.toggle('dark',"+(theme==='dark')+");return true})()"); await pause(100);
      for (let i=0;i<6;i++) assert.ok(await js("frameContrast("+fig(i)+")>=4.5"), theme+' text contrast in concept '+i);
    }
    await js(fig(0)+".scrollIntoView()"); await pause(100);
    await shot('dark-narrow');
    await js("document.documentElement.classList.remove('dark')");
    await js("document.querySelectorAll('#no-transitions').forEach(e=>e.remove())");
    const thumbInside = "(()=>{const s=document.querySelector('[role=switch]');const t=s.firstElementChild.getBoundingClientRect(),r=s.getBoundingClientRect();return t.left>=r.left-0.5&&t.right<=r.right+0.5&&t.top>=r.top-0.5&&t.bottom<=r.bottom+0.5})()";
    const switchBothStates = async size => { for (let i=0;i<2;i++) { await js("document.querySelector('[role=switch]').click()"); await pause(250); assert.ok(await js(thumbInside), 'switch thumb inside track at '+size+' ('+await js("document.querySelector('[role=switch]').getAttribute('aria-checked')")+')') } };
    await switchBothStates('100%');
    await js("document.documentElement.style.fontSize='125%'"); await pause(150);
    await switchBothStates('125%');
    assert.equal(await js(pageFits), true, 'enlarged text without page overflow');
    await shot('light-enlarged');
    checks.push('theme-contrast','enlarged-text','switch-geometry');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',electron:process.versions.electron,checks}));
    app.exit(0);
  } catch(error){console.error(error);console.error((await js('document.body.innerText')).slice(0,1500));console.error(errors);app.exit(1)}
});
`
  )
  const code = await new Promise((done, reject) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require("electron"), [main], { env, stdio: "inherit" })
    const timer = setTimeout(() => child.kill("SIGTERM"), 60000)
    child.once("error", reject)
    child.once("exit", (code) => {
      clearTimeout(timer)
      done(code ?? 1)
    })
  })
  process.exitCode = code
} finally {
  await rm(temporary, { recursive: true, force: true })
}
