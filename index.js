const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('chat.db');

// ════════════════════════════════════════════════════════════
//  ★ EDITABLE CONFIG — change these freely ★
// ════════════════════════════════════════════════════════════
const MASTER_PASSWORD = '582624';         // ← master/admin password
// ════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json());

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#44aaff',
    is_mod INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    ban_reason TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT DEFAULT '',
    creator_id INTEGER,
    password TEXT,
    is_private INTEGER NOT NULL DEFAULT 0,
    is_general INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    server_message TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(creator_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#44aaff',
    content TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_id) REFERENCES rooms(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(receiver_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ip_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    user_id INTEGER,
    event TEXT DEFAULT 'login',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS mod_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add server_message column if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE rooms ADD COLUMN server_message TEXT DEFAULT ''`);
} catch(e) { /* already exists */ }

// Seed General room
const existing = db.prepare('SELECT id FROM rooms WHERE is_general = 1').get();
if (!existing) {
  db.prepare(
    `INSERT INTO rooms (name, description, is_general, is_private) VALUES ('General', 'The main chat. Always here.', 1, 0)`
  ).run();
}

// ── Daily reset job ───────────────────────────────────────────────────────────

function resetMessages() {
  db.prepare('DELETE FROM messages').run();
  db.prepare('UPDATE rooms SET message_count = 0').run();
  console.log(`[${new Date().toISOString()}] Daily reset: all messages cleared.`);
}

function scheduleNextReset() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(() => {
    resetMessages();
    scheduleNextReset();
  }, msUntil);
  console.log(`Next reset in ${Math.round(msUntil / 1000 / 60)} minutes.`);
}
scheduleNextReset();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMaster(pw) { return pw === MASTER_PASSWORD; }

function getUser(username, password) {
  return db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
}

function logIp(req, userId) {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    db.prepare('INSERT INTO ip_log (ip, user_id, event) VALUES (?, ?, ?)').run(ip, userId, 'action');
    return ip;
  } catch(e) { return 'unknown'; }
}

function isIpBanned(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  return !!db.prepare('SELECT ip FROM banned_ips WHERE ip = ?').get(ip);
}

function modLog(action, target, detail = '') {
  db.prepare('INSERT INTO mod_log (action, target, detail) VALUES (?, ?, ?)').run(action, target, detail);
}

// ── User routes ───────────────────────────────────────────────────────────────

// GET all users (public, no passwords)
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, username, color FROM users WHERE banned = 0').all();
  res.json(users);
});

// Register
app.post('/api/users/register', (req, res) => {
  if (isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });
  const userColor = color || '#44aaff';
  const result = db.prepare('INSERT INTO users (username, password, color) VALUES (?, ?, ?)').run(username, password, userColor);
  logIp(req, result.lastInsertRowid);
  res.json({ success: true, id: result.lastInsertRowid, username, color: userColor });
});

// Login
app.post('/api/users/login', (req, res) => {
  if (isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
  const { username, password } = req.body;
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  if (user.banned) return res.status(403).json({ error: 'Your account has been banned' + (user.ban_reason ? ': ' + user.ban_reason : '') });
  logIp(req, user.id);
  res.json({ success: true, id: user.id, username: user.username, color: user.color, is_mod: user.is_mod });
});

// Update account
app.put('/api/users/:id', (req, res) => {
  const { currentPassword, newUsername, newPassword, color } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!isMaster(currentPassword) && user.password !== currentPassword) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  if (newUsername && newUsername !== user.username) {
    if (newUsername.length < 2 || newUsername.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, user.id);
    if (taken) return res.status(409).json({ error: 'Username taken' });
  }
  const updatedUsername = newUsername || user.username;
  const updatedPassword = newPassword || user.password;
  const updatedColor = color || user.color;
  db.prepare('UPDATE users SET username = ?, password = ?, color = ? WHERE id = ?')
    .run(updatedUsername, updatedPassword, updatedColor, user.id);
  res.json({ success: true, id: user.id, username: updatedUsername, color: updatedColor, is_mod: user.is_mod });
});

// ── Room routes ───────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.server_message, r.created_at,
           u.username as creator_name
    FROM rooms r
    LEFT JOIN users u ON r.creator_id = u.id
    ORDER BY r.is_general DESC, r.message_count DESC, r.created_at DESC
  `).all();
  res.json(rooms.map(r => ({ ...r, locked: r.is_private === 1 })));
});

