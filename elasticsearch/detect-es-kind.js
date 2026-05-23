/**
 * Sniff a JSON string to decide whether it is an Elasticsearch mapping dump
 * or a settings dump.
 *
 * Returns one of: 'mapping' | 'setting' | 'unknown'.
 *
 * Detection rules (order matters):
 *   1. If the top-level JSON parses to a STRING, treat it as a settings dump.
 *      Some upstream tools emit settings as a JSON-encoded string of JSON
 *      (i.e. the file contents are `"\"{...}\""`).
 *   2. Otherwise the top-level value is expected to be an object keyed by
 *      index name. If ANY value has `.mappings`, classify as mapping. This
 *      also covers full index dumps that contain BOTH `.mappings` and
 *      `.settings` — they're treated as mapping uploads (the mapping endpoint
 *      will fold any embedded settings into its records).
 *   3. If ANY top-level value has `.settings`, classify as setting.
 *   4. Anything else is 'unknown' — the caller should reject with 422.
 */

'use strict';

function sniffEsKind(rawText) {
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        return 'unknown';
    }
    if (typeof parsed === 'string') return 'setting';
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';

    let sawSetting = false;
    for (const body of Object.values(parsed)) {
        if (!body || typeof body !== 'object') continue;
        if (body.mappings) return 'mapping';
        if (body.settings) sawSetting = true;
    }
    return sawSetting ? 'setting' : 'unknown';
}

module.exports = { sniffEsKind };
