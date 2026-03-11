const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('/app/data/chat.db');

const MASTER_PASSWORD = '582624';
const MSG_CAP = 200; // max messages kept per room (no daily wipe needed)

app.use(cors());
app.use(express.json());

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#44aaff', banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, muted INTEGER NOT NULL DEFAULT 0, is_mod INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT DEFAULT '', creator_id INTEGER, password TEXT, is_private INTEGER NOT NULL DEFAULT 0, is_general INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(creator_id) REFERENCES users(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#44aaff', content TEXT NOT NULL, ip TEXT, is_system INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(room_id) REFERENCES rooms(id), FOREIGN KEY(user_id) REFERENCES users(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS banned_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL UNIQUE, reason TEXT, banned_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS mod_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

// Indexes for fast trim & lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_username ON ip_log(username)`);

// Upgrade existing DB safely
try { db.exec(`ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN ban_reason TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_mod INTEGER NOT NULL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN ip TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`); } catch(e) {}

// Seed General room
if (!db.prepare('SELECT id FROM rooms WHERE is_general = 1').get()) {
  db.prepare(`INSERT INTO rooms (name, description, is_general, is_private) VALUES ('General', 'The main chat. Always here.', 1, 0)`).run();
}

// ── Fast trim — uses index, no subquery list ──────────────────────────────────
// Keeps the newest MSG_CAP messages per room by deleting anything with an id
// lower than the (COUNT - MSG_CAP)-th oldest id. Single indexed range delete.
const trimRoom = db.transaction((roomId) => {
  const row = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_id = ?').get(roomId);
  if (row.c <= MSG_CAP) return;
  // Find the id of the (excess)-th oldest message — delete everything below it
  const excess = row.c - MSG_CAP;
  const cutoff = db.prepare(
    'SELECT id FROM messages WHERE room_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?'
  ).get(roomId, excess);
  if (cutoff) {
    db.prepare('DELETE FROM messages WHERE room_id = ? AND id < ?').run(roomId, cutoff.id);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function isMaster(pw) { return pw === MASTER_PASSWORD; }
function getUser(username, password) { return db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password); }
function getUserByName(username) { return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username); }
function getClientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }
function isIpBanned(ip) { return !!db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(ip); }
function logIp(ip, userId, username, action) { db.prepare('INSERT INTO ip_log (ip, user_id, username, action) VALUES (?, ?, ?, ?)').run(ip, userId, username, action); }
function modLog(action, target, detail) { db.prepare('INSERT INTO mod_log (action, target, detail) VALUES (?, ?, ?)').run(action, target, detail || null); }
function isMod(user) { return user && (user.is_mod === 1 || isMaster(user.password)); }
function requireMaster(req, res, next) {
  const pw = req.body?.password || req.query?.password;
  if (!isMaster(pw)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Parse command args — quoted first arg supported e.g. /ban "John Doe" reason
function parseArgs(argStr) {
  argStr = argStr.trim();
  if (argStr.startsWith('"')) {
    const end = argStr.indexOf('"', 1);
    if (end !== -1) {
      const name = argStr.slice(1, end);
      const rest = argStr.slice(end + 1).trim();
      return [name, ...rest.split(' ').filter(Boolean)];
    }
  }
  return argStr.split(' ').filter(Boolean);
}

function postSystemMessage(roomId, content) {
  if (!db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId)) return;
  db.pragma('foreign_keys = OFF');
  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content, is_system) VALUES (?, 0, ?, ?, ?, 1)')
    .run(roomId, 'System', '#888899', content);
  db.pragma('foreign_keys = ON');
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(roomId);
  trimRoom(roomId);
}

// ── User routes ───────────────────────────────────────────────────────────────
app.post('/api/users/register', (req, res) => {
  const { username, password, color } = req.body;
  const ip = getClientIp(req);
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP has been banned.' });
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username must be 2-24 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username taken' });
  const userColor = color || '#44aaff';
  const result = db.prepare('INSERT INTO users (username, password, color) VALUES (?, ?, ?)').run(username, password, userColor);
  logIp(ip, result.lastInsertRowid, username, 'register');
  res.json({ success: true, id: result.lastInsertRowid, username, color: userColor, is_mod: 0 });
});

app.post('/api/users/login', (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP has been banned.' });
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  if (user.banned) return res.status(403).json({ error: `You are banned.${user.ban_reason ? ' Reason: ' + user.ban_reason : ''}` });
  logIp(ip, user.id, user.username, 'login');
  res.json({ success: true, id: user.id, username: user.username, color: user.color, is_mod: user.is_mod });
});

app.put('/api/users/:id', (req, res) => {
  const { currentPassword, newUsername, newPassword, color } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!isMaster(currentPassword) && user.password !== currentPassword) return res.status(403).json({ error: 'Wrong password' });
  if (newUsername && newUsername !== user.username) {
    if (newUsername.length < 2 || newUsername.length > 24) return res.status(400).json({ error: 'Username must be 2-24 characters' });
    if (db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, user.id)) return res.status(409).json({ error: 'Username taken' });
  }
  const u = newUsername || user.username, p = newPassword || user.password, c = color || user.color;
  db.prepare('UPDATE users SET username = ?, password = ?, color = ? WHERE id = ?').run(u, p, c, user.id);
  res.json({ success: true, id: user.id, username: u, color: c, is_mod: user.is_mod });
});

