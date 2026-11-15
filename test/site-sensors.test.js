// GET /site/sensors: what wildfirealarm.org shows, behind SITE_SENSORS_TOKEN.
//   npm test
process.env.NODE_ENV = 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.SITE_SENSORS_TOKEN = 'site-test-token';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('../config/database');
const models = require('../models');
const { createApp } = require('../app');
const siteSensors = require('../services/siteSensors');

let server, base;

const SITE = { authorization: 'Bearer site-test-token' };
async function get(path, headers = SITE) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

const MIN = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

async function node(deviceId, lastSeenAgo, extra = {}) {
  return models.Device.create({
    deviceId, name: `Home of ${deviceId}`, type: 'air-quality-monitor', status: 'active',
    lastSeen: ago(lastSeenAgo), latitude: 49.8, longitude: -119.5, notecardUid: `dev:${deviceId}`,
    lastSeverity: 'none', ...extra,
  });
}

async function sample(device, at, values) {
  for (const [readingType, [value, unit]] of Object.entries(values)) {
    await models.Reading.create({ deviceId: device.id, readingType, value, unit, timestamp: at });
  }
}

before(async () => {
  await sequelize.sync({ force: true });
  const app = createApp({ requestLog: false });
  app.locals.dbReady = true;
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await sequelize.close();
});

beforeEach(async () => {
  siteSensors._reset();
  await models.Reading.destroy({ where: {} });
  await models.Device.destroy({ where: {} });
});

test('the site reads the latest values, deduped, with no location', async () => {
  const d = await node('biobot-004', 2 * MIN);
  const at = ago(3 * MIN);
  const values = { temperature: [21.82, '°C'], humidity: [43.28, '%'], pm25: [1, 'μg/m³'], altitude: [428.4, 'm'] };
  await sample(d, at, values);
  await sample(d, at, values); // the same batch stored twice
  await sample(d, ago(40 * MIN), { pm25: [5, 'μg/m³'], temperature: [20, '°C'] });

  const r = await get('/site/sensors');
  assert.equal(r.status, 200);
  assert.equal(r.body.sensors.length, 1);
  const s = r.body.sensors[0];
  assert.equal(s.deviceId, 'biobot-004');
  assert.equal(s.online, true);
  assert.equal(s.severity, 'none');
  assert.deepEqual(s.latest.temperature, { value: 21.82, unit: '°C', at: at.toISOString() });
  assert.equal(s.latest.pm25.value, 1);
  assert.equal(s.latest.altitude, undefined);
  assert.ok(s.history.pm25.length >= 2);
  assert.equal(s.history.pm25.at(-1).v, 1);

  const text = JSON.stringify(r.body);
  for (const secret of ['latitude', 'longitude', '49.8', '119.5', 'Home of', 'dev:biobot', 'altitude']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('a node silent for more than 30 minutes is offline but keeps its last values', async () => {
  const d = await node('HSD_3', 31 * MIN);
  await sample(d, ago(32 * MIN), { temperature: [18, '°C'] });
  const s = (await get('/site/sensors')).body.sensors[0];
  assert.equal(s.online, false);
  assert.equal(s.latest.temperature.value, 18);
});

test('demo nodes are left out and nodes without readings still appear', async () => {
  await node('demo-1', MIN, { type: 'demo' });
  await node('biobot-002', 10 * MIN);
  const body = (await get('/site/sensors')).body;
  assert.deepEqual(body.sensors.map((s) => s.deviceId), ['biobot-002']);
  assert.deepEqual(body.sensors[0].latest, {});
  assert.equal(body.onlineWithinMinutes, 30);
});

test('without the right token the endpoint refuses, and it is closed when no token is configured', async () => {
  await node('biobot-002', MIN);
  assert.equal((await get('/site/sensors', {})).status, 401);
  assert.equal((await get('/site/sensors', { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await fetch(base + '/public/sensors')).status, 404);

  const saved = process.env.SITE_SENSORS_TOKEN;
  delete process.env.SITE_SENSORS_TOKEN;
  try {
    assert.equal((await get('/site/sensors')).status, 503);
  } finally {
    process.env.SITE_SENSORS_TOKEN = saved;
  }
});
