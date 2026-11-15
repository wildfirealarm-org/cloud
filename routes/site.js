const crypto = require('crypto');
const express = require('express');
const { siteSensors } = require('../services/siteSensors');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Site
 *   description: Read-only data for the wildfirealarm.org website, behind a shared token
 */

// The website sends `Authorization: Bearer <SITE_SENSORS_TOKEN>`. Without the
// variable set the endpoint stays closed.
function requireSiteToken(req, res, next) {
  const expected = process.env.SITE_SENSORS_TOKEN || '';
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!expected) return res.status(503).json({ error: 'Site token is not configured' });
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/**
 * @swagger
 * /site/sensors:
 *   get:
 *     summary: Latest readings and six hours of history for every real node (for the website)
 *     description: >
 *       Needs `Authorization: Bearer <SITE_SENSORS_TOKEN>`; closed (503) when the
 *       variable is not set. Demo nodes are left out, and so is anything that
 *       locates a node (coordinates, altitude, name, Notecard id). `online`
 *       means the node was heard from in the last 30 minutes. `history` holds
 *       10-minute averages of PM2.5 and temperature for the six hours before
 *       the newest sample. Cached for 60 seconds.
 *     tags: [Site]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       401: { description: Missing or wrong token }
 *       503: { description: SITE_SENSORS_TOKEN not configured }
 *       200:
 *         description: Sensors
 *         content:
 *           application/json:
 *             example:
 *               generatedAt: '2026-11-15T15:00:00.000Z'
 *               onlineWithinMinutes: 30
 *               sensors:
 *                 - deviceId: biobot-004
 *                   lastSeen: '2026-11-15T14:58:10.000Z'
 *                   lastReadingAt: '2026-11-15T14:57:40.000Z'
 *                   online: true
 *                   severity: none
 *                   latest:
 *                     temperature: { value: 21.8, unit: '°C', at: '2026-11-15T14:57:40.000Z' }
 *                     pm25: { value: 1, unit: 'μg/m³', at: '2026-11-15T14:57:40.000Z' }
 *                   history:
 *                     pm25: [{ t: '2026-11-15T14:50:00.000Z', v: 1 }]
 *                     temperature: [{ t: '2026-11-15T14:50:00.000Z', v: 21.8 }]
 */
router.get('/site/sensors', requireSiteToken, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json(await siteSensors());
  } catch (err) {
    console.error('site sensors failed:', err.message);
    res.status(500).json({ error: 'Could not load sensors' });
  }
});

module.exports = router;
