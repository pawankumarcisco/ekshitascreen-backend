import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import ImageKit, { toFile } from '@imagekit/nodejs';

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'screencast-local-jwt-secret-key-39281';
const DEVICE_KEY_SECRET = process.env.DEVICE_KEY_SECRET || 'screencast-device-key-secret-91823';
const DATABASE_URL = process.env.DATABASE_URL;
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT?.replace(/\/$/, '');

const postgres = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
    ? undefined
    : { rejectUnauthorized: false }
}) : null;

const imageKit = IMAGEKIT_PRIVATE_KEY ? new ImageKit({ privateKey: IMAGEKIT_PRIVATE_KEY }) : null;

function originalImageKitUrl(url: string): string {
  if (!IMAGEKIT_URL_ENDPOINT || !url.startsWith(`${IMAGEKIT_URL_ENDPOINT}/`)) return url;
  const relativePath = url.slice(IMAGEKIT_URL_ENDPOINT.length + 1);
  return `${IMAGEKIT_URL_ENDPOINT}/tr:orig-true/${relativePath}`;
}

// Storage directories
const STORAGE_ROOT = path.resolve(process.cwd(), 'storage');
const MEDIA_DIR = path.join(STORAGE_ROOT, 'media');
const THUMBNAILS_DIR = path.join(STORAGE_ROOT, 'thumbnails');
const DOWNLOADS_DIR = path.join(STORAGE_ROOT, 'downloads');
const DATA_FILE = path.join(STORAGE_ROOT, 'screencast-db.json');

if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(THUMBNAILS_DIR)) fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Initial seed images from generated assets if available
const seedImages = [
  { name: 'Welcome_Lobby.jpg', path: '/src/assets/images/signage_welcome_1790695056196.jpg' },
  { name: 'Morning_Offer.jpg', path: '/src/assets/images/signage_offer_1790695069605.jpg' },
  { name: 'Bistro_Menu.jpg', path: '/src/assets/images/signage_menu_1790695082723.jpg' },
  { name: 'Tech_Summit_Event.jpg', path: '/src/assets/images/signage_event_1790695096571.jpg' }
];

interface DBState {
  users: any[];
  devices: any[];
  activations: any[];
  screens: any[];
  screenConfigurations: any[];
  mediaAssets: any[];
  playlists: any[];
  playlistItems: any[];
  deviceSyncs: any[];
  heartbeats: any[];
  auditLogs: any[];
  screenGroups: any[];
  screenGroupMembers: any[];
  publishJobs: any[];
  publishTargets: any[];
  publishAttempts: any[];
  publishEvents: any[];
}

function loadDB(): DBState {
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse DB file, resetting', e);
    }
  }

  const defaultAdmin = {
    id: 'user-admin-001',
    name: process.env.ADMIN_NAME || 'EkshitaScreen Admin',
    email: process.env.ADMIN_EMAIL || 'admin@ekshitascreen.com',
    passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'ChangeMeBeforeProduction!', 10),
    role: 'ADMIN',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const defaultOperator = {
    id: 'user-op-002',
    name: 'Operator Jane',
    email: 'operator@screencast.local',
    passwordHash: bcrypt.hashSync('operator123', 10),
    role: 'OPERATOR',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const initialDB: DBState = {
    users: [defaultAdmin, defaultOperator],
    devices: [],
    activations: [],
    screens: [],
    screenConfigurations: [],
    mediaAssets: [],
    playlists: [],
    playlistItems: [],
    deviceSyncs: [],
    heartbeats: [],
    auditLogs: [],
    screenGroups: [],
    screenGroupMembers: [],
    publishJobs: [],
    publishTargets: [],
    publishAttempts: [],
    publishEvents: []
  };

  saveDB(initialDB);
  return initialDB;
}

function saveDB(db: DBState) {
  const serialized = JSON.stringify(db);

  // Local JSON remains a convenient development fallback. Render persists to Postgres.
  if (!postgres) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error saving local database:', err);
    }
  }

  schedulePostgresSave(serialized);
}

let pendingStateJson: string | null = null;
let postgresSaveTimer: NodeJS.Timeout | null = null;
let postgresSaveChain: Promise<void> = Promise.resolve();
let postgresReady = false;
let db = loadDB();

function normalizeState(state: DBState): boolean {
  let changed = false;
  // Additive state migration for installations created before groups/publications.
  for (const key of ['screenGroups', 'screenGroupMembers', 'publishJobs', 'publishTargets', 'publishAttempts', 'publishEvents'] as const) {
    if (!Array.isArray(state[key])) { state[key] = []; changed = true; }
  }
  return changed;
}
normalizeState(db);

function schedulePostgresSave(serialized: string) {
  if (!postgres || !postgresReady) return;
  pendingStateJson = serialized;
  if (postgresSaveTimer) return;

  postgresSaveTimer = setTimeout(() => {
    postgresSaveTimer = null;
    const snapshot = pendingStateJson;
    pendingStateJson = null;
    if (!snapshot) return;

    postgresSaveChain = postgresSaveChain
      .then(async () => {
        await postgres.query(
          `INSERT INTO app_state (id, data, updated_at)
           VALUES (1, $1::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [snapshot]
        );
      })
      .catch(error => console.error('[Postgres] Failed to persist application state:', error));
  }, 100);
}

async function initializePostgres() {
  if (!postgres) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production');
    }
    console.warn('[Postgres] DATABASE_URL is not set; using local JSON storage.');
    return;
  }

  await postgres.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await postgres.query<{ data: DBState }>('SELECT data FROM app_state WHERE id = 1');
  if (result.rows[0]?.data) {
    db = result.rows[0].data;
    const migrated = normalizeState(db);
    console.log('[Postgres] Loaded persisted EkshitaScreen state.');
    if (migrated) {
      await postgres.query('UPDATE app_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(db)]);
      console.log('[Postgres] Migrated persisted state for screen groups and publications.');
    }
  } else {
    await postgres.query(
      'INSERT INTO app_state (id, data) VALUES (1, $1::jsonb)',
      [JSON.stringify(db)]
    );
    console.log('[Postgres] Created initial EkshitaScreen state.');
  }
  postgresReady = true;
}

function addOneYear(value: string | Date = new Date()) {
  const date = new Date(value);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

function isScreenSuspended(screen: any) {
  return !screen.validUntil || new Date(screen.validUntil).getTime() <= Date.now();
}

// Backfill ownership for databases created before multi-user isolation existed.
const adminUserId = db.users.find(user => user.role === 'ADMIN')?.id || db.users[0]?.id;
let ownershipMigrated = false;
for (const screen of db.screens) {
  if (!screen.userId) { screen.userId = adminUserId; ownershipMigrated = true; }
  if (!screen.validUntil) { screen.validUntil = addOneYear(screen.createdAt); ownershipMigrated = true; }
}
for (const asset of db.mediaAssets) {
  if (!asset.userId) { asset.userId = adminUserId; ownershipMigrated = true; }
}
if (ownershipMigrated) saveDB(db);

// Seed media assets if empty
function initializeSeedAssets() {
  if (process.env.NODE_ENV === 'production' || imageKit) return;
  if (db.mediaAssets.length === 0) {
    for (const item of seedImages) {
      const fullSrcPath = path.resolve(process.cwd(), '.' + item.path);
      if (fs.existsSync(fullSrcPath)) {
        const fileBuffer = fs.readFileSync(fullSrcPath);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const assetId = 'asset-' + crypto.randomUUID().slice(0, 8);
        const storageKey = `${assetId}-${item.name}`;
        const destPath = path.join(MEDIA_DIR, storageKey);
        const thumbDestPath = path.join(THUMBNAILS_DIR, storageKey);
        
        fs.writeFileSync(destPath, fileBuffer);
        fs.writeFileSync(thumbDestPath, fileBuffer); // For simple thumbnail serving

        db.mediaAssets.push({
          id: assetId,
          originalName: item.name,
          storageKey,
          mimeType: 'image/jpeg',
          fileSize: fileBuffer.length,
          width: 1920,
          height: 1080,
          sha256: hash,
          userId: adminUserId,
          createdAt: new Date().toISOString()
        });
      }
    }
    saveDB(db);
  }
}
initializeSeedAssets();

// Express & WebSocket Server setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[EkshitaScreen] Port ${PORT} is already in use. Stop the existing process or start with a different PORT.`);
    return;
  }
  console.error('[EkshitaScreen] WebSocket server error:', error);
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage static serving
app.use('/storage/media', express.static(MEDIA_DIR));
app.use('/storage/thumbnails', express.static(THUMBNAILS_DIR));
app.use('/storage/downloads', express.static(DOWNLOADS_DIR));

// WebSocket Clients registry
const connectedSockets = new Set<WebSocket>();
const deviceSockets = new Map<string, WebSocket>(); // deviceId -> socket

wss.on('connection', (ws: WebSocket, req) => {
  connectedSockets.add(ws);

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'DEVICE_IDENTIFY' && data.deviceId) {
        deviceSockets.set(data.deviceId, ws);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', () => {
    connectedSockets.delete(ws);
    for (const [deviceId, sock] of deviceSockets.entries()) {
      if (sock === ws) deviceSockets.delete(deviceId);
    }
  });
});

function broadcastEvent(type: string, payload: any) {
  const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of connectedSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function notifyDevice(deviceId: string, type: string, payload: any) {
  const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  const sock = deviceSockets.get(deviceId);
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(message);
  }
  // Also broadcast to admin dashboards
  broadcastEvent(type, { deviceId, ...payload });
}

// Multer upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, callback) => {
    const validMimes = ['image/jpeg', 'image/png'];
    const validExtension = /\.(jpe?g|png)$/i.test(file.originalname);
    callback(null, validMimes.includes(file.mimetype) && validExtension);
  }
});

