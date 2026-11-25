import { is_send_press } from '../../../../script.js';
import { is_group_generating } from '../../../group-chats.js';
import { getRegexScripts, runRegexScript } from '../../regex/engine.js';
import { countTokensOpenAIAsync, getTokenizerModel } from '../../../tokenizers.js';
import { applicable, compare, compact, isSaver } from './core.js';

const SELECTOR = '[data-pm-identifier="chatHistory"]';
const BADGE = 'sola-recap-savings';
const cache = new Map(); // only in memory, keyed by current chat and post index
let session = '', timer, busy = false, revision = 0, pending = false;
const generating = () => is_send_press || is_group_generating;
let lastRow = null, lastSignature = '', lastMessages = [], lastResult = null;
const context = () => globalThis.SillyTavern?.getContext?.();
const number = n => n.toLocaleString('en-US');
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
function row() { return document.querySelector(SELECTOR); }
function visible(el) { return !!el?.isConnected && el.getClientRects().length > 0 && !document.hidden; }
function badge(el) {
    const name = el.querySelector('[data-pm-name], .completion_prompt_manager_prompt_name');
    if (!name) return null;
    let span = name.querySelector(`.${BADGE}`);
    if (!span) {
        span = document.createElement('span');
        span.className = BADGE;
        span.setAttribute('aria-live', 'off');
        name.append(span);
    }
    return span;
}
function render(el, result) {
    const b = badge(el);
    if (!b) return;
    const label = result ? `−${compact(result.saved)} tok` : '…';
    if (b.textContent !== label) b.textContent = label;
    const title = result
        ? `Recap savings: approx. ${number(result.saved)} tokens across ${result.posts} compressed assistant posts in the eligible full chat. Compares the same prompt-only regex pipeline with/without the Russian Narrative saver. Excludes header and pose savings. Not a provider bill or exact final context count; context limits may exclude old messages.`
        : 'Calculating recap savings…';
    if (b.title !== title) b.title = title;
}
function clear(el) { el?.querySelector(`.${BADGE}`)?.remove(); }
function schedule(invalidate = true) {
    if (invalidate) revision++;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
}
function sameMessages(a, b) {
    return a.length === b.length && a.every((x,i) => x.text === b[i].text && x.user === b[i].user);
}
async function refresh() {
    if (busy || generating()) return;
    pending = false;
    const el = row(), ctx = context();
    if (!visible(el) || !ctx || ctx.mainApi !== 'openai') return;
    if (el.className.includes('prompt_manager_prompt_disabled')) { clear(el); return; }
    let scripts;
    try { scripts = ctx.extensionSettings?.disabledExtensions?.includes('regex') ? [] : getRegexScripts({ allowedOnly: true }); }
    catch (e) { clear(el); console.warn('[Sola Recap Savings] Regex unavailable', e); return; }
    scripts = scripts.filter(s => !s.disabled && s.promptOnly && s.placement?.includes(2));
    if (!scripts.some(isSaver)) { clear(el); lastResult = null; lastSignature = ''; return; }
    const chatKey = JSON.stringify([ctx.groupId, ctx.characterId, ctx.chatId, ctx.getCurrentChatId?.(), getTokenizerModel()]);
    if (session !== chatKey) { session = chatKey; cache.clear(); lastResult = null; lastSignature = ''; }
    // System/hidden messages are excluded like the regular prompt builder.
    const messages = (ctx.chat || []).filter(m => !m.is_system).map(m => ({text: String(m.mes ?? ''), user: !!m.is_user}));
    const sig = JSON.stringify(scripts);
    if (lastResult && !scripts.some(s => /\{\{/.test(`${s.findRegex} ${s.replaceString}`)) && sig === lastSignature && sameMessages(messages,lastMessages)) { render(el,lastResult); return; }
    busy = true;
    const runRevision = revision;
    const cancelled = () => revision !== runRevision || generating() || !visible(row());
    render(el, null);
    try {
        let saved = 0, posts = 0;
        for (let i = 0; i < messages.length; i++) {
            if (cancelled()) return;
            const m = messages[i], depth = messages.length - i - 1;
            if (m.user || !/<ru\s*>/i.test(m.text)) continue;
            const active = scripts.filter(s => applicable(s, depth));
            if (!active.some(isSaver)) continue;
            const key = JSON.stringify(active.map(s => [s.id, s.scriptName, s.findRegex, s.replaceString, s.trimStrings, s.substituteRegex]));
            let entry = cache.get(i);
            // Reuse old posts only if text and active rules match. Macro-bearing rules
            // may depend on external state, so do not cache their comparisons.
            const dynamic = active.some(s => /\{\{/.test(`${s.findRegex} ${s.replaceString}`));
            if (!entry || entry.text !== m.text || entry.key !== key || dynamic) {
                const pair = compare(m.text, active, depth, runRegexScript);
                let delta = 0;
                if (pair) {
                    const before = await countTokensOpenAIAsync({role:'assistant',content:pair.before}, true);
                    if (cancelled()) return;
                    const after = await countTokensOpenAIAsync({role:'assistant',content:pair.after}, true);
                    if (cancelled()) return;
                    if (!Number.isFinite(before) || !Number.isFinite(after)) throw Error('Invalid tokenizer response');
                    delta = before - after;
                }
                entry = {text:m.text,key,delta,compressed:!!pair};
                if (!dynamic) cache.set(i,entry);
            }
            saved += entry.delta;
            posts += Number(entry.compressed);
            if (i % 12 === 0) await yieldUI();
        }
        if (cancelled()) return;
        for (const i of cache.keys()) if (i >= messages.length) cache.delete(i);
        lastResult = {saved:Math.max(0,saved),posts};
        lastSignature = sig; lastMessages = messages;
        render(row(),lastResult);
    } catch(e) {
        console.warn('[Sola Recap Savings] Token count failed',e);
        const b = row()?.querySelector(`.${BADGE}`);
        if (b) { b.textContent = '— tok'; b.title = 'Tokenizer unavailable. Reopen Prompt Manager to retry.'; }
    } finally {
        busy = false;
        if (pending) schedule(false);
    }
}
function init() {
    const ctx = context();
    if (!ctx) return;
    const events = ctx.eventTypes || ctx.event_types || {};
    for (const key of ['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','OAI_PRESET_CHANGED','CHATCOMPLETION_SOURCE_CHANGED','CHATCOMPLETION_MODEL_CHANGED','SETTINGS_UPDATED','GENERATION_ENDED','GENERATION_STOPPED']) {
        if (events[key]) ctx.eventSource.on(events[key], () => {
            schedule();
        });
    }
    if (events.GENERATION_STARTED) ctx.eventSource.on(events.GENERATION_STARTED, (...args) => {
        // Ignore Prompt Manager dry runs (3rd argument on current ST).
        if (args[2] === true) return;
        revision++; pending = true;
    });
    // PM replaces its rows when it renders. A lightweight row check restores
    // the badge without watching the whole chat or listening to stream tokens.
    let wasVisible = false, wasGenerating = false;
    setInterval(() => {
        const el = row(), now = visible(el), active = generating();
        if (el !== lastRow || now !== wasVisible || (wasGenerating && !active)) {
            lastRow = el; wasVisible = now;
            if (now) schedule(false);
        }
        wasGenerating = active;
    }, 500);
    // React to settings changes even if the installed ST version has no event for them.
    document.addEventListener('change', () => { if (visible(row())) schedule(); }, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(false); });
    schedule(false);
}
// Extensions load after the main context is registered.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
