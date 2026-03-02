const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('chat.db');

const MASTER_PASSWORD = '582624';

app.use(cors());
app.use(express.json());

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#44aaff',
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_id) REFERENCES rooms(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`);

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

// ── User routes ───────────────────────────────────────────────────────────────

// Register
app.post('/api/users/register', (req, res) => {
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 2 || username.length > 24) return res.status(400).json({ error: 'Username must be 2–24 characters' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username taken' });
  const userColor = color || '#44aaff';
  const result = db.prepare('INSERT INTO users (username, password, color) VALUES (?, ?, ?)').run(username, password, userColor);
  res.json({ success: true, id: result.lastInsertRowid, username, color: userColor });
});

// Login
app.post('/api/users/login', (req, res) => {
  const { username, password } = req.body;
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ success: true, id: user.id, username: user.username, color: user.color });
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
  res.json({ success: true, id: user.id, username: updatedUsername, color: updatedColor });
});

// ── Room routes ───────────────────────────────────────────────────────────────

// GET all rooms (sorted: general first, then by message_count desc)
app.get('/api/rooms', (req, res) => {
  const { viewerPassword } = req.query;
  const rooms = db.prepare(`
    SELECT r.id, r.name, r.description, r.is_general, r.is_private, r.message_count, r.created_at,
           u.username as creator_name
    FROM rooms r
    LEFT JOIN users u ON r.creator_id = u.id
    ORDER BY r.is_general DESC, r.message_count DESC, r.created_at DESC
  `).all();

  // Don't expose whether a room is private to its contents — just flag it
  res.json(rooms.map(r => ({
    ...r,
    locked: r.is_private === 1
  })));
});

// POST create room
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

// DELETE room
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

// ── Message routes ────────────────────────────────────────────────────────────

// GET messages for a room
app.get('/api/rooms/:id/messages', (req, res) => {
  const { roomPassword } = req.query;
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
    return res.status(403).json({ error: 'Wrong room password' });
  }
  const messages = db.prepare(`
    SELECT id, username, color, content, created_at FROM messages
    WHERE room_id = ?
    ORDER BY created_at ASC
    LIMIT 200
  `).all(req.params.id);
  res.json(messages);
});

// POST send message
app.post('/api/rooms/:id/messages', (req, res) => {
  const { username, password, content, roomPassword } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  if (content.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 chars)' });
  const user = getUser(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.is_private && !isMaster(roomPassword) && room.password !== roomPassword) {
    return res.status(403).json({ error: 'Wrong room password' });
  }
  db.prepare(
    'INSERT INTO messages (room_id, user_id, username, color, content) VALUES (?, ?, ?, ?, ?)'
  ).run(room.id, user.id, user.username, user.color, content.trim());
  db.prepare('UPDATE rooms SET message_count = message_count + 1 WHERE id = ?').run(room.id);
  res.json({ success: true });
});

// ── Admin: force reset (master only) ─────────────────────────────────────────
app.post('/api/admin/reset', (req, res) => {
  const { password } = req.body;
  if (!isMaster(password)) return res.status(403).json({ error: 'Forbidden' });
  resetMessages();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));