function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      if (offset + 4 > buffer.length) return null;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

// Middleware helpers
function authMiddleware(req: any, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  if (!token || token === 'demo-token' || token === 'undefined' || token === 'null') {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}

function adminMiddleware(req: any, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

function canAccessScreen(user: any, screen: any) {
  return user?.role === 'ADMIN' || screen?.userId === user?.id;
}

function deviceAuthMiddleware(req: any, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const deviceUid = req.headers['x-device-uid'] as string;

  if (!authHeader && !deviceUid) {
    return res.status(401).json({ error: 'Unauthorized: Missing device credentials' });
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, DEVICE_KEY_SECRET) as any;
      req.device = decoded;
      return next();
    } catch (e) {
      // fallback to deviceUid
    }
  }

  if (deviceUid) {
    const dev = db.devices.find(d => d.deviceUid === deviceUid);
    if (dev) {
      req.device = { deviceId: dev.id, deviceUid: dev.deviceUid };
      return next();
    }
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid device authentication' });
}

function logAudit(userId: string | null, deviceId: string | null, action: string, details: any) {
  const entry = {
    id: 'audit-' + crypto.randomUUID(),
    userId,
    deviceId,
    action,
    details,
    createdAt: new Date().toISOString()
  };
  db.auditLogs.unshift(entry);
  if (db.auditLogs.length > 500) db.auditLogs.pop();
  saveDB(db);
}

// -------------------------------------------------------------
// 1. HEALTH CHECK (Public)
// -------------------------------------------------------------
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'screencast',
    mode: 'local',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// -------------------------------------------------------------
// 2. DASHBOARD AUTHENTICATION
// -------------------------------------------------------------
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase() && u.isActive);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  logAudit(user.id, null, 'USER_LOGIN', { email: user.email });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt
    }
  });
});

app.get('/api/auth/me', authMiddleware, (req: any, res: Response) => {
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt
  });
});

// USER MANAGEMENT (ADMIN ONLY)
app.get('/api/users', authMiddleware, adminMiddleware, (_req: Request, res: Response) => {
  res.json(db.users.map(({ passwordHash, ...user }) => user));
});

app.post('/api/users', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  const { name, email, password, role = 'OPERATOR', isActive = true } = req.body;
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) return res.status(400).json({ error: 'Name, email, and a password of at least 6 characters are required' });
  if (db.users.some(user => user.email.toLowerCase() === email.trim().toLowerCase())) return res.status(409).json({ error: 'A user with this email already exists' });
  const now = new Date().toISOString();
  const user = { id: 'user-' + crypto.randomUUID(), name: name.trim(), email: email.trim().toLowerCase(), passwordHash: bcrypt.hashSync(password, 10), role: role === 'VIEWER' ? 'VIEWER' : 'OPERATOR', isActive: Boolean(isActive), createdAt: now, updatedAt: now };
  db.users.push(user); saveDB(db);
  const { passwordHash, ...safeUser } = user; res.status(201).json(safeUser);
});

app.patch('/api/users/:id', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  const user = db.users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { name, email, password, role, isActive } = req.body;
  if (email && db.users.some(item => item.id !== user.id && item.email.toLowerCase() === email.trim().toLowerCase())) return res.status(409).json({ error: 'A user with this email already exists' });
  if (name !== undefined) user.name = name.trim();
  if (email !== undefined) user.email = email.trim().toLowerCase();
  if (password) { if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' }); user.passwordHash = bcrypt.hashSync(password, 10); }
  if (role !== undefined && user.id !== req.user.id) user.role = role === 'VIEWER' ? 'VIEWER' : 'OPERATOR';
  if (isActive !== undefined && user.id !== req.user.id) user.isActive = Boolean(isActive);
  user.updatedAt = new Date().toISOString(); saveDB(db);
  const { passwordHash, ...safeUser } = user; res.json(safeUser);
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const user = db.users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (db.screens.some(screen => screen.userId === user.id) || db.mediaAssets.some(asset => asset.userId === user.id)) return res.status(409).json({ error: 'Reassign or remove this user’s screens and media before deleting the account' });
  db.users = db.users.filter(item => item.id !== user.id); saveDB(db); res.json({ message: 'User deleted' });
});

