// Exercise the real authenticated API boundary used by both MCP transports and sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'routine-mutations-test';
const token = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
async function server(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-routine-mutations-'));
  fs.writeFileSync(path.join(dir, 'secret'), SECRET);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  let log = '';
  child.stdout.on('data', data => log += data);
  child.stderr.on('data', data => log += data);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  const request = async (endpoint, body, uid = 'one', method = 'POST') => {
    const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { Authorization: `Bearer ${token(uid)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  return { dir, request, file: path.join(dir, 'state-one.json'), api: `http://127.0.0.1:${port}` };
}
const initial = () => ({ _rev: 4, _ts: 100, resetAt: 50, resetIds: { routines: ['gone'] }, routines: [{ id: 'old', name: 'Existing', ex: [{ id: '0001', sets: 3, reps: 8 }] }], workouts: [{ id: 'w1' }], week: { 1: ['old'] } });

test('paired routine operations and browser sync share revisions, reset rules, cache eviction and profile isolation', async t => {
  const h = await server(t);
  fs.writeFileSync(h.file, JSON.stringify(initial()));
  // Populate the revision cache before the mutation.
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, 4);
  const edit = { operation: 'edit', baseRev: 4, input: { routine_id: 'old', name: 'Renamed' } };
  assert.equal((await fetch(h.api + '/api/routines/mutate', { method: 'POST' })).status, 401);
  assert.equal((await h.request('/api/routines/mutate', { ...edit, baseRev: undefined })).status, 400);
  assert.equal((await h.request('/api/routines/mutate', { ...edit, baseRev: '4' })).status, 400);
  // A different profile cannot select 'one' through arguments; it has no such routine.
  assert.equal((await h.request('/api/routines/mutate', { ...edit, baseRev: 0, uid: 'one' }, 'two')).status, 404);
  const saved = await h.request('/api/routines/mutate', edit);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rev, 5);
  const current = JSON.parse(fs.readFileSync(h.file));
  assert.equal(current.routines[0].name, 'Renamed');
  assert.deepEqual(current.workouts, initial().workouts);
  assert.equal(current.resetAt, 50);
  assert.ok(current._ts > 100);
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, 5);
  const conflict = await h.request('/api/data', { state: initial(), baseRev: 4 }, 'one', 'PUT');
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.state, current);
  assert.equal((await h.request('/api/data', { state: { ...current, resetAt: 1, resetIds: {}, active: { id: 'local' } }, baseRev: 5 }, 'one', 'PUT')).status, 200);
  const stale = await h.request('/api/routines/mutate', { operation: 'delete', baseRev: 5, input: { routine_id: 'old', confirm: true } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 6);
  assert.equal(stale.body.state.resetAt, 50);
  assert.equal('active' in stale.body.state, false);
  assert.equal((await h.request('/api/routines/mutate', { operation: 'delete', baseRev: 6, input: { routine_id: 'old', confirm: true } })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file)).week, {});
});

test('invalid operations and a lock held by another writer never partially commit', async t => {
  const h = await server(t);
  fs.writeFileSync(h.file, JSON.stringify(initial()));
  const before = fs.readFileSync(h.file, 'utf8');
  for (const body of [
    { operation: 'delete', input: { routine_id: 'old' } },
    { operation: 'edit', input: { routine_id: 'old', name: 'Bad', exercises: [{ id: 'unknown', sets: 3, reps: 8 }] } },
    { operation: 'create', input: { routines: [{ name: 'Bad', exercises: [{ id: '0001', sets: 3, reps: '8' }] }] } },
    { operation: 'other', input: {} }
  ]) assert.equal((await h.request('/api/routines/mutate', { ...body, baseRev: 4 })).status, 400);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  fs.writeFileSync(h.file + '.lock', 'another process');
  assert.equal((await h.request('/api/routines/mutate', { operation: 'delete', baseRev: 4, input: { routine_id: 'old', confirm: true } })).status, 503);
  assert.equal((await h.request('/api/data', { state: initial(), baseRev: 4 }, 'one', 'PUT')).status, 503);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  fs.unlinkSync(h.file + '.lock');
});