// ── Room routes ───────────────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.created_at, u.username as creator_name FROM rooms r LEFT JOIN users u ON r.creator_id = u.id ORDER BY r.is_general DESC, r.message_count DESC, r.created_at DESC`).all();
  res.json(rooms.map(r => ({ ...r, locked: r.is_private === 1 })));
});

app.post('/api/rooms', (req, res) => {
  const { name, description, creatorUsername, creatorPassword, roomPassword, isPrivate } = req.body;
  const ip = getClientIp(req);
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP has been banned.' });
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Room name must be 2-32 characters' });
  const creator = getUser(creatorUsername, creatorPassword);
  if (!creator) return res.status(401).json({ error: 'Invalid credentials' });
  if (creator.banned) return res.status(403).json({ error: 'You are banned' });
  if (db.prepare('SELECT id FROM rooms WHERE name = ?').get(name)) return res.status(409).json({ error: 'A room with that name already exists' });
  if (isPrivate && !roomPassword) return res.status(400).json({ error: 'Private rooms need a password' });
  const result = db.prepare('INSERT INTO rooms (name, description, creator_id, password, is_private) VALUES (?, ?, ?, ?, ?)').run(name, description || '', creator.id, roomPassword || null, isPrivate ? 1 : 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete('/api/rooms/:id', (req, res) => {
  const { password } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_general) return res.status(403).json({ error: 'Cannot delete the General room' });
  if (!isMaster(password) && room.password !== password) return res.status(403).json({ error: 'Wrong password' });
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  res.json({ success: true });
});

// ── Message routes ────────────────────────────────────────────────────────────
app.get('/api/rooms/:id/messages', (req, res) => {
  const { roomPassword } = req.query;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) return res.status(403).json({ error: 'Wrong room password' });
  res.json(db.prepare(`SELECT id, username, color, content, is_system, created_at FROM messages WHERE room_id = ? ORDER BY id ASC LIMIT 150`).all(req.params.id));
});

app.post('/api/rooms/:id/messages', (req, res) => {
  const { username, password, content, roomPassword } = req.body;
  const ip = getClientIp(req);
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: `You are banned.${user.ban_reason ? ' Reason: ' + user.ban_reason : ''}` });
  if (user.muted) return res.status(403).json({ error: 'You are muted.' });
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP has been banned.' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) return res.status(403).json({ error: 'Wrong room password' });

  // ── Slash commands ──────────────────────────────────────────────────────────
  const trimmed = content.trim();
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parseArgs(parts.slice(1).join(' '));

    if (cmd === 'help') {
      const modCmds = isMod(user) ? `\n  /ban <user> [reason]\n  /unban <user>\n  /mute <user>\n  /unmute <user>\n  /ipban <user> [reason]\n  /ipunban <ip>\n  /kick <user>\n  /clearchat\n  /delete <user>` : '';
      postSystemMessage(room.id, `Available commands:${modCmds}\n  /help — show this list`);
      return res.json({ success: true });
    }

    if (!isMod(user)) {
      postSystemMessage(room.id, `❌ You don't have permission to use /${cmd}.`);
      return res.json({ success: true });
    }

    const needTarget = (cmdName, usage) => {
      if (!args[0]) { postSystemMessage(room.id, `Usage: ${usage}`); return true; }
      return false;
    };
    const noUser = (name) => { postSystemMessage(room.id, `❌ User "${name}" not found.`); };
    const bump = () => db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);

    if (cmd === 'ban') {
      if (needTarget('ban', '/ban <username> [reason]')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      const reason = args.slice(1).join(' ') || null;
      db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason, target.id);
      modLog('ban_user', target.username, `by ${user.username}${reason ? ': ' + reason : ''}`);
      postSystemMessage(room.id, `🔨 ${target.username} has been banned.${reason ? ' Reason: ' + reason : ''}`);
      return res.json({ success: true });
    }

    if (cmd === 'unban') {
      if (needTarget('unban', '/unban <username>')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(target.id);
      modLog('unban_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `✅ ${target.username} has been unbanned.`);
      return res.json({ success: true });
    }

    if (cmd === 'mute') {
      if (needTarget('mute', '/mute <username>')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      db.prepare('UPDATE users SET muted = 1 WHERE id = ?').run(target.id);
      modLog('mute_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🔇 ${target.username} has been muted.`);
      return res.json({ success: true });
    }

    if (cmd === 'unmute') {
      if (needTarget('unmute', '/unmute <username>')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      db.prepare('UPDATE users SET muted = 0 WHERE id = ?').run(target.id);
      modLog('unmute_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🔊 ${target.username} has been unmuted.`);
      return res.json({ success: true });
    }

    if (cmd === 'ipban') {
      if (needTarget('ipban', '/ipban <username> [reason]')) return res.json({ success: true });
      const reason = args.slice(1).join(' ') || null;
      const ipEntry = db.prepare('SELECT ip FROM ip_log WHERE username = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1').get(args[0]);
      if (!ipEntry) { postSystemMessage(room.id, `❌ No IP found for "${args[0]}".`); return res.json({ success: true }); }
      db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason) VALUES (?, ?)').run(ipEntry.ip, reason);
      modLog('ban_ip', ipEntry.ip, `for ${args[0]} by ${user.username}`);
      postSystemMessage(room.id, `🚫 IP for ${args[0]} has been banned.`);
      return res.json({ success: true });
    }

    if (cmd === 'ipunban') {
      if (needTarget('ipunban', '/ipunban <ip>')) return res.json({ success: true });
      db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(args[0]);
      modLog('unban_ip', args[0], `by ${user.username}`);
      postSystemMessage(room.id, `✅ IP ${args[0]} has been unbanned.`);
      return res.json({ success: true });
    }

    if (cmd === 'kick') {
      if (needTarget('kick', '/kick <username>')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run('Kicked', target.id);
      setTimeout(() => db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(target.id), 3000);
      modLog('kick_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `👢 ${target.username} has been kicked.`);
      return res.json({ success: true });
    }

    if (cmd === 'clearchat') {
      db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
      db.prepare('UPDATE rooms SET message_count = 0 WHERE id = ?').run(room.id);
      modLog('clear_room', room.name, `by ${user.username}`);
      postSystemMessage(room.id, `🧹 Chat cleared by ${user.username}.`);
      return res.json({ success: true });
    }

    if (cmd === 'delete') {
      if (needTarget('delete', '/delete <username>')) return res.json({ success: true });
      const target = getUserByName(args[0]);
      if (!target) { noUser(args[0]); return res.json({ success: true }); }
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      modLog('delete_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🗑️ Account "${target.username}" has been deleted.`);
      return res.json({ success: true });
    }

    postSystemMessage(room.id, `❓ Unknown command "/${cmd}". Type /help for a list.`);
    return res.json({ success: true });
  }

  // Normal message
  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content, ip) VALUES (?, ?, ?, ?, ?, ?)').run(room.id, user.id, user.username, user.color, content.trim(), ip);
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
  logIp(ip, user.id, user.username, 'message');

  // Trim old messages — fast indexed delete, no lag
  trimRoom(room.id);

  res.json({ success: true });
});

// ── Admin reset (manual only — no more scheduled wipe) ────────────────────────
app.post('/api/admin/reset', (req, res) => {
  if (!isMaster(req.body.password)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM messages').run();
  db.prepare('UPDATE rooms SET message_count = 0').run();
  modLog('force_reset', 'all', null);
  console.log(`[${new Date().toISOString()}] Manual reset by admin.`);
  res.json({ success: true });
});

// ── Mod routes ────────────────────────────────────────────────────────────────
app.get('/api/mod/users', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare(`SELECT u.id, u.username, u.color, u.banned, u.ban_reason, u.muted, u.is_mod, u.created_at, COUNT(m.id) as message_count FROM users u LEFT JOIN messages m ON m.user_id = u.id GROUP BY u.id ORDER BY u.created_at DESC`).all());
});

app.get('/api/mod/ips', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  const ips = db.prepare(`SELECT ip, GROUP_CONCAT(DISTINCT username) as usernames, COUNT(*) as event_count, MAX(created_at) as last_seen FROM ip_log GROUP BY ip ORDER BY last_seen DESC`).all();
  const banned = db.prepare('SELECT ip FROM banned_ips').all().map(r => r.ip);
  res.json(ips.map(row => ({ ...row, usernames: row.usernames ? row.usernames.split(',') : [], banned: banned.includes(row.ip) })));
});

app.get('/api/mod/banned-ips', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT * FROM banned_ips ORDER BY banned_at DESC').all());
});

app.get('/api/mod/log', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT * FROM mod_log ORDER BY created_at DESC LIMIT 200').all());
});