// -------------------------------------------------------------
// 3. DEVICE ACTIVATION APIS
// -------------------------------------------------------------
app.post('/api/device/activation/request', (req: Request, res: Response) => {
  const { deviceUid, deviceName, appVersion, androidVersion, model, manufacturer } = req.body;

  if (!deviceUid) {
    return res.status(400).json({ error: 'deviceUid is required' });
  }

  let device = db.devices.find(d => d.deviceUid === deviceUid);
  if (!device) {
    device = {
      id: 'dev-' + crypto.randomUUID(),
      deviceUid,
      deviceName: deviceName || 'Android TV ' + deviceUid.slice(-4),
      appVersion: appVersion || '1.0.0',
      androidVersion: androidVersion || '12',
      model: model || 'Android TV Box',
      manufacturer: manufacturer || 'Generic',
      registered: false,
      registeredAt: null,
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.devices.push(device);
  } else {
    device.appVersion = appVersion || device.appVersion;
    device.androidVersion = androidVersion || device.androidVersion;
    device.model = model || device.model;
    device.manufacturer = manufacturer || device.manufacturer;
    device.lastSeenAt = new Date().toISOString();
  }

  // If already registered, return registration status
  if (device.registered) {
    const screen = db.screens.find(s => s.deviceId === device.id);
    const token = jwt.sign({ deviceId: device.id, deviceUid: device.deviceUid }, DEVICE_KEY_SECRET, { expiresIn: '365d' });
    return res.json({
      status: 'ACTIVATED',
      registered: true,
      deviceId: device.id,
      screenId: screen ? screen.id : null,
      token
    });
  }

  // Cancel any existing pending activations for this device
  for (const act of db.activations) {
    if (act.deviceId === device.id && act.status === 'PENDING') {
      act.status = 'CANCELLED';
    }
  }

  // Generate 6-digit code e.g. SC-482913
  const randomNum = Math.floor(100000 + Math.random() * 900000);
  const code = `SC-${randomNum}`;
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 mins

  const activation = {
    id: 'act-' + crypto.randomUUID(),
    deviceId: device.id,
    code,
    codeHash,
    codeDisplaySuffix: code.slice(-3),
    status: 'PENDING',
    expiresAt,
    consumedAt: null,
    createdAt: new Date().toISOString()
  };

  db.activations.push(activation);
  saveDB(db);

  logAudit(null, device.id, 'ACTIVATION_REQUESTED', { code, deviceUid });
  broadcastEvent('NEW_ACTIVATION_PENDING', { code, deviceId: device.id, deviceUid });

  res.json({
    status: 'PENDING',
    code,
    expiresAt,
    pollIntervalSeconds: 3
  });
});

app.get('/api/device/activation/status', (req: Request, res: Response) => {
  const { deviceUid, code } = req.query as { deviceUid?: string; code?: string };
  if (!deviceUid && !code) {
    return res.status(400).json({ error: 'deviceUid or code parameter required' });
  }

  let device = deviceUid ? db.devices.find(d => d.deviceUid === deviceUid) : null;
  let activation: any = null;

  if (device) {
    activation = db.activations
      .filter(a => a.deviceId === device!.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  } else if (code) {
    activation = db.activations.find(a => a.code.toUpperCase() === code.toUpperCase());
    if (activation) {
      device = db.devices.find(d => d.id === activation.deviceId);
    }
  }

  if (!activation || !device) {
    return res.status(404).json({ error: 'Activation not found' });
  }

  // Check expiration
  if (activation.status === 'PENDING' && new Date(activation.expiresAt).getTime() < Date.now()) {
    activation.status = 'EXPIRED';
    saveDB(db);
  }

  const screen = db.screens.find(s => s.deviceId === device.id);
  let token = null;
  if (activation.status === 'ACTIVATED') {
    token = jwt.sign({ deviceId: device.id, deviceUid: device.deviceUid }, DEVICE_KEY_SECRET, { expiresIn: '365d' });
  }

  res.json({
    status: activation.status,
    registered: device.registered,
    deviceId: device.id,
    screenId: screen ? screen.id : null,
    screenName: screen ? screen.name : null,
    token
  });
});

// -------------------------------------------------------------
// 4. SCREEN REGISTRATION (from Dashboard)
// -------------------------------------------------------------
app.post('/api/screens/register', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  const { code, name, location, description, config, userId } = req.body;

  if (!code || !name || !userId) {
    return res.status(400).json({ error: 'Activation code, screen name, and assigned user are required' });
  }
  const assignedUser = db.users.find(user => user.id === userId && user.isActive && user.role !== 'ADMIN');
  if (!assignedUser) return res.status(400).json({ error: 'Select an active non-admin user' });

  const cleanCode = code.trim().toUpperCase();
  const activation = db.activations.find(a => a.code.toUpperCase() === cleanCode);

  if (!activation) {
    return res.status(404).json({ error: 'Invalid activation code' });
  }

  if (activation.status === 'EXPIRED' || new Date(activation.expiresAt).getTime() < Date.now()) {
    activation.status = 'EXPIRED';
    saveDB(db);
    return res.status(400).json({ error: 'This activation code has expired' });
  }

  if (activation.status === 'ACTIVATED') {
    return res.status(400).json({ error: 'This activation code has already been used' });
  }

  const device = db.devices.find(d => d.id === activation.deviceId);
  if (!device) {
    return res.status(404).json({ error: 'Associated device not found' });
  }

  // Mark device as registered
  device.registered = true;
  device.registeredAt = new Date().toISOString();
  device.deviceName = name;

  // Mark activation as consumed
  activation.status = 'ACTIVATED';
  activation.consumedAt = new Date().toISOString();

  // Create Screen
  const screenId = 'screen-' + crypto.randomUUID();
  const screen = {
    id: screenId,
    deviceId: device.id,
    name,
    location: location || null,
    description: description || null,
    userId: assignedUser.id,
    validUntil: addOneYear(),
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.screens.push(screen);

  // Create default ScreenConfiguration
  const screenConfig = {
    id: 'cfg-' + crypto.randomUUID(),
    screenId,
    width: config?.width || 1920,
    height: config?.height || 1080,
    rotation: config?.rotation ?? 0,
    orientation: config?.orientation || 'LANDSCAPE',
    fitMode: config?.fitMode || 'FIT',
    intervalSeconds: config?.intervalSeconds || 10,
    transition: config?.transition || 'FADE',
    transitionDurationMs: config?.transitionDurationMs || 400,
    loop: config?.loop ?? true,
    shuffle: config?.shuffle ?? false,
    autoStart: config?.autoStart ?? true,
    version: 1,
    updatedAt: new Date().toISOString()
  };
  db.screenConfigurations.push(screenConfig);

  // Create initial empty draft playlist
  const playlistId = 'pl-' + crypto.randomUUID();
  const draftPlaylist = {
    id: playlistId,
    screenId,
    version: 1,
    status: 'DRAFT',
    createdBy: req.user.id,
    publishedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.playlists.push(draftPlaylist);

  // If there are existing media assets, add the first 2 as initial draft items
  const ownedAssets = db.mediaAssets.filter(asset => asset.userId === assignedUser.id);
  if (ownedAssets.length > 0) {
    ownedAssets.slice(0, 2).forEach((asset, idx) => {
      db.playlistItems.push({
        id: 'pli-' + crypto.randomUUID(),
        playlistId,
        mediaAssetId: asset.id,
        sortOrder: idx + 1,
        durationSeconds: 10,
        enabled: true
      });
    });
  }

  saveDB(db);

  logAudit(req.user.id, device.id, 'SCREEN_REGISTERED', { screenId, name, code: cleanCode });

  // Notify device and dashboard
  notifyDevice(device.id, 'DEVICE_ACTIVATED', { screenId, screenName: name });
  broadcastEvent('SCREEN_LIST_UPDATED', { screenId });

  res.status(201).json({
    message: 'Screen registered successfully',
    screen,
    configuration: screenConfig,
    device
  });
});

const PUBLISH_STATES = ['QUEUED', 'DOWNLOADING', 'VERIFYING', 'READY', 'PLAYING', 'FAILED', 'SUPERSEDED'];
const STATE_RANK: Record<string, number> = { QUEUED: 0, DOWNLOADING: 1, VERIFYING: 2, READY: 3, PLAYING: 4 };

function visibleScreensFor(user: any) {
  return user.role === 'ADMIN' ? db.screens : db.screens.filter(s => s.userId === user.id);
}

function summarizeJob(jobId: string) {
  const counts = Object.fromEntries(PUBLISH_STATES.map(status => [status.toLowerCase(), 0]));
  for (const target of db.publishTargets.filter(t => t.jobId === jobId)) counts[target.status.toLowerCase()]++;
  return counts;
}

function enrichJob(job: any) {
  const targets = db.publishTargets.filter(t => t.jobId === job.id).map(target => ({
    ...target,
    screen: db.screens.find(s => s.id === target.screenId) || { id: target.screenId, name: target.screenNameSnapshot },
    attempts: db.publishAttempts.filter(a => a.targetId === target.id)
  }));
  return { ...job, counts: summarizeJob(job.id), targets };
}

function startAttempt(target: any, automatic = false) {
  const prior = db.publishAttempts.filter(a => a.targetId === target.id);
  const attempt = {
    id: 'attempt-' + crypto.randomUUID(), targetId: target.id, number: prior.length + 1,
    status: 'QUEUED', eventSequence: 0, bytesDownloaded: 0, totalBytes: target.totalBytes,
    filesCompleted: 0, totalFiles: target.totalFiles, currentFile: null, progressPercent: 0,
    errorCode: null, errorMessage: null, automatic, createdAt: new Date().toISOString(),
    startedAt: null, readyAt: null, activatedAt: null, playbackConfirmedAt: null, completedAt: null
  };
  target.attemptId = attempt.id; target.attemptNumber = attempt.number; target.status = 'QUEUED';
  target.errorCode = null; target.errorMessage = null; target.lastProgressAt = attempt.createdAt;
  db.publishAttempts.push(attempt);
  return attempt;
}

// -------------------------------------------------------------
// 5. SCREEN GROUPS
// -------------------------------------------------------------
app.get('/api/screen-groups', authMiddleware, (req: any, res: Response) => {
  const allowed = new Set(visibleScreensFor(req.user).map(s => s.id));
  const now = Date.now();
  res.json(db.screenGroups.filter(g => req.user.role === 'ADMIN' || g.ownerId === req.user.id).map(group => {
    const memberIds = db.screenGroupMembers.filter(m => m.groupId === group.id && allowed.has(m.screenId)).map(m => m.screenId);
    const members = db.screens.filter(s => memberIds.includes(s.id));
    const online = members.filter(s => {
      const d = db.devices.find(device => device.id === s.deviceId);
      return d?.lastSeenAt && now - new Date(d.lastSeenAt).getTime() <= 90000;
    }).length;
    return { ...group, screenIds: memberIds, totalScreens: members.length, onlineScreens: online, offlineScreens: members.length - online };
  }));
});

app.post('/api/screen-groups', authMiddleware, (req: any, res: Response) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const screenIds = [...new Set(Array.isArray(req.body.screenIds) ? req.body.screenIds : [])] as string[];
  const allowed = new Set(visibleScreensFor(req.user).map(s => s.id));
  if (screenIds.some(id => !allowed.has(id))) return res.status(403).json({ error: 'One or more screens are outside your authorized scope' });
  const now = new Date().toISOString();
  const group = { id: 'group-' + crypto.randomUUID(), name, description: String(req.body.description || ''), ownerId: req.user.id, isActive: true, createdBy: req.user.id, updatedBy: req.user.id, createdAt: now, updatedAt: now };
  db.screenGroups.push(group);
  for (const screenId of screenIds) db.screenGroupMembers.push({ id: 'member-' + crypto.randomUUID(), groupId: group.id, screenId, createdAt: now, createdBy: req.user.id });
  saveDB(db); logAudit(req.user.id, null, 'SCREEN_GROUP_CREATED', { groupId: group.id, name, screenIds });
  res.status(201).json({ ...group, screenIds });
});

app.patch('/api/screen-groups/:id', authMiddleware, (req: any, res: Response) => {
  const group = db.screenGroups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (req.user.role !== 'ADMIN' && group.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  const screenIds = req.body.screenIds === undefined ? null : [...new Set(req.body.screenIds || [])] as string[];
  const allowed = new Set(visibleScreensFor(req.user).map(s => s.id));
  if (screenIds?.some(id => !allowed.has(id))) return res.status(403).json({ error: 'One or more screens are outside your authorized scope' });
  if (req.body.name !== undefined) { const name = String(req.body.name).trim(); if (!name) return res.status(400).json({ error: 'Group name is required' }); group.name = name; }
  if (req.body.description !== undefined) group.description = String(req.body.description || '');
  if (req.body.isActive !== undefined) group.isActive = Boolean(req.body.isActive);
  if (screenIds) {
    db.screenGroupMembers = db.screenGroupMembers.filter(m => m.groupId !== group.id);
    for (const screenId of screenIds) db.screenGroupMembers.push({ id: 'member-' + crypto.randomUUID(), groupId: group.id, screenId, createdAt: new Date().toISOString(), createdBy: req.user.id });
  }
  group.updatedBy = req.user.id; group.updatedAt = new Date().toISOString();
  saveDB(db); logAudit(req.user.id, null, 'SCREEN_GROUP_UPDATED', { groupId: group.id, screenIds });
  res.json({ ...group, screenIds: db.screenGroupMembers.filter(m => m.groupId === group.id).map(m => m.screenId) });
});

app.delete('/api/screen-groups/:id', authMiddleware, (req: any, res: Response) => {
  const group = db.screenGroups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (req.user.role !== 'ADMIN' && group.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  db.screenGroups = db.screenGroups.filter(g => g.id !== group.id);
  db.screenGroupMembers = db.screenGroupMembers.filter(m => m.groupId !== group.id);
  saveDB(db); logAudit(req.user.id, null, 'SCREEN_GROUP_DELETED', { groupId: group.id, name: group.name });
  res.json({ message: 'Group deleted; screens and publication history were preserved' });
});

app.post('/api/publications/resolve-targets', authMiddleware, (req: any, res: Response) => {
  const allowed = new Set(visibleScreensFor(req.user).map(s => s.id));
  const requestedGroups = [...new Set(req.body.groupIds || [])] as string[];
  const groups = db.screenGroups.filter(g => requestedGroups.includes(g.id) && g.isActive);
  if (groups.length !== requestedGroups.length || groups.some(g => req.user.role !== 'ADMIN' && g.ownerId !== req.user.id)) return res.status(403).json({ error: 'Unauthorized or inactive group target' });
  const resolved = new Set<string>(req.body.screenIds || []);
  for (const member of db.screenGroupMembers) if (requestedGroups.includes(member.groupId)) resolved.add(member.screenId);
  if ([...resolved].some(id => !allowed.has(id))) return res.status(403).json({ error: 'Unauthorized screen target' });
  const screens = db.screens.filter(s => resolved.has(s.id));
  res.json({ uniqueCount: screens.length, screens });
});

app.post('/api/publications', authMiddleware, (req: any, res: Response) => {
  if (req.user.role === 'VIEWER') return res.status(403).json({ error: 'Publish permission required' });
  const idempotencyKey = String(req.body.idempotencyKey || req.headers['idempotency-key'] || '').trim();
  if (!idempotencyKey) return res.status(400).json({ error: 'A client-generated idempotencyKey is required' });
  const existing = db.publishJobs.find(j => j.ownerId === req.user.id && j.idempotencyKey === idempotencyKey);
  if (existing) return res.json(enrichJob(existing));
  const sourceScreen = db.screens.find(s => s.id === req.body.sourceScreenId);
  if (!sourceScreen || !canAccessScreen(req.user, sourceScreen)) return res.status(403).json({ error: 'Unauthorized source screen' });
  const draft = db.playlists.find(p => p.screenId === sourceScreen.id && p.status === 'DRAFT');
  if (!draft) return res.status(400).json({ error: 'No draft playlist found to publish' });
  const draftItems = db.playlistItems.filter(i => i.playlistId === draft.id && i.enabled).sort((a,b) => a.sortOrder - b.sortOrder);
  if (!draftItems.length) return res.status(400).json({ error: 'Cannot publish an empty playlist' });
  const requestedGroups = [...new Set(req.body.groupIds || [])] as string[];
  const groups = db.screenGroups.filter(g => requestedGroups.includes(g.id) && g.isActive);
  if (groups.length !== requestedGroups.length || groups.some(g => req.user.role !== 'ADMIN' && g.ownerId !== req.user.id)) return res.status(403).json({ error: 'Unauthorized or inactive group target' });
  const ids = new Set<string>(req.body.screenIds || []);
  for (const m of db.screenGroupMembers) if (requestedGroups.includes(m.groupId)) ids.add(m.screenId);
  const allowed = new Set(visibleScreensFor(req.user).map(s => s.id));
  if (!ids.size) return res.status(400).json({ error: 'Select at least one screen or group' });
  if ([...ids].some(id => !allowed.has(id))) return res.status(403).json({ error: 'Unauthorized screen target' });
  const now = new Date().toISOString();
  const assets = draftItems.map(item => {
    const asset = db.mediaAssets.find(a => a.id === item.mediaAssetId);
    if (!asset) return null;
    return { assetId: asset.id, filename: asset.originalName, order: item.sortOrder, durationSeconds: item.durationSeconds || 10, sha256: asset.sha256, fileSize: Number(asset.fileSize), mimeType: asset.mimeType, downloadUrl: `/api/device/media/${asset.id}` };
  }).filter(Boolean);
  if (assets.length !== draftItems.length) return res.status(409).json({ error: 'Draft references missing media' });
  const version = Math.max(0, ...db.publishJobs.map(j => Number(j.contentVersion) || 0)) + 1;
  const job = { id: 'job-' + crypto.randomUUID(), ownerId: sourceScreen.userId, publisherId: req.user.id, publisherName: req.user.name, idempotencyKey, sourceScreenId: sourceScreen.id, contentVersion: version, playlistVersion: draft.version, groupSnapshots: groups.map(g => ({ id: g.id, name: g.name })), targetCount: ids.size, createdAt: now };
  db.publishJobs.push(job);
  for (const screenId of ids) {
    const screen = db.screens.find(s => s.id === screenId)!;
    for (const old of db.publishTargets.filter(t => t.screenId === screenId && !['PLAYING','FAILED','SUPERSEDED'].includes(t.status))) { old.status = 'SUPERSEDED'; old.supersededAt = now; }
    const config = db.screenConfigurations.find(c => c.screenId === screenId);
    const target: any = { id: 'target-' + crypto.randomUUID(), jobId: job.id, screenId, screenNameSnapshot: screen.name, deviceId: screen.deviceId, targetVersion: version, playlistVersion: draft.version, configurationVersion: config?.version || 1, configurationSnapshot: config ? { ...config } : null, manifestSnapshot: assets, status: 'QUEUED', totalBytes: assets.reduce((n: number, a: any) => n + a.fileSize, 0), totalFiles: assets.length, bytesDownloaded: 0, filesCompleted: 0, progressPercent: 0, activeVersion: null, previousActiveVersion: db.heartbeats.find(h => h.deviceId === screen.deviceId)?.appliedVersion || 0, lastProgressAt: now, errorCode: null, errorMessage: null, createdAt: now };
    db.publishTargets.push(target); startAttempt(target);
    notifyDevice(screen.deviceId, 'CONTENT_UPDATE_AVAILABLE', { publishJobId: job.id, targetId: target.id, attemptId: target.attemptId, manifestVersion: version });
  }
  saveDB(db); logAudit(req.user.id, null, 'PUBLICATION_CREATED', { jobId: job.id, resolvedScreenIds: [...ids], groupSnapshots: job.groupSnapshots });
  broadcastEvent('PUBLICATION_UPDATED', { jobId: job.id });
  res.status(201).json(enrichJob(job));
});

app.get('/api/publications', authMiddleware, (req: any, res: Response) => res.json(db.publishJobs.filter(j => req.user.role === 'ADMIN' || j.ownerId === req.user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(enrichJob)));
app.get('/api/publications/:id', authMiddleware, (req: any, res: Response) => {
  const job = db.publishJobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Publication not found' });
  if (req.user.role !== 'ADMIN' && job.ownerId !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  res.json(enrichJob(job));
});

function retryTarget(req: any, res: Response, target: any) {
  if (!target || target.status !== 'FAILED') return res.status(409).json({ error: 'Only failed targets can be retried' });
  const job = db.publishJobs.find(j => j.id === target.jobId);
  if (!job || (req.user.role !== 'ADMIN' && job.ownerId !== req.user.id)) return res.status(403).json({ error: 'Access denied' });
  const attempt = startAttempt(target); saveDB(db);
  notifyDevice(target.deviceId, 'CONTENT_UPDATE_AVAILABLE', { publishJobId: job.id, targetId: target.id, attemptId: attempt.id, manifestVersion: target.targetVersion });
  logAudit(req.user.id, target.deviceId, 'PUBLICATION_RETRY', { jobId: job.id, targetId: target.id, attemptId: attempt.id });
  return res.json({ target, attempt });
}
app.post('/api/publications/:jobId/targets/:targetId/retry', authMiddleware, (req: any, res: Response) => retryTarget(req, res, db.publishTargets.find(t => t.id === req.params.targetId && t.jobId === req.params.jobId)));
app.post('/api/publications/:jobId/retry-failed', authMiddleware, (req: any, res: Response) => {
  const job = db.publishJobs.find(j => j.id === req.params.jobId);
  if (!job || (req.user.role !== 'ADMIN' && job.ownerId !== req.user.id)) return res.status(403).json({ error: 'Access denied' });
  const retried = db.publishTargets.filter(t => t.jobId === job.id && t.status === 'FAILED').map(t => ({ target: t, attempt: startAttempt(t) }));
  for (const item of retried) notifyDevice(item.target.deviceId, 'CONTENT_UPDATE_AVAILABLE', { publishJobId: job.id, targetId: item.target.id, attemptId: item.attempt.id, manifestVersion: item.target.targetVersion });
  saveDB(db); logAudit(req.user.id, null, 'PUBLICATION_RETRY_ALL', { jobId: job.id, count: retried.length });
  res.json({ count: retried.length });
});

// -------------------------------------------------------------
// 6. SCREENS MANAGEMENT
// -------------------------------------------------------------
app.get('/api/screens', authMiddleware, (req: any, res: Response) => {
  const now = Date.now();
  const OFFLINE_THRESHOLD_MS = 90 * 1000; // 90 seconds

  const visibleScreens = req.user.role === 'ADMIN' ? db.screens : db.screens.filter(screen => screen.userId === req.user.id);
  const enrichedScreens = visibleScreens.map(screen => {
    const device = db.devices.find(d => d.id === screen.deviceId);
    const configuration = db.screenConfigurations.find(c => c.screenId === screen.id);
    
    // Find active published playlist
    const publishedPlaylist = db.playlists
      .filter(p => p.screenId === screen.id && p.status === 'PUBLISHED')
      .sort((a, b) => b.version - a.version)[0];

    // Find latest draft playlist
    const draftPlaylist = db.playlists
      .filter(p => p.screenId === screen.id && p.status === 'DRAFT')
      .sort((a, b) => b.version - a.version)[0];

    const activePlaylist = publishedPlaylist || draftPlaylist;

    const items = activePlaylist
      ? db.playlistItems.filter(i => i.playlistId === activePlaylist.id)
      : [];

    const latestSync = db.deviceSyncs
      .filter(s => s.deviceId === screen.deviceId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

    // Online status based on recent heartbeat
    const lastSeenTime = device?.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    const isOnline = Boolean(device && (now - lastSeenTime <= OFFLINE_THRESHOLD_MS));

    return {
      ...screen,
      isSuspended: isScreenSuspended(screen),
      device: device ? {
        ...device,
        isOnline
      } : null,
      configuration,
      publishedVersion: publishedPlaylist ? publishedPlaylist.version : 0,
      draftVersion: draftPlaylist ? draftPlaylist.version : (publishedPlaylist ? publishedPlaylist.version + 1 : 1),
      hasDraftChanges: Boolean(draftPlaylist),
      itemCount: items.length,
      syncStatus: latestSync ? latestSync.status : 'UP_TO_DATE',
      appliedVersion: latestSync?.appliedVersion ?? (publishedPlaylist ? publishedPlaylist.version : 0),
      desiredVersion: db.publishTargets.filter(t => t.screenId === screen.id && t.status !== 'SUPERSEDED').sort((a,b) => b.targetVersion - a.targetVersion)[0]?.targetVersion || 0,
      activeVersion: db.publishTargets.filter(t => t.screenId === screen.id && t.status === 'PLAYING').sort((a,b) => b.targetVersion - a.targetVersion)[0]?.activeVersion || latestSync?.appliedVersion || 0,
      groupIds: db.screenGroupMembers.filter(m => m.screenId === screen.id).map(m => m.groupId),
      lastSeenAt: device?.lastSeenAt
    };
  });

  res.json(enrichedScreens);
});

app.get('/api/screens/:id', authMiddleware, (req: any, res: Response) => {
  const screen = db.screens.find(s => s.id === req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  if (!canAccessScreen(req.user, screen)) return res.status(403).json({ error: 'Access denied' });

  const device = db.devices.find(d => d.id === screen.deviceId);
  const configuration = db.screenConfigurations.find(c => c.screenId === screen.id);
  
  const publishedPlaylist = db.playlists
    .filter(p => p.screenId === screen.id && p.status === 'PUBLISHED')
    .sort((a, b) => b.version - a.version)[0];

  const draftPlaylist = db.playlists
    .filter(p => p.screenId === screen.id && p.status === 'DRAFT')
    .sort((a, b) => b.version - a.version)[0];

  const latestSync = db.deviceSyncs
    .filter(s => s.deviceId === screen.deviceId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

  const now = Date.now();
  const lastSeenTime = device?.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  const isOnline = Boolean(device && (now - lastSeenTime <= 90 * 1000));

  res.json({
    ...screen,
    isSuspended: isScreenSuspended(screen),
    device: device ? { ...device, isOnline } : null,
    configuration,
    publishedVersion: publishedPlaylist ? publishedPlaylist.version : 0,
    hasDraftChanges: Boolean(draftPlaylist),
    latestSync
  });
});

app.patch('/api/screens/:id', authMiddleware, (req: any, res: Response) => {
  const screen = db.screens.find(s => s.id === req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  if (!canAccessScreen(req.user, screen)) return res.status(403).json({ error: 'Access denied' });

  const { name, location, description, isActive } = req.body;
  if (name !== undefined) screen.name = name;
  if (location !== undefined) screen.location = location;
  if (description !== undefined) screen.description = description;
  if (isActive !== undefined) screen.isActive = isActive;
  screen.updatedAt = new Date().toISOString();

  saveDB(db);
  logAudit(req.user.id, screen.deviceId, 'SCREEN_UPDATED', { screenId: screen.id });
  broadcastEvent('SCREEN_UPDATED', { screenId: screen.id });

  res.json(screen);
});

app.delete('/api/screens/:id/unregister', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  const screen = db.screens.find(s => s.id === req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const device = db.devices.find(d => d.id === screen.deviceId);
  const playlistIds = new Set(db.playlists.filter(p => p.screenId === screen.id).map(p => p.id));

  db.playlistItems = db.playlistItems.filter(item => !playlistIds.has(item.playlistId));
  db.playlists = db.playlists.filter(playlist => playlist.screenId !== screen.id);
  db.screenConfigurations = db.screenConfigurations.filter(config => config.screenId !== screen.id);
  db.deviceSyncs = db.deviceSyncs.filter(sync => sync.deviceId !== screen.deviceId);
  db.screens = db.screens.filter(item => item.id !== screen.id);

  if (device) {
    device.registered = false;
    device.registeredAt = null;
    device.deviceName = null;
    device.updatedAt = new Date().toISOString();
  }

  for (const activation of db.activations) {
    if (activation.deviceId === screen.deviceId && (activation.status === 'ACTIVATED' || activation.status === 'PENDING')) {
      activation.status = 'CANCELLED';
    }
  }

  saveDB(db);
  logAudit(req.user.id, screen.deviceId, 'SCREEN_UNREGISTERED', { screenId: screen.id, name: screen.name });
  notifyDevice(screen.deviceId, 'DEVICE_UNREGISTERED', { screenId: screen.id });
  broadcastEvent('SCREEN_LIST_UPDATED', { screenId: screen.id, unregistered: true });

  res.json({ message: 'Screen unregistered successfully' });
});

app.post('/api/screens/:id/renew', authMiddleware, adminMiddleware, (req: any, res: Response) => {
  const screen = db.screens.find(s => s.id === req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const currentExpiry = screen.validUntil ? new Date(screen.validUntil) : new Date();
  const renewalStart = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
  screen.validUntil = addOneYear(renewalStart);
  screen.updatedAt = new Date().toISOString();
  saveDB(db);

  logAudit(req.user.id, screen.deviceId, 'SCREEN_RENEWED', { screenId: screen.id, validUntil: screen.validUntil });
  notifyDevice(screen.deviceId, 'SCREEN_RENEWED', { screenId: screen.id, validUntil: screen.validUntil });
  broadcastEvent('SCREEN_LIST_UPDATED', { screenId: screen.id, renewed: true });
  res.json({ ...screen, isSuspended: false });
});

// -------------------------------------------------------------
// 6. SCREEN CONFIGURATION
// -------------------------------------------------------------
app.get('/api/screens/:id/config', authMiddleware, (req: any, res: Response) => {
  const screen = db.screens.find(s => s.id === req.params.id);
  if (!screen || !canAccessScreen(req.user, screen)) return res.status(404).json({ error: 'Screen configuration not found' });
  const config = db.screenConfigurations.find(c => c.screenId === req.params.id);
  if (!config) return res.status(404).json({ error: 'Screen configuration not found' });
  res.json(config);
});

app.patch('/api/screens/:id/config', authMiddleware, (req: any, res: Response) => {
  const ownedScreen = db.screens.find(s => s.id === req.params.id);
  if (!ownedScreen || !canAccessScreen(req.user, ownedScreen)) return res.status(403).json({ error: 'Access denied' });
  let config = db.screenConfigurations.find(c => c.screenId === req.params.id);
  if (!config) return res.status(404).json({ error: 'Screen configuration not found' });

  const {
    width,
    height,
    rotation,
    orientation,
    fitMode,
    intervalSeconds,
    transition,
    transitionDurationMs,
    loop,
    shuffle,
    autoStart
  } = req.body;

  if (width !== undefined) config.width = width;
  if (height !== undefined) config.height = height;
  if (rotation !== undefined) config.rotation = rotation;
  if (orientation !== undefined) config.orientation = orientation;
  if (fitMode !== undefined) config.fitMode = fitMode;
  if (intervalSeconds !== undefined) config.intervalSeconds = intervalSeconds;
  if (transition !== undefined) config.transition = transition;
  if (transitionDurationMs !== undefined) config.transitionDurationMs = transitionDurationMs;
  if (loop !== undefined) config.loop = loop;
  if (shuffle !== undefined) config.shuffle = shuffle;
  if (autoStart !== undefined) config.autoStart = autoStart;

  config.version += 1;
  config.updatedAt = new Date().toISOString();

  saveDB(db);

  const screen = db.screens.find(s => s.id === req.params.id);
  if (screen) {
    notifyDevice(screen.deviceId, 'CONFIG_UPDATED', {
      screenId: screen.id,
      configurationVersion: config.version,
      configuration: config
    });
  }

  logAudit(req.user.id, screen?.deviceId || null, 'SCREEN_CONFIG_UPDATED', { configVersion: config.version });

  res.json(config);
});

// -------------------------------------------------------------
// 7. MEDIA MANAGEMENT
// -------------------------------------------------------------
app.get('/api/media', authMiddleware, (req: any, res: Response) => {
  // Compute usage count across playlists
  const usageCounts = new Map<string, number>();
  for (const item of db.playlistItems) {
    usageCounts.set(item.mediaAssetId, (usageCounts.get(item.mediaAssetId) || 0) + 1);
  }

  const visibleAssets = req.user.role === 'ADMIN' ? db.mediaAssets : db.mediaAssets.filter(asset => asset.userId === req.user.id);
  const enrichedAssets = visibleAssets.map(asset => ({
    ...asset,
    url: asset.url || `/storage/media/${asset.storageKey}`,
    thumbnailUrl: asset.thumbnailUrl || `/storage/thumbnails/${asset.storageKey}`,
    usageCount: usageCounts.get(asset.id) || 0
  }));

  res.json(enrichedAssets);
});

app.post('/api/media/upload', authMiddleware, upload.array('files', 10), async (req: any, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No image files uploaded' });
  }

  const uploadedAssets: any[] = [];
  const dpi = Number(req.body.dpi ?? 150);
  const quality = Number(req.body.quality ?? 80);
  if (![75, 100, 150, 200].includes(dpi) || !Number.isInteger(quality) || quality < 75 || quality > 100) {
    return res.status(400).json({ error: 'DPI must be 75, 100, 150, or 200 and quality must be from 75 to 100.' });
  }

  try {
    for (const file of files) {
    // Validate mimetype
    const validMimes = ['image/jpeg', 'image/png'];
    if (!validMimes.includes(file.mimetype)) {
      continue;
    }
    const dimensions = imageDimensions(file.buffer, file.mimetype);
    if (!dimensions) return res.status(400).json({ error: `${file.originalname} is not a valid JPEG or PNG image.` });
    if (dimensions.width !== 1920 || dimensions.height !== 1080) {
      return res.status(400).json({ error: `${file.originalname} must be processed to 1920×1080 before upload.` });
    }

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const assetId = 'asset-' + crypto.randomUUID().slice(0, 8);
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `${assetId}-${sanitizedName}`;

    let mediaUrl = `/storage/media/${storageKey}`;
    let thumbnailUrl = `/storage/thumbnails/${storageKey}`;
    let imageKitFileId: string | null = null;
    let remoteStorageKey = storageKey;

    if (imageKit) {
      const uploaded = await imageKit.files.upload({
        file: await toFile(file.buffer, sanitizedName),
        fileName: storageKey,
        folder: `/ekshitascreen/${req.user.id}/media`,
        useUniqueFileName: false,
        overwriteFile: false,
        tags: ['ekshitascreen', `user-${req.user.id}`]
      });
      if (!uploaded.url || !uploaded.fileId) throw new Error(`ImageKit did not return a URL for ${file.originalname}`);
      mediaUrl = uploaded.url;
      thumbnailUrl = uploaded.thumbnailUrl || uploaded.url;
      imageKitFileId = uploaded.fileId;
      remoteStorageKey = uploaded.filePath || storageKey;
    } else {
      const filePath = path.join(MEDIA_DIR, storageKey);
      const thumbPath = path.join(THUMBNAILS_DIR, storageKey);
      fs.writeFileSync(filePath, file.buffer);
      fs.writeFileSync(thumbPath, file.buffer);
    }

    const asset = {
      id: assetId,
      originalName: file.originalname,
      storageKey: remoteStorageKey,
      imageKitFileId,
      url: mediaUrl,
      thumbnailUrl,
      mimeType: file.mimetype,
      fileSize: file.size,
      width: dimensions.width,
      height: dimensions.height,
      dpi,
      quality,
      sha256: hash,
      userId: req.user.id,
      createdAt: new Date().toISOString()
    };

    db.mediaAssets.push(asset);
    uploadedAssets.push({
      ...asset,
      url: mediaUrl,
      thumbnailUrl,
      usageCount: 0
    });
  }

  saveDB(db);
  broadcastEvent('MEDIA_LIBRARY_UPDATED', { count: uploadedAssets.length });

  res.status(201).json(uploadedAssets);
  } catch (error) {
    console.error('[ImageKit] Upload failed:', error);
    res.status(502).json({ error: 'Media upload failed. Check the ImageKit configuration and try again.' });
  }
});

app.delete('/api/media/:id', authMiddleware, async (req: any, res: Response) => {
  const assetId = req.params.id;
  const asset = db.mediaAssets.find(a => a.id === assetId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  if (req.user.role !== 'ADMIN' && asset.userId !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  // Critical requirement: Prevent deletion of assets referenced by active published playlists!
  const publishedPlaylists = db.playlists.filter(p => p.status === 'PUBLISHED');
  const publishedPlaylistIds = new Set(publishedPlaylists.map(p => p.id));
  const isReferencedInPublished = db.playlistItems.some(
    item => item.mediaAssetId === assetId && publishedPlaylistIds.has(item.playlistId)
  );
  const isReferencedInRetainedManifest = db.publishTargets.some(target =>
    Array.isArray(target.manifestSnapshot) && target.manifestSnapshot.some((item: any) => item.assetId === assetId)
  );

  if (isReferencedInPublished || isReferencedInRetainedManifest) {
    return res.status(409).json({
      error: 'Cannot delete media asset: It is currently active in a published playlist. Remove or replace it on the screen first.'
    });
  }

  // Remove from ImageKit or the local development filesystem.
  try {
    if (asset.imageKitFileId && imageKit) {
      await imageKit.files.delete(asset.imageKitFileId);
    } else {
      const filePath = path.join(MEDIA_DIR, asset.storageKey);
      const thumbPath = path.join(THUMBNAILS_DIR, asset.storageKey);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    }
  } catch (err) {
    console.error('Media deletion error:', err);
    return res.status(502).json({ error: 'Could not delete the media file from storage.' });
  }

  // Remove from database and clean up playlist items in draft
  db.mediaAssets = db.mediaAssets.filter(a => a.id !== assetId);
  db.playlistItems = db.playlistItems.filter(i => i.mediaAssetId !== assetId);
  saveDB(db);

  logAudit(req.user.id, null, 'MEDIA_DELETED', { assetId, name: asset.originalName });
  broadcastEvent('MEDIA_LIBRARY_UPDATED', { deletedId: assetId });

  res.json({ message: 'Media asset deleted successfully' });
});

// -------------------------------------------------------------
// 8. PLAYLISTS (DRAFT & PUBLISH)
// -------------------------------------------------------------
app.get('/api/screens/:id/playlist', authMiddleware, (req: any, res: Response) => {
  const screenId = req.params.id;
  const screen = db.screens.find(s => s.id === screenId);
  if (!screen || !canAccessScreen(req.user, screen)) return res.status(403).json({ error: 'Access denied' });

  const published = db.playlists
    .filter(p => p.screenId === screenId && p.status === 'PUBLISHED')
    .sort((a, b) => b.version - a.version)[0];

  const draft = db.playlists
    .filter(p => p.screenId === screenId && p.status === 'DRAFT')
    .sort((a, b) => b.version - a.version)[0];

  const enrichPlaylist = (pl: any) => {
    if (!pl) return null;
    const items = db.playlistItems
      .filter(i => i.playlistId === pl.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(i => {
        const asset = db.mediaAssets.find(a => a.id === i.mediaAssetId);
        return {
          ...i,
          mediaAsset: asset ? {
            ...asset,
            url: `/storage/media/${asset.storageKey}`,
            thumbnailUrl: `/storage/thumbnails/${asset.storageKey}`
          } : null
        };
      });

    return {
      ...pl,
      items
    };
  };

  res.json({
    published: enrichPlaylist(published),
    draft: enrichPlaylist(draft)
  });
});

app.put('/api/screens/:id/playlist/draft', authMiddleware, (req: any, res: Response) => {
  const screenId = req.params.id;
  const { items } = req.body; // array of { mediaAssetId, sortOrder, durationSeconds, enabled }

  const screen = db.screens.find(s => s.id === screenId);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  if (!canAccessScreen(req.user, screen)) return res.status(403).json({ error: 'Access denied' });

  if (Array.isArray(items) && items.some((item: any) => {
    const asset = db.mediaAssets.find(a => a.id === item.mediaAssetId);
    return !asset || (req.user.role !== 'ADMIN' && asset.userId !== req.user.id) || (screen.userId && asset.userId !== screen.userId);
  })) return res.status(400).json({ error: 'Playlist contains media not owned by the assigned screen user' });

  // Find or create draft playlist
  let draft = db.playlists.find(p => p.screenId === screenId && p.status === 'DRAFT');
  const latestPublished = db.playlists
    .filter(p => p.screenId === screenId && p.status === 'PUBLISHED')
    .sort((a, b) => b.version - a.version)[0];

  const nextVersion = latestPublished ? latestPublished.version + 1 : 1;

  if (!draft) {
    draft = {
      id: 'pl-' + crypto.randomUUID(),
      screenId,
      version: nextVersion,
      status: 'DRAFT',
      createdBy: req.user.id,
      publishedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.playlists.push(draft);
  } else {
    draft.version = nextVersion;
    draft.updatedAt = new Date().toISOString();
  }

  // Remove old items for this draft
  db.playlistItems = db.playlistItems.filter(i => i.playlistId !== draft.id);

  // Add new items
  if (Array.isArray(items)) {
    items.forEach((item: any, idx: number) => {
      db.playlistItems.push({
        id: 'pli-' + crypto.randomUUID(),
        playlistId: draft.id,
        mediaAssetId: item.mediaAssetId,
        sortOrder: item.sortOrder ?? idx + 1,
        durationSeconds: item.durationSeconds ?? 10,
        enabled: item.enabled ?? true
      });
    });
  }

  saveDB(db);

  logAudit(req.user.id, screen.deviceId, 'PLAYLIST_DRAFT_SAVED', { screenId, itemCount: items?.length || 0 });
  broadcastEvent('PLAYLIST_DRAFT_SAVED', { screenId });

  res.json({
    message: 'Draft saved successfully',
    draft
  });
});

app.post('/api/screens/:id/playlist/publish', authMiddleware, (req: any, res: Response) => {
  const screenId = req.params.id;
  const screen = db.screens.find(s => s.id === screenId);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });
  if (!canAccessScreen(req.user, screen)) return res.status(403).json({ error: 'Access denied' });

  const draft = db.playlists.find(p => p.screenId === screenId && p.status === 'DRAFT');
  if (!draft) {
    return res.status(400).json({ error: 'No draft playlist found to publish' });
  }

  const items = db.playlistItems.filter(i => i.playlistId === draft.id && i.enabled);
  if (items.length === 0) {
    return res.status(400).json({ error: 'Cannot publish an empty playlist. Please add at least one enabled image.' });
  }

  // Archive previous published playlists for this screen
  for (const pl of db.playlists) {
    if (pl.screenId === screenId && pl.status === 'PUBLISHED') {
      pl.status = 'ARCHIVED';
    }
  }

  // Promote draft to published (immutable version)
  draft.status = 'PUBLISHED';
  draft.publishedAt = new Date().toISOString();
  draft.updatedAt = new Date().toISOString();

  // Record pending sync for device
  const syncRecord = {
    id: 'sync-' + crypto.randomUUID(),
    deviceId: screen.deviceId,
    targetVersion: draft.version,
    appliedVersion: null,
    status: 'PENDING',
    progress: 0,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };
  db.deviceSyncs.push(syncRecord);

  saveDB(db);

  // Notify device via WebSocket: CONTENT_UPDATE_AVAILABLE
  const config = db.screenConfigurations.find(c => c.screenId === screen.id);
  notifyDevice(screen.deviceId, 'CONTENT_UPDATE_AVAILABLE', {
    screenId: screen.id,
    playlistVersion: draft.version,
    configurationVersion: config ? config.version : 1
  });

  logAudit(req.user.id, screen.deviceId, 'PLAYLIST_PUBLISHED', {
    screenId,
    version: draft.version,
    itemsCount: items.length
  });

  broadcastEvent('PLAYLIST_PUBLISHED', {
    screenId,
    version: draft.version,
    syncId: syncRecord.id
  });

  res.json({
    message: 'Playlist published successfully',
    version: draft.version,
    publishedAt: draft.publishedAt,
    sync: syncRecord
  });
});

// -------------------------------------------------------------
// 9. DEVICE MANIFEST & MEDIA DOWNLOAD
// -------------------------------------------------------------
app.get('/api/device/manifest', deviceAuthMiddleware, (req: any, res: Response) => {
  const deviceId = req.device.deviceId;
  const screen = db.screens.find(s => s.deviceId === deviceId);
  if (!screen) {
    return res.status(404).json({ error: 'No screen configured for this device' });
  }
  if (isScreenSuspended(screen)) {
    return res.status(403).json({ error: 'Screen registration suspended', code: 'SCREEN_SUSPENDED', validUntil: screen.validUntil });
  }

  const desiredTarget = db.publishTargets
    .filter(t => t.deviceId === deviceId && !['SUPERSEDED', 'PLAYING'].includes(t.status))
    .sort((a, b) => b.targetVersion - a.targetVersion)[0];
  if (desiredTarget) {
    return res.json({
      publishJobId: desiredTarget.jobId,
      targetId: desiredTarget.id,
      attemptId: desiredTarget.attemptId,
      manifestVersion: desiredTarget.targetVersion,
      screenId: screen.id,
      playlistVersion: desiredTarget.playlistVersion,
      configurationVersion: desiredTarget.configurationVersion,
      screenConfiguration: desiredTarget.configurationSnapshot,
      items: desiredTarget.manifestSnapshot
    });
  }

  const config = db.screenConfigurations.find(c => c.screenId === screen.id) || {
    id: 'cfg-default',
    screenId: screen.id,
    width: 1920,
    height: 1080,
    rotation: 0,
    orientation: 'LANDSCAPE',
    fitMode: 'FIT',
    intervalSeconds: 10,
    transition: 'FADE',
    transitionDurationMs: 400,
    loop: true,
    shuffle: false,
    autoStart: true,
    version: 1
  };

  const published = db.playlists
    .filter(p => p.screenId === screen.id && p.status === 'PUBLISHED')
    .sort((a, b) => b.version - a.version)[0];

  if (!published) {
    return res.json({
      screenId: screen.id,
      playlistVersion: 0,
      configurationVersion: config.version,
      screenConfiguration: config,
      items: []
    });
  }

  const items = db.playlistItems
    .filter(i => i.playlistId === published.id && i.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(i => {
      const asset = db.mediaAssets.find(a => a.id === i.mediaAssetId);
      if (!asset) return null;
      return {
        assetId: asset.id,
        filename: asset.originalName,
        order: i.sortOrder,
        durationSeconds: i.durationSeconds || config.intervalSeconds || 10,
        sha256: asset.sha256,
        fileSize: asset.fileSize,
        // Keep devices on the application origin. The backend proxies ImageKit's
        // original bytes and validates them before Android applies the playlist.
        downloadUrl: `/api/device/media/${asset.id}`
      };
    })
    .filter(Boolean);

  res.json({
    screenId: screen.id,
    playlistVersion: published.version,
    configurationVersion: config.version,
    screenConfiguration: config,
    items
  });
});

app.get('/api/device/media/:assetId', deviceAuthMiddleware, async (req: Request, res: Response) => {
  const asset = db.mediaAssets.find(a => a.id === req.params.assetId);
  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  if (asset.url?.startsWith('https://')) {
    try {
      const upstream = await fetch(originalImageKitUrl(asset.url));
      if (!upstream.ok) {
        return res.status(502).json({ error: `Media storage returned HTTP ${upstream.status}` });
      }

      const fileBuffer = Buffer.from(await upstream.arrayBuffer());
      const downloadedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (downloadedHash !== asset.sha256) {
        console.error(`[Media] Checksum mismatch for ${asset.id}: expected ${asset.sha256}, got ${downloadedHash}`);
        return res.status(502).json({ error: 'Stored media checksum mismatch. Re-upload this asset.' });
      }

      res.setHeader('Content-Type', asset.mimeType || upstream.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Length', fileBuffer.length);
      res.setHeader('X-Asset-SHA256', asset.sha256);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(fileBuffer);
    } catch (error) {
      console.error(`[Media] Failed to proxy ${asset.id} from ImageKit`, error);
      return res.status(502).json({ error: 'Unable to retrieve media from storage' });
    }
  }

  const filePath = path.join(MEDIA_DIR, asset.storageKey);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Physical media file missing from local storage' });
  }

  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Content-Length', asset.fileSize);
  res.setHeader('X-Asset-SHA256', asset.sha256);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

  fs.createReadStream(filePath).pipe(res);
});

// -------------------------------------------------------------
// 10. DEVICE HEARTBEAT & SYNC STATUS
// -------------------------------------------------------------
app.post('/api/device/heartbeat', deviceAuthMiddleware, (req: any, res: Response) => {
  const { appVersion, playbackStatus, appliedVersion, freeStorageBytes } = req.body;
  const deviceId = req.device.deviceId;

  const device = db.devices.find(d => d.id === deviceId);
  const screen = db.screens.find(s => s.deviceId === deviceId);
  if (device) {
    device.lastSeenAt = new Date().toISOString();
    if (appVersion) device.appVersion = appVersion;
  }

  // Keep heartbeat history bounded
  const heartbeatEntry = {
    id: 'hb-' + crypto.randomUUID(),
    deviceId,
    lastSeenAt: new Date().toISOString(),
    playbackStatus: playbackStatus || 'PLAYING',
    appliedVersion: appliedVersion ?? 0,
    freeStorageBytes: freeStorageBytes || 0,
    appVersion: appVersion || '1.0.0'
  };
  db.heartbeats.unshift(heartbeatEntry);
  if (db.heartbeats.length > 200) db.heartbeats.pop();

  saveDB(db);

  // Broadcast device status update to dashboard
  broadcastEvent('DEVICE_HEARTBEAT', {
    deviceId,
    playbackStatus,
    appliedVersion,
    lastSeenAt: heartbeatEntry.lastSeenAt,
    isOnline: true
  });

  res.json({
    status: 'acknowledged',
    serverTime: new Date().toISOString(),
    accountStatus: !device?.registered || !screen
      ? 'UNREGISTERED'
      : isScreenSuspended(screen)
        ? 'SUSPENDED'
        : 'ACTIVE',
    screenName: screen?.name || null,
    validUntil: screen?.validUntil || null
  });
});

app.post('/api/device/sync-status', deviceAuthMiddleware, (req: any, res: Response) => {
  const deviceId = req.device.deviceId;
  const { publishJobId, targetId, attemptId, manifestVersion, eventId, eventSequence, status,
    bytesDownloaded, totalBytes, filesCompleted, totalFiles, currentFile, progressPercent,
    errorCode, errorMessage, activeVersion } = req.body;
  if (!PUBLISH_STATES.includes(status) || status === 'SUPERSEDED') return res.status(400).json({ error: 'Invalid device status' });
  const target = db.publishTargets.find(t => t.id === targetId && t.jobId === publishJobId && t.deviceId === deviceId);
  if (!target || target.attemptId !== attemptId || target.targetVersion !== manifestVersion) return res.status(409).json({ error: 'Stale or mismatched publication attempt' });
  const newest = db.publishTargets.filter(t => t.deviceId === deviceId && t.status !== 'SUPERSEDED').sort((a,b) => b.targetVersion - a.targetVersion)[0];
  if (!newest || newest.id !== target.id) return res.status(409).json({ error: 'Publication was superseded' });
  const attempt = db.publishAttempts.find(a => a.id === attemptId);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  if (eventId && db.publishEvents.some(e => e.attemptId === attemptId && e.eventId === eventId)) return res.json({ status: 'duplicate', target });
  const sequence = Number(eventSequence || 0);
  if (sequence <= attempt.eventSequence) return res.json({ status: 'ignored_out_of_order', target });
  const currentRank = STATE_RANK[attempt.status] ?? -1, nextRank = STATE_RANK[status] ?? -1;
  if (attempt.status !== 'FAILED' && status !== 'FAILED' && nextRank < currentRank) return res.status(409).json({ error: 'Status regression rejected' });
  if (status === 'PLAYING' && Number(activeVersion) !== target.targetVersion) return res.status(409).json({ error: 'PLAYING requires acknowledgement of the correct active version' });
  const now = new Date().toISOString();
  const nextBytes = Math.max(attempt.bytesDownloaded || 0, Math.min(Number(bytesDownloaded || 0), Number(totalBytes ?? target.totalBytes)));
  const calculated = target.totalBytes === 0 ? 100 : Math.floor(nextBytes * 100 / target.totalBytes);
  Object.assign(attempt, { eventSequence: sequence, status, bytesDownloaded: nextBytes, totalBytes: Number(totalBytes ?? target.totalBytes), filesCompleted: Math.max(attempt.filesCompleted || 0, Number(filesCompleted || 0)), totalFiles: Number(totalFiles ?? target.totalFiles), currentFile: currentFile || null, progressPercent: Math.max(attempt.progressPercent || 0, calculated, Number(progressPercent || 0)), errorCode: status === 'FAILED' ? errorCode || 'DEVICE_ERROR' : null, errorMessage: status === 'FAILED' ? errorMessage || 'Device reported failure' : null });
  if (!attempt.startedAt && status !== 'QUEUED') attempt.startedAt = now;
  if (status === 'READY') attempt.readyAt = now;
  if (status === 'PLAYING') { attempt.activatedAt ||= now; attempt.playbackConfirmedAt = now; attempt.completedAt = now; }
  if (status === 'FAILED') attempt.completedAt = now;
  Object.assign(target, { status, bytesDownloaded: attempt.bytesDownloaded, filesCompleted: attempt.filesCompleted, progressPercent: attempt.progressPercent, currentFile: attempt.currentFile, lastProgressAt: now, errorCode: attempt.errorCode, errorMessage: attempt.errorMessage });
  if (status === 'READY') target.readyAt = now;
  if (status === 'PLAYING') { target.activeVersion = activeVersion; target.activatedAt = now; target.playbackConfirmedAt = now; }
  db.publishEvents.push({ id: 'event-' + crypto.randomUUID(), eventId: eventId || null, attemptId, targetId, status, eventSequence: sequence, details: { bytesDownloaded: nextBytes, filesCompleted, currentFile, errorCode, errorMessage }, createdAt: now });
  if (db.publishEvents.length > 5000) db.publishEvents.splice(0, db.publishEvents.length - 5000);
  saveDB(db); logAudit(null, deviceId, status === 'FAILED' ? 'PUBLICATION_FAILED' : status === 'PLAYING' ? 'PUBLICATION_PLAYING_CONFIRMED' : 'PUBLICATION_PROGRESS', { targetId, attemptId, status, manifestVersion });
  broadcastEvent('PUBLICATION_UPDATED', { jobId: publishJobId, targetId });
  res.json({ status: 'ok', target });
});

// -------------------------------------------------------------
// 11. AUDIT LOGS & SYSTEM STATS
// -------------------------------------------------------------
app.get('/api/audit', authMiddleware, (req: Request, res: Response) => {
  res.json(db.auditLogs.slice(0, 100));
});

// -------------------------------------------------------------
// 12. DOWNLOAD PACKAGES FOR LOCAL SETUP
// -------------------------------------------------------------
app.get('/api/downloads', (req: Request, res: Response) => {
  const getPackageInfo = (filename: string, name: string, description: string, tag: string) => {
    const filePath = path.join(DOWNLOADS_DIR, filename);
    const exists = fs.existsSync(filePath);
    const size = exists ? fs.statSync(filePath).size : 0;
    return {
      filename,
      name,
      description,
      tag,
      size,
      sizeFormatted: size > 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MB` : `${(size / 1024).toFixed(1)} KB`,
      downloadUrl: `/api/download/${filename}`,
      exists
    };
  };

  res.json([
    getPackageInfo(
      'screencast-android-player.zip',
      'Android TV Player (Kotlin Studio Project)',
      'Complete native Android TV application project ready for Android Studio, Leanback TV, D-pad navigation, Room, and Gradle build.',
      'Android APK Source'
    ),
    getPackageInfo(
      'screencast-dashboard-backend.zip',
      'Dashboard & Local Backend Server',
      'Full React Vite TypeScript dashboard with Express backend, WebSocket sync gateway, and PostgreSQL Prisma models.',
      'Server & Web'
    ),
    getPackageInfo(
      'screencast-full-monorepo.zip',
      'Complete Monorepo Suite',
      'Entire repository containing Android Player, Dashboard, Backend, Shared Types, Documentation, and Docker configuration.',
      'All-in-One'
    ),
    getPackageInfo(
      'screencast-docs-setup.zip',
      'Setup Guides & Architecture Docs',
      'Offline documentation markdown files for Android TV installation, Wi-Fi ADB sideloading, LAN configuration, and API specs.',
      'Documentation'
    )
  ]);
});

app.get('/api/download/:package', (req: Request, res: Response) => {
  const pkg = req.params.package;
  let filename = '';
  if (pkg === 'android' || pkg === 'android-player' || pkg === 'screencast-android-player.zip') {
    filename = 'screencast-android-player.zip';
  } else if (pkg === 'dashboard' || pkg === 'dashboard-backend' || pkg === 'screencast-dashboard-backend.zip') {
    filename = 'screencast-dashboard-backend.zip';
  } else if (pkg === 'monorepo' || pkg === 'full' || pkg === 'screencast-full-monorepo.zip') {
    filename = 'screencast-full-monorepo.zip';
  } else if (pkg === 'docs' || pkg === 'screencast-docs-setup.zip') {
    filename = 'screencast-docs-setup.zip';
  } else {
    filename = path.basename(pkg);
  }

  const filePath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Package file not found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// -------------------------------------------------------------
// 12. SWAGGER / API DOCS JSON
// -------------------------------------------------------------
app.get('/api/docs/swagger.json', (req: Request, res: Response) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'EkshitaScreen Local Network Digital Signage API',
      version: '1.0.0',
      description: 'REST and WebSocket API specification for EkshitaScreen Phase 1 Local Signage Management and Android TV playback.'
    },
    paths: {
      '/api/health': { get: { summary: 'Check local server connectivity (unauthenticated)' } },
      '/api/auth/login': { post: { summary: 'Dashboard user authentication' } },
      '/api/auth/me': { get: { summary: 'Get current dashboard session user' } },
      '/api/device/activation/request': { post: { summary: 'Android player requests temporary activation code' } },
      '/api/device/activation/status': { get: { summary: 'Poll status of temporary activation code' } },
      '/api/screens/register': { post: { summary: 'Dashboard registers screen using activation code' } },
      '/api/screens': { get: { summary: 'List all registered screens with live status' } },
      '/api/screens/{id}': { get: { summary: 'Get screen detail' }, patch: { summary: 'Update screen name/location' } },
      '/api/screens/{id}/config': { get: { summary: 'Get screen config' }, patch: { summary: 'Update screen configuration' } },
      '/api/media': { get: { summary: 'List media assets' } },
      '/api/media/upload': { post: { summary: 'Upload compressed 1920×1080 image media assets (JPEG or PNG)' } },
      '/api/media/{id}': { delete: { summary: 'Safely delete unreferenced media asset' } },
      '/api/screens/{id}/playlist': { get: { summary: 'Get draft & published playlists' } },
      '/api/screens/{id}/playlist/draft': { put: { summary: 'Save draft playlist without pushing' } },
      '/api/screens/{id}/playlist/publish': { post: { summary: 'Publish immutable playlist version and push to Android' } },
      '/api/device/manifest': { get: { summary: 'Android TV fetches published media manifest' } },
      '/api/device/media/{assetId}': { get: { summary: 'Stream media asset with SHA-256 header' } },
      '/api/device/heartbeat': { post: { summary: 'Android TV posts 30s heartbeat' } },
      '/api/device/sync-status': { post: { summary: 'Android TV reports download & staging progress' } }
    }
  });
});

// Vite Middleware for Development / Static Production Serving
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    const required = [
      'DATABASE_URL',
      'JWT_SECRET',
      'DEVICE_KEY_SECRET',
      'IMAGEKIT_PRIVATE_KEY',
      'IMAGEKIT_PUBLIC_KEY',
      'IMAGEKIT_URL_ENDPOINT',
      'ADMIN_EMAIL',
      'ADMIN_PASSWORD'
    ].filter(key => !process.env[key]);
    if (required.length > 0) throw new Error(`Missing required production variables: ${required.join(', ')}`);
  }

  await initializePostgres();

  // `npm start` executes the compiled file from dist, so treat that artifact as
  // production even when the caller has not explicitly set NODE_ENV.
  const isCompiledBuild = path.resolve(process.argv[1] || '') === path.resolve(process.cwd(), 'dist', 'server.js');
  if (process.env.NODE_ENV !== 'production' && !isCompiledBuild) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[EkshitaScreen] Server active on http://0.0.0.0:${PORT}`);
    console.log(`[EkshitaScreen] Media directory: ${MEDIA_DIR}`);
    console.log(`[EkshitaScreen] WebSocket Gateway ready for Android TV & Web Dashboard`);
  });
}

startServer().catch(err => {
  console.error('[EkshitaScreen] Fatal server error:', err);
  process.exitCode = 1;
});

