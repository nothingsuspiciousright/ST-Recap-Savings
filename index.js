// ST-Recap-Savings: mobile-compatible UI and explicit diagnostics.
// Read-only comparison. Never edits chat, prompt or regex settings.
const SELECTOR = '[data-pm-identifier="chatHistory"]';
const BADGE = 'sola-recap-savings';
const VERSION = '1.0.3';
const isSaver = s => s.id === 'd9c82f13-b5d0-4286-b5bb-a0b3835c4013' || /\bSaver:\s*Russian Narrative\b/i.test(s.scriptName || '');
const applicable = (s,d) => !s.disabled && !!s.promptOnly && s.placement?.includes(2) && !(s.minDepth != null && Number(s.minDepth) >= -1 && d < Number(s.minDepth)) && !(s.maxDepth != null && Number(s.maxDepth) >= 0 && d > Number(s.maxDepth));
const compact = n => n < 1000 ? String(n) : `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k`;
const visible = el => !!el?.isConnected && !!el.getClientRects().length && !document.hidden && getComputedStyle(el).visibility !== 'hidden';
const row = () => [...document.querySelectorAll(SELECTOR)].find(visible);
const cache = new Map();
let deps, loading, timer, busy = false, pending = false, revision = 0, lastRow, wasGenerating = false, session = '', lastResult, lastSignature = '', lastMessages = [], status = {label:'Loading…', detail:'Starting Recap Savings'};
const errorText = e => String(e?.message || e?.statusText || e || 'Unknown error').slice(0,200);
const generating = () => !!(deps?.main?.is_send_press || deps?.group?.is_group_generating);
function render(el = row()) {
    if (!el) return;
    const name = el.querySelector('[data-pm-name], .completion_prompt_manager_prompt_name');
    if (!name) return;
    let b = name.querySelector(`.${BADGE}`);
    if (!b) {
        b = document.createElement('span'); b.className = BADGE;
        b.setAttribute('role','button'); b.tabIndex = 0;
        b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showStatus(); });
        b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); showStatus(); } });
        name.append(b);
        // Keep this label out of the name's single-line ellipsis on mobile.
        for (const [k,v] of Object.entries({'display':'block','white-space':'normal','overflow-wrap':'anywhere','margin-inline-start':'0','margin-top':'2px','font-size':'.72em','line-height':'1.2','color':'#c7c7c7','opacity':'1','cursor':'pointer'})) b.style.setProperty(k,v,'important');
        name.style.setProperty('white-space','normal','important');
        name.style.setProperty('overflow','visible','important');
    }
    if (b.textContent !== status.label) b.textContent = status.label;
    b.title = status.detail; b.setAttribute('aria-label',`Recap Savings: ${status.detail}`);
}
function showStatus() { window.alert(`Recap Savings ${VERSION}\n\n${status.detail}`); if (!busy) schedule(); }
function setStatus(label,detail) { status = {label,detail}; render(); }
function schedule(invalidate = true) {
    if (invalidate) revision++;
    pending = true; clearTimeout(timer); timer = setTimeout(refresh, 300);
}
async function loadDeps() {
    if (deps) return deps;
    if (!loading) loading = Promise.all([
        import('../../regex/engine.js'), import('../../../tokenizers.js'), import('../../../../script.js'), import('../../../group-chats.js'), import('../../../extensions.js')
    ]).then(([regex,token,main,group,ext]) => {
        if (typeof regex.getRegexScripts !== 'function' || typeof regex.runRegexScript !== 'function' || typeof token.countTokensOpenAIAsync !== 'function' || typeof token.getTokenizerModel !== 'function') throw Error('Required SillyTavern API is missing');
        deps = {regex,token,main,group,ext}; return deps;
    }).catch(e => { loading = null; throw e; });
    return loading;
}
let subscribed = false;
function subscribe(ctx) {
    if (subscribed || !ctx?.eventSource?.on) return;
    subscribed = true;
    const events = ctx.eventTypes || ctx.event_types || {};
    for (const key of ['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','OAI_PRESET_CHANGED','CHATCOMPLETION_SOURCE_CHANGED','CHATCOMPLETION_MODEL_CHANGED','SETTINGS_UPDATED','GENERATION_ENDED','GENERATION_STOPPED']) {
        if (events[key]) ctx.eventSource.on(events[key], () => schedule());
    }
    if (events.GENERATION_STARTED) ctx.eventSource.on(events.GENERATION_STARTED, (...args) => { if (args[2] !== true) { revision++; pending = true; } });
}
async function refresh() {
    if (busy) return;
    const el = row(); if (!el) return;
    if (generating()) { setStatus('Waiting…','Generation is running; savings will refresh when it ends.'); return; }
    busy = true; pending = false;
    const runRevision = revision;
    const cancelled = () => revision !== runRevision || generating() || !row();
    let phase = 'Loading extension API';
    try {
        const {regex,token,main,ext} = await loadDeps();
        if (cancelled()) return;
        phase = 'Getting SillyTavern context';
        const ctx = ext.getContext?.() || globalThis.SillyTavern?.getContext?.();
        if (!ctx) { setStatus('No context','SillyTavern context is not ready. Tap this label to retry.'); return; }
        subscribe(ctx);
        if ((ctx.mainApi ?? main.main_api) !== 'openai') { setStatus('Wrong API','Recap Savings supports Chat Completion (OpenAI-compatible) only. Current API: '+String(ctx.mainApi ?? main.main_api)); return; }
        if (el.className.includes('prompt_manager_prompt_disabled')) { setStatus('History off','Chat History is disabled.'); return; }
        if (ctx.extensionSettings?.disabledExtensions?.includes('regex')) { setStatus('Regex off','The Regex extension is disabled.'); return; }
        phase = 'Reading active regex rules';
        const all = regex.getRegexScripts({allowedOnly:false});
        const allowed = regex.getRegexScripts({allowedOnly:true});
        const scripts = allowed.filter(s => !s.disabled && s.promptOnly && s.placement?.includes(2));
        if (!scripts.some(isSaver)) {
            lastResult = null; lastSignature = '';
            const found = all.filter(isSaver), permitted = allowed.filter(isSaver);
            if (!found.length) setStatus('Saver missing','Russian Narrative Saver was not found. Import the original rule in Global Regex.');
            else if (!permitted.length) setStatus('Saver blocked','Saver exists, but its character/preset Regex scope is not allowed.');
            else if (permitted.every(s=>s.disabled)) setStatus('Saver disabled','Russian Narrative Saver is disabled.');
            else setStatus('Saver settings','Saver must be enabled for AI Output and Alter Outgoing Prompt.');
            return;
        }
        phase = 'Preparing messages';
        const chatKey = JSON.stringify([ctx.groupId,ctx.characterId,ctx.chatId,ctx.getCurrentChatId?.(),token.getTokenizerModel()]);
        if (session !== chatKey) { session = chatKey; cache.clear(); lastResult = null; lastSignature = ''; }
        const messages = (ctx.chat || []).filter(m=>!m.is_system).map(m=>({text:String(m.mes ?? ''),user:!!m.is_user}));
        const sig = JSON.stringify(scripts), dynamic = scripts.some(s=>/\{\{/.test(`${s.findRegex} ${s.replaceString}`));
        const report = result => setStatus(result.posts ? `−${compact(result.saved)} tok` : '0 tok · no matches', `Approx. ${result.saved.toLocaleString('en-US')} tokens saved across ${result.posts} changed assistant posts in the full eligible chat. ${result.candidates} posts contained a Russian block. Not the provider bill or exact current prompt. Tap to refresh.`);
        if (lastResult && !dynamic && sig===lastSignature && messages.length===lastMessages.length && messages.every((m,i)=>m.text===lastMessages[i].text && m.user===lastMessages[i].user)) { report(lastResult); return; }
        setStatus('Calculating…','Comparing existing prompt-only Regex rules with and without the Saver.');
        let saved=0, posts=0, candidates=0;
        for (let i=0;i<messages.length;i++) {
            if (cancelled()) return;
            const m=messages[i], depth=messages.length-i-1;
            if (m.user || !/<ru\s*>/i.test(m.text)) continue;
            candidates++;
            const active=scripts.filter(s=>applicable(s,depth));
            if (!active.some(isSaver)) continue;
            const key=JSON.stringify(active), hasMacros=active.some(s=>/\{\{/.test(`${s.findRegex} ${s.replaceString}`));
            let entry=cache.get(i);
            if (!entry || entry.text!==m.text || entry.key!==key || hasMacros) {
                phase='Applying prompt-only Regex';
                let before=m.text, after=m.text;
                for (const s of active) { if (!isSaver(s)) before=regex.runRegexScript(s,before); after=regex.runRegexScript(s,after); }
                let delta=0, changed=before!==after;
                if (changed) {
                    phase='Counting tokens';
                    const a=await token.countTokensOpenAIAsync({role:'assistant',content:before},true);
                    if (cancelled()) return;
                    const b=await token.countTokensOpenAIAsync({role:'assistant',content:after},true);
                    if (cancelled()) return;
                    if (!Number.isFinite(a)||!Number.isFinite(b)) throw Error('Invalid tokenizer response');
                    delta=a-b;
                }
                entry={text:m.text,key,delta,changed}; if (!hasMacros) cache.set(i,entry);
            }
            saved+=entry.delta; posts+=Number(entry.changed);
            if (i%12===0) await new Promise(resolve=>setTimeout(resolve,0));
        }
        if (cancelled()) return;
        for (const i of cache.keys()) if (i>=messages.length) cache.delete(i);
        lastResult={saved:Math.max(0,saved),posts,candidates}; lastSignature=sig; lastMessages=messages; report(lastResult);
    } catch(e) { if (!cancelled()) setStatus('Recap error',`${phase}: ${errorText(e)}`); console.warn('[Recap Savings]',phase,e); }
    finally { busy=false; if (pending && !generating()) schedule(false); }
}
function init() {
    if (window.__solaRecapSavingsMobile103) return;
    window.__solaRecapSavingsMobile103=true;
    // Start UI independently of imports so failures can be displayed on Android.
    setInterval(()=>{
        const el=row(), active=generating();
        if (el!==lastRow || (wasGenerating && !active)) { lastRow=el; if(el) { render(el); schedule(false); } }
        else if (el && !el.querySelector(`.${BADGE}`)) render(el);
        wasGenerating=active;
    },500);
    document.addEventListener('change',()=>{if(row()) schedule();},true);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) schedule();});
    schedule(false);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