app.get('/api/mod/users/:id/messages', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare(`SELECT m.id, m.content, m.created_at, m.ip, r.name as room_name FROM messages m LEFT JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 100`).all(req.params.id));
});

app.get('/api/mod/ip/:ip/messages', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare(`SELECT m.id, m.username, m.content, m.created_at, r.name as room_name FROM messages m LEFT JOIN rooms r ON r.id = m.room_id WHERE m.ip = ? ORDER BY m.created_at DESC LIMIT 100`).all(req.params.ip));
});

app.post('/api/mod/users/:id/ban', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(req.body.reason || null, user.id);
  modLog('ban_user', user.username, req.body.reason || null);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/unban', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(user.id);
  modLog('unban_user', user.username, null);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/mute', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET muted = 1 WHERE id = ?').run(user.id);
  modLog('mute_user', user.username, null);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/unmute', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET muted = 0 WHERE id = ?').run(user.id);
  modLog('unmute_user', user.username, null);
  res.json({ success: true });
});

app.post('/api/mod/users/:id/setmod', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const val = req.body.is_mod ? 1 : 0;
  db.prepare('UPDATE users SET is_mod = ? WHERE id = ?').run(val, user.id);
  modLog(val ? 'grant_mod' : 'revoke_mod', user.username, null);
  res.json({ success: true });
});

