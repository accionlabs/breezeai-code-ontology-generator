/**
 * Regression test for the Node.js / TypeScript web-route extractor.
 * Covers Express, Fastify, Koa, and NestJS (HTTP + GraphQL + WS + message).
 * Run: node test/extract-routes-js.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes: jsRoutes } = require("../nodejs/extract-routes-nodejs");
const { extractFileRoutes: tsRoutes } = require("../typescript/extract-routes-typescript");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsroutes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (routes, p) => routes.find((r) => r.path === p);

// --------------------------------------------------------------- Express ----
withTempFile("server.js", `
const express = require('express');
const app = express();
const router = express.Router();
app.get('/health', (req, res) => res.send('ok'));
router.post('/login', loginHandler);
router.delete('/users/:id', removeHandler);
app.all('/wildcard', h);
app.use('/api', router);
const cache = new Map();
cache.get('not-a-route');
`, (file) => {
  const r = jsRoutes(file);
  check("express: 5 routes (mount incl.)", r.length === 5);
  check("express: framework", r.every((x) => x.framework === "express"));
  check("express: GET path", find(r, "/health").method === "GET");
  check("express: param path", find(r, "/users/:id").method === "DELETE");
  check("express: .all -> ANY", find(r, "/wildcard").method === "ANY");
  check("express: .use -> mount", find(r, "/api").kind === "mount");
  check("express: cache.get('key') NOT a route", !r.some((x) => x.path === "not-a-route"));
  check("express: call routes file-scoped", r.every((x) => x.scope === "file"));
});

// --------------------------------------------------------------- Fastify ----
withTempFile("app.js", `
const fastify = require('fastify')();
fastify.get('/ping', async () => 'pong');
fastify.route({ method: 'POST', url: '/submit', handler: onSubmit });
`, (file) => {
  const r = jsRoutes(file);
  check("fastify: 2 routes", r.length === 2);
  check("fastify: framework", r.every((x) => x.framework === "fastify"));
  check("fastify: .route object url+method", find(r, "/submit").method === "POST");
});

// -------------------------------------------------- false-positive guard ----
withTempFile("util.js", `
const cache = new Map();
function f() { cache.get('x'); store.post('y'); }
`, (file) => {
  // no express/fastify/koa import -> call-based detection disabled
  check("no framework import: no routes", jsRoutes(file).length === 0);
});

// ----------------------------------------------------------- NestJS HTTP ----
withTempFile("users.controller.ts", `
import { Controller, Get, Post, Delete } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne() {}
  @Post()
  create() {}
  @Delete(':id')
  remove() {}
}
`, (file) => {
  const r = tsRoutes(file);
  check("nest http: 3 routes", r.length === 3);
  check("nest http: framework", r.every((x) => x.framework === "nestjs"));
  check("nest http: controller base composed", find(r, "users/:id").method === "GET");
  check("nest http: @Post no-arg uses base", find(r, "users").method === "POST");
  check("nest http: function-scoped w/ handler", find(r, "users/:id").scope === "function" &&
    find(r, "users/:id").handler === "findOne");
});

// ----------------------------------------------- NestJS GraphQL/WS/message ----
withTempFile("cats.resolver.ts", `
import { Resolver, Query, Mutation, ResolveField } from '@nestjs/graphql';
import { SubscribeMessage } from '@nestjs/websockets';
import { MessagePattern, EventPattern } from '@nestjs/microservices';
@Resolver(() => Cat)
export class CatsResolver {
  @Query(() => [Cat], { name: 'cats' })
  findAll() {}
  @Mutation(() => Cat)
  createCat() {}
  @ResolveField()
  owner() {}
  @SubscribeMessage('message')
  handleMessage() {}
  @MessagePattern({ cmd: 'sum' })
  accumulate() {}
  @EventPattern('user_created')
  handleUserCreated() {}
}
`, (file) => {
  const r = tsRoutes(file);
  check("nest patterns: 6 routes", r.length === 6);
  check("nest graphql: @Query name option", find(r, "cats").kind === "graphql" &&
    find(r, "cats").method === "QUERY");
  check("nest graphql: @Mutation defaults to method name", find(r, "createCat").kind === "graphql");
  check("nest graphql: @ResolveField", r.some((x) => x.method === "RESOLVE_FIELD"));
  check("nest ws: @SubscribeMessage", find(r, "message").kind === "ws");
  check("nest message: @MessagePattern", r.some((x) => x.kind === "message" && x.method === "MESSAGE"));
  check("nest message: @EventPattern", find(r, "user_created").method === "EVENT");
  check("nest patterns: all function-scoped", r.every((x) => x.scope === "function" && x.handler));
});

// ------------------------------ custom decorator framework (no @nestjs) ----
// Real codebases define their own @Controller/@Get (e.g. a homegrown core.ts).
// These should still be detected (tagged "nestjs-like"), but GraphQL/WS/message
// patterns must NOT fire without a real @nestjs import.
withTempFile("user.controller.ts", `
import { Controller, Get, Post, Put } from './core';
import { Query } from './core';

@Controller('/users')
export default class UserController {
  @Post('/login', LoginDto, { auth: true })
  login() {}
  @Get('/by-api-key', { auth: false })
  getByApiKey() {}
  @Put('/:id/role', UpdateDto, { auth: true })
  updateRole() {}
  @Query()
  notARealGraphqlRoute() {}
}
`, (file) => {
  const r = tsRoutes(file);
  check("custom fw: 3 HTTP routes detected (no @nestjs import)", r.length === 3);
  check("custom fw: tagged nestjs-like", r.every((x) => x.framework === "nestjs-like"));
  check("custom fw: @Controller base composed", find(r, "/users/by-api-key").method === "GET");
  check("custom fw: handler + function scope",
    find(r, "/users/login").handler === "login" && find(r, "/users/login").scope === "function");
  check("custom fw: @Query NOT treated as route without @nestjs import",
    !r.some((x) => x.kind === "graphql"));
});

// ----------------------------------------------- Vue Router (frontend) ------
// Page-routes (path -> component), nested children composed, lazy imports.
withTempFile("router.ts", `
import { createRouter, createWebHistory } from 'vue-router'
import Home from './Home.vue'
const routes = [
  { path: '/', name: 'home', component: Home },
  { path: '/users/:id', component: () => import('./User.vue') },
  { path: '/admin', component: Admin, children: [
    { path: 'settings', name: 'admin-settings', component: () => import('./Settings.vue') },
    { path: '', component: Dashboard },
  ]},
]
const router = createRouter({ history: createWebHistory(), routes })
`, (file) => {
  const r = tsRoutes(file);
  check("vue-router: 5 page-routes", r.length === 5);
  check("vue-router: framework + kind page + method VIEW",
    r.every((x) => x.framework === "vue-router" && x.kind === "page" && x.method === "VIEW"));
  check("vue-router: component handler", find(r, "/").handler === "Home");
  check("vue-router: lazy import -> component basename", find(r, "/users/:id").handler === "User.vue");
  check("vue-router: nested children path-composed", find(r, "/admin/settings") != null);
  check("vue-router: empty child path -> parent path", find(r, "/admin").handler != null &&
    r.filter((x) => x.path === "/admin").length === 2); // parent + index child
  check("vue-router: route name captured", find(r, "/admin/settings").decorator === "admin-settings");
});

withTempFile("not-router.ts", `const routes = [{ path: '/x', component: Foo }]`, (file) => {
  check("vue-router: no vue-router import -> not detected", tsRoutes(file).length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
