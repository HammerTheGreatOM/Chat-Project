const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();

// ════════════════════════════════════════════════════════════
//  ★ EDITABLE CONFIG — also changeable at runtime via mod panel
// ════════════════════════════════════════════════════════════
const CONFIG_FILE = path.join(__dirname, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
  return { masterPassword: '582624' };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();
function isMaster(pw) { return pw === config.masterPassword; }
// ════════════════════════════════════════════════════════════

const db = new Database('chat.db');
app.use(cors());
app.use(express.json());

// Trust proxy for real IPs (works on Render/Railway)
app.set('trust proxy', true);

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

// Whitelist: per-room list of allowed users (if empty, all allowed)
db.exec(`
  CREATE TABLE IF NOT EXISTS room_whitelist (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(room_id, user_id),
    FOREIGN KEY(room_id) REFERENCES rooms(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

// Per-room mutes (room_id=0 means global mute)
db.exec(`
  CREATE TABLE IF NOT EXISTS room_mutes (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(room_id, user_id)
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

// Migrations for existing DBs
['server_message TEXT DEFAULT ""'].forEach(col => {
  try { db.exec(`ALTER TABLE rooms ADD COLUMN ${col}`); } catch(e) {}
});

// ── Seed ─────────────────────────────────────────────────────────────────────

// Reserve "Server" username
const serverUser = db.prepare("SELECT id FROM users WHERE username = 'Server' COLLATE NOCASE").get();
if (!serverUser) {
  db.prepare("INSERT INTO users (username, password, color, is_mod) VALUES ('Server', '__server__', '#7c6dfa', 1)").run();
}

const existing = db.prepare('SELECT id FROM rooms WHERE is_general = 1').get();
if (!existing) {
  db.prepare(`INSERT INTO rooms (name, description, is_general, is_private) VALUES ('General', 'The main chat. Always here.', 1, 0)`).run();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClientIp(req) {
  // Use req.ip which respects 'trust proxy' setting — gives real client IP
  return req.ip || 'unknown';
}

function logIp(req, userId, event = 'action') {
  try {
    const ip = getClientIp(req);
    db.prepare('INSERT INTO ip_log (ip, user_id, event) VALUES (?, ?, ?)').run(ip, userId, event);
    return ip;
  } catch(e) { return 'unknown'; }
}

function isIpBanned(req) {
  const ip = getClientIp(req);
  return !!db.prepare('SELECT ip FROM banned_ips WHERE ip = ?').get(ip);
}

function modLog(action, target, detail = '') {
  db.prepare('INSERT INTO mod_log (action, target, detail) VALUES (?, ?, ?)').run(action, target, detail);
}

function getUser(username, password) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND password = ?').get(username, password);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function isRoomCreator(userId, roomId) {
  const room = db.prepare('SELECT creator_id FROM rooms WHERE id = ?').get(roomId);
  return room && room.creator_id === userId;
}

function isWhitelistEnabled(roomId) {
  const count = db.prepare('SELECT COUNT(*) as c FROM room_whitelist WHERE room_id = ?').get(roomId);
  return count && count.c > 0;
}

function isUserWhitelisted(userId, roomId) {
  if (!isWhitelistEnabled(roomId)) return true; // whitelist empty = open
  return !!db.prepare('SELECT 1 FROM room_whitelist WHERE room_id = ? AND user_id = ?').get(roomId, userId);
}

function isUserMutedInRoom(userId, roomId) {
  return !!db.prepare('SELECT 1 FROM room_mutes WHERE (room_id = ? OR room_id = 0) AND user_id = ?').get(roomId, userId);
}

function postSystemMessage(roomId, text) {
  const serverUser = db.prepare("SELECT id FROM users WHERE username = 'Server' COLLATE NOCASE").get();
  if (!serverUser) return;
  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content, is_system) VALUES (?, ?, ?, ?, ?, 1)')
    .run(roomId, serverUser.id, 'Server', '#7c6dfa', text);
}

// ── Daily reset ───────────────────────────────────────────────────────────────

function resetMessages() {
  db.prepare('DELETE FROM messages').run();
  db.prepare('UPDATE rooms SET message_count = 0').run();
  console.log(`[${new Date().toISOString()}] Daily reset.`);
}

function scheduleNextReset() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(() => { resetMessages(); scheduleNextReset(); }, msUntil);
  console.log(`Next reset in ${Math.round(msUntil / 1000 / 60)} minutes.`);
}
scheduleNextReset();

// ── User routes ───────────────────────────────────────────────────────────────

app.get('/api/users', (req, res) => {
  const users = db.prepare("SELECT id, username, color FROM users WHERE banned = 0 AND username != 'Server' COLLATE NOCASE").all();
  res.json(users);
});

app.post('/api/users/register', (req, res) => {
  if (isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.trim().toLowerCase() === 'server') return res.status(400).json({ error: '"Server" is a reserved username' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });
  const userColor = color || '#44aaff';
  const result = db.prepare('INSERT INTO users (username, password, color) VALUES (?, ?, ?)').run(username.trim(), password, userColor);
  logIp(req, result.lastInsertRowid, 'register');
  res.json({ success: true, id: result.lastInsertRowid, username: username.trim(), color: userColor });
});

app.post('/api/users/login', (req, res) => {
  if (isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
  const { username, password } = req.body;
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  if (user.banned) return res.status(403).json({ error: 'Account banned' + (user.ban_reason ? ': ' + user.ban_reason : '') });
  logIp(req, user.id, 'login');
  res.json({ success: true, id: user.id, username: user.username, color: user.color, is_mod: user.is_mod });
});

app.put('/api/users/:id', (req, res) => {
  const { currentPassword, newUsername, newPassword, color } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!isMaster(currentPassword) && user.password !== currentPassword) return res.status(403).json({ error: 'Wrong password' });
  if (newUsername) {
    if (newUsername.trim().toLowerCase() === 'server') return res.status(400).json({ error: '"Server" is a reserved username' });
    if (newUsername.length < 2 || newUsername.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
    const taken = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(newUsername, user.id);
    if (taken) return res.status(409).json({ error: 'Username taken' });
  }
  const updatedUsername = newUsername || user.username;
  const updatedPassword = newPassword || user.password;
  const updatedColor = color || user.color;
  db.prepare('UPDATE users SET username = ?, password = ?, color = ? WHERE id = ?').run(updatedUsername, updatedPassword, updatedColor, user.id);
  res.json({ success: true, id: user.id, username: updatedUsername, color: updatedColor, is_mod: user.is_mod });
});

// ── Room routes ───────────────────────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.server_message, r.created_at,
           u.username as creator_name, r.creator_id
    FROM rooms r LEFT JOIN users u ON r.creator_id = u.id
    ORDER BY r.is_general DESC, r.message_count DESC, r.created_at DESC
  `).all();
  res.json(rooms.map(r => ({ ...r, locked: r.is_private === 1 })));
});

app.post('/api/rooms', (req, res) => {
  const { name, description, creatorUsername, creatorPassword, roomPassword, isPrivate, serverMessage } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Room name must be 2–32 characters' });
  const creator = getUser(creatorUsername, creatorPassword);
  if (!creator) return res.status(401).json({ error: 'Invalid credentials' });
  const exists = db.prepare('SELECT id FROM rooms WHERE name = ? COLLATE NOCASE').get(name);
  if (exists) return res.status(409).json({ error: 'A room with that name already exists' });
  if (isPrivate && !roomPassword) return res.status(400).json({ error: 'Private rooms need a password' });
  const result = db.prepare(
    'INSERT INTO rooms (name, description, creator_id, password, is_private, server_message) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, description || '', creator.id, roomPassword || null, isPrivate ? 1 : 0, serverMessage || '');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete('/api/rooms/:id', (req, res) => {
  const { password } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_general) return res.status(403).json({ error: 'Cannot delete the General room' });
  if (!isMaster(password) && room.password !== password) return res.status(403).json({ error: 'Wrong password' });
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM room_whitelist WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM room_mutes WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  res.json({ success: true });
});

// Get room whitelist
app.get('/api/rooms/:id/whitelist', (req, res) => {
  const { roomPassword, password, username, userPassword } = req.query;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  // Allow room creator, master, or whitelisted users to see list
  const list = db.prepare('SELECT u.id, u.username, u.color FROM room_whitelist rw JOIN users u ON rw.user_id = u.id WHERE rw.room_id = ?').all(req.params.id);
  res.json({ enabled: isWhitelistEnabled(parseInt(req.params.id)), users: list });
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
    WHERE room_id = ? ORDER BY created_at ASC LIMIT 200
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

  const roomId = parseInt(req.params.id);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
    return res.status(403).json({ error: 'Wrong room password' });
  }

  // Whitelist check
  if (!isMaster(password) && !isUserWhitelisted(user.id, roomId) && !isRoomCreator(user.id, roomId)) {
    return res.status(403).json({ error: 'You are not whitelisted in this room' });
  }

  // Mute check (room-specific or global)
  if (isUserMutedInRoom(user.id, roomId)) return res.status(403).json({ error: 'You are muted in this room' });

  // ── Command handling ────────────────────────────────────────────────────────
  const trimmed = content.trim();
  if (trimmed.startsWith('/')) {
    return handleCommand(req, res, user, room, trimmed, roomPassword);
  }

  db.prepare('INSERT INTO messages (room_id, user_id, username, color, content) VALUES (?, ?, ?, ?, ?)').run(roomId, user.id, user.username, user.color, trimmed);
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(roomId);
  logIp(req, user.id);
  res.json({ success: true });
});

// ── Command engine ────────────────────────────────────────────────────────────

function parseArgs(str) {
  // Parses: /cmd "quoted arg" bare_arg
  const args = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) args.push(m[1] || m[2]);
  return args; // args[0] = command, args[1..] = params
}

function handleCommand(req, res, user, room, content, roomPassword) {
  const args = parseArgs(content);
  const cmd = args[0].toLowerCase();
  const isCreator = isRoomCreator(user.id, room.id);
  const isMod = user.is_mod === 1;
  const isMasterUser = isMaster(user.password) || isMaster(roomPassword);

  // Helper to check if caller has permission for a command
  function canMod() { return isMod || isMasterUser; }
  function canCreator() { return isCreator || isMod || isMasterUser; }

  // /help
  if (cmd === '/help') {
    const lines = ['/help — show commands'];
    if (canCreator()) {
      lines.push('/ban "user" [reason] — ban from THIS room');
      lines.push('/unban "user" — unban from THIS room');
      lines.push('/mute "user" — mute in THIS room');
      lines.push('/unmute "user" — unmute in THIS room');
      lines.push('/delete — delete a message (shows picker)');
      lines.push('/whitelist "user" — add user to whitelist');
      lines.push('/unwhitelist "user" — remove user from whitelist');
      lines.push('/setmsg "message" — set server message');
      lines.push('/clearmsg — clear server message');
    }
    if (canMod()) {
      lines.push('/globalban "user" [reason] — ban globally');
      lines.push('/globalunban "user" — unban globally');
      lines.push('/globalmute "user" — mute globally');
      lines.push('/globalunmute "user" — unmute globally');
      lines.push('/makemod "user" — grant mod');
      lines.push('/removemod "user" — revoke mod');
      lines.push('/clearchat — clear all messages in this room');
    }
    postSystemMessage(room.id, lines.join('\n'));
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    return res.json({ success: true });
  }

  // Room-creator commands (only affect THIS room)
  if (cmd === '/ban' || cmd === '/unban' || cmd === '/mute' || cmd === '/unmute') {
    if (!canCreator()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: `Usage: ${cmd} "username"` });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    if (target.id === user.id) return res.status(400).json({ error: "Can't do that to yourself" });

    if (cmd === '/ban') {
      const reason = args.slice(2).join(' ') || '';
      // Room ban = mute in this room (can't send) + blacklist from whitelist
      db.prepare('INSERT OR IGNORE INTO room_mutes (room_id, user_id) VALUES (?, ?)').run(room.id, target.id);
      postSystemMessage(room.id, `${target.username} has been banned from this room.${reason ? ' Reason: ' + reason : ''}`);
      modLog('room_ban', target.username, `room:${room.name}`);
    } else if (cmd === '/unban') {
      db.prepare('DELETE FROM room_mutes WHERE room_id = ? AND user_id = ?').run(room.id, target.id);
      postSystemMessage(room.id, `${target.username} has been unbanned from this room.`);
      modLog('room_unban', target.username, `room:${room.name}`);
    } else if (cmd === '/mute') {
      db.prepare('INSERT OR IGNORE INTO room_mutes (room_id, user_id) VALUES (?, ?)').run(room.id, target.id);
      postSystemMessage(room.id, `${target.username} has been muted in this room.`);
      modLog('room_mute', target.username, `room:${room.name}`);
    } else if (cmd === '/unmute') {
      db.prepare('DELETE FROM room_mutes WHERE room_id = ? AND user_id = ?').run(room.id, target.id);
      postSystemMessage(room.id, `${target.username} has been unmuted in this room.`);
      modLog('room_unmute', target.username, `room:${room.name}`);
    }
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    return res.json({ success: true });
  }

  // /whitelist and /unwhitelist (creator or mod)
  if (cmd === '/whitelist' || cmd === '/unwhitelist') {
    if (!canCreator()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: `Usage: ${cmd} "username"` });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    if (cmd === '/whitelist') {
      db.prepare('INSERT OR IGNORE INTO room_whitelist (room_id, user_id) VALUES (?, ?)').run(room.id, target.id);
      // Also add creator to whitelist to not lock them out
      db.prepare('INSERT OR IGNORE INTO room_whitelist (room_id, user_id) VALUES (?, ?)').run(room.id, user.id);
      postSystemMessage(room.id, `${target.username} has been added to the whitelist.`);
      modLog('whitelist_add', target.username, `room:${room.name}`);
    } else {
      db.prepare('DELETE FROM room_whitelist WHERE room_id = ? AND user_id = ?').run(room.id, target.id);
      postSystemMessage(room.id, `${target.username} has been removed from the whitelist.`);
      modLog('whitelist_remove', target.username, `room:${room.name}`);
    }
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    return res.json({ success: true });
  }

  // /setmsg and /clearmsg (creator or mod)
  if (cmd === '/setmsg' || cmd === '/clearmsg') {
    if (!canCreator()) return res.status(403).json({ error: 'No permission' });
    const msg = cmd === '/setmsg' ? args.slice(1).join(' ') : '';
    db.prepare('UPDATE rooms SET server_message = ? WHERE id = ?').run(msg, room.id);
    postSystemMessage(room.id, msg ? `Server message updated.` : `Server message cleared.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('set_server_msg', room.name, msg.slice(0, 60));
    return res.json({ success: true });
  }

  // /delete — returns list of messages for frontend to pick from
  if (cmd === '/delete') {
    if (!canCreator()) return res.status(403).json({ error: 'No permission' });
    const msgs = db.prepare('SELECT id, username, content, created_at FROM messages WHERE room_id = ? AND is_system = 0 ORDER BY created_at DESC LIMIT 50').all(room.id);
    return res.json({ success: true, action: 'show_delete_picker', messages: msgs });
  }

  // /clearchat — mod/master only
  if (cmd === '/clearchat') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
    db.prepare('UPDATE rooms SET message_count = 0 WHERE id = ?').run(room.id);
    postSystemMessage(room.id, `Chat was cleared by a moderator.`);
    db.prepare('UPDATE rooms SET message_count = 1 WHERE id = ?').run(room.id);
    modLog('clear_messages', room.name);
    return res.json({ success: true });
  }

  // Global mod commands
  if (cmd === '/globalban') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1]; const reason = args.slice(2).join(' ') || '';
    if (!targetName) return res.status(400).json({ error: 'Usage: /globalban "username" [reason]' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason, target.id);
    postSystemMessage(room.id, `${target.username} has been globally banned.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('ban_user', target.username, reason);
    return res.json({ success: true });
  }

  if (cmd === '/globalunban') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: 'Usage: /globalunban "username"' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('UPDATE users SET banned = 0, ban_reason = "" WHERE id = ?').run(target.id);
    postSystemMessage(room.id, `${target.username} has been globally unbanned.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('unban_user', target.username);
    return res.json({ success: true });
  }

  if (cmd === '/globalmute') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: 'Usage: /globalmute "username"' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('INSERT OR IGNORE INTO room_mutes (room_id, user_id) VALUES (0, ?)').run(target.id);
    postSystemMessage(room.id, `${target.username} has been globally muted.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('mute_user', target.username, 'global');
    return res.json({ success: true });
  }

  if (cmd === '/globalunmute') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: 'Usage: /globalunmute "username"' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('DELETE FROM room_mutes WHERE room_id = 0 AND user_id = ?').run(target.id);
    postSystemMessage(room.id, `${target.username} has been globally unmuted.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('unmute_user', target.username, 'global');
    return res.json({ success: true });
  }

  if (cmd === '/makemod') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: 'Usage: /makemod "username"' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('UPDATE users SET is_mod = 1 WHERE id = ?').run(target.id);
    postSystemMessage(room.id, `${target.username} has been made a moderator.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('grant_mod', target.username);
    return res.json({ success: true });
  }

  if (cmd === '/removemod') {
    if (!canMod()) return res.status(403).json({ error: 'No permission' });
    const targetName = args[1];
    if (!targetName) return res.status(400).json({ error: 'Usage: /removemod "username"' });
    const target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(targetName);
    if (!target) return res.status(404).json({ error: `User "${targetName}" not found` });
    db.prepare('UPDATE users SET is_mod = 0 WHERE id = ?').run(target.id);
    postSystemMessage(room.id, `${target.username}'s moderator status has been removed.`);
    db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
    modLog('revoke_mod', target.username);
    return res.json({ success: true });
  }

  // Unknown command
  postSystemMessage(room.id, `Unknown command: ${cmd}. Type /help for available commands.`);
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
  return res.json({ success: true });
}

