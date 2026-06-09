/**
 * Regression test for the TS/JS capture gaps closed in BREEZEAI-690:
 *   - .mts/.cts/.mjs/.cjs module files are scanned (language detection)
 *   - parameter decorators (@Param/@Body/@Query) captured on function params
 *   - JS class fields captured as field_definition (with name)
 *   - api_call collected at file scope (not just method scope)
 * Run: node test/ts-js-capture.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { extractFunctionsAndCalls, extractFileStatements } = require("../typescript/extract-functions-typescript");
const { extractClasses } = require("../nodejs/extract-classes-nodejs");
const {
  extractFileStatements: jsFileStatements,
} = require("../nodejs/extract-functions-nodejs");
const { detectLanguages } = require("../main");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsjs-cap-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------------- .mts / .cjs module files are scanned ----
withTempDir({ "worker.mts": "export const x = 1;\n" }, (dir) => {
  const langs = detectLanguages(dir);
  check(".mts detected as TypeScript", langs.some((l) => l.key === "typescript"));
});
withTempDir({ "legacy.cjs": "module.exports = {};\n" }, (dir) => {
  const langs = detectLanguages(dir);
  check(".cjs detected as JavaScript", langs.some((l) => l.key === "javascript"));
});

// ----------------------------------------- parameter decorators captured ----
withTempDir({
  "ctrl.ts": `
class C {
  detail(@Param('id') id: number, @Body() dto: AddProjectDto, @Query('q') q?: string) {}
}
`,
}, (dir) => {
  const fns = extractFunctionsAndCalls(path.join(dir, "ctrl.ts"), dir, false, false);
  const detail = fns.find((f) => f.name === "detail");
  const byName = (n) => detail.params.find((p) => p.name === n);
  check("param @Param captured with arg", byName("id").decorators[0].name === "Param" &&
    byName("id").decorators[0].args[0] === "id");
  check("param @Body captured, no args", byName("dto").decorators[0].name === "Body" &&
    byName("dto").decorators[0].args.length === 0);
  check("param @Body type -> DTO", byName("dto").type === "AddProjectDto");
  check("param @Query captured", byName("q").decorators[0].name === "Query");
});

// undecorated params carry no `decorators` key (additive — only when present)
withTempDir({ "plain.ts": `function f(a: number, b: string) { return a; }` }, (dir) => {
  const fns = extractFunctionsAndCalls(path.join(dir, "plain.ts"), dir, false, false);
  const f = fns.find((x) => x.name === "f");
  check("undecorated params have no decorators key", f.params.every((p) => !("decorators" in p)));
});

// namespaced (member-expression) param decorators keep their full qualifier
// (LoopBack @param.path.string / @param.query.number, not just "string"/"number")
withTempDir({
  "lb.ts": `
class C {
  m(@param.path.string('id') id: string, @param.query.number('limit') limit: number, @requestBody() body: Dto) {}
}
`,
}, (dir) => {
  const fns = extractFunctionsAndCalls(path.join(dir, "lb.ts"), dir, false, false);
  const m = fns.find((f) => f.name === "m");
  const dec = (n) => m.params.find((p) => p.name === n).decorators[0];
  check("namespaced @param.path.string keeps qualifier", dec("id").name === "param.path.string" && dec("id").args[0] === "id");
  check("namespaced @param.query.number keeps qualifier", dec("limit").name === "param.query.number");
  check("plain @requestBody identifier unchanged", dec("body").name === "requestBody");
});

// -------------------------------------- JS class field_definition capture ----
withTempDir({
  "widget.js": `
class Widget {
  count = 0;
  label = 'hi';
  render() { return this.count; }
}
`,
}, (dir) => {
  const classes = extractClasses(path.join(dir, "widget.js"), dir, true);
  const w = classes.find((c) => c.name === "Widget");
  const fields = (w.statements || []).filter((s) => s.type === "field_definition");
  check("JS class fields captured as field_definition", fields.length === 2);
  check("field_definition has name (count)", fields.some((s) => s.name === "count"));
  check("field_definition has name (label)", fields.some((s) => s.name === "label"));
});

// ------------------------------------------- api_call at file scope (TS) ----
withTempDir({
  "client.ts": `
import axios from 'axios';
axios.get('/top-level');
function inside() { return axios.post('/in-fn'); }
`,
}, (dir) => {
  const stmts = extractFileStatements(path.join(dir, "client.ts"));
  const apis = stmts.filter((s) => s.type === "api_call");
  check("TS file-scope api_call captured", apis.some((s) => s.endpoint === "/top-level" && s.method === "GET"));
});

// ------------------------------------------- api_call at file scope (JS) ----
withTempDir({
  "client.js": `
const axios = require('axios');
axios.delete('/top-level-js');
`,
}, (dir) => {
  const stmts = jsFileStatements(path.join(dir, "client.js"));
  const apis = stmts.filter((s) => s.type === "api_call");
  check("JS file-scope api_call captured", apis.some((s) => s.endpoint === "/top-level-js" && s.method === "DELETE"));
});

console.log(`\n✅ All ${passed} assertions passed.`);
