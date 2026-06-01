/**
 * Regression test for the PHP web-route extractor.
 * Covers Laravel (facade calls + resource), Symfony (#[Route] attributes),
 * and Drupal/Symfony YAML routing files.
 * Run: node test/extract-routes-php.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes, extractYamlRoutes } = require("../php/extract-routes-php");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phproutes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const findAll = (routes, p) => routes.filter((r) => r.path === p);
const find = (routes, p) => routes.find((r) => r.path === p);

// ---------------------------------------------------------------- Laravel ----
withTempFile("web.php", `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', 'UserController@store');
Route::match(['get', 'post'], '/search', [SearchController::class, 'run']);
Route::resource('photos', PhotoController::class);
Route::apiResource('comments', CommentController::class);
Route::view('/welcome', 'welcome');
`, (file) => {
  const r = extractFileRoutes(file);
  check("laravel: framework", r.every((x) => x.framework === "laravel"));
  check("laravel: array action -> Ctrl@method", find(r, "/users").handler === "UserController@index");
  check("laravel: string action preserved",
    findAll(r, "/users").some((x) => x.handler === "UserController@store"));
  check("laravel: match -> joined methods", find(r, "/search").method === "GET,POST");
  check("laravel: resource expands to 7", r.filter((x) => x.handler && x.handler.startsWith("PhotoController@")).length === 7);
  check("laravel: resource show path + param", find(r, "/photos/{photo}") &&
    r.some((x) => x.path === "/photos/{photo}" && x.handler === "PhotoController@show"));
  check("laravel: resource update PUT,PATCH",
    r.some((x) => x.path === "/photos/{photo}" && x.method === "PUT,PATCH"));
  check("laravel: apiResource expands to 5 (no create/edit)",
    r.filter((x) => x.handler && x.handler.startsWith("CommentController@")).length === 5);
  check("laravel: apiResource omits create/edit",
    !r.some((x) => x.handler === "CommentController@create" || x.handler === "CommentController@edit"));
  check("laravel: view route", find(r, "/welcome").kind === "view");
});

// ---------------------------------------------------------------- Symfony ----
withTempFile("ApiController.php", `<?php
namespace App\\Controller;
use Symfony\\Component\\Routing\\Annotation\\Route;

#[Route('/api', name: 'api_')]
class ApiController {
    #[Route('/list', methods: ['GET'])]
    public function list() {}

    #[Route('/create', methods: ['POST', 'PUT'])]
    public function create() {}
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("symfony: 2 routes", r.length === 2);
  check("symfony: framework", r.every((x) => x.framework === "symfony"));
  check("symfony: class base + method path composed", find(r, "/api/list").method === "GET");
  check("symfony: methods array joined", find(r, "/api/create").method === "POST,PUT");
  check("symfony: function-scoped with handler",
    find(r, "/api/list").scope === "function" && find(r, "/api/list").handler === "list");
});

// ----------------------------------------------------------- Drupal YAML ----
withTempFile("mymodule.routing.yml", `mymodule.content:
  path: '/mypage'
  defaults:
    _controller: '\\Drupal\\mymodule\\Controller\\MyController::content'
  methods: [GET]
mymodule.form:
  path: '/mypage/add'
  defaults:
    _form: '\\Drupal\\mymodule\\Form\\AddForm'
`, (file) => {
  const r = extractYamlRoutes(file);
  check("drupal yaml: 2 routes", r.length === 2);
  check("drupal yaml: framework", r.every((x) => x.framework === "drupal"));
  check("drupal yaml: _controller handler", find(r, "/mypage").handler.endsWith("MyController::content"));
  check("drupal yaml: methods", find(r, "/mypage").method === "GET");
  check("drupal yaml: _form fallback handler", find(r, "/mypage/add").handler.endsWith("AddForm"));
  check("drupal yaml: distinct line numbers",
    find(r, "/mypage").startLine !== find(r, "/mypage/add").startLine);
});

// ---------------------------------------------------------- Symfony YAML ----
withTempFile("routes.yaml", `app_home:
  path: /home
  controller: App\\Controller\\HomeController::index
  methods: [GET, POST]
app_about:
  path: /about
  controller: App\\Controller\\AboutController
`, (file) => {
  const r = extractYamlRoutes(file);
  check("symfony yaml: 2 routes", r.length === 2);
  check("symfony yaml: framework", r.every((x) => x.framework === "symfony"));
  check("symfony yaml: controller + methods", find(r, "/home").method === "GET,POST" &&
    find(r, "/home").handler === "App\\Controller\\HomeController::index");
});

console.log(`\n✅ All ${passed} assertions passed.`);
