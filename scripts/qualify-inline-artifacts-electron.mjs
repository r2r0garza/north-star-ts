import { build } from "vite"
import react from "@vitejs/plugin-react"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(
  join(tmpdir(), "north-star-artifact-qualification-")
)
try {
  await build({
    configFile: false,
    root: resolve("scripts/fixtures"),
    base: "./",
    plugins: [react()],
    resolve: { alias: { "@": resolve("src/renderer/src") } },
    build: {
      outDir: join(temporary, "renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve("scripts/fixtures/inline-artifacts.html"),
      },
    },
  })
  const main = join(temporary, "main.cjs")
  await writeFile(
    main,
    `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(join(temporary, "user-data"))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({width:420,height:850,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  const errors=[];
  window.webContents.on('console-message', event => { if(event.level === 'error') errors.push(event.message) });
  const js = expression => window.webContents.executeJavaScript(expression, true);
  const wait = async expression => { for(let i=0;i<200;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,25))}throw Error('Timed out: '+expression) };
  const button = label => js("[...document.querySelectorAll('button')].find(b=>b.textContent==="+JSON.stringify(label)+").click()");
  const started=performance.now();
  try {
    await window.loadFile(${JSON.stringify(join(temporary, "renderer/inline-artifacts.html"))});
    await wait("document.querySelectorAll('tbody tr').length===1000");
    const mountMs=Math.round(performance.now()-started);
    assert.equal(await js("document.querySelectorAll('tbody td').length"),24000);
    assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
    await wait("document.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value').length>0");
    assert.ok(await js("(()=>{const svg=document.querySelector('.recharts-surface').getBoundingClientRect();return [...document.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')].every(t=>{const b=t.getBoundingClientRect();return b.top>=svg.top && b.bottom<=svg.bottom && !t.textContent.includes('currency units')})})()"),'numeric axis labels stay inside chart viewport');
    const sortStarted=performance.now(); await button('Metric 1');
    await wait("document.querySelector('tbody td').textContent==='0'");
    const sortMs=Math.round(performance.now()-sortStarted);
    await button('Reset order');
    await wait("document.querySelector('tbody td').textContent==='9'");
    await js("document.querySelector('[data-slot=message-scroller-viewport]').dispatchEvent(new WheelEvent('wheel',{deltaY:-2000,bubbles:true}))");
    await new Promise(r=>setTimeout(r,400));
    await js("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop=0");
    await new Promise(r=>setTimeout(r,200));
    const readingTop=await js("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop");
    await js("document.querySelector('button').click()");
    await wait("document.querySelectorAll('figure').length===3");
    await new Promise(r=>setTimeout(r,300));
    assert.ok(Math.abs(await js("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop")-readingTop)<10,'off-bottom reading position');
    await js("(()=>{let v=document.querySelector('[data-slot=message-scroller-viewport]');v.scrollTop=v.scrollHeight})()");
    await new Promise(r=>setTimeout(r,300));
    await button('Append artifact');
    await wait("document.querySelectorAll('figure').length===4");
    await new Promise(r=>setTimeout(r,800));
    assert.ok(await js("(()=>{let v=document.querySelector('[data-slot=message-scroller-viewport]');return v.scrollHeight-v.scrollTop-v.clientHeight<12})()"),'bottom follow');
    await js("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop=0");
    const reads=await js("window.qualification.reads()");
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Expand').scrollIntoView()");
    await new Promise(r=>setTimeout(r,200));
    await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Expand').focus()");
    await button('Expand');
    await wait("!!document.querySelector('[role=dialog]')");
    assert.ok(await js("document.querySelector('[role=dialog]').contains(document.activeElement)"),'dialog initial focus');
    await button('View data');
    await wait("!!document.querySelector('[role=dialog] table')");
    assert.ok(await js("document.querySelector('[role=dialog]').textContent.includes('Synthetic qualification data')"));
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    assert.equal(await js("document.activeElement.textContent"),'Expand');
    assert.equal(await js("window.qualification.reads()"),reads);
    await js("document.documentElement.classList.add('dark')");
    assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--artifact-series-1').trim()"),'#93c5fd');
    await js("document.documentElement.classList.remove('dark')");
    assert.equal(await js("getComputedStyle(document.documentElement).getPropertyValue('--artifact-series-1').trim()"),'#1d4ed8');
    await js("(()=>{let r=document.createRange();r.selectNodeContents(document.querySelector('figcaption'));let s=getSelection();s.removeAllRanges();s.addRange(r)})()");
    assert.ok(await js("getSelection().toString().includes('Observed revenue')"));
    const baselineCells=await js("document.querySelectorAll('tbody td').length");
    const baselineRows=await js("document.querySelectorAll('tbody tr').length");
    const repeatedStarted=performance.now();
    await button('Append table'); await wait("document.querySelectorAll('tbody tr').length==="+(baselineRows+1000));
    await button('Append table'); await wait("document.querySelectorAll('tbody tr').length==="+(baselineRows+2000));
    const repeatedTableMs=Math.round(performance.now()-repeatedStarted);
    assert.equal(await js("document.querySelectorAll('tbody td').length"),baselineCells+48000);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({status:'passed',electron:process.versions.electron,mountMs,sortMs,repeatedTableMs,cells:72000,checks:['narrow-width','numeric-axis-label-bounds','numeric-sort-reset','off-bottom-anchor','bottom-follow','dialog-escape','focus-initial-return','data-view-no-refetch','theme-tokens','text-selection']}));
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
