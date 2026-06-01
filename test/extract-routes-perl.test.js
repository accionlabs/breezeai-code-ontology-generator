/**
 * Regression test for the Perl web-route extractor.
 * Covers Dancer/Dancer2, Mojolicious (Lite + routes object), and Catalyst.
 * Run: node test/extract-routes-perl.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../perl/extract-routes-perl");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function tmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perlroutes-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const find = (routes, p) => routes.find((r) => r.path === p);

async function main() {
  // ----------------------------------------------------------- Dancer ----
  {
    const { file, cleanup } = tmp("dancer.pl", `use Dancer2;
get '/users' => sub { return "ok"; };
post '/users' => sub { };
put '/users/:id' => sub { };
del '/del/:id' => sub { };
any '/wildcard' => sub { };`);
    const r = await extractFileRoutes(file);
    cleanup();
    check("dancer: 5 routes", r.length === 5);
    check("dancer: framework + file-scoped", r.every((x) => x.framework === "dancer" && x.scope === "file"));
    check("dancer: GET path", find(r, "/users").method === "GET");
    check("dancer: del -> DELETE", find(r, "/del/:id").method === "DELETE");
    check("dancer: any -> ANY", find(r, "/wildcard").method === "ANY");
  }

  // ------------------------------------------------------- Mojolicious ----
  {
    const { file, cleanup } = tmp("mojo.pl", `use Mojolicious::Lite;
get '/lite' => sub { };
my $r = app->routes;
$r->get('/mojo')->to('controller#action');
$r->post('/submit')->to('form#submit');
$r->websocket('/ws')->to('ws#stream');`);
    const r = await extractFileRoutes(file);
    cleanup();
    check("mojo: framework", r.every((x) => x.framework === "mojolicious"));
    check("mojo: Lite DSL route", find(r, "/lite").method === "GET");
    check("mojo: routes-object + ->to handler", find(r, "/mojo").handler === "controller#action");
    check("mojo: POST ->to", find(r, "/submit").handler === "form#submit");
    check("mojo: websocket -> ws kind", find(r, "/ws").kind === "ws" && find(r, "/ws").method === "WEBSOCKET");
  }

  // ------------------------- Mojo client-call exclusion (real-repo finding) ----
  // $ua->get / $t->get (UserAgent / Test::Mojo) share method names with the
  // router but are NOT routes.
  {
    const { file, cleanup } = tmp("client.pl", `use Mojolicious::Lite;
my $r = app->routes;
$r->get('/real')->to('a#b');
my $ua = Mojo::UserAgent->new;
$ua->get('/client-call');
$t->get('/test-call');`);
    const r = await extractFileRoutes(file);
    cleanup();
    check("mojo: real router route kept", find(r, "/real") != null);
    check("mojo: $ua->get NOT a route", !find(r, "/client-call"));
    check("mojo: $t->get NOT a route", !find(r, "/test-call"));
    check("mojo: only the router route", r.length === 1);
  }

  // ---------------------------------------------------------- Catalyst ----
  {
    const { file, cleanup } = tmp("Root.pm", `package MyApp::Controller::Root;
use Moose;
BEGIN { extends 'Catalyst::Controller'; }
sub list :Path('/items') :Args(0) { }
sub view :Local { }
sub home :Global { }
sub base :Chained('/') :PathPart('shop') :Args(0) { }`);
    const r = await extractFileRoutes(file);
    cleanup();
    check("catalyst: 4 routes", r.length === 4);
    check("catalyst: framework + function-scoped", r.every((x) => x.framework === "catalyst" && x.scope === "function"));
    check("catalyst: :Path value", find(r, "/items").handler === "list");
    check("catalyst: :Local -> sub name path", find(r, "view") != null);
    check("catalyst: :Global -> /name", find(r, "/home") != null);
    check("catalyst: :Chained -> chained kind", find(r, "shop").kind === "chained");
  }

  // --------------------------------------------------- plain Perl file ----
  {
    const { file, cleanup } = tmp("plain.pl", `use strict;
sub add { my ($a, $b) = @_; return $a + $b; }
get_config('key');`);
    const r = await extractFileRoutes(file);
    cleanup();
    check("plain perl: no routes (no framework import)", r.length === 0);
  }

  console.log(`\n✅ All ${passed} assertions passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