app.delete('/api/mod/users/:id', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  modLog('delete_user', user.username, null);
  res.json({ success: true });
});

app.post('/api/mod/ban-ip', requireMaster, (req, res) => {
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason) VALUES (?, ?)').run(ip, reason || null);
  modLog('ban_ip', ip, reason || null);
  res.json({ success: true });
});

app.post('/api/mod/unban-ip', requireMaster, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(ip);
  modLog('unban_ip', ip, null);
  res.json({ success: true });
});

app.delete('/api/mod/messages/:id', requireMaster, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  db.prepare('UPDATE rooms SET message_count = MAX(0, message_count - 1) WHERE id = ?').run(msg.room_id);
  modLog('delete_message', msg.username, msg.content.substring(0, 60));
  res.json({ success: true });
});

app.delete('/api/mod/users/:id/messages', requireMaster, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(user.id);
  modLog('clear_messages', user.username, null);
  res.json({ success: true });
});

app.get('/api/mod/rooms', (req, res) => {
  if (!isMaster(req.query.password)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare(`SELECT r.*, u.username as creator_name FROM rooms r LEFT JOIN users u ON r.creator_id = u.id ORDER BY r.is_general DESC, r.message_count DESC`).all());
});

app.delete('/api/mod/rooms/:id', requireMaster, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_general) return res.status(403).json({ error: 'Cannot delete General' });
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  modLog('delete_room', room.name, null);
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//  DM TABLE + TRIM + DAILY RESET
// ════════════════════════════════════════════════
const DM_CAP = 100; // max messages per DM convo

db.exec(`
  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    convo_key TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    sender_color TEXT NOT NULL DEFAULT '#44aaff',
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_dms_convo ON dms(convo_key, id)`);

// Canonical key so user 3↔7 and user 7↔3 map to the same convo
function dmKey(id1, id2) {
  return id1 < id2 ? `${id1}_${id2}` : `${id2}_${id1}`;
}

const trimDm = db.transaction((key) => {
  const row = db.prepare('SELECT COUNT(*) as c FROM dms WHERE convo_key = ?').get(key);
  if (row.c <= DM_CAP) return;
  const excess = row.c - DM_CAP;
  const cutoff = db.prepare('SELECT id FROM dms WHERE convo_key = ? ORDER BY id ASC LIMIT 1 OFFSET ?').get(key, excess);
  if (cutoff) db.prepare('DELETE FROM dms WHERE convo_key = ? AND id < ?').run(key, cutoff.id);
});

// Daily reset — wipes ALL dms at midnight UTC
function resetDms() {
  db.prepare('DELETE FROM dms').run();
  console.log(`[${new Date().toISOString()}] Daily DM reset done.`);
}
function scheduleDmReset() {
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { resetDms(); scheduleDmReset(); }, next - new Date());
}
scheduleDmReset();

// GET /api/users — list all users (for contacts list), no passwords exposed
app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT id, username, color FROM users WHERE banned = 0 ORDER BY username ASC COLLATE NOCASE').all());
});

// GET /api/dm/:myId/:theirId — fetch conversation  { myPassword required as query param }
app.get('/api/dm/:myId/:theirId', (req, res) => {
  const { password } = req.query;
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.myId);
  if (!me || me.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (me.banned) return res.status(403).json({ error: 'You are banned' });
  const them = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(req.params.theirId);
  if (!them) return res.status(404).json({ error: 'User not found' });
  const key = dmKey(me.id, them.id);
  const messages = db.prepare(
    'SELECT id, sender_id, sender_name, sender_color, content, created_at FROM dms WHERE convo_key = ? ORDER BY id ASC LIMIT 150'
  ).all(key);
  res.json({ messages, them });
});

// POST /api/dm/:myId/:theirId — send a message
app.post('/api/dm/:myId/:theirId', (req, res) => {
  const { password, content } = req.body;
  const ip = getClientIp(req);
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP has been banned.' });
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.myId);
  if (!me || me.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (me.banned) return res.status(403).json({ error: `You are banned.${me.ban_reason ? ' Reason: ' + me.ban_reason : ''}` });
  if (me.muted) return res.status(403).json({ error: 'You are muted.' });
  const them = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.theirId);
  if (!them) return res.status(404).json({ error: 'User not found' });
  if (me.id === them.id) return res.status(400).json({ error: "Can't DM yourself" });
  const key = dmKey(me.id, them.id);
  const result = db.prepare(
    'INSERT INTO dms (convo_key, sender_id, sender_name, sender_color, content) VALUES (?, ?, ?, ?, ?)'
  ).run(key, me.id, me.username, me.color, content.trim());
  logIp(ip, me.id, me.username, 'dm');
  trimDm(key);
  res.json({ success: true, id: result.lastInsertRowid });
});

