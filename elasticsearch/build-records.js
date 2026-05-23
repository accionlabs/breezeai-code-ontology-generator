/**
 * Turn a set of uploaded Elasticsearch JSON files into NDJSON-ready
 * records for the ontology graph ingest pipeline.
 *
 * Inputs:
 *   uploads — array of { name, text } objects, where `name` is the
 *             original filename (used for record `path`) and `text` is the
 *             raw file contents. Files may be a mapping JSON, a settings
 *             JSON, or any mix; multiple files of either kind are merged
 *             by indexName.
 *
 * Outputs (either thrown as `BuildError` or returned in the result):
 *   {
 *     records:         the NDJSON rows ready for S3,
 *     kind:            'mapping' | 'settings-only',
 *     mapping:         { name } | null,          // first mapping (back-compat)
 *     setting:         { name } | null,          // first setting (back-compat)
 *     mappings:        Array<{ name }>,          // every mapping uploaded
 *     settings:        Array<{ name }>,          // every setting uploaded
 *     indexCount:      number of indices across all mappings,
 *     fieldCount:      total fields across all mappings,
 *     settingsMatched: number of indices that picked up settings
 *   }
 *
 * Record shapes:
 *   - With a mapping (settings, if uploaded, are merged in):
 *       { __type: 'es_index',   path, indexName,
 *         shards, replicas, defaultAnalyzer, aliases, fields }
 *   - Settings-only:
 *       { __type: 'es_settings', path, indexName,
 *         shards, replicas, defaultAnalyzer }
 */

'use strict';

const { sniffEsKind } = require('./detect-es-kind');
const { parseESMappingFile } = require('./extract-es-mapping');
const { parseESSettingFile } = require('./extract-es-setting');

class BuildError extends Error {
    constructor(message, statusCode = 422) {
        super(message);
        this.name = 'BuildError';
        this.statusCode = statusCode;
    }
}

/**
 * Sniff each upload by content and bucket it into mapping or setting.
 * Multiple files of either kind are accepted and merged downstream by
 * indexName. Files that cannot be classified produce a 422 BuildError.
 */
function classifyUploads(uploads) {
    const mappings = [];
    const settings = [];

    for (const u of uploads) {
        const kind = sniffEsKind(u.text);
        if (kind === 'mapping') mappings.push(u);
        else if (kind === 'setting') settings.push(u);
        else {
            throw new BuildError(
                `Could not determine whether ${u.name} is a mapping or setting JSON`,
            );
        }
    }

    return { mappings, settings };
}

/**
 * Parse every mapping file and concatenate the resulting per-index entries.
 * Each entry tags its source file path so downstream records can attribute
 * the index back to the upload it came from.
 */
function parseMappingsOrThrow(mappings) {
    const out = [];
    for (const m of mappings) {
        let indices;
        try {
            indices = parseESMappingFile(m.text, m.name);
        } catch (err) {
            throw new BuildError(err.message);
        }
        for (const idx of indices) {
            out.push({ ...idx, sourcePath: m.name });
        }
    }
    return out;
}

/**
 * Parse every setting file and merge into a single Map keyed by indexName.
 * Later files win on conflicts. When at least one mapping is also present,
 * settings parse errors are non-fatal — the mapping is enough to populate
 * the graph. With settings-only uploads, parse errors bubble up.
 */
function parseSettingsOrThrow(settings, hasMapping) {
    const merged = new Map();
    for (const s of settings) {
        let parsed;
        try {
            parsed = parseESSettingFile(s.text, s.name);
        } catch (err) {
            if (!hasMapping) throw new BuildError(err.message);
            continue;
        }
        for (const [indexName, picked] of parsed.entries()) {
            merged.set(indexName, { ...picked, sourcePath: s.name });
        }
    }
    return merged;
}

function buildMappingRecords(indices, settingsByIndex) {
    return indices.map((idx) => {
        const s = settingsByIndex.get(idx.indexName) || {};
        return {
            __type: 'es_index',
            path: idx.sourcePath,
            indexName: idx.indexName,
            shards: s.shards || null,
            replicas: s.replicas || null,
            defaultAnalyzer: s.defaultAnalyzer || null,
            aliases: idx.aliases,
            fields: idx.fields,
        };
    });
}

function buildSettingRecords(settingsByIndex) {
    const out = [];
    for (const [indexName, s] of settingsByIndex.entries()) {
        out.push({
            __type: 'es_settings',
            path: s.sourcePath,
            indexName,
            shards: s.shards || null,
            replicas: s.replicas || null,
            defaultAnalyzer: s.defaultAnalyzer || null,
        });
    }
    return out;
}

/**
 * Top-level orchestrator.
 *
 * @param {Array<{name: string, text: string, slotHint?: string}>} uploads
 * @returns {object} build result described in the module header
 * @throws {BuildError} when the inputs cannot be turned into records
 */
function buildEsRecords(uploads) {
    if (!uploads || uploads.length === 0) {
        throw new BuildError("At least one ES JSON file is required", 400);
    }

    const { mappings, settings } = classifyUploads(uploads);
    if (mappings.length === 0 && settings.length === 0) {
        throw new BuildError("No valid Elasticsearch mapping or setting JSON could be classified");
    }

    const indices = parseMappingsOrThrow(mappings);
    const settingsByIndex = parseSettingsOrThrow(settings, mappings.length > 0);

    const records = mappings.length > 0
        ? buildMappingRecords(indices, settingsByIndex)
        : buildSettingRecords(settingsByIndex);

    if (records.length === 0) {
        throw new BuildError("No Elasticsearch indices could be extracted from the uploaded file(s)");
    }

    // For result reporting, surface the first mapping/setting name (kept for
    // backwards-compat with callers that read `build.mapping.name`).
    const primaryMapping = mappings[0] ? { name: mappings[0].name } : null;
    const primarySetting = settings[0] ? { name: settings[0].name } : null;

    return {
        records,
        kind: mappings.length > 0 ? 'mapping' : 'settings-only',
        mapping: primaryMapping,
        setting: primarySetting,
        mappings: mappings.map((m) => ({ name: m.name })),
        settings: settings.map((s) => ({ name: s.name })),
        indexCount: indices.length,
        fieldCount: indices.reduce((n, i) => n + i.fields.length, 0),
        settingsMatched: settingsByIndex.size,
    };
}

module.exports = { buildEsRecords, BuildError };
