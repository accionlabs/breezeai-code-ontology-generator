/**
 * Regression test for function/method `returnType` capture across languages.
 * Covers BREEZEAI-698: returnType must be populated for Python, Java, C#, Go,
 * PHP, Salesforce (Apex) and VB.NET; null for untyped/void/constructors; and
 * absent (N/A) for Perl.
 *
 * Run: node test/extract-return-type.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

// Write `content` to a temp file named `name` and pass its path to `fn`.
// Cleans up after `fn` resolves, so async extractors (Perl) finish reading first.
function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "returntype-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(file, dir);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result && typeof result.then === "function") {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

const find = (fns, name) => fns.find((f) => f.name === name);
const rt = (fns, name) => (find(fns, name) || {}).returnType;

async function main() {
  // ---------------------------------------------------------------- Python ----
  {
    const { extractFunctionsAndCalls } = require("../python/extract-functions-python");
    withTempFile("a.py", "def f(x) -> int:\n    return x\ndef g(x):\n    return x\n", (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, null, false, false);
      check("python: annotated return -> 'int'", rt(fns, "f") === "int");
      check("python: unannotated -> null", rt(fns, "g") === null);
    });
  }

  // ------------------------------------------------------------------ Java ----
  {
    const { extractFunctionsAndCalls } = require("../java/extract-functions-java");
    withTempFile("A.java", `class A { String foo(){return "";} A(){} void bar(){} }`, (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, {}, false, false);
      check("java: method -> 'String'", rt(fns, "foo") === "String");
      check("java: constructor -> null", rt(fns, "A") === null);
      check("java: void -> 'void'", rt(fns, "bar") === "void");
    });
  }

  // -------------------------------------------------------------------- C# ----
  {
    const { extractFunctionsAndCalls } = require("../csharp/extract-functions-csharp");
    withTempFile("a.cs", `class X { public int Foo() { int Bar() { return 1; } return Bar(); } public X(){} }`, (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, {}, false, false);
      check("csharp: method -> 'int'", rt(fns, "Foo") === "int");
      // Regression: local_function_statement uses field `type`, not `returns`.
      check("csharp: local function -> 'int'", rt(fns, "Bar") === "int");
      check("csharp: constructor -> null", rt(fns, "X") === null);
    });
  }

  // -------------------------------------------------------------------- Go ----
  {
    const { extractFunctionsAndCalls } = require("../golang/extract-functions-golang");
    withTempFile("a.go", "package m\nfunc a()(int,error){return 0,nil}\nfunc b(){}\n", (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, null, false, false);
      check("go: multiple returns -> '(int,error)'", rt(fns, "a") === "(int,error)");
      check("go: no return -> null", rt(fns, "b") === null);
    });
  }

  // ------------------------------------------------------------------- PHP ----
  {
    const { extractFunctionsAndCalls } = require("../php/extract-functions-php");
    withTempFile("a.php", `<?php class A{ function f(): ?int {return 1;} function g(){} }`, (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, {}, false, false);
      check("php: nullable hint -> '?int'", rt(fns, "f") === "?int");
      check("php: no hint -> null", rt(fns, "g") === null);
    });
  }

  // ------------------------------------------------------------ Salesforce ----
  {
    const { extractFunctionsAndCalls } = require("../salesforce/extract-functions-salesforce");
    withTempFile("a.cls", `public class A{ public String foo(){return "";} public A(){} public void bar(){} }`, (file, dir) => {
      // Apex signature: (file, repo, classIndex, references, captureSource, captureStatements)
      const fns = extractFunctionsAndCalls(file, dir, {}, null, false, false);
      check("apex: method -> 'String'", rt(fns, "foo") === "String");
      check("apex: constructor -> null", rt(fns, "A") === null);
      check("apex: void -> 'void'", rt(fns, "bar") === "void");
    });
  }

  // -------------------------------------------------- VB.NET (tree-sitter) ----
  {
    const { extractFunctionsAndCalls } = require("../vbnet/extract-functions-vbnet");
    const src = `Public Class A
Public Function Foo() As Integer
End Function
Public Sub Bar()
End Sub
Public Property Name As String
Public Function Qual() As System.Collections.Generic.List(Of String)
End Function
End Class`;
    withTempFile("a.vb", src, (file, dir) => {
      const fns = extractFunctionsAndCalls(file, dir, {}, false, false);
      check("vbnet ts: Function -> 'Integer'", rt(fns, "Foo") === "Integer");
      check("vbnet ts: Sub -> null", rt(fns, "Bar") === null);
      // Hardening: properties expose the type via a nested as_clause.
      check("vbnet ts: Property -> 'String'", rt(fns, "Name") === "String");
      // Hardening: generic return types must not be truncated before the ')'.
      check(
        "vbnet ts: generic not truncated",
        rt(fns, "Qual") === "System.Collections.Generic.List(Of String)"
      );
    });
  }

  // --------------------------------------------------------- VB.NET (regex) ----
  {
    const { analyzeVBNetFileWithRegex } = require("../vbnet/regex-parser-vbnet");
    // NOTE: the auto-property is placed last on purpose. The regex parser treats
    // a bodyless `Property X As T` as consuming following lines, so a Sub right
    // after it would be dropped (a pre-existing parser quirk, unrelated to 698).
    const src = `Public Class A
Public Sub Bar()
End Sub
Public Function Qual() As System.Collections.Generic.List(Of String)
End Function
Public Function Impl() As Integer Implements IFoo.Impl
End Function
Public Property Name As String
End Class`;
    withTempFile("b.vb", src, (file, dir) => {
      const fns = analyzeVBNetFileWithRegex(file, dir, false).functions || [];
      check(
        "vbnet regex: full generic captured",
        rt(fns, "Qual") === "System.Collections.Generic.List(Of String)"
      );
      check("vbnet regex: Implements stripped -> 'Integer'", rt(fns, "Impl") === "Integer");
      check("vbnet regex: Property -> 'String'", rt(fns, "Name") === "String");
      check("vbnet regex: Sub -> null", rt(fns, "Bar") === null);
    });
  }

  // ------------------------------------------------------------------ Perl ----
  {
    const { extractFunctionsAndCalls } = require("../perl/extract-functions-perl");
    await withTempFile("a.pl", "sub greet {\n    my $name = shift;\n    return \"hi $name\";\n}\n", async (file, dir) => {
      const fns = await extractFunctionsAndCalls(file, dir, null, false, false);
      // Perl is dynamically typed: returnType is N/A and must not be set.
      check("perl: returnType is N/A (unset)", !("returnType" in (find(fns, "greet") || {})));
    });
  }

  console.log(`\n✅ All ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