// Delete a specific message (for /delete picker)
app.delete('/api/rooms/:roomId/messages/:msgId', (req, res) => {
  const { username, password, roomPassword } = req.body;
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const roomId = parseInt(req.params.roomId);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isCreator = isRoomCreator(user.id, roomId);
  if (!isCreator && !user.is_mod && !isMaster(password)) return res.status(403).json({ error: 'No permission' });
  db.prepare('DELETE FROM messages WHERE id = ? AND room_id = ?').run(req.params.msgId, roomId);
  db.prepare('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = ?) WHERE id = ?').run(roomId, roomId);
  res.json({ success: true });
});

// ── Direct Messages ───────────────────────────────────────────────────────────

app.get('/api/dm/:userId/inbox', (req, res) => {
  const { password } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
  const partners = db.prepare(`
    SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as partner_id,
      MAX(created_at) as last_time
    FROM direct_messages WHERE sender_id = ? OR receiver_id = ?
    GROUP BY partner_id ORDER BY last_time DESC
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

app.get('/api/dm/:userId/:partnerId', (req, res) => {
  const { password } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
  const partner = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(req.params.partnerId);
  if (!partner) return res.status(404).json({ error: 'User not found' });
  const messages = db.prepare(`
    SELECT dm.id, dm.sender_id, u.username as sender_name, dm.content, dm.created_at
    FROM direct_messages dm JOIN users u ON dm.sender_id = u.id
    WHERE (dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?)
    ORDER BY dm.created_at ASC LIMIT 200
  `).all(user.id, partner.id, partner.id, user.id);
  res.json({ them: partner, messages });
});

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

// ── Mod API ───────────────────────────────────────────────────────────────────

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
    FROM users u LEFT JOIN messages m ON m.user_id = u.id
    WHERE u.username != 'Server' COLLATE NOCASE
    GROUP BY u.id ORDER BY u.created_at DESC
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

app.get('/api/mod/rooms/:id/messages', (req, res) => {
  if (!checkMod(req, res)) return;
  const msgs = db.prepare(`
    SELECT m.id, m.username, m.color, m.content, m.is_system, m.created_at,
           r.name as room_name
    FROM messages m JOIN rooms r ON m.room_id = r.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC LIMIT 100
  `).all(req.params.id);
  res.json(msgs);
});

app.get('/api/mod/ips', (req, res) => {
  if (!checkMod(req, res)) return;
  const ips = db.prepare(`
    SELECT il.ip, COUNT(*) as event_count, MAX(il.created_at) as last_seen,
      GROUP_CONCAT(DISTINCT u.username) as usernames_raw,
      CASE WHEN bi.ip IS NOT NULL THEN 1 ELSE 0 END as banned,
      bi.reason as ban_reason
    FROM ip_log il
    LEFT JOIN users u ON il.user_id = u.id
    LEFT JOIN banned_ips bi ON il.ip = bi.ip
    GROUP BY il.ip ORDER BY last_seen DESC
  `).all();
  res.json(ips.map(i => ({ ...i, usernames: i.usernames_raw ? i.usernames_raw.split(',').filter(Boolean) : [] })));
});

app.get('/api/mod/ip/:ip/messages', (req, res) => {
  if (!checkMod(req, res)) return;
  const ip = decodeURIComponent(req.params.ip);
  const userIds = db.prepare('SELECT DISTINCT user_id FROM ip_log WHERE ip = ?').all(ip).map(r => r.user_id).filter(Boolean);
  if (!userIds.length) return res.json([]);
  const placeholders = userIds.map(() => '?').join(',');
  const msgs = db.prepare(`
    SELECT m.id, m.content, m.created_at, m.username, r.name as room_name
    FROM messages m JOIN rooms r ON m.room_id = r.id
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
    WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 100
  `).all(req.params.id);
  res.json(msgs);
});

app.get('/api/mod/log', (req, res) => {
  if (!checkMod(req, res)) return;
  const logs = db.prepare('SELECT * FROM mod_log ORDER BY created_at DESC LIMIT 300').all();
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
  db.prepare('INSERT OR IGNORE INTO room_mutes (room_id, user_id) VALUES (0, ?)').run(req.params.id);
  if (user) modLog('mute_user', user.username, 'global');
  res.json({ success: true });
});

app.post('/api/mod/users/:id/unmute', (req, res) => {
  if (!checkMod(req, res)) return;
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM room_mutes WHERE room_id = 0 AND user_id = ?').run(req.params.id);
  if (user) modLog('unmute_user', user.username, 'global');
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
  db.prepare('DELETE FROM room_whitelist WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM room_mutes WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id)').run();
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
  db.prepare('DELETE FROM room_whitelist WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM room_mutes WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  modLog('delete_room', room.name);
  res.json({ success: true });
});

app.delete('/api/mod/messages/:id', (req, res) => {
  if (!checkMod(req, res)) return;
  const msg = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  if (msg) db.prepare('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = ?) WHERE id = ?').run(msg.room_id, msg.room_id);
  modLog('delete_message', '#' + req.params.id);
  res.json({ success: true });
});

app.post('/api/mod/ban-ip', (req, res) => {
  if (!checkMod(req, res)) return;
  const { ip, reason } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
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

app.post('/api/mod/rooms/:id/server-message', (req, res) => {
  if (!checkMod(req, res)) return;
  const { message } = req.body;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  db.prepare('UPDATE rooms SET server_message = ? WHERE id = ?').run(message || '', room.id);
  modLog('set_server_msg', room.name, (message || '').slice(0, 60));
  res.json({ success: true });
});

// Change master password
app.post('/api/mod/change-password', (req, res) => {
  if (!checkMod(req, res)) return;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  config.masterPassword = newPassword;
  saveConfig(config);
  modLog('change_master_pw', 'system');
  res.json({ success: true });
});

// Get current IP of caller (for diagnostics)
app.get('/api/mod/my-ip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

app.post('/api/admin/reset', (req, res) => {
  const { password } = req.body;
  if (!isMaster(password)) return res.status(403).json({ error: 'Forbidden' });
  resetMessages();
  modLog('force_reset', 'all rooms');
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
