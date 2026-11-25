// Pure helpers; no modifications of messages or regex settings.
export const SAVER_ID = 'd9c82f13-b5d0-4286-b5bb-a0b3835c4013';
export const isSaver = s => s.id === SAVER_ID || /\bSaver:\s*Russian Narrative\b/i.test(s.scriptName || '');
export function applicable(s, depth) {
    return !s.disabled && !!s.promptOnly && s.placement?.includes(2)
        && !(s.minDepth != null && Number(s.minDepth) >= -1 && depth < Number(s.minDepth))
        && !(s.maxDepth != null && Number(s.maxDepth) >= 0 && depth > Number(s.maxDepth));
}
export function compare(raw, scripts, depth, run) {
    const active = scripts.filter(s => applicable(s, depth));
    if (!active.some(isSaver) || !/<ru\s*>/i.test(raw)) return null;
    let before = raw, after = raw;
    for (const s of active) {
        if (!isSaver(s)) before = run(s, before);
        after = run(s, after);
    }
    return before === after ? null : { before, after };
}
export function compact(n) {
    if (n < 1000) return String(n);
    return `${Number((n / 1000).toFixed(n < 10000 ? 1 : 0))}k`;
}