// GET /api/dm/:myId/inbox — list all convos the user has participated in (for sidebar)
app.get('/api/dm/:myId/inbox', (req, res) => {
  const { password } = req.query;
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.myId);
  if (!me || me.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  // Find all convo_keys involving this user — key format is "smallerId_largerId"
  const myId = me.id;
  const rows = db.prepare(`
    SELECT d.convo_key,
      MAX(d.id) as last_id,
      MAX(d.created_at) as last_at
    FROM dms d
    WHERE d.convo_key = (CAST(? AS TEXT) || '_' || CAST(d.sender_id AS TEXT))
       OR d.convo_key = (CAST(d.sender_id AS TEXT) || '_' || CAST(? AS TEXT))
       OR d.sender_id = ?
    GROUP BY d.convo_key
    ORDER BY last_id DESC
  `).all(myId, myId, myId);

  // Deduplicate and resolve partner for each convo
  const seen = new Set();
  const convos = [];
  for (const row of rows) {
    if (seen.has(row.convo_key)) continue;
    seen.add(row.convo_key);
    const [a, b] = row.convo_key.split('_').map(Number);
    if (a !== myId && b !== myId) continue; // safety check
    const partnerId = a === myId ? b : a;
    const partner = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(partnerId);
    const last = db.prepare('SELECT content, sender_name, created_at FROM dms WHERE convo_key = ? ORDER BY id DESC LIMIT 1').get(row.convo_key);
    if (partner) convos.push({ convo_key: row.convo_key, partner, last });
  }

  res.json(convos);
});


// ════════════════════════════════════════════════
//  SOCIAL — posts, likes, follows
// ════════════════════════════════════════════════
const POST_CAP = 500;

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#f1c40f',
    content TEXT NOT NULL,
    like_count INTEGER NOT NULL DEFAULT 0,
    reply_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(reply_to) REFERENCES posts(id) ON DELETE CASCADE
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS post_likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    PRIMARY KEY(user_id, post_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL,
    following_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(follower_id, following_id),
    FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts(reply_to)`);

// Daily reset of posts
function resetPosts() {
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM post_likes').run();
  console.log(`[${new Date().toISOString()}] Daily posts reset.`);
}
function schedulePostReset() {
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { resetPosts(); schedulePostReset(); }, next - new Date());
}
schedulePostReset();

// Trim oldest top-level posts when over cap
const trimPosts = db.transaction(() => {
  const row = db.prepare('SELECT COUNT(*) as c FROM posts WHERE reply_to IS NULL').get();
  if (row.c <= POST_CAP) return;
  const excess = row.c - POST_CAP;
  const cutoff = db.prepare('SELECT id FROM posts WHERE reply_to IS NULL ORDER BY id ASC LIMIT 1 OFFSET ?').get(excess);
  if (cutoff) db.prepare('DELETE FROM posts WHERE id <= ? OR reply_to <= ?').run(cutoff.id, cutoff.id);
});

function enrichPosts(posts, viewerId) {
  if (!posts.length) return [];
  const likedIds = viewerId
    ? new Set(db.prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${posts.map(()=>'?').join(',')})`).all(viewerId, ...posts.map(p=>p.id)).map(r=>r.post_id))
    : new Set();
  return posts.map(p => ({ ...p, liked: likedIds.has(p.id) }));
}

// GET /api/posts — global feed
app.get('/api/posts', (req, res) => {
  const viewerId = parseInt(req.query.userId) || null;
  const before = parseInt(req.query.before) || null;
  const limit = Math.min(parseInt(req.query.limit) || 30, 60);
  const posts = before
    ? db.prepare('SELECT * FROM posts WHERE reply_to IS NULL AND id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    : db.prepare('SELECT * FROM posts WHERE reply_to IS NULL ORDER BY id DESC LIMIT ?').all(limit);
  res.json(enrichPosts(posts, viewerId));
});

// GET /api/posts/user/:userId — profile posts
app.get('/api/posts/user/:userId', (req, res) => {
  const viewerId = parseInt(req.query.viewerId) || null;
  const user = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const posts = db.prepare('SELECT * FROM posts WHERE user_id = ? AND reply_to IS NULL ORDER BY id DESC LIMIT 60').all(req.params.userId);
  const followerCount = db.prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(req.params.userId).c;
  const followingCount = db.prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(req.params.userId).c;
  const isFollowing = viewerId ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewerId, req.params.userId) : false;
  res.json({ user, posts: enrichPosts(posts, viewerId), followerCount, followingCount, isFollowing });
});

// GET /api/posts/:id — single post + replies
app.get('/api/posts/:id', (req, res) => {
  const viewerId = parseInt(req.query.userId) || null;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const replies = db.prepare('SELECT * FROM posts WHERE reply_to = ? ORDER BY id ASC LIMIT 100').all(req.params.id);
  res.json({ post: enrichPosts([post], viewerId)[0], replies: enrichPosts(replies, viewerId) });
});

