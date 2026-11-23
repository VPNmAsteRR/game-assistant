const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

/* =========================================================
   MineBuddy — десктоп-приложение (Windows)
   ---------------------------------------------------------
   - прозрачное окно-оверлей поверх игры
   - читает NDJSON-поток от мода Minecraft (127.0.0.1)
   - переподключается сам, если игра перезапустилась
   - реакции: правило-движок + опционально LLM (в следующем этапе)
   ========================================================= */

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const defaultConfig = {
  port: 47821,
  character: 'sunboy',
  muted: false,
  liteMode: false,
  showFeed: true,
  alwaysOnTop: true,
  clickThrough: true,
  bounds: null,
  voiceEnabled: false
};

let config = { ...defaultConfig };
let overlayWin = null;
let tray = null;
let tcpClient = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let connected = false;
let lastEventAt = 0;

/* ---------- конфиг ---------- */

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('config load failed', e);
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('config save failed', e);
  }
}

/* ---------- окно ---------- */

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;

  const bounds = config.bounds || {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height
  };

  overlayWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(config.clickThrough, { forward: true });

  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay', 'index.html'), {
    query: { overlay: '1' }
  });

  overlayWin.once('ready-to-show', () => {
    overlayWin.showInactive();
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function toggleOverlay() {
  if (!overlayWin) return createOverlay();
  if (overlayWin.isVisible()) overlayWin.hide();
  else overlayWin.showInactive();
}

/* ---------- мост к моду ---------- */

function connectToMod() {
  clearTimeout(reconnectTimer);

  if (tcpClient) {
    tcpClient.destroy();
    tcpClient = null;
  }

  const socket = new net.Socket();
  tcpClient = socket;
  let buffer = '';

  socket.setNoDelay(true);
  socket.setKeepAlive(true, 5000);

  socket.connect(config.port, '127.0.0.1', () => {
    connected = true;
    reconnectDelay = 1000;
    console.log('[bridge] подключено к моду на порту', config.port);
    updateTray();
    sendToOverlay({ type: 'bridge', connected: true });
  });

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');

    // защита от мусора: не даём буферу расти бесконечно
    if (buffer.length > 1_000_000) {
      buffer = buffer.slice(-100_000);
    }

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        handleModMessage(JSON.parse(line));
      } catch (e) {
        // битую строку просто пропускаем
      }
    }
  });

  socket.on('error', () => {
    // молча — мод может быть просто не запущен
  });

  socket.on('close', () => {
    if (connected) {
      console.log('[bridge] соединение потеряно');
    }
    connected = false;
    tcpClient = null;
    updateTray();
    sendToOverlay({ type: 'bridge', connected: false });

    // экспоненциальный бэкофф, максимум 10 секунд
    reconnectTimer = setTimeout(connectToMod, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  });
}

function sendToOverlay(payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('minebuddy', payload);
  }
}

/* ---------- обработка сообщений мода ---------- */

function handleModMessage(msg) {
  lastEventAt = Date.now();

  if (msg.type === 'hello') {
    sendToOverlay({ type: 'hello', version: msg.version });
    return;
  }

  if (msg.type === 'snapshot') {
    sendToOverlay({ type: 'snapshot', data: msg });
    reactToSnapshot(msg);
    return;
  }

  if (msg.type === 'event') {
    sendToOverlay({ type: 'event', data: msg });
    reactToEvent(msg);
  }
}

/* ---------- движок реакций ----------
   Пока без LLM: набор правил, чтобы приложение уже было живым.
   Позже сюда подставляется ответ модели.
   ------------------------------------ */

const REACTIONS = {
  death: [
    'Ну всё, приехали.',
    'Это было больно смотреть.',
    'Респавн. И сделай вид, что так и планировал.'
  ],
  damage: [
    'Тебе прилетело. Уворачивайся!',
    'Ай. Это было неприятно даже мне.'
  ],
  hunger: [
    'Ты голодный. Поешь, а то не доживёшь до вечера.',
    'Живот урчит громче крипера.'
  ],
  xp: [
    'Новый уровень. Хоть что-то.',
    'Опыт капает. Медленно, но капает.'
  ],
  dimension: [
    'Новое измерение. Не умри сразу.',
    'Загрузка... и вот мы уже не дома.'
  ],
  mob_near: [
    'Осторожно, рядом опасность.',
    'У тебя гости. И они не с добром.'
  ],
  mine_ore: [
    'Руда. Не забудь факелы.',
    'Копаешь? Хоть что-то полезное.'
  ],
  attack_mob: [
    'Бей! Или беги. Я не решаю за тебя.',
    'Агрессия. Мне нравится.'
  ],
  attack_animal: [
    'За что ты так с коровой?',
    'Она вообще не сопротивлялась.'
  ],
  join: [
    'Я на связи. Показывай, на что способен.',
    'Мир загружен. Начинаем.'
  ],
  leave: [
    'Уходишь? Ладно, до встречи.',
    'Сбежал. Понятно.'
  ]
};

const lastReaction = new Map();

