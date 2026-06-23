const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set(['/health', '/api/hashtags/trending']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Hashtag extraction ─────────────────────────────────────────────────────────

function extractHashtags(content) {
  const tags = new Set();
  for (const m of content.matchAll(/#([a-zA-Z0-9_]{1,50})/g)) {
    const tag = m[1].toLowerCase();
    if (!/^\d+$/.test(tag)) tags.add(tag);
  }
  return Array.from(tags);
}

// ── Feed ──────────────────────────────────────────────────────────────────────

app.get('/api/feed/trending', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE p.deleted_at IS NULL
        AND p.created_at > NOW() - INTERVAL '48 hours'
      GROUP BY p.id
      ORDER BY (COUNT(DISTINCT l.id) + COUNT(DISTINCT c.id) * 2) DESC, p.created_at DESC
      LIMIT 20 OFFSET $2
    `, [userId, offset]);
    res.json({ pulses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feed/following', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user.id;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      INNER JOIN pulse_follows f ON f.following_id = p.user_id AND f.follower_id = $1
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20 OFFSET $2
    `, [userId, offset]);
    res.json({ pulses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feed/live', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20 OFFSET $2
    `, [userId, offset]);
    res.json({ pulses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Pulses ────────────────────────────────────────────────────────────────────

app.post('/api/pulses', async (req, res) => {
  try {
    const { content, signature, sign_message, pubkey } = req.body;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }
    if (content.length > 280) {
      return res.status(400).json({ error: 'Content exceeds 280 characters' });
    }
    const { rows } = await pool.query(`
      INSERT INTO pulses (user_id, username, usernode_pubkey, content, signature, sign_message)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, username, usernode_pubkey, content, signature, sign_message, created_at
    `, [req.user.id, req.user.username, pubkey || req.user.usernode_pubkey || null,
        content.trim(), signature || null, sign_message || null]);
    const tags = extractHashtags(content.trim());
    if (tags.length > 0) {
      const vals = tags.map((_, i) => `($1, $${i + 2})`).join(', ');
      pool.query(`INSERT INTO pulse_hashtags (pulse_id, tag) VALUES ${vals}`, [rows[0].id, ...tags]).catch(() => {});
    }
    res.json({ pulse: { ...rows[0], like_count: 0, comment_count: 0, liked_by_me: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pulses/:id', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE p.id = $2 AND p.deleted_at IS NULL
      GROUP BY p.id
    `, [userId, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ pulse: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pulses/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`
      UPDATE pulses SET deleted_at = NOW()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
    `, [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found or not yours' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Likes ─────────────────────────────────────────────────────────────────────

app.post('/api/pulses/:id/like', async (req, res) => {
  try {
    const { signature, sign_message, pubkey } = req.body;
    await pool.query(`
      INSERT INTO pulse_likes (pulse_id, user_id, username, usernode_pubkey, signature, sign_message)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (pulse_id, user_id) DO NOTHING
    `, [req.params.id, req.user.id, req.user.username,
        pubkey || req.user.usernode_pubkey || null,
        signature || null, sign_message || null]);
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS like_count FROM pulse_likes WHERE pulse_id = $1',
      [req.params.id]
    );
    res.json({ ok: true, like_count: rows[0].like_count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pulses/:id/like', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM pulse_likes WHERE pulse_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS like_count FROM pulse_likes WHERE pulse_id = $1',
      [req.params.id]
    );
    res.json({ ok: true, like_count: rows[0].like_count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Comments ──────────────────────────────────────────────────────────────────

app.get('/api/pulses/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, user_id, username, usernode_pubkey, content, signature, sign_message, created_at
      FROM pulse_comments
      WHERE pulse_id = $1
      ORDER BY created_at ASC
    `, [req.params.id]);
    res.json({ comments: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pulses/:id/comments', async (req, res) => {
  try {
    const { content, signature, sign_message, pubkey } = req.body;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }
    if (content.length > 280) {
      return res.status(400).json({ error: 'Content exceeds 280 characters' });
    }
    const pulseCheck = await pool.query(
      'SELECT id FROM pulses WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!pulseCheck.rows.length) return res.status(404).json({ error: 'Pulse not found' });

    const { rows } = await pool.query(`
      INSERT INTO pulse_comments (pulse_id, user_id, username, usernode_pubkey, content, signature, sign_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id, username, usernode_pubkey, content, signature, sign_message, created_at
    `, [req.params.id, req.user.id, req.user.username,
        pubkey || req.user.usernode_pubkey || null,
        content.trim(), signature || null, sign_message || null]);
    res.json({ comment: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Users / Profiles ──────────────────────────────────────────────────────────

app.get('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const meId = req.user ? req.user.id : null;

    const [pulseRes, followersRes, followingRes, pubkeyRes] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS pulse_count FROM pulses WHERE username = $1 AND deleted_at IS NULL',
        [username]
      ),
      pool.query(
        'SELECT COUNT(*)::int AS follower_count FROM pulse_follows WHERE following_username = $1',
        [username]
      ),
      pool.query(
        'SELECT COUNT(*)::int AS following_count FROM pulse_follows WHERE follower_username = $1',
        [username]
      ),
      pool.query(
        'SELECT usernode_pubkey FROM pulses WHERE username = $1 AND usernode_pubkey IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [username]
      ),
    ]);

    let is_following = false;
    if (meId) {
      const fRes = await pool.query(
        'SELECT 1 FROM pulse_follows WHERE follower_id = $1 AND following_username = $2',
        [meId, username]
      );
      is_following = fRes.rows.length > 0;
    }

    res.json({
      username,
      usernode_pubkey: pubkeyRes.rows[0]?.usernode_pubkey || null,
      pulse_count: pulseRes.rows[0].pulse_count,
      follower_count: followersRes.rows[0].follower_count,
      following_count: followingRes.rows[0].following_count,
      is_following,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:username/pulses', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE p.username = $2 AND p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20 OFFSET $3
    `, [userId, req.params.username, offset]);
    res.json({ pulses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:username/follow', async (req, res) => {
  try {
    const { username } = req.params;
    if (username === req.user.username) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    // Resolve target user_id from their most recent pulse
    const targetRes = await pool.query(
      'SELECT user_id FROM pulses WHERE username = $1 LIMIT 1',
      [username]
    );
    const targetId = targetRes.rows[0]?.user_id || 0;
    await pool.query(`
      INSERT INTO pulse_follows (follower_id, follower_username, following_id, following_username)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (follower_id, following_id) DO NOTHING
    `, [req.user.id, req.user.username, targetId, username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:username/follow', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM pulse_follows WHERE follower_id = $1 AND following_username = $2',
      [req.user.id, req.params.username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Suggestions (who to follow) ───────────────────────────────────────────────

app.get('/api/suggestions', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT username, usernode_pubkey
      FROM pulses
      WHERE username != $1 AND deleted_at IS NULL
        AND username NOT IN (
          SELECT following_username FROM pulse_follows WHERE follower_id = $2
        )
      ORDER BY username
      LIMIT 5
    `, [req.user.username, req.user.id]);
    res.json({ suggestions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ users: [], pulses: [] });
    const term = '%' + q + '%';
    const userId = req.user ? req.user.id : null;

    const [usersRes, pulsesRes] = await Promise.all([
      pool.query(`
        SELECT username, MAX(usernode_pubkey) AS usernode_pubkey
        FROM pulses
        WHERE deleted_at IS NULL AND username ILIKE $1
        GROUP BY username
        ORDER BY username
        LIMIT 10
      `, [term]),
      pool.query(`
        SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
               p.signature, p.sign_message, p.created_at,
               COUNT(DISTINCT l.id)::int AS like_count,
               COUNT(DISTINCT c.id)::int AS comment_count,
               BOOL_OR(l.user_id = $1) AS liked_by_me
        FROM pulses p
        LEFT JOIN pulse_likes l ON l.pulse_id = p.id
        LEFT JOIN pulse_comments c ON c.pulse_id = p.id
        WHERE p.deleted_at IS NULL AND p.content ILIKE $2
        GROUP BY p.id
        ORDER BY p.created_at DESC
        LIMIT 20
      `, [userId, term]),
    ]);

    res.json({ users: usersRes.rows, pulses: pulsesRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Hashtags ──────────────────────────────────────────────────────────────────

app.get('/api/hashtags/trending', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ph.tag, COUNT(*)::int AS count
      FROM pulse_hashtags ph
      JOIN pulses p ON ph.pulse_id = p.id
      WHERE p.deleted_at IS NULL
        AND ph.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY ph.tag
      ORDER BY count DESC, ph.tag ASC
      LIMIT 8
    `);
    res.json({ tags: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hashtags/:tag/pulses', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.user ? req.user.id : null;
    const { rows } = await pool.query(`
      SELECT p.id, p.user_id, p.username, p.usernode_pubkey, p.content,
             p.signature, p.sign_message, p.created_at,
             COUNT(DISTINCT l.id)::int AS like_count,
             COUNT(DISTINCT c.id)::int AS comment_count,
             BOOL_OR(l.user_id = $1) AS liked_by_me
      FROM pulses p
      JOIN pulse_hashtags ph ON ph.pulse_id = p.id
      LEFT JOIN pulse_likes l ON l.pulse_id = p.id
      LEFT JOIN pulse_comments c ON c.pulse_id = p.id
      WHERE ph.tag = lower($2)
        AND p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.created_at DESC
      LIMIT 20 OFFSET $3
    `, [userId, req.params.tag, offset]);
    res.json({ pulses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Direct Messages ───────────────────────────────────────────────────────────

app.get('/api/messages', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id))
          sender_id, sender_username, recipient_id, recipient_username,
          content, created_at
        FROM pulse_messages
        WHERE sender_id = $1 OR recipient_id = $1
        ORDER BY LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC
      )
      SELECT
        CASE WHEN l.sender_id = $1 THEN l.recipient_id ELSE l.sender_id END AS partner_id,
        CASE WHEN l.sender_id = $1 THEN l.recipient_username ELSE l.sender_username END AS partner_username,
        SUBSTRING(l.content FROM 1 FOR 60) AS last_message,
        l.created_at AS last_message_at,
        l.sender_id AS last_sender_id,
        (SELECT COUNT(*)::int FROM pulse_messages
         WHERE recipient_id = $1
           AND sender_id = (CASE WHEN l.sender_id = $1 THEN l.recipient_id ELSE l.sender_id END)
           AND read_at IS NULL) AS unread_count
      FROM latest l
      ORDER BY l.created_at DESC
    `, [userId]);
    if (IS_STAGING && rows.length === 0) {
      const now = Date.now();
      return res.json({ conversations: [
        {
          partner_id: 99990002,
          partner_username: 'staging-pulse-bob',
          last_message: 'Makes sense — keeps it private',
          last_message_at: new Date(now - 2 * 3600 * 1000).toISOString(),
          last_sender_id: 99990002,
          unread_count: 0,
        },
        {
          partner_id: 99990003,
          partner_username: 'staging-pulse-carol',
          last_message: 'Welcome to the mutual DM club!',
          last_message_at: new Date(now - 1 * 3600 * 1000).toISOString(),
          last_sender_id: 99990003,
          unread_count: 0,
        },
      ]});
    }
    res.json({ conversations: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const userId = req.user.id;
    const isStagingPartner = IS_STAGING && username.startsWith('staging-pulse-');

    if (isStagingPartner) {
      const now = Date.now();
      const partnerIds = { 'staging-pulse-bob': 99990002, 'staging-pulse-carol': 99990003 };
      const partnerId = partnerIds[username] || 0;
      const demoMap = {
        'staging-pulse-bob': [
          { from_me: true,  content: 'Hey! Just noticed we can DM now',              mins_ago: 180 },
          { from_me: false, content: 'Nice, feels pretty seamless',                   mins_ago: 165 },
          { from_me: true,  content: 'Yeah, only works if you both follow each other', mins_ago: 150 },
          { from_me: false, content: 'Makes sense — keeps it private',                mins_ago: 120 },
        ],
        'staging-pulse-carol': [
          { from_me: false, content: 'Welcome to the mutual DM club!',  mins_ago: 60 },
          { from_me: true,  content: 'Haha thanks for the follow-back', mins_ago: 30 },
        ],
      };
      const template = demoMap[username] || [];
      const messages = template.map((m, i) => ({
        id: 8000000 + i,
        sender_id:        m.from_me ? userId    : partnerId,
        sender_username:  m.from_me ? req.user.username : username,
        recipient_id:     m.from_me ? partnerId : userId,
        recipient_username: m.from_me ? username : req.user.username,
        content: m.content,
        created_at: new Date(now - m.mins_ago * 60 * 1000).toISOString(),
        read_at:    new Date(now - (m.mins_ago - 5) * 60 * 1000).toISOString(),
      }));
      return res.json({ messages, partner_username: username, is_mutual: true });
    }

    const mutualCheck = await pool.query(`
      SELECT 1 FROM pulse_follows f1
      WHERE f1.follower_id = $1 AND f1.following_username = $2
        AND EXISTS (
          SELECT 1 FROM pulse_follows f2
          WHERE f2.follower_username = $2 AND f2.following_id = $1
        )
    `, [userId, username]);
    if (!mutualCheck.rows.length) {
      return res.json({ messages: [], partner_username: username, is_mutual: false });
    }
    const { rows } = await pool.query(`
      SELECT id, sender_id, sender_username, recipient_id, recipient_username,
             content, created_at, read_at
      FROM pulse_messages
      WHERE (sender_id = $1 AND recipient_username = $2)
         OR (recipient_id = $1 AND sender_username = $2)
      ORDER BY created_at ASC
    `, [userId, username]);
    res.json({ messages: rows, partner_username: username, is_mutual: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { content } = req.body;
    const userId = req.user.id;
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Content is required' });
    }
    if (content.length > 280) {
      return res.status(400).json({ error: 'Content exceeds 280 characters' });
    }
    const isStagingPartner = IS_STAGING && username.startsWith('staging-pulse-');
    if (!isStagingPartner) {
      const mutualCheck = await pool.query(`
        SELECT 1 FROM pulse_follows f1
        WHERE f1.follower_id = $1 AND f1.following_username = $2
          AND EXISTS (
            SELECT 1 FROM pulse_follows f2
            WHERE f2.follower_username = $2 AND f2.following_id = $1
          )
      `, [userId, username]);
      if (!mutualCheck.rows.length) {
        return res.status(403).json({ error: 'Not mutually following' });
      }
    }
    const recipientRes = await pool.query(
      'SELECT user_id FROM pulses WHERE username = $1 LIMIT 1',
      [username]
    );
    const recipientId = recipientRes.rows[0]?.user_id;
    if (!recipientId) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    const { rows } = await pool.query(`
      INSERT INTO pulse_messages (sender_id, sender_username, recipient_id, recipient_username, content)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, sender_id, sender_username, recipient_id, recipient_username, content, created_at, read_at
    `, [userId, req.user.username, recipientId, username, content.trim()]);
    res.json({ message: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages/:username/read', async (req, res) => {
  try {
    await pool.query(`
      UPDATE pulse_messages
      SET read_at = NOW()
      WHERE recipient_id = $1 AND sender_username = $2 AND read_at IS NULL
    `, [req.user.id, req.params.username]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Static & Shell ────────────────────────────────────────────────────────────

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Schema + Seed ─────────────────────────────────────────────────────────────

async function start() {
  app.listen(port, () => console.log(`Listening on :${port}`));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pulses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      usernode_pubkey VARCHAR(255),
      content TEXT NOT NULL,
      signature TEXT,
      sign_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS pulse_likes (
      id SERIAL PRIMARY KEY,
      pulse_id INTEGER REFERENCES pulses(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      usernode_pubkey VARCHAR(255),
      signature TEXT,
      sign_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(pulse_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS pulse_comments (
      id SERIAL PRIMARY KEY,
      pulse_id INTEGER REFERENCES pulses(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      usernode_pubkey VARCHAR(255),
      content TEXT NOT NULL,
      signature TEXT,
      sign_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pulse_follows (
      id SERIAL PRIMARY KEY,
      follower_id INTEGER NOT NULL,
      follower_username VARCHAR(255) NOT NULL,
      following_id INTEGER NOT NULL,
      following_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(follower_id, following_id)
    );
    CREATE TABLE IF NOT EXISTS pulse_hashtags (
      id SERIAL PRIMARY KEY,
      pulse_id INTEGER REFERENCES pulses(id) ON DELETE CASCADE,
      tag VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pulse_hashtags_tag ON pulse_hashtags(tag);
    CREATE INDEX IF NOT EXISTS idx_pulse_hashtags_created_at ON pulse_hashtags(created_at);
    CREATE TABLE IF NOT EXISTS pulse_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL,
      sender_username VARCHAR(255) NOT NULL,
      recipient_id INTEGER NOT NULL,
      recipient_username VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_pulse_messages_pair ON pulse_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at);
    CREATE INDEX IF NOT EXISTS idx_pulse_messages_recipient ON pulse_messages (recipient_id, read_at);
  `);
  await pool.query(`COMMENT ON TABLE pulse_messages IS 'staging:private'`);

  if (IS_STAGING) {
    // Insert seed pulses (10 posts across 5 fake users)
    await pool.query(`
      INSERT INTO pulses (id, user_id, username, usernode_pubkey, content, signature, created_at) VALUES
        (900001, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'Usernode just hit a new milestone! The community keeps growing.',
         'staging-sig-001', NOW() - INTERVAL '1 hour'),
        (900002, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'On-chain identity is the future. No more anonymous spam.',
         'staging-sig-002', NOW() - INTERVAL '5 hours'),
        (900003, 99990002, 'staging-pulse-bob', 'ut1staging000bob',
         'Anyone else excited about the Pulse launch? This is how social should work.',
         'staging-sig-003', NOW() - INTERVAL '2 hours'),
        (900004, 99990002, 'staging-pulse-bob', 'ut1staging000bob',
         'Just verified my first transaction. Feels good to own your data.',
         'staging-sig-004', NOW() - INTERVAL '8 hours'),
        (900005, 99990003, 'staging-pulse-carol', 'ut1staging000carol',
         'Reminder: your wallet is your identity. Guard it well.',
         'staging-sig-005', NOW() - INTERVAL '3 hours'),
        (900006, 99990003, 'staging-pulse-carol', 'ut1staging000carol',
         'Three months on Usernode and I haven''t looked back.',
         'staging-sig-006', NOW() - INTERVAL '12 hours'),
        (900007, 99990004, 'staging-pulse-dave', 'ut1staging000dave',
         'Building in public on Usernode. Thread incoming.',
         'staging-sig-007', NOW() - INTERVAL '6 hours'),
        (900008, 99990005, 'staging-pulse-eve', 'ut1staging000eve',
         'The vibe on here is just different. Healthy discourse.',
         'staging-sig-008', NOW() - INTERVAL '4 hours'),
        (900009, 99990005, 'staging-pulse-eve', 'ut1staging000eve',
         'Who''s coming to the next community call?',
         'staging-sig-009', NOW() - INTERVAL '10 hours'),
        (900010, 99990005, 'staging-pulse-eve', 'ut1staging000eve',
         'Shoutout to everyone who''s been signing their posts from day one.',
         'staging-sig-010', NOW() - INTERVAL '36 hours')
      ON CONFLICT (id) DO NOTHING
    `);

    // Hashtag seed posts (900011–900020) — used to populate Trending Topics panel
    await pool.query(`
      INSERT INTO pulses (id, user_id, username, usernode_pubkey, content, signature, created_at) VALUES
        (900011, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'The future of decentralized social is here! #web3 #blockchain',
         'staging-sig-011', NOW() - INTERVAL '1 hour'),
        (900012, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'Loving the vibes on #pulse today. This community is everything! #usernode',
         'staging-sig-012', NOW() - INTERVAL '2 hours'),
        (900013, 99990002, 'staging-pulse-bob', 'ut1staging000bob',
         'Gm everyone! Great day to be building on #web3 #gm',
         'staging-sig-013', NOW() - INTERVAL '3 hours'),
        (900014, 99990002, 'staging-pulse-bob', 'ut1staging000bob',
         'The #blockchain space is evolving so fast. Staying bullish on #crypto',
         'staging-sig-014', NOW() - INTERVAL '4 hours'),
        (900015, 99990003, 'staging-pulse-carol', 'ut1staging000carol',
         'Just found my new home on #pulse. Never going back to web2! #web3',
         'staging-sig-015', NOW() - INTERVAL '5 hours'),
        (900016, 99990003, 'staging-pulse-carol', 'ut1staging000carol',
         'Good morning from the Usernode community! #gm #usernode',
         'staging-sig-016', NOW() - INTERVAL '6 hours'),
        (900017, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'Building something on #pulse right now. #crypto and #defi are going to change everything.',
         'staging-sig-017', NOW() - INTERVAL '7 hours'),
        (900018, 99990002, 'staging-pulse-bob', 'ut1staging000bob',
         'The #blockchain revolution is just getting started. #web3 forever.',
         'staging-sig-018', NOW() - INTERVAL '8 hours'),
        (900019, 99990003, 'staging-pulse-carol', 'ut1staging000carol',
         'Signed my first on-chain post today. What a time to be alive.',
         'staging-sig-019', NOW() - INTERVAL '9 hours'),
        (900020, 99990001, 'staging-pulse-alice', 'ut1staging000alice',
         'The future is decentralized. Keep building.',
         'staging-sig-020', NOW() - INTERVAL '10 hours')
      ON CONFLICT (id) DO NOTHING
    `);

    // Likes — spread to make alice and bob trending
    await pool.query(`
      INSERT INTO pulse_likes (pulse_id, user_id, username) VALUES
        (900001, 99990002, 'staging-pulse-bob'),
        (900001, 99990003, 'staging-pulse-carol'),
        (900001, 99990004, 'staging-pulse-dave'),
        (900001, 99990005, 'staging-pulse-eve'),
        (900002, 99990002, 'staging-pulse-bob'),
        (900002, 99990003, 'staging-pulse-carol'),
        (900002, 99990004, 'staging-pulse-dave'),
        (900003, 99990001, 'staging-pulse-alice'),
        (900003, 99990003, 'staging-pulse-carol'),
        (900003, 99990004, 'staging-pulse-dave'),
        (900003, 99990005, 'staging-pulse-eve'),
        (900004, 99990001, 'staging-pulse-alice'),
        (900004, 99990003, 'staging-pulse-carol'),
        (900005, 99990001, 'staging-pulse-alice'),
        (900005, 99990002, 'staging-pulse-bob'),
        (900006, 99990001, 'staging-pulse-alice'),
        (900007, 99990001, 'staging-pulse-alice'),
        (900007, 99990003, 'staging-pulse-carol'),
        (900008, 99990001, 'staging-pulse-alice'),
        (900009, 99990002, 'staging-pulse-bob')
      ON CONFLICT (pulse_id, user_id) DO NOTHING
    `);

    // Comments
    await pool.query(`
      INSERT INTO pulse_comments (id, pulse_id, user_id, username, usernode_pubkey, content) VALUES
        (9000001, 900001, 99990002, 'staging-pulse-bob', 'ut1staging000bob', 'Totally agree! The growth has been incredible.'),
        (9000002, 900003, 99990001, 'staging-pulse-alice', 'ut1staging000alice', 'Same here! Pulse is going to change everything.'),
        (9000003, 900005, 99990004, 'staging-pulse-dave', 'ut1staging000dave', 'Wise words. Backed up my seed phrase again after reading this.'),
        (9000004, 900007, 99990003, 'staging-pulse-carol', 'ut1staging000carol', 'Following this thread closely!'),
        (9000005, 900009, 99990004, 'staging-pulse-dave', 'ut1staging000dave', 'I''ll be there! Who else?')
      ON CONFLICT (id) DO NOTHING
    `);

    // Follows
    await pool.query(`
      INSERT INTO pulse_follows (follower_id, follower_username, following_id, following_username) VALUES
        (99990001, 'staging-pulse-alice', 99990002, 'staging-pulse-bob'),
        (99990001, 'staging-pulse-alice', 99990003, 'staging-pulse-carol'),
        (99990002, 'staging-pulse-bob', 99990001, 'staging-pulse-alice'),
        (99990003, 'staging-pulse-carol', 99990001, 'staging-pulse-alice'),
        (99990003, 'staging-pulse-carol', 99990002, 'staging-pulse-bob'),
        (99990003, 'staging-pulse-carol', 99990004, 'staging-pulse-dave'),
        (99990004, 'staging-pulse-dave', 99990003, 'staging-pulse-carol')
      ON CONFLICT (follower_id, following_id) DO NOTHING
    `);

    // Hashtag rows for the seed posts — powers the Trending Topics panel
    await pool.query(`
      INSERT INTO pulse_hashtags (id, pulse_id, tag, created_at) VALUES
        (9100001, 900011, 'web3',       NOW() - INTERVAL '1 hour'),
        (9100002, 900011, 'blockchain', NOW() - INTERVAL '1 hour'),
        (9100003, 900012, 'pulse',      NOW() - INTERVAL '2 hours'),
        (9100004, 900012, 'usernode',   NOW() - INTERVAL '2 hours'),
        (9100005, 900013, 'web3',       NOW() - INTERVAL '3 hours'),
        (9100006, 900013, 'gm',         NOW() - INTERVAL '3 hours'),
        (9100007, 900014, 'blockchain', NOW() - INTERVAL '4 hours'),
        (9100008, 900014, 'crypto',     NOW() - INTERVAL '4 hours'),
        (9100009, 900015, 'pulse',      NOW() - INTERVAL '5 hours'),
        (9100010, 900015, 'web3',       NOW() - INTERVAL '5 hours'),
        (9100011, 900016, 'gm',         NOW() - INTERVAL '6 hours'),
        (9100012, 900016, 'usernode',   NOW() - INTERVAL '6 hours'),
        (9100013, 900017, 'pulse',      NOW() - INTERVAL '7 hours'),
        (9100014, 900017, 'crypto',     NOW() - INTERVAL '7 hours'),
        (9100015, 900017, 'defi',       NOW() - INTERVAL '7 hours'),
        (9100016, 900018, 'blockchain', NOW() - INTERVAL '8 hours'),
        (9100017, 900018, 'web3',       NOW() - INTERVAL '8 hours')
      ON CONFLICT (id) DO NOTHING
    `);

    // Messages (staging:private — empty in prod; seeded here so DM inbox has content)
    // alice↔bob and alice↔carol are both mutual follows (see follows seed above)
    await pool.query(`
      INSERT INTO pulse_messages (id, sender_id, sender_username, recipient_id, recipient_username, content, created_at, read_at) VALUES
        (8000001, 99990001, 'staging-pulse-alice', 99990002, 'staging-pulse-bob',
         'Hey! Just noticed we can DM now',
         NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours 55 minutes'),
        (8000002, 99990002, 'staging-pulse-bob', 99990001, 'staging-pulse-alice',
         'Nice, feels pretty seamless',
         NOW() - INTERVAL '2 hours 45 minutes', NOW() - INTERVAL '2 hours 40 minutes'),
        (8000003, 99990001, 'staging-pulse-alice', 99990002, 'staging-pulse-bob',
         'Yeah, only works if you both follow each other',
         NOW() - INTERVAL '2 hours 30 minutes', NOW() - INTERVAL '2 hours 25 minutes'),
        (8000004, 99990002, 'staging-pulse-bob', 99990001, 'staging-pulse-alice',
         'Makes sense — keeps it private',
         NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 55 minutes'),
        (8000005, 99990003, 'staging-pulse-carol', 99990001, 'staging-pulse-alice',
         'Welcome to the mutual DM club!',
         NOW() - INTERVAL '1 hour', NULL),
        (8000006, 99990001, 'staging-pulse-alice', 99990003, 'staging-pulse-carol',
         'Haha thanks for the follow-back',
         NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '25 minutes')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

start().catch(err => { console.error(err); process.exit(1); });