// POST /api/posts — create post or reply
app.post('/api/posts', (req, res) => {
  const { userId, password, content, replyTo } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
  if (content.length > 500) return res.status(400).json({ error: 'Max 500 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'You are banned' });
  if (user.muted) return res.status(403).json({ error: 'You are muted' });
  if (replyTo && !db.prepare('SELECT id FROM posts WHERE id = ?').get(replyTo)) return res.status(404).json({ error: 'Parent post not found' });
  const result = db.prepare(
    'INSERT INTO posts (user_id, username, color, content, reply_to) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, user.username, user.color, content.trim(), replyTo || null);
  if (!replyTo) trimPosts();
  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/posts/:id
app.delete('/api/posts/:id', (req, res) => {
  const { userId, password } = req.body;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (post.user_id !== user.id && !isMod(user)) return res.status(403).json({ error: 'Not your post' });
  db.prepare('DELETE FROM posts WHERE id = ? OR reply_to = ?').run(post.id, post.id);
  res.json({ success: true });
});

// POST /api/posts/:id/like — toggle like
app.post('/api/posts/:id/like', (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const existing = db.prepare('SELECT 1 FROM post_likes WHERE user_id = ? AND post_id = ?').get(user.id, post.id);
  if (existing) {
    db.prepare('DELETE FROM post_likes WHERE user_id = ? AND post_id = ?').run(user.id, post.id);
    db.prepare('UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id = ?').run(post.id);
    res.json({ liked: false, likes: Math.max(0, post.like_count - 1) });
  } else {
    db.prepare('INSERT OR IGNORE INTO post_likes (user_id, post_id) VALUES (?, ?)').run(user.id, post.id);
    db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(post.id);
    res.json({ liked: true, likes: post.like_count + 1 });
  }
});

// POST /api/follows — toggle follow
app.post('/api/follows', (req, res) => {
  const { userId, password, targetId } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.id === parseInt(targetId)) return res.status(400).json({ error: "Can not follow yourself" });
  const existing = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(user.id, targetId);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(user.id, targetId);
    res.json({ following: false });
  } else {
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(user.id, targetId);
    res.json({ following: true });
  }
});

// GET /api/posts/feed/:userId — following feed
app.get('/api/posts/feed/:userId', (req, res) => {
  const { password } = req.query;
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!me || me.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const ids = db.prepare('SELECT following_id FROM follows WHERE follower_id = ?').all(me.id).map(r => r.following_id);
  if (!ids.length) return res.json([]);
  const ph = ids.map(() => '?').join(',');
  const posts = db.prepare(`SELECT * FROM posts WHERE user_id IN (${ph}) AND reply_to IS NULL ORDER BY id DESC LIMIT 60`).all(...ids);
  res.json(enrichPosts(posts, me.id));
});


// ════════════════════════════════════════════════
//  WHITEBOARD — shared drawing boards
// ════════════════════════════════════════════════
const WB_STROKE_CAP = 2000; // max strokes per board before oldest trimmed
const WB_BOARDS_CAP = 50;   // max total boards

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT 'Untitled',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS strokes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT 'Guest',
    color TEXT NOT NULL DEFAULT '#4fc3f7',
    width INTEGER NOT NULL DEFAULT 4,
    points TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_strokes_board ON strokes(board_id, id)`);

// Daily reset of boards
function resetBoards() {
  db.prepare('DELETE FROM strokes').run();
  db.prepare('DELETE FROM boards').run();
  console.log(`[${new Date().toISOString()}] Daily boards reset.`);
}
function scheduleBoardReset() {
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { resetBoards(); scheduleBoardReset(); }, next - new Date());
}
scheduleBoardReset();

function genCode() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

function trimStrokes(boardId) {
  const row = db.prepare('SELECT COUNT(*) as c FROM strokes WHERE board_id = ?').get(boardId);
  if (row.c <= WB_STROKE_CAP) return;
  const excess = row.c - WB_STROKE_CAP;
  const cutoff = db.prepare('SELECT id FROM strokes WHERE board_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?').get(boardId, excess);
  if (cutoff) db.prepare('DELETE FROM strokes WHERE board_id = ? AND id < ?').run(boardId, cutoff.id);
}

// GET /api/boards — list all public boards
app.get('/api/boards', (req, res) => {
  const boards = db.prepare(`
    SELECT b.id, b.room_code, b.name, b.updated_at,
      COUNT(s.id) as stroke_count
    FROM boards b
    LEFT JOIN strokes s ON s.board_id = b.id
    GROUP BY b.id
    ORDER BY b.updated_at DESC
    LIMIT 50
  `).all();
  res.json(boards);
});

// POST /api/boards — create a new board
app.post('/api/boards', (req, res) => {
  const { name } = req.body;
  // trim total boards if over cap
  const total = db.prepare('SELECT COUNT(*) as c FROM boards').get().c;
  if (total >= WB_BOARDS_CAP) {
    const oldest = db.prepare('SELECT id FROM boards ORDER BY updated_at ASC LIMIT 1').get();
    if (oldest) {
      db.prepare('DELETE FROM strokes WHERE board_id = ?').run(oldest.id);
      db.prepare('DELETE FROM boards WHERE id = ?').run(oldest.id);
    }
  }
  let code = genCode();
  // ensure unique
  while (db.prepare('SELECT id FROM boards WHERE room_code = ?').get(code)) code = genCode();
  const result = db.prepare('INSERT INTO boards (room_code, name) VALUES (?, ?)').run(code, (name || 'Untitled').slice(0,40));
  res.json({ success: true, id: result.lastInsertRowid, room_code: code });
});

// GET /api/boards/:code — get board + all strokes since ?after=id
app.get('/api/boards/:code', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE room_code = ?').get(req.params.code);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  const after = parseInt(req.query.after) || 0;
  const strokes = db.prepare(
    'SELECT id, username, color, width, points FROM strokes WHERE board_id = ? AND id > ? ORDER BY id ASC'
  ).all(board.id, after);
  res.json({ board, strokes });
});

// POST /api/boards/:code/strokes — add a stroke
app.post('/api/boards/:code/strokes', (req, res) => {
  const { username, color, width, points, userId, password } = req.body;
  if (!points || !Array.isArray(points) || points.length < 2) return res.status(400).json({ error: 'Invalid stroke' });
  const board = db.prepare('SELECT * FROM boards WHERE room_code = ?').get(req.params.code);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  // Optional auth — if userId+password provided, use real username
  let finalUsername = (username || 'Guest').slice(0, 24);
  let finalUserId = null;
  if (userId && password) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user && user.password === password && !user.banned) {
      finalUsername = user.username;
      finalUserId = user.id;
    }
  }
  const finalColor = (color || '#4fc3f7').slice(0,7);
  const finalWidth = Math.min(Math.max(parseInt(width)||4, 1), 40);
  const result = db.prepare(
    'INSERT INTO strokes (board_id, user_id, username, color, width, points) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(board.id, finalUserId, finalUsername, finalColor, finalWidth, JSON.stringify(points));
  db.prepare('UPDATE boards SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(board.id);
  trimStrokes(board.id);
  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/boards/:code/strokes — clear board (auth required, any valid user)
app.delete('/api/boards/:code/strokes', (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const board = db.prepare('SELECT * FROM boards WHERE room_code = ?').get(req.params.code);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  db.prepare('DELETE FROM strokes WHERE board_id = ?').run(board.id);
  db.prepare('UPDATE boards SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(board.id);
  res.json({ success: true });
});

// DELETE /api/boards/:code — delete whole board
app.delete('/api/boards/:code', (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const board = db.prepare('SELECT * FROM boards WHERE room_code = ?').get(req.params.code);
  if (!board) return res.status(404).json({ error: 'Board not found' });
  db.prepare('DELETE FROM strokes WHERE board_id = ?').run(board.id);
  db.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
  res.json({ success: true });
});


// ════════════════════════════════════════════════
//  VIDEOS — shared video links (YouTube / Vimeo)
// ════════════════════════════════════════════════
const VIDEO_CAP = 200; // max videos stored total

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT 'Anonymous',
    color TEXT NOT NULL DEFAULT '#e74c3c',
    title TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    embed_url TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'youtube',
    like_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS video_likes (
    user_id INTEGER NOT NULL,
    video_id INTEGER NOT NULL,
    PRIMARY KEY(user_id, video_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS video_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#e74c3c',
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_id ON videos(id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_video_comments_vid ON video_comments(video_id)`);

// Daily reset
function resetVideos() {
  db.prepare('DELETE FROM video_comments').run();
  db.prepare('DELETE FROM video_likes').run();
  db.prepare('DELETE FROM videos').run();
  console.log(`[${new Date().toISOString()}] Daily videos reset.`);
}
function scheduleVideoReset() {
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { resetVideos(); scheduleVideoReset(); }, next - new Date());
}
scheduleVideoReset();

function trimVideos() {
  const row = db.prepare('SELECT COUNT(*) as c FROM videos').get();
  if (row.c <= VIDEO_CAP) return;
  const excess = row.c - VIDEO_CAP;
  const cutoff = db.prepare('SELECT id FROM videos ORDER BY id ASC LIMIT 1 OFFSET ?').get(excess);
  if (cutoff) {
    db.prepare('DELETE FROM video_comments WHERE video_id <= ?').run(cutoff.id);
    db.prepare('DELETE FROM video_likes WHERE video_id <= ?').run(cutoff.id);
    db.prepare('DELETE FROM videos WHERE id <= ?').run(cutoff.id);
  }
}

// Parse URL -> {provider, embedUrl, videoId}
function parseVideoUrl(url) {
  url = url.trim();
  // YouTube
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/);
  if (m) return { provider: 'youtube', videoId: m[1], embedUrl: `https://www.youtube.com/embed/${m[1]}?rel=0` };
  // YouTube shorts
  m = url.match(/youtube\.com\/shorts\/([\w-]{11})/);
  if (m) return { provider: 'youtube', videoId: m[1], embedUrl: `https://www.youtube.com/embed/${m[1]}?rel=0` };
  // Vimeo
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return { provider: 'vimeo', videoId: m[1], embedUrl: `https://player.vimeo.com/video/${m[1]}` };
  return null;
}