app.post('/api/rooms', (req, res) => {
  const { name, description, creatorUsername, creatorPassword, roomPassword, isPrivate } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Room name must be 2–32 characters' });
  const creator = getUser(creatorUsername, creatorPassword);
  if (!creator) return res.status(401).json({ error: 'Invalid credentials' });
  const exists = db.prepare('SELECT id FROM rooms WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ error: 'A room with that name already exists' });
  if (isPrivate && !roomPassword) return res.status(400).json({ error: 'Private rooms need a password' });
  const result = db.prepare(
    'INSERT INTO rooms (name, description, creator_id, password, is_private) VALUES (?, ?, ?, ?, ?)'
  ).run(name, description || '', creator.id, roomPassword || null, isPrivate ? 1 : 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete('/api/rooms/:id', (req, res) => {
  const { password } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_general) return res.status(403).json({ error: 'Cannot delete the General room' });
  if (!isMaster(password) && room.password !== password) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  res.json({ success: true });
});

// ── Server message for room ───────────────────────────────────────────────────

// Set/update server message for a room (master only)
app.put('/api/rooms/:id/server-message', (req, res) => {
  const { password, message } = req.body;
  if (!isMaster(password)) return res.status(403).json({ error: 'Forbidden' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  db.prepare('UPDATE rooms SET server_message = ? WHERE id = ?').run(message || '', room.id);
  modLog('set_server_msg', room.name, message ? message.slice(0, 60) : '(cleared)');
  res.json({ success: true });
});

// ── Message routes ────────────────────────────────────────────────────────────

app.get('/api/rooms/:id/messages', (req, res) => {
  const { roomPassword } = req.query;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
    return res.status(403).json({ error: 'Wrong room password' });
  }
  const messages = db.prepare(`
    SELECT id, username, color, content, is_system, created_at FROM messages
    WHERE room_id = ?
    ORDER BY created_at ASC
    LIMIT 200
  `).all(req.params.id);
  res.json(messages);
});

app.post('/api/rooms/:id/messages', (req, res) => {
  const { username, password, content, roomPassword } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'You are banned' });
  if (user.muted) return res.status(403).json({ error: 'You are muted' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
    return res.status(403).json({ error: 'Wrong room password' });
  }
  db.prepare(
    'INSERT INTO messages (room_id, user_id, username, color, content) VALUES (?, ?, ?, ?, ?)'
  ).run(room.id, user.id, user.username, user.color, content.trim());
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
  logIp(req, user.id);
  res.json({ success: true });
});

// ── Direct Messages ───────────────────────────────────────────────────────────

// Get DM inbox (list of conversations)
app.get('/api/dm/:userId/inbox', (req, res) => {
  const { password } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });

  const partners = db.prepare(`
    SELECT DISTINCT
      CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as partner_id,
      MAX(created_at) as last_time
    FROM direct_messages
    WHERE sender_id = ? OR receiver_id = ?
    GROUP BY partner_id
    ORDER BY last_time DESC
  `).all(user.id, user.id, user.id);

  const result = partners.map(p => {
    const partner = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(p.partner_id);
    if (!partner) return null;
    const last = db.prepare(`
      SELECT * FROM direct_messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(user.id, p.partner_id, p.partner_id, user.id);
    return { partner, last };
  }).filter(Boolean);

  res.json(result);
});

// Get messages between two users
app.get('/api/dm/:userId/:partnerId', (req, res) => {
  const { password } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
  const partner = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(req.params.partnerId);
  if (!partner) return res.status(404).json({ error: 'User not found' });
  const messages = db.prepare(`
    SELECT dm.id, dm.sender_id, u.username as sender_name, dm.content, dm.created_at
    FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE (dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?)
    ORDER BY dm.created_at ASC
    LIMIT 200
  `).all(user.id, partner.id, partner.id, user.id);
  res.json({ them: partner, messages });
});

// Send DM
app.post('/api/dm/:userId/:partnerId', (req, res) => {
  const { password, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
  if (content.length > 1000) return res.status(400).json({ error: 'Too long' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
  if (user.banned) return res.status(403).json({ error: 'You are banned' });
  const partner = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.partnerId);
  if (!partner) return res.status(404).json({ error: 'User not found' });
  db.prepare('INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES (?, ?, ?)').run(user.id, partner.id, content.trim());
  res.json({ success: true });
});

// ── Mod routes ────────────────────────────────────────────────────────────────

function checkMod(req, res) {
  const pw = req.query.password || req.body?.password;
  if (!isMaster(pw)) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

app.get('/api/mod/users', (req, res) => {
  if (!checkMod(req, res)) return;
  const users = db.prepare(`
    SELECT u.id, u.username, u.color, u.is_mod, u.muted, u.banned, u.ban_reason, u.created_at,
      COUNT(m.id) as message_count
    FROM users u
    LEFT JOIN messages m ON m.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

app.get('/api/mod/rooms', (req, res) => {
  if (!checkMod(req, res)) return;
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.server_message, r.created_at,
           u.username as creator_name
    FROM rooms r LEFT JOIN users u ON r.creator_id = u.id
    ORDER BY r.is_general DESC, r.message_count DESC
  `).all();
  res.json(rooms);
});

app.get('/api/mod/ips', (req, res) => {
  if (!checkMod(req, res)) return;
  const ips = db.prepare(`
    SELECT il.ip, COUNT(*) as event_count, MAX(il.created_at) as last_seen,
      GROUP_CONCAT(DISTINCT u.username) as usernames_raw,
      CASE WHEN bi.ip IS NOT NULL THEN 1 ELSE 0 END as banned
    FROM ip_log il
    LEFT JOIN users u ON il.user_id = u.id
    LEFT JOIN banned_ips bi ON il.ip = bi.ip
    GROUP BY il.ip
    ORDER BY last_seen DESC
  `).all();
  res.json(ips.map(i => ({ ...i, usernames: i.usernames_raw ? i.usernames_raw.split(',') : [] })));
});

app.get('/api/mod/ip/:ip/messages', (req, res) => {
  if (!checkMod(req, res)) return;
  const ip = decodeURIComponent(req.params.ip);
  const userIds = db.prepare('SELECT DISTINCT user_id FROM ip_log WHERE ip = ?').all(ip).map(r => r.user_id);
  if (!userIds.length) return res.json([]);
  const placeholders = userIds.map(() => '?').join(',');
  const msgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.username, r.name as room_name, il.ip
    FROM messages m
    JOIN rooms r ON m.room_id = r.id
    LEFT JOIN ip_log il ON il.user_id = m.user_id
    WHERE m.user_id IN (${placeholders})
    ORDER BY m.created_at DESC LIMIT 100
  `).all(...userIds);
  res.json(msgs);
});

app.get('/api/mod/users/:id/messages', (req, res) => {
  if (!checkMod(req, res)) return;
  const msgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.username, r.name as room_name,
           (SELECT il.ip FROM ip_log il WHERE il.user_id = m.user_id ORDER BY il.created_at DESC LIMIT 1) as ip
    FROM messages m JOIN rooms r ON m.room_id = r.id
    WHERE m.user_id = ?
    ORDER BY m.created_at DESC LIMIT 100
  `).all(req.params.id);
  res.json(msgs);
});

app.get('/api/mod/log', (req, res) => {
  if (!checkMod(req, res)) return;
  const logs = db.prepare('SELECT * FROM mod_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(logs);
});

app.post('/api/mod/users/:id/ban', (req, res) => {
  if (!checkMod(req, res)) return;
  const { reason } = req.body;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason || '', req.params.id);
  if (user) modLog('ban_user', user.username, reason || '');
  res.json({ success: true });
});

app.post('/api/mod/users/:id/unban', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET banned = 0, ban_reason = "" WHERE id = ?').run(req.params.id);
  if (user) modLog('unban_user', user.username);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/mute', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET muted = 1 WHERE id = ?').run(req.params.id);
  if (user) modLog('mute_user', user.username);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/unmute', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET muted = 0 WHERE id = ?').run(req.params.id);
  if (user) modLog('unmute_user', user.username);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/setmod', (req, res) => {
  if (!checkMod(req, res)) return;
  const { is_mod } = req.body;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET is_mod = ? WHERE id = ?').run(is_mod ? 1 : 0, req.params.id);
  if (user) modLog(is_mod ? 'grant_mod' : 'revoke_mod', user.username);
  res.json({ success: true });
});

app.delete('/api/mod/users/:id', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM direct_messages WHERE sender_id = ? OR receiver_id = ?').run(req.params.id, req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (user) modLog('delete_user', user.username);
  res.json({ success: true });
});

app.delete('/api/mod/users/:id/messages', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.params.id);
  db.prepare('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id)').run();
  if (user) modLog('clear_messages', user.username);
  res.json({ success: true });
});

app.delete('/api/mod/rooms/:id', (req, res) => {
  if (!checkMod(req, res)) return;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (room.is_general) return res.status(403).json({ error: 'Cannot delete General' });
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  modLog('delete_room', room.name);
  res.json({ success: true });
});

app.delete('/api/mod/messages/:id', (req, res) => {
  if (!checkMod(req, res)) return;
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id)').run();
  modLog('delete_message', '#' + req.params.id);
  res.json({ success: true });
});

app.post('/api/mod/ban-ip', (req, res) => {
  if (!checkMod(req, res)) return;
  const { ip, reason } = req.body;
  db.prepare('INSERT OR REPLACE INTO banned_ips (ip, reason) VALUES (?, ?)').run(ip, reason || '');
  modLog('ban_ip', ip, reason || '');
  res.json({ success: true });
});

app.post('/api/mod/unban-ip', (req, res) => {
  if (!checkMod(req, res)) return;
  const { ip } = req.body;
  db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(ip);
  modLog('unban_ip', ip);
  res.json({ success: true });
});

// Set server message from mod panel
app.post('/api/mod/rooms/:id/server-message', (req, res) => {
  if (!checkMod(req, res)) return;
  const { message } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  db.prepare('UPDATE rooms SET server_message = ? WHERE id = ?').run(message || '', room.id);
  modLog('set_server_msg', room.name, message ? message.slice(0, 60) : '(cleared)');
  res.json({ success: true });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.post('/api/admin/reset', (req, res) => {
  const { password } = req.body;
  if (!isMaster(password)) return res.status(403).json({ error: 'Forbidden' });
  resetMessages();
  modLog('force_reset', 'all rooms');
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
