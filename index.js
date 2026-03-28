const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// ════════════════════════════════════════════════════════════
//  ★ EDITABLE CONFIG
// ════════════════════════════════════════════════════════════
let MASTER_PASSWORD = process.env.MASTER_PASSWORD || '582624';
// ════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json());
app.set('trust proxy', true);

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function q1(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] || null;
}

// ── Schema ────────────────────────────────────────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#44aaff',
      is_mod INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      creator_id INTEGER REFERENCES users(id),
      password TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      is_general INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      server_message TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      username TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#44aaff',
      content TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_whitelist (
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (room_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_mutes (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (room_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_log (
      id SERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      user_id INTEGER,
      event TEXT DEFAULT 'login',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS banned_ips (
      ip TEXT PRIMARY KEY,
      reason TEXT DEFAULT '',
      banned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mod_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed Server user
  const serverUser = await q1(`SELECT id FROM users WHERE LOWER(username) = 'server'`);
  if (!serverUser) {
    await pool.query(`INSERT INTO users (username, password, color, is_mod) VALUES ('Server', '__server__', '#7c6dfa', 1)`);
  }
  // Seed General room
  const general = await q1(`SELECT id FROM rooms WHERE is_general = 1`);
  if (!general) {
    await pool.query(`INSERT INTO rooms (name, description, is_general, is_private) VALUES ('General', 'The main chat. Always here.', 1, 0)`);
  }

  console.log('Database ready.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMaster(pw) { return pw === MASTER_PASSWORD; }
function getClientIp(req) { return req.ip || 'unknown'; }

async function logIp(req, userId, event = 'action') {
  try {
    const ip = getClientIp(req);
    await pool.query('INSERT INTO ip_log (ip, user_id, event) VALUES ($1, $2, $3)', [ip, userId, event]);
  } catch(e) {}
}

async function isIpBanned(req) {
  const ip = getClientIp(req);
  return !!(await q1('SELECT ip FROM banned_ips WHERE ip = $1', [ip]));
}

async function modLog(action, target, detail = '') {
  await pool.query('INSERT INTO mod_log (action, target, detail) VALUES ($1, $2, $3)', [action, target, detail]);
}

async function getUser(username, password) {
  return q1('SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND password = $2', [username, password]);
}

async function isRoomCreator(userId, roomId) {
  const room = await q1('SELECT creator_id FROM rooms WHERE id = $1', [roomId]);
  return room && room.creator_id === Number(userId);
}

async function isWhitelistEnabled(roomId) {
  const row = await q1('SELECT COUNT(*) as c FROM room_whitelist WHERE room_id = $1', [roomId]);
  return row ? Number(row.c) > 0 : false;
}

async function isUserWhitelisted(userId, roomId) {
  if (!await isWhitelistEnabled(roomId)) return true;
  return !!(await q1('SELECT 1 FROM room_whitelist WHERE room_id = $1 AND user_id = $2', [roomId, userId]));
}

async function isUserMutedInRoom(userId, roomId) {
  return !!(await q1('SELECT 1 FROM room_mutes WHERE (room_id = $1 OR room_id = 0) AND user_id = $2', [roomId, userId]));
}

async function postSystemMessage(roomId, text) {
  const serverUser = await q1(`SELECT id FROM users WHERE LOWER(username) = 'server'`);
  if (!serverUser) return;
  await pool.query(
    'INSERT INTO messages (room_id, user_id, username, color, content, is_system) VALUES ($1, $2, $3, $4, $5, 1)',
    [roomId, serverUser.id, 'Server', '#7c6dfa', text]
  );
}

// ── Daily reset ───────────────────────────────────────────────────────────────

async function resetMessages() {
  await pool.query('DELETE FROM messages');
  await pool.query('UPDATE rooms SET message_count = 0');
  console.log(`[${new Date().toISOString()}] Daily reset.`);
}

function scheduleNextReset() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(async () => { await resetMessages(); scheduleNextReset(); }, msUntil);
  console.log(`Next reset in ${Math.round(msUntil / 1000 / 60)} minutes.`);
}

// ── User routes ───────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
  try {
    const users = await q(`SELECT id, username, color FROM users WHERE banned = 0 AND LOWER(username) != 'server'`);
    res.json(users);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users/register', async (req, res) => {
  try {
    if (await isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
    const { username, password, color } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (username.trim().toLowerCase() === 'server') return res.status(400).json({ error: '"Server" is a reserved username' });
    if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const exists = await q1('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (exists) return res.status(409).json({ error: 'Username taken' });
    const userColor = color || '#44aaff';
    const result = await q1('INSERT INTO users (username, password, color) VALUES ($1, $2, $3) RETURNING id', [username.trim(), password, userColor]);
    await logIp(req, result.id, 'register');
    res.json({ success: true, id: result.id, username: username.trim(), color: userColor });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/users/login', async (req, res) => {
  try {
    if (await isIpBanned(req)) return res.status(403).json({ error: 'Access denied' });
    const { username, password } = req.body;
    const user = await getUser(username, password);
    if (!user) return res.status(401).json({ error: 'Wrong username or password' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' + (user.ban_reason ? ': ' + user.ban_reason : '') });
    await logIp(req, user.id, 'login');
    res.json({ success: true, id: user.id, username: user.username, color: user.color, is_mod: user.is_mod });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword, color } = req.body;
    const user = await q1('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!isMaster(currentPassword) && user.password !== currentPassword) return res.status(403).json({ error: 'Wrong password' });
    if (newUsername) {
      if (newUsername.trim().toLowerCase() === 'server') return res.status(400).json({ error: '"Server" is a reserved username' });
      if (newUsername.length < 2 || newUsername.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
      const taken = await q1('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [newUsername, user.id]);
      if (taken) return res.status(409).json({ error: 'Username taken' });
    }
    const updatedUsername = newUsername || user.username;
    const updatedPassword = newPassword || user.password;
    const updatedColor = color || user.color;
    await pool.query('UPDATE users SET username = $1, password = $2, color = $3 WHERE id = $4', [updatedUsername, updatedPassword, updatedColor, user.id]);
    res.json({ success: true, id: user.id, username: updatedUsername, color: updatedColor, is_mod: user.is_mod });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Room routes ───────────────────────────────────────────────────────────────

app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await q(`
      SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count,
             r.server_message, r.created_at, u.username as creator_name, r.creator_id
      FROM rooms r LEFT JOIN users u ON r.creator_id = u.id
      ORDER BY r.is_general DESC, r.message_count DESC, r.created_at DESC
    `);
    res.json(rooms.map(r => ({ ...r, locked: r.is_private === 1 })));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, description, creatorUsername, creatorPassword, roomPassword, isPrivate, serverMessage } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (name.length < 2 || name.length > 32) return res.status(400).json({ error: 'Room name must be 2–32 characters' });
    const creator = await getUser(creatorUsername, creatorPassword);
    if (!creator) return res.status(401).json({ error: 'Invalid credentials' });
    const exists = await q1('SELECT id FROM rooms WHERE LOWER(name) = LOWER($1)', [name]);
    if (exists) return res.status(409).json({ error: 'A room with that name already exists' });
    if (isPrivate && !roomPassword) return res.status(400).json({ error: 'Private rooms need a password' });
    const result = await q1(
      'INSERT INTO rooms (name, description, creator_id, password, is_private, server_message) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, description || '', creator.id, roomPassword || null, isPrivate ? 1 : 0, serverMessage || '']
    );
    res.json({ success: true, id: result.id });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/rooms/:id', async (req, res) => {
  try {
    const { password } = req.body;
    const room = await q1('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.is_general) return res.status(403).json({ error: 'Cannot delete the General room' });
    if (!isMaster(password) && room.password !== password) return res.status(403).json({ error: 'Wrong password' });
    await pool.query('DELETE FROM messages WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM room_whitelist WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM room_mutes WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/rooms/:id/whitelist', async (req, res) => {
  try {
    const roomId = req.params.id;
    const enabled = await isWhitelistEnabled(roomId);
    const users = await q('SELECT u.id, u.username, u.color FROM room_whitelist rw JOIN users u ON rw.user_id = u.id WHERE rw.room_id = $1', [roomId]);
    res.json({ enabled, users });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Message routes ────────────────────────────────────────────────────────────

app.get('/api/rooms/:id/messages', async (req, res) => {
  try {
    const { roomPassword } = req.query;
    const room = await q1('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
      return res.status(403).json({ error: 'Wrong room password' });
    }
    const messages = await q(
      'SELECT id, username, color, content, is_system, created_at FROM messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200',
      [req.params.id]
    );
    res.json(messages);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/rooms/:id/messages', async (req, res) => {
  try {
    const { username, password, content, roomPassword } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
    if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
    const user = await getUser(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) return res.status(403).json({ error: 'You are banned' });
    const roomId = Number(req.params.id);
    const room = await q1('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
      return res.status(403).json({ error: 'Wrong room password' });
    }
    const trimmed = content.trim();
    const isCommand = trimmed.startsWith('/');
    const isCreatorSending = await isRoomCreator(user.id, roomId);
    const isMasterSending = isMaster(password);
    const isModSending = user.is_mod === 1;
    if (!isCommand) {
      if (!isMasterSending && !isModSending && !isCreatorSending && !await isUserWhitelisted(user.id, roomId)) {
        return res.status(403).json({ error: 'You are not whitelisted in this room' });
      }
      if (await isUserMutedInRoom(user.id, roomId)) return res.status(403).json({ error: 'You are muted in this room' });
    }
    if (isCommand) return handleCommand(req, res, user, room, trimmed, password, roomPassword);
    await pool.query('INSERT INTO messages (room_id, user_id, username, color, content) VALUES ($1, $2, $3, $4, $5)', [roomId, user.id, user.username, user.color, trimmed]);
    await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [roomId]);
    await logIp(req, user.id);
    res.json({ success: true });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Command engine ────────────────────────────────────────────────────────────

function parseArgs(str) {
  const args = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) args.push(m[1] || m[2]);
  return args;
}

async function handleCommand(req, res, user, room, content, password, roomPassword) {
  const args = parseArgs(content);
  const cmd = args[0].toLowerCase();
  const isCreator = await isRoomCreator(user.id, room.id);
  const isMod = user.is_mod === 1;
  const isMasterUser = isMaster(password);
  function canMod() { return isMod || isMasterUser; }
  function canCreator() { return isCreator || isMod || isMasterUser; }

  try {
    if (cmd === '/help') {
      const lines = ['/help — show commands'];
      if (canCreator()) {
        lines.push('/ban "user" [reason] — ban from THIS room', '/unban "user" — unban from THIS room',
          '/mute "user" — mute in THIS room', '/unmute "user" — unmute in THIS room',
          '/whitelist "user" — add to whitelist', '/unwhitelist "user" — remove from whitelist',
          '/clearwhitelist — open room to everyone', '/whitelistinfo — show whitelist',
          '/setmsg "message" — set server message', '/clearmsg — clear server message',
          '/delete — delete a message (picker)');
      }
      if (canMod()) {
        lines.push('/globalban "user" [reason]', '/globalunban "user"',
          '/globalmute "user"', '/globalunmute "user"',
          '/makemod "user"', '/removemod "user"', '/clearchat');
      }
      await postSystemMessage(room.id, lines.join('\n'));
      await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
      return res.json({ success: true });
    }

    if (['/ban', '/unban', '/mute', '/unmute'].includes(cmd)) {
      if (!canCreator()) return res.status(403).json({ error: 'No permission' });
      const target = await q1('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [args[1]]);
      if (!args[1]) return res.status(400).json({ error: `Usage: ${cmd} "username"` });
      if (!target) return res.status(404).json({ error: `User "${args[1]}" not found` });
      if (target.id === user.id) return res.status(400).json({ error: "Can't do that to yourself" });
      if (cmd === '/ban') {
        const reason = args.slice(2).join(' ') || '';
        await pool.query('INSERT INTO room_mutes (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, target.id]);
        await postSystemMessage(room.id, `${target.username} has been banned from this room.${reason ? ' Reason: ' + reason : ''}`);
        await modLog('room_ban', target.username, `room:${room.name}`);
      } else if (cmd === '/unban') {
        await pool.query('DELETE FROM room_mutes WHERE room_id = $1 AND user_id = $2', [room.id, target.id]);
        await postSystemMessage(room.id, `${target.username} has been unbanned from this room.`);
      } else if (cmd === '/mute') {
        await pool.query('INSERT INTO room_mutes (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, target.id]);
        await postSystemMessage(room.id, `${target.username} has been muted in this room.`);
      } else {
        await pool.query('DELETE FROM room_mutes WHERE room_id = $1 AND user_id = $2', [room.id, target.id]);
        await postSystemMessage(room.id, `${target.username} has been unmuted in this room.`);
      }
      await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
      return res.json({ success: true });
    }

    if (['/whitelist', '/unwhitelist', '/clearwhitelist', '/whitelistinfo'].includes(cmd)) {
      if (!canCreator()) return res.status(403).json({ error: 'No permission' });
      if (cmd === '/clearwhitelist') {
        await pool.query('DELETE FROM room_whitelist WHERE room_id = $1', [room.id]);
        await postSystemMessage(room.id, `Whitelist cleared — room is now open to everyone.`);
      } else if (cmd === '/whitelistinfo') {
        const enabled = await isWhitelistEnabled(room.id);
        if (!enabled) {
          await postSystemMessage(room.id, `Whitelist OFF — anyone can chat. Use /whitelist "username" to enable it.`);
        } else {
          const rows = await q('SELECT u.username FROM room_whitelist rw JOIN users u ON rw.user_id = u.id WHERE rw.room_id = $1', [room.id]);
          await postSystemMessage(room.id, `Whitelist ON (${rows.length}): ${rows.map(r => r.username).join(', ')}\nUse /clearwhitelist to open to everyone.`);
        }
      } else {
        if (!args[1]) return res.status(400).json({ error: `Usage: ${cmd} "username"` });
        const target = await q1('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [args[1]]);
        if (!target) return res.status(404).json({ error: `User "${args[1]}" not found` });
        if (cmd === '/whitelist') {
          await pool.query('INSERT INTO room_whitelist (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, user.id]);
          await pool.query('INSERT INTO room_whitelist (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [room.id, target.id]);
          await postSystemMessage(room.id, `${target.username} added to whitelist. Room is now restricted. Use /clearwhitelist to open it back up.`);
          await modLog('whitelist_add', target.username, `room:${room.name}`);
        } else {
          if (target.id === user.id && isCreator) return res.status(400).json({ error: "Can't remove yourself — use /clearwhitelist instead" });
          await pool.query('DELETE FROM room_whitelist WHERE room_id = $1 AND user_id = $2', [room.id, target.id]);
          await postSystemMessage(room.id, `${target.username} removed from whitelist.`);
        }
      }
      await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
      return res.json({ success: true });
    }

    if (cmd === '/setmsg' || cmd === '/clearmsg') {
      if (!canCreator()) return res.status(403).json({ error: 'No permission' });
      const msg = cmd === '/setmsg' ? args.slice(1).join(' ') : '';
      await pool.query('UPDATE rooms SET server_message = $1 WHERE id = $2', [msg, room.id]);
      await postSystemMessage(room.id, msg ? `Server message updated.` : `Server message cleared.`);
      await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
      await modLog('set_server_msg', room.name, msg.slice(0, 60));
      return res.json({ success: true });
    }

    if (cmd === '/delete') {
      if (!canCreator()) return res.status(403).json({ error: 'No permission' });
      const msgs = await q('SELECT id, username, content, created_at FROM messages WHERE room_id = $1 AND is_system = 0 ORDER BY created_at DESC LIMIT 50', [room.id]);
      return res.json({ success: true, action: 'show_delete_picker', messages: msgs });
    }

    if (cmd === '/clearchat') {
      if (!canMod()) return res.status(403).json({ error: 'No permission' });
      await pool.query('DELETE FROM messages WHERE room_id = $1', [room.id]);
      await pool.query('UPDATE rooms SET message_count = 0 WHERE id = $1', [room.id]);
      await postSystemMessage(room.id, `Chat was cleared by a moderator.`);
      await pool.query('UPDATE rooms SET message_count = 1 WHERE id = $1', [room.id]);
      await modLog('clear_messages', room.name);
      return res.json({ success: true });
    }

    // Global mod commands
    for (const [c, action] of [['/globalban', 'ban'], ['/globalunban', 'unban'], ['/globalmute', 'mute'], ['/globalunmute', 'unmute'], ['/makemod', 'mod'], ['/removemod', 'unmod']]) {
      if (cmd !== c) continue;
      if (!canMod()) return res.status(403).json({ error: 'No permission' });
      if (!args[1]) return res.status(400).json({ error: `Usage: ${cmd} "username"` });
      const target = await q1('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [args[1]]);
      if (!target) return res.status(404).json({ error: `User "${args[1]}" not found` });
      const reason = args.slice(2).join(' ') || '';
      if (action === 'ban') { await pool.query('UPDATE users SET banned = 1, ban_reason = $1 WHERE id = $2', [reason, target.id]); await postSystemMessage(room.id, `${target.username} has been globally banned.`); await modLog('ban_user', target.username, reason); }
      if (action === 'unban') { await pool.query('UPDATE users SET banned = 0, ban_reason = $1 WHERE id = $2', ['', target.id]); await postSystemMessage(room.id, `${target.username} has been globally unbanned.`); await modLog('unban_user', target.username); }
      if (action === 'mute') { await pool.query('INSERT INTO room_mutes (room_id, user_id) VALUES (0, $1) ON CONFLICT DO NOTHING', [target.id]); await postSystemMessage(room.id, `${target.username} globally muted.`); await modLog('mute_user', target.username, 'global'); }
      if (action === 'unmute') { await pool.query('DELETE FROM room_mutes WHERE room_id = 0 AND user_id = $1', [target.id]); await postSystemMessage(room.id, `${target.username} globally unmuted.`); await modLog('unmute_user', target.username, 'global'); }
      if (action === 'mod') { await pool.query('UPDATE users SET is_mod = 1 WHERE id = $1', [target.id]); await postSystemMessage(room.id, `${target.username} is now a moderator.`); await modLog('grant_mod', target.username); }
      if (action === 'unmod') { await pool.query('UPDATE users SET is_mod = 0 WHERE id = $1', [target.id]); await postSystemMessage(room.id, `${target.username}'s mod status removed.`); await modLog('revoke_mod', target.username); }
      await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
      return res.json({ success: true });
    }

    await postSystemMessage(room.id, `Unknown command: ${cmd}. Type /help for commands.`);
    await pool.query('UPDATE rooms SET message_count = message_count + 1 WHERE id = $1', [room.id]);
    return res.json({ success: true });

  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
}

app.delete('/api/rooms/:roomId/messages/:msgId', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await getUser(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const roomId = Number(req.params.roomId);
    const isCreator = await isRoomCreator(user.id, roomId);
    if (!isCreator && !user.is_mod && !isMaster(password)) return res.status(403).json({ error: 'No permission' });
    await pool.query('DELETE FROM messages WHERE id = $1 AND room_id = $2', [req.params.msgId, roomId]);
    await pool.query('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = $1) WHERE id = $1', [roomId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Direct Messages ───────────────────────────────────────────────────────────

app.get('/api/dm/:userId/inbox', async (req, res) => {
  try {
    const { password } = req.query;
    const user = await q1('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
    const partners = await q(`
      SELECT DISTINCT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END as partner_id,
        MAX(created_at) as last_time
      FROM direct_messages WHERE sender_id = $1 OR receiver_id = $1
      GROUP BY partner_id ORDER BY last_time DESC
    `, [user.id]);
    const result = await Promise.all(partners.map(async p => {
      const partner = await q1('SELECT id, username, color FROM users WHERE id = $1', [p.partner_id]);
      if (!partner) return null;
      const last = await q1(`SELECT * FROM direct_messages WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1) ORDER BY created_at DESC LIMIT 1`, [user.id, p.partner_id]);
      return { partner, last };
    }));
    res.json(result.filter(Boolean));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/dm/:userId/:partnerId', async (req, res) => {
  try {
    const { password } = req.query;
    const user = await q1('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
    const partner = await q1('SELECT id, username, color FROM users WHERE id = $1', [req.params.partnerId]);
    if (!partner) return res.status(404).json({ error: 'User not found' });
    const messages = await q(`SELECT dm.id, dm.sender_id, u.username as sender_name, dm.content, dm.created_at FROM direct_messages dm JOIN users u ON dm.sender_id = u.id WHERE (dm.sender_id=$1 AND dm.receiver_id=$2) OR (dm.sender_id=$2 AND dm.receiver_id=$1) ORDER BY dm.created_at ASC LIMIT 200`, [user.id, partner.id]);
    res.json({ them: partner, messages });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/dm/:userId/:partnerId', async (req, res) => {
  try {
    const { password, content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Empty message' });
    const user = await q1('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Unauthorized' });
    if (user.banned) return res.status(403).json({ error: 'You are banned' });
    const partner = await q1('SELECT id FROM users WHERE id = $1', [req.params.partnerId]);
    if (!partner) return res.status(404).json({ error: 'User not found' });
    await pool.query('INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES ($1, $2, $3)', [user.id, partner.id, content.trim()]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Mod routes ────────────────────────────────────────────────────────────────

function checkMod(req, res) {
  const pw = req.query.password || req.body?.password;
  if (!isMaster(pw)) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

app.post('/api/mod/login', (req, res) => {
  const { password } = req.body;
  if (!isMaster(password)) return res.status(403).json({ error: 'Wrong password' });
  res.json({ success: true });
});

app.get('/api/mod/users', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const users = await q(`SELECT u.id, u.username, u.color, u.is_mod, u.banned, u.ban_reason, u.created_at, COUNT(m.id) as message_count FROM users u LEFT JOIN messages m ON m.user_id = u.id WHERE LOWER(u.username) != 'server' GROUP BY u.id ORDER BY u.created_at DESC`);
    res.json(users);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/rooms', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const rooms = await q(`SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.server_message, r.created_at, u.username as creator_name FROM rooms r LEFT JOIN users u ON r.creator_id = u.id ORDER BY r.is_general DESC, r.message_count DESC`);
    res.json(rooms);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/rooms/:id/messages', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const msgs = await q(`SELECT m.id, m.username, m.color, m.content, m.is_system, m.created_at, r.name as room_name FROM messages m JOIN rooms r ON m.room_id = r.id WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [req.params.id]);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/ips', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const ips = await q(`SELECT il.ip, COUNT(*) as event_count, MAX(il.created_at) as last_seen, STRING_AGG(DISTINCT u.username, ',') as usernames_raw, CASE WHEN bi.ip IS NOT NULL THEN 1 ELSE 0 END as banned, bi.reason as ban_reason FROM ip_log il LEFT JOIN users u ON il.user_id = u.id LEFT JOIN banned_ips bi ON il.ip = bi.ip GROUP BY il.ip, bi.ip, bi.reason ORDER BY last_seen DESC`);
    res.json(ips.map(i => ({ ...i, usernames: i.usernames_raw ? i.usernames_raw.split(',').filter(Boolean) : [] })));
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/ip/:ip/messages', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const ip = decodeURIComponent(req.params.ip);
    const msgs = await q(`SELECT m.id, m.content, m.created_at, m.username, r.name as room_name FROM messages m JOIN rooms r ON m.room_id = r.id WHERE m.user_id IN (SELECT DISTINCT user_id FROM ip_log WHERE ip = $1 AND user_id IS NOT NULL) ORDER BY m.created_at DESC LIMIT 100`, [ip]);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/users/:id/messages', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const msgs = await q(`SELECT m.id, m.content, m.created_at, m.username, r.name as room_name, (SELECT il.ip FROM ip_log il WHERE il.user_id = m.user_id ORDER BY il.created_at DESC LIMIT 1) as ip FROM messages m JOIN rooms r ON m.room_id = r.id WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [req.params.id]);
    res.json(msgs);
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/log', async (req, res) => {
  if (!checkMod(req, res)) return;
  try { res.json(await q('SELECT * FROM mod_log ORDER BY created_at DESC LIMIT 300')); }
  catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/users/:id/ban', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { reason } = req.body;
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE users SET banned = 1, ban_reason = $1 WHERE id = $2', [reason || '', req.params.id]);
    if (user) await modLog('ban_user', user.username, reason || '');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/users/:id/unban', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE users SET banned = 0, ban_reason = $1 WHERE id = $2', ['', req.params.id]);
    if (user) await modLog('unban_user', user.username);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/users/:id/mute', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('INSERT INTO room_mutes (room_id, user_id) VALUES (0, $1) ON CONFLICT DO NOTHING', [req.params.id]);
    if (user) await modLog('mute_user', user.username, 'global');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/users/:id/unmute', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM room_mutes WHERE room_id = 0 AND user_id = $1', [req.params.id]);
    if (user) await modLog('unmute_user', user.username, 'global');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/users/:id/setmod', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { is_mod } = req.body;
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE users SET is_mod = $1 WHERE id = $2', [is_mod ? 1 : 0, req.params.id]);
    if (user) await modLog(is_mod ? 'grant_mod' : 'revoke_mod', user.username);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/users/:id', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM messages WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM direct_messages WHERE sender_id = $1 OR receiver_id = $1', [req.params.id, req.params.id]);
    await pool.query('DELETE FROM room_whitelist WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM room_mutes WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await pool.query('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id)');
    if (user) await modLog('delete_user', user.username);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/users/:id/messages', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const user = await q1('SELECT username FROM users WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM messages WHERE user_id = $1', [req.params.id]);
    await pool.query('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = rooms.id)');
    if (user) await modLog('clear_messages', user.username);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/rooms/:id', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const room = await q1('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.is_general) return res.status(403).json({ error: 'Cannot delete General' });
    await pool.query('DELETE FROM messages WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM room_whitelist WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM room_mutes WHERE room_id = $1', [room.id]);
    await pool.query('DELETE FROM rooms WHERE id = $1', [room.id]);
    await modLog('delete_room', room.name);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/messages/:id', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const msg = await q1('SELECT room_id FROM messages WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
    if (msg) await pool.query('UPDATE rooms SET message_count = (SELECT COUNT(*) FROM messages WHERE room_id = $1) WHERE id = $1', [msg.room_id]);
    await modLog('delete_message', '#' + req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/ban-ip', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { ip, reason } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP required' });
    await pool.query('INSERT INTO banned_ips (ip, reason) VALUES ($1, $2) ON CONFLICT (ip) DO UPDATE SET reason = $2', [ip, reason || '']);
    await modLog('ban_ip', ip, reason || '');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/unban-ip', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { ip } = req.body;
    await pool.query('DELETE FROM banned_ips WHERE ip = $1', [ip]);
    await modLog('unban_ip', ip);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/rooms/:id/server-message', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { message } = req.body;
    const room = await q1('SELECT * FROM rooms WHERE id = $1', [req.params.id]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    await pool.query('UPDATE rooms SET server_message = $1 WHERE id = $2', [message || '', room.id]);
    await modLog('set_server_msg', room.name, (message || '').slice(0, 60));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/rooms/:id/whitelist', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const room = await q1('SELECT name FROM rooms WHERE id = $1', [req.params.id]);
    await pool.query('DELETE FROM room_whitelist WHERE room_id = $1', [req.params.id]);
    if (room) await modLog('whitelist_clear', room.name, 'via mod panel');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/mod/rooms/:id/whitelist/:userId', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    await pool.query('DELETE FROM room_whitelist WHERE room_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mod/change-password', async (req, res) => {
  if (!checkMod(req, res)) return;
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    MASTER_PASSWORD = newPassword;
    await modLog('change_master_pw', 'system');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/mod/my-ip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    const { password } = req.body;
    if (!isMaster(password)) return res.status(403).json({ error: 'Forbidden' });
    await resetMessages();
    await modLog('force_reset', 'all rooms');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  scheduleNextReset();
  app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
}).catch(e => {
  console.error('Failed to init database:', e);
  process.exit(1);
});
