const { Op } = require('sequelize');
const { Device, Reading } = require('../models');

// What wildfirealarm.org shows about the sensors: the latest values and a
// short history per node. Nodes sit at people's homes, so nothing that
// locates them leaves here (no coordinates, altitude, name or Notecard id).

const ONLINE_MS = 30 * 60 * 1000;     // a node uploads every 10 min; 30 min of silence = offline
const HISTORY_MS = 6 * 60 * 60 * 1000;
const BUCKET_MS = 10 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const LATEST_TYPES = ['temperature', 'humidity', 'pressure', 'pm1', 'pm25', 'pm10', 'gasResistance'];
const HISTORY_TYPES = ['pm25', 'temperature'];

let cache = null;

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

async function latestFor(device) {
  const newest = await Reading.max('timestamp', { where: { deviceId: device.id } });
  if (!newest) return { at: null, latest: {}, history: {} };
  const end = new Date(newest);

  const [batch, recent] = await Promise.all([
    Reading.findAll({
      attributes: ['readingType', 'value', 'unit', 'timestamp'],
      // A minute's window instead of an exact match, so DATETIME rounding can't miss the batch
      where: { deviceId: device.id, readingType: LATEST_TYPES, timestamp: { [Op.gte]: new Date(end.getTime() - 60 * 1000) } },
      order: [['timestamp', 'DESC']],
    }),
    Reading.findAll({
      attributes: ['readingType', 'value', 'timestamp'],
      where: {
        deviceId: device.id,
        readingType: HISTORY_TYPES,
        timestamp: { [Op.gt]: new Date(end.getTime() - HISTORY_MS), [Op.lte]: end },
      },
    }),
  ]);

  // Ingest can store the same sample twice; one value per type is enough
  const latest = {};
  for (const r of batch) {
    latest[r.readingType] ??= { value: Number(r.value), unit: r.unit, at: new Date(r.timestamp).toISOString() };
  }

  // 10-minute averages over the six hours before the newest sample
  const history = {};
  for (const type of HISTORY_TYPES) {
    const buckets = new Map();
    for (const r of recent) {
      if (r.readingType !== type) continue;
      const t = Math.floor(new Date(r.timestamp).getTime() / BUCKET_MS) * BUCKET_MS;
      const b = buckets.get(t) || { sum: 0, n: 0 };
      b.sum += Number(r.value); b.n++;
      buckets.set(t, b);
    }
    history[type] = [...buckets.entries()].sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({ t: new Date(t).toISOString(), v: round(b.sum / b.n) }));
  }

  return { at: end.toISOString(), latest, history };
}

async function siteSensors(now = new Date()) {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.body;

  const devices = await Device.findAll({
    attributes: ['id', 'deviceId', 'type', 'lastSeen', 'lastSeverity'],
    where: { type: { [Op.ne]: 'demo' } },
    order: [['id', 'ASC']],
  });

  const sensors = [];
  for (const d of devices) {
    const { at, latest, history } = await latestFor(d);
    const lastSeen = d.lastSeen ? new Date(d.lastSeen) : null;
    sensors.push({
      deviceId: d.deviceId,
      lastSeen: lastSeen ? lastSeen.toISOString() : null,
      lastReadingAt: at,
      online: !!lastSeen && now.getTime() - lastSeen.getTime() <= ONLINE_MS,
      severity: d.lastSeverity || 'none',
      latest,
      history,
    });
  }

  const body = { generatedAt: now.toISOString(), onlineWithinMinutes: ONLINE_MS / 60000, sensors };
  cache = { at: now.getTime(), body };
  return body;
}

module.exports = { siteSensors, _reset: () => { cache = null; } };