function pickReaction(kind) {
  const pool = REACTIONS[kind];
  if (!pool || !pool.length) return null;

  // антиповтор: не чаще раза в 6 секунд на один тип
  const now = Date.now();
  const prev = lastReaction.get(kind) || 0;
  if (now - prev < 6000) return null;
  lastReaction.set(kind, now);

  return pool[Math.floor(Math.random() * pool.length)];
}

function reactToEvent(msg) {
  const text = pickReaction(msg.kind);
  if (!text) return;

  const emotion = emotionForKind(msg.kind);
  sendToOverlay({
    type: 'react',
    data: { text, emotion, kind: msg.kind, message: msg.message }
  });
}

function reactToSnapshot(snapshot) {
  // реакции на состояние — редко, только на критичное
  const now = Date.now();
  if (now - (reactToSnapshot._last || 0) < 20000) return;

  if (snapshot.health !== undefined && Number(snapshot.health) <= 4) {
    reactToSnapshot._last = now;
    sendToOverlay({
      type: 'react',
      data: {
        text: 'У тебя почти нет здоровья. Серьёзно, спрячься.',
        emotion: 'surprise',
        kind: 'lowhealth'
      }
    });
  }
}

function emotionForKind(kind) {
  switch (kind) {
    case 'death':
    case 'attack_mob':
      return 'anger';
    case 'damage':
    case 'mob_near':
    case 'hunger':
      return 'surprise';
    case 'xp':
    case 'mine_ore':
      return 'joy';
    case 'join':
    case 'leave':
      return 'neutral';
    case 'dimension':
      return 'think';
    default:
      return 'neutral';
  }
}

/* ---------- трей ---------- */

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: connected ? 'Мод: подключён' : 'Мод: не найден',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Показать / скрыть оверлей',
      accelerator: 'F11',
      click: toggleOverlay
    },
    {
      label: 'Lite-режим',
      type: 'checkbox',
      checked: config.liteMode,
      click: item => {
        config.liteMode = item.checked;
        saveConfig();
        sendToOverlay({ type: 'setting', key: 'lite', value: item.checked });
      }
    },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: item => {
        config.alwaysOnTop = item.checked;
        saveConfig();
        if (overlayWin) overlayWin.setAlwaysOnTop(item.checked, 'screen-saver');
      }
    },
    {
      label: 'Клики проходят в игру',
      type: 'checkbox',
      checked: config.clickThrough,
      click: item => {
        config.clickThrough = item.checked;
        saveConfig();
        if (overlayWin) overlayWin.setIgnoreMouseEvents(item.checked, { forward: true });
      }
    },
    { type: 'separator' },
    {
      label: 'Переподключиться к моду',
      click: connectToMod
    },
    {
      label: 'Папка с настройками',
      click: () => shell.openPath(app.getPath('userData'))
    },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() }
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(connected ? 'MineBuddy — мод подключён' : 'MineBuddy — ожидание мода');
}

function createTray() {
  // иконка генерируется на лету, чтобы не тащить бинарник в репозиторий
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,' + Buffer.from(TRAY_PNG_BASE64, 'base64').toString('base64')
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('double-click', toggleOverlay);
  updateTray();
}

/* 16x16 PNG-точка (зелёный круг на тёмном фоне) */
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR42mNkYPhfz0AEYBxVSF+F' +
  'jIyM/xkYGP4zMjL+Z2Rk/M/AwPCfkZHxPwMDw39GRsb/DAwM/xkZGf8zMDD8Z2Rk/M/AwPCfkZHx' +
  'PwMDw39GRsb/DAwM/wE1eQ4BZm5tWQAAAABJRU5ErkJggg==';

/* ---------- IPC ---------- */

ipcMain.handle('get-config', () => config);

ipcMain.on('save-config', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig();
  updateTray();
});

ipcMain.handle('toggle-click-through', () => {
  config.clickThrough = !config.clickThrough;
  saveConfig();
  if (overlayWin) overlayWin.setIgnoreMouseEvents(config.clickThrough, { forward: true });
  updateTray();
  return config.clickThrough;
});

ipcMain.handle('bridge-status', () => connected);

/* ---------- жизненный цикл ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (overlayWin) overlayWin.showInactive();
  });

  app.whenReady().then(() => {
    loadConfig();
    createOverlay();
    createTray();
    connectToMod();

    globalShortcut.register('F11', toggleOverlay);
    globalShortcut.register('F10', () => sendToOverlay({ type: 'demo' }));
    globalShortcut.register('F9', () => {
      config.muted = !config.muted;
      saveConfig();
      sendToOverlay({ type: 'setting', key: 'muted', value: config.muted });
    });
    globalShortcut.register('F7', () => sendToOverlay({ type: 'cycleCharacter' }));
    globalShortcut.register('F8', () => sendToOverlay({ type: 'settings' }));

    app.on('activate', () => {
      if (!overlayWin) createOverlay();
    });
  });

  app.on('window-all-closed', e => {
    e.preventDefault(); // живём в трее
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearTimeout(reconnectTimer);
    if (tcpClient) tcpClient.destroy();
  });
}
