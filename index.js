const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('chat.db');

const MASTER_PASSWORD = '582624';

app.use(cors());
app.use(express.json());

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#44aaff', banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, muted INTEGER NOT NULL DEFAULT 0, is_mod INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT DEFAULT '', creator_id INTEGER, password TEXT, is_private INTEGER NOT NULL DEFAULT 0, is_general INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(creator_id) REFERENCES users(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#44aaff', content TEXT NOT NULL, ip TEXT, is_system INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(room_id) REFERENCES rooms(id), FOREIGN KEY(user_id) REFERENCES users(id))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, action TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS banned_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL UNIQUE, reason TEXT, banned_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS mod_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

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

// ── Daily reset ───────────────────────────────────────────────────────────────
function resetMessages() {
  db.prepare('DELETE FROM messages').run();
  db.prepare('UPDATE rooms SET message_count = 0').run();
  console.log(`[${new Date().toISOString()}] Daily reset done.`);
}
function scheduleNextReset() {
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(() => { resetMessages(); scheduleNextReset(); }, next - new Date());
}
scheduleNextReset();

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
  // Use NULL for user_id on system messages — disable FK check temporarily
  db.pragma('foreign_keys = OFF');
  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content, is_system) VALUES (?, 0, ?, ?, ?, 1)')
    .run(roomId, 'System', '#888899', content);
  db.pragma('foreign_keys = ON');
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
  res.json(db.prepare(`SELECT id, username, color, content, is_system, created_at FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 200`).all(req.params.id));
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

  // ── Slash command handling ──────────────────────────────────────────────────
  const trimmed = content.trim();
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const args = parseArgs(parts.slice(1).join(' '));

    // /help — available to everyone
    if (cmd === 'help') {
      const modCmds = user.is_mod ? `\n  /ban <user> [reason]\n  /unban <user>\n  /mute <user>\n  /unmute <user>\n  /ipban <user> [reason]\n  /ipunban <ip>\n  /kick <user>\n  /clearchat\n  /delete <user>` : '';
      postSystemMessage(room.id, `Available commands:${modCmds}\n  /help — show this list\nMod commands are marked above.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    // All other slash commands require mod
    if (!isMod(user)) {
      postSystemMessage(room.id, `❌ You don't have permission to use /${cmd}.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'ban') {
      const targetName = args[0];
      const reason = args.slice(1).join(' ') || null;
      if (!targetName) { postSystemMessage(room.id, `Usage: /ban <username> [reason]`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason, target.id);
      modLog('ban_user', target.username, `by ${user.username}${reason ? ': ' + reason : ''}`);
      postSystemMessage(room.id, `🔨 ${target.username} has been banned.${reason ? ' Reason: ' + reason : ''}`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'unban') {
      const targetName = args[0];
      if (!targetName) { postSystemMessage(room.id, `Usage: /unban <username>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(target.id);
      modLog('unban_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `✅ ${target.username} has been unbanned.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'mute') {
      const targetName = args[0];
      if (!targetName) { postSystemMessage(room.id, `Usage: /mute <username>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('UPDATE users SET muted = 1 WHERE id = ?').run(target.id);
      modLog('mute_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🔇 ${target.username} has been muted.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'unmute') {
      const targetName = args[0];
      if (!targetName) { postSystemMessage(room.id, `Usage: /unmute <username>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('UPDATE users SET muted = 0 WHERE id = ?').run(target.id);
      modLog('unmute_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🔊 ${target.username} has been unmuted.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'ipban') {
      const targetName = args[0];
      const reason = args.slice(1).join(' ') || null;
      if (!targetName) { postSystemMessage(room.id, `Usage: /ipban <username> [reason]`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      // Find last known IP for this user
      const ipEntry = db.prepare('SELECT ip FROM ip_log WHERE username = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1').get(targetName);
      if (!ipEntry) { postSystemMessage(room.id, `❌ No IP found for "${targetName}".`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('INSERT OR IGNORE INTO banned_ips (ip, reason) VALUES (?, ?)').run(ipEntry.ip, reason);
      modLog('ban_ip', ipEntry.ip, `for ${targetName} by ${user.username}`);
      postSystemMessage(room.id, `🚫 IP for ${targetName} has been banned.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'ipunban') {
      const targetIp = args[0];
      if (!targetIp) { postSystemMessage(room.id, `Usage: /ipunban <ip>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(targetIp);
      modLog('unban_ip', targetIp, `by ${user.username}`);
      postSystemMessage(room.id, `✅ IP ${targetIp} has been unbanned.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'kick') {
      const targetName = args[0];
      if (!targetName) { postSystemMessage(room.id, `Usage: /kick <username>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      // Ban then immediately unban — forces them to re-login, session is broken
      db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run('Kicked', target.id);
      setTimeout(() => { db.prepare('UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?').run(target.id); }, 3000);
      modLog('kick_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `👢 ${target.username} has been kicked.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'clearchat') {
      db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
      db.prepare('UPDATE rooms SET message_count = 0 WHERE id = ?').run(room.id);
      modLog('clear_room', room.name, `by ${user.username}`);
      postSystemMessage(room.id, `🧹 Chat cleared by ${user.username}.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    if (cmd === 'delete') {
      const targetName = args[0];
      if (!targetName) { postSystemMessage(room.id, `Usage: /delete <username>`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      const target = getUserByName(targetName);
      if (!target) { postSystemMessage(room.id, `❌ User "${targetName}" not found.`); db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id); return res.json({ success: true }); }
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      modLog('delete_user', target.username, `by ${user.username}`);
      postSystemMessage(room.id, `🗑️ Account "${target.username}" has been deleted.`);
      db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
      return res.json({ success: true });
    }

    // Unknown command
    postSystemMessage(room.id, `❓ Unknown command "/${cmd}". Type /help for a list.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    return res.json({ success: true });
  }

  // Normal message
  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content, ip) VALUES (?, ?, ?, ?, ?, ?)').run(room.id, user.id, user.username, user.color, content.trim(), ip);
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
  logIp(ip, user.id, user.username, 'message');
  res.json({ success: true });
});

// ── Admin reset ───────────────────────────────────────────────────────────────
app.post('/api/admin/reset', (req, res) => {
  if (!isMaster(req.body.password)) return res.status(403).json({ error: 'Forbidden' });
  resetMessages();
  modLog('force_reset', 'all', null);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