function enrichVideos(videos, viewerId) {
  if (!videos.length) return [];
  const likedIds = viewerId
    ? new Set(db.prepare(`SELECT video_id FROM video_likes WHERE user_id = ? AND video_id IN (${videos.map(()=>'?').join(',')})`).all(viewerId, ...videos.map(v=>v.id)).map(r=>r.video_id))
    : new Set();
  return videos.map(v => ({ ...v, liked: likedIds.has(v.id) }));
}

// GET /api/videos — list all videos newest first
app.get('/api/videos', (req, res) => {
  const viewerId = parseInt(req.query.userId) || null;
  const before = parseInt(req.query.before) || null;
  const limit = Math.min(parseInt(req.query.limit) || 24, 60);
  const videos = before
    ? db.prepare('SELECT * FROM videos WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
    : db.prepare('SELECT * FROM videos ORDER BY id DESC LIMIT ?').all(limit);
  res.json(enrichVideos(videos, viewerId));
});

// GET /api/videos/top — most liked
app.get('/api/videos/top', (req, res) => {
  const viewerId = parseInt(req.query.userId) || null;
  const videos = db.prepare('SELECT * FROM videos ORDER BY like_count DESC, id DESC LIMIT 24').all();
  res.json(enrichVideos(videos, viewerId));
});

// GET /api/videos/:id — single video + comments
app.get('/api/videos/:id', (req, res) => {
  const viewerId = parseInt(req.query.userId) || null;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  db.prepare('UPDATE videos SET view_count = view_count + 1 WHERE id = ?').run(video.id);
  const comments = db.prepare('SELECT * FROM video_comments WHERE video_id = ? ORDER BY id ASC LIMIT 100').all(video.id);
  res.json({ video: enrichVideos([video], viewerId)[0], comments });
});

// POST /api/videos — submit a video
app.post('/api/videos', (req, res) => {
  const { userId, password, url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const parsed = parseVideoUrl(url);
  if (!parsed) return res.status(400).json({ error: 'Only YouTube and Vimeo URLs are supported' });
  let username = 'Anonymous', userColor = '#e74c3c', finalUserId = null;
  if (userId && password) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'You are banned' });
    username = user.username; userColor = user.color; finalUserId = user.id;
  }
  const finalTitle = (title || '').trim().slice(0, 100) || 'Untitled';
  const result = db.prepare(
    'INSERT INTO videos (user_id, username, color, title, url, embed_url, provider) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(finalUserId, username, userColor, finalTitle, url.trim(), parsed.embedUrl, parsed.provider);
  trimVideos();
  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/videos/:id
app.delete('/api/videos/:id', (req, res) => {
  const { userId, password } = req.body;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (userId && password) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    if (video.user_id !== user.id && !isMod(user)) return res.status(403).json({ error: 'Not your video' });
  } else {
    return res.status(401).json({ error: 'Login required to delete' });
  }
  db.prepare('DELETE FROM video_comments WHERE video_id = ?').run(video.id);
  db.prepare('DELETE FROM video_likes WHERE video_id = ?').run(video.id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  res.json({ success: true });
});

// POST /api/videos/:id/like — toggle like (auth required)
app.post('/api/videos/:id/like', (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const existing = db.prepare('SELECT 1 FROM video_likes WHERE user_id = ? AND video_id = ?').get(user.id, video.id);
  if (existing) {
    db.prepare('DELETE FROM video_likes WHERE user_id = ? AND video_id = ?').run(user.id, video.id);
    db.prepare('UPDATE videos SET like_count = MAX(0, like_count - 1) WHERE id = ?').run(video.id);
    res.json({ liked: false, likes: Math.max(0, video.like_count - 1) });
  } else {
    db.prepare('INSERT OR IGNORE INTO video_likes (user_id, video_id) VALUES (?, ?)').run(user.id, video.id);
    db.prepare('UPDATE videos SET like_count = like_count + 1 WHERE id = ?').run(video.id);
    res.json({ liked: true, likes: video.like_count + 1 });
  }
});

// POST /api/videos/:id/comments
app.post('/api/videos/:id/comments', (req, res) => {
  const { userId, password, content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Comment required' });
  if (content.length > 500) return res.status(400).json({ error: 'Max 500 chars' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'You are banned' });
  if (user.muted) return res.status(403).json({ error: 'You are muted' });
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const result = db.prepare(
    'INSERT INTO video_comments (video_id, user_id, username, color, content) VALUES (?, ?, ?, ?, ?)'
  ).run(video.id, user.id, user.username, user.color, content.trim());
  // Trim comments per video to 100
  const ccount = db.prepare('SELECT COUNT(*) as c FROM video_comments WHERE video_id = ?').get(video.id).c;
  if (ccount > 100) {
    const cutoff = db.prepare('SELECT id FROM video_comments WHERE video_id = ? ORDER BY id ASC LIMIT 1').get(video.id);
    if (cutoff) db.prepare('DELETE FROM video_comments WHERE id = ?').run(cutoff.id);
  }
  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/videos/:id/comments/:cid
app.delete('/api/videos/:id/comments/:cid', (req, res) => {
  const { userId, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const comment = db.prepare('SELECT * FROM video_comments WHERE id = ?').get(req.params.cid);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.user_id !== user.id && !isMod(user)) return res.status(403).json({ error: 'Not your comment' });
  db.prepare('DELETE FROM video_comments WHERE id = ?').run(comment.id);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