test('two plan creates confirmed at the same revision commit exactly once', async t => {
  const h = await server(t);
  fs.writeFileSync(h.file, JSON.stringify(initial()));
  const create = name => ({ operation: 'create', baseRev: 4, input: {
    routines: [{ name, exercises: [{ id: '0001', sets: 3, reps: 8 }] }]
  } });
  const responses = await Promise.all(['Plan A', 'Plan B'].map(name => h.request('/api/routines/mutate', create(name))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const saved = responses.find(r => r.status === 200).body;
  const refused = responses.find(r => r.status === 409).body;
  const current = (await h.request('/api/data', undefined, 'one', 'GET')).body;
  assert.equal(current.rev, 5);
  assert.equal(current.state.routines.length, 2);
  assert.equal(current.state.routines[1].id, saved.created_routines[0].id);
  assert.equal(current.state.routines[1].name, saved.created_routines[0].name);
  assert.deepEqual(current.state.workouts, initial().workouts);
  assert.equal(refused.rev, current.rev);
  assert.deepEqual(refused.state, current.state);
});

test('phone sync and a routine edit share one compare-and-write boundary', async t => {
  const h = await server(t);
  fs.writeFileSync(h.file, JSON.stringify(initial()));
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, 4);
  const phone = { ...initial(), workouts: [...initial().workouts, { id: 'phone-workout', entries: [] }] };
  const [synced, edited] = await Promise.all([
    h.request('/api/data', { state: phone, baseRev: 4 }, 'one', 'PUT'),
    h.request('/api/routines/mutate', { operation: 'edit', baseRev: 4, input: { routine_id: 'old', name: 'MCP edit' } })
  ]);
  assert.deepEqual([synced.status, edited.status].sort(), [200, 409]);
  const current = (await h.request('/api/data', undefined, 'one', 'GET')).body;
  assert.equal(current.rev, 5);
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, current.rev);
  // Either caller may win. The other gets the complete winning state, never a silent overwrite.
  assert.equal(current.state.routines[0].name, edited.status === 200 ? 'MCP edit' : 'Existing');
  assert.deepEqual(current.state.workouts, synced.status === 200 ? phone.workouts : initial().workouts);
  const conflict = (synced.status === 409 ? synced : edited).body;
  assert.equal(conflict.rev, current.rev);
  assert.deepEqual(conflict.state, current.state);
});

test('one invalid routine refuses the entire plan and leaves the confirmed revision usable', async t => {
  const h = await server(t);
  fs.writeFileSync(h.file, JSON.stringify(initial()));
  const before = fs.readFileSync(h.file, 'utf8');
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, 4);
  const valid = { name: 'Valid', exercises: [{ id: '0001', sets: 3, reps: 8 }] };
  const response = await h.request('/api/routines/mutate', { operation: 'create', baseRev: 4, input: {
    routines: [valid, { name: 'Unknown exercise', exercises: [{ id: 'not-in-catalogue', sets: 3, reps: 8 }] }],
    weekdays: [{ weekday: 1, routine_indexes: [0, 1] }]
  } });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unknown exercise/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.equal((await h.request('/api/data/rev', undefined, 'one', 'GET')).body.rev, 4);
  const retry = await h.request('/api/routines/mutate', { operation: 'create', baseRev: 4, input: { routines: [valid] } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.rev, 5);
  const current = JSON.parse(fs.readFileSync(h.file));
  assert.deepEqual(current.week, initial().week);
  assert.deepEqual(current.routines.map(r => r.name), ['Existing', 'Valid']);
});

test('editing repeated exercise slots preserves their individual settings through the API', async t => {
  const h = await server(t);
  const state = initial();
  state.routines[0].ex = [
    { id: '0001', sets: 3, reps: 8, weight: 40, restSec: 120, note: 'Heavy', warmup: true },
    { id: '0001', sets: 2, reps: 12, weight: 20, restSec: 60, note: 'Light' }
  ];
  fs.writeFileSync(h.file, JSON.stringify(state));
  const edited = await h.request('/api/routines/mutate', { operation: 'edit', baseRev: 4, input: {
    routine_id: 'old', exercises: [{ id: '0001', sets: 4, reps: 6 }, { id: '0001', sets: 2, reps: 15 }]
  } });
  assert.equal(edited.status, 200);
  const current = (await h.request('/api/data', undefined, 'one', 'GET')).body;
  assert.equal(current.rev, 5);
  assert.deepEqual(current.state.routines[0].ex, [
    { ...state.routines[0].ex[0], mode: 'reps', sets: 4, reps: 6 },
    { ...state.routines[0].ex[1], mode: 'reps', reps: 15 }
  ]);
  assert.deepEqual(current.state.workouts, state.workouts);
  assert.deepEqual(current.state.week, state.week);
});
