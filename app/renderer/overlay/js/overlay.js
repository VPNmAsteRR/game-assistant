/* =========================================================
   MineBuddy Overlay — ядро
   -----------------------------------------------------------
   Производительность:
   - typewriter работает на requestAnimationFrame с бюджетом
     времени, а не на setTimeout-на-символ
   - FPS-метр обновляется раз в секунду и только текстом
   - тяжёлые анимации отключаются, когда окно не в фокусе
     или включён Lite-режим
   - никаких layout-thrashing: все чтения DOM — батчами
   - публичное API для хоста (Electron/IPC/WebSocket)
   ========================================================= */
(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const params   = new URLSearchParams(location.search);
  const isOverlayHost = params.get('overlay') === '1';

  const root     = $('#app');
  const body     = document.body;
  const elCharName   = $('#charName');
  const elCharRole   = $('#charRole');
  const elCharEmotion= $('#charEmotion');
  const elDialogueName = $('#dialogueName');
  const elDialogueTag  = $('#dialogueTag');
  const elText   = $('#dialogueText');
  const elAvatarImg = $('#avatarImg');
  const elAvatarPh  = $('#avatarPh');
  const elFeed   = $('#feed');
  const elToast  = $('#toast');
  const elFps    = $('#fpsVal');
  const elLat    = $('#latVal');
  const elAiState= $('#aiState');
  const elMic    = $('#micState');
  const elScrim  = $('#scrim');
  const elRec    = $('#recDot');

  /* ---------- состояние ---------- */
  const state = {
    charIndex: 0,
    emotion: 'neutral',
    talking: false,
    muted: false,
    micOn: false,
    overlayVisible: true,
    hidden: false,
    typeSpeed: 34,        // символов в секунду
    latency: 180,         // мс, «задержка» индикатора
    lastActivity: performance.now(),
    fps: 0,
    lite: false
  };

  /* ---------- утилиты ---------- */

  function pick(arr) {
    return arr[(Math.random() * arr.length) | 0];
  }

  function toast(msg, ms = 1600) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => elToast.classList.remove('show'), ms);
  }

  function touchActivity() {
    state.lastActivity = performance.now();
    if (state.hidden) {
      state.hidden = false;
      body.classList.remove('idle');
    }
  }

  /* ---------- персонажи ---------- */
  const CHARS = window.MB_CHARACTERS || [];
  const EMO_LABELS = window.MB_EMOTION_LABELS || {};

  function currentChar() {
    return CHARS[state.charIndex] || CHARS[0];
  }

  function setCharacter(index, silent) {
    if (!CHARS.length) return;
    state.charIndex = ((index % CHARS.length) + CHARS.length) % CHARS.length;
    const c = currentChar();

    elCharName.textContent = c.name;
    elCharRole.textContent = c.role;
    elDialogueName.textContent = titleCase(c.name);
    elDialogueTag.textContent = c.tag || 'реакция';
    root.style.setProperty('--accent', c.accent || '#7dff8a');
    root.style.setProperty('--accent-2', c.accent || '#2fe07a');

    // пытаемся подхватить спрайт для текущей эмоции
    applyEmotion(state.emotion, true);
    renderCharList();

    if (!silent) toast(`Персонаж: ${c.name}`);
  }

  function titleCase(s) {
    return s
      .toLowerCase()
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function renderCharList() {
    const list = $('#charList');
    list.textContent = '';
    const frag = document.createDocumentFragment();

    CHARS.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'char-opt' + (i === state.charIndex ? ' active' : '');
      btn.dataset.char = c.id;

      const badge = document.createElement('span');
      badge.className = 'co-badge';
      badge.textContent = c.short;

      const wrap = document.createElement('span');
      const nm = document.createElement('span');
      nm.className = 'co-name';
      nm.textContent = c.name;
      const ds = document.createElement('span');
      ds.className = 'co-desc';
      ds.textContent = c.role;
      wrap.append(nm, document.createElement('br'), ds);

      const dot = document.createElement('span');
      dot.className = 'co-dot';

      btn.append(badge, wrap, dot);
      btn.addEventListener('click', () => {
        setCharacter(i);
        sayForEmotion('neutral', pick(c.lines.neutral || ['...']));
      });

      frag.appendChild(btn);
    });

    list.appendChild(frag);
  }

  /* ---------- эмоции + спрайты ---------- */
  let imgProbe = null;
  const missingSprites = new Set();

  function applyEmotion(emotion, silent) {
    const c = currentChar();
    if (!c) return;
    const allowed = c.emotions || ['neutral'];
    const emo = allowed.includes(emotion) ? emotion : 'neutral';
    state.emotion = emo;

    // CSS-заглушка
    elAvatarPh.dataset.emotion = emo;
    elCharEmotion.textContent = EMO_LABELS[emo] || emo.toUpperCase();

    // Попытка загрузить спрайт: assets/<id>/<emotion>.png
    const src = `assets/${c.id}/${emo}.png`;
    loadSprite(src);

    if (!silent) touchActivity();
  }

  function loadSprite(src) {
    // уже знаем, что файла нет — не дёргаем сеть повторно
    if (missingSprites.has(src)) {
      elAvatarImg.hidden = true;
      elAvatarPh.style.opacity = '1';
      return;
    }

    if (elAvatarImg.dataset.current !== src) {
      if (imgProbe) { imgProbe.onload = imgProbe.onerror = null; }
      imgProbe = new Image();
      imgProbe.onload = () => {
        elAvatarImg.src = src;
        elAvatarImg.dataset.current = src;
        elAvatarImg.hidden = false;
        elAvatarPh.style.opacity = '0';
      };
      imgProbe.onerror = () => {
        // спрайта нет — остаётся CSS-заглушка, запоминаем чтобы не спамить 404
        missingSprites.add(src);
        elAvatarImg.hidden = true;
        elAvatarImg.removeAttribute('src');
        delete elAvatarImg.dataset.current;
        elAvatarPh.style.opacity = '1';
      };
      imgProbe.src = src;
    }
  }

  /* ---------- диалог с эффектом печатной машинки ---------- */
  const typewriter = {
    full: '',
    shown: 0,
    raf: 0,
    last: 0,
    active: false,
    caret: null
  };

  function ensureCaret() {
    if (!typewriter.caret) {
      typewriter.caret = document.createElement('span');
      typewriter.caret.className = 'caret';
    }
    return typewriter.caret;
  }

  function sayForEmotion(emotion, text) {
    setTalking(true, 900 + text.length * 45);
    applyEmotion(emotion);
    typeText(text);
    pushFeed(emotionToKind(emotion), currentChar().name, text);
  }

  function typeText(text) {
    cancelAnimationFrame(typewriter.raf);
    typewriter.full = text;
    typewriter.shown = 0;
    typewriter.active = true;
    typewriter.last = performance.now();

    // один текстовый узел + caret: обновляем только nodeValue
    const textNode = document.createTextNode('');
    const caret = ensureCaret();
    elText.textContent = '';
    elText.appendChild(textNode);
    elText.appendChild(caret);

    const step = now => {
      if (!typewriter.active) return;

      const dt = Math.min(now - typewriter.last, 120); // защита от прыжков после лага
      typewriter.last = now;

      const add = Math.max(1, Math.floor((dt / 1000) * state.typeSpeed));
      typewriter.shown = Math.min(typewriter.full.length, typewriter.shown + add);
      textNode.nodeValue = typewriter.full.slice(0, typewriter.shown);

      if (typewriter.shown >= typewriter.full.length) {
        typewriter.active = false;
        setTimeout(() => {
          if (!typewriter.active && caret.parentNode) caret.remove();
        }, 900);
        return;
      }
      typewriter.raf = requestAnimationFrame(step);
    };

    typewriter.raf = requestAnimationFrame(step);
  }

  function setTalking(on, duration) {
    state.talking = on;
    body.classList.toggle('talking', on);
    clearTimeout(setTalking._t);
    if (on) {
      setTalking._t = setTimeout(() => {
        state.talking = false;
        body.classList.remove('talking');
      }, duration || 1200);
    }
  }

  function emotionToKind(emotion) {
    switch (emotion) {
      case 'anger': return 'bad';
      case 'surprise': return 'warn';
      case 'think': return 'info';
      case 'joy': return 'good';
      default: return 'info';
    }
  }

  /* ---------- лента событий ---------- */
  const MAX_FEED = 5;

  function renderFeedItem(kind, who, text) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.dataset.kind = kind || 'info';

    const k = document.createElement('div');
    k.className = 'feed-k';
    k.textContent = who || 'СОБЫТИЕ';

    const t = document.createElement('div');
    t.className = 'feed-t';
    t.textContent = text || '';

    const wrap = document.createElement('div');
    wrap.append(k, t);

    item.append(wrap);

    elFeed.appendChild(item);
    while (elFeed.children.length > MAX_FEED) elFeed.firstElementChild.remove();

    setTimeout(() => {
      item.classList.add('out');
      setTimeout(() => item.remove(), 260);
    }, 6200);
  }

  const pushFeed = (kind, who, text) => renderFeedItem(kind, who, text);

  /* ---------- FPS + латентность ---------- */
  let frames = 0;
  let fpsWindowStart = performance.now();

  function fpsLoop(now) {
    frames++;
    if (now - fpsWindowStart >= 1000) {
      const fps = Math.round((frames * 1000) / (now - fpsWindowStart));
      state.fps = fps;
      frames = 0;
      fpsWindowStart = now;

      // обновляем только если изменилось — меньше работы
      const txt = String(fps);
      if (elFps.textContent !== txt) elFps.textContent = txt;

      body.classList.toggle('fps-low', fps < 45 && fps >= 25);
      body.classList.toggle('fps-bad', fps < 25);

      // в Lite-режиме дополнительно режем анимации при просадке
      if (state.lite && fps < 20) body.classList.add('reduce-motion');
    }
    requestAnimationFrame(fpsLoop);
  }

  function setLatency(ms) {
    state.latency = ms;
    elLat.textContent = ms ? `${ms}ms` : '—';
    const out = $('#latOut');
    if (out) out.textContent = `${ms} мс`;
  }

  /* ---------- микрофон / звук ---------- */
  function setMic(on) {
    state.micOn = on;
    elMic.textContent = on ? 'вкл' : 'выкл';
    elMic.style.color = on ? 'var(--accent)' : '';
    $('#chipMic').classList.toggle('is-on', on);
  }

  function setMuted(muted, silent) {
    state.muted = muted;
    const btn = $('[data-act="mute"]');
    btn.classList.toggle('is-off', muted);
    btn.classList.toggle('is-on', !muted);
    if (!silent) toast(muted ? 'Звук выключен' : 'Звук включён');
  }

  /* ---------- настройки ---------- */
  const OPT_KEYS = ['lite', 'scanlines', 'idleSleep', 'reduceMotion', 'transparent', 'feed', 'hints'];
  const opts = {
    lite: false,
    scanlines: true,
    idleSleep: true,
    reduceMotion: false,
    transparent: isOverlayHost,
    feed: true,
    hints: true
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem('minebuddy.settings');
      if (raw) Object.assign(opts, JSON.parse(raw));
    } catch {}
    applyAllSettings();
  }

  function saveSettings() {
    try {
      localStorage.setItem('minebuddy.settings', JSON.stringify(opts));
    } catch {}
  }

  function applyAllSettings() {
    body.classList.toggle('lite', !!opts.lite);
    state.lite = !!opts.lite;
    body.classList.toggle('no-scan', !opts.scanlines);
    body.classList.toggle('reduce-motion', !!opts.reduceMotion || !!opts.lite);
    body.classList.toggle('transparent', !!opts.transparent);
    body.classList.toggle('no-hints', !opts.hints);
    $('#feed').classList.toggle('hidden', !opts.feed);

    $$('input[data-opt]').forEach(input => {
      const key = input.dataset.opt;
      if (input.type === 'checkbox') {
        if (key in opts) input.checked = !!opts[key];
      }
    });

    const perfNote = $('#perfNote');
    if (perfNote) {
      perfNote.textContent = state.lite
        ? 'Lite: 30 FPS · эффекты выкл · композитинг простой'
        : 'UI: 30 FPS · рендер: композитный';
    }
  }

  function bindSettingsUI() {
    $$('input[data-opt]').forEach(input => {
      const key = input.dataset.opt;
      if (key === 'typeSpeed' || key === 'latency') return;
      input.addEventListener('change', () => {
        opts[key] = input.checked;
        applyAllSettings();
        saveSettings();
      });
    });

    const speed = $('input[data-opt="typeSpeed"]');
    const speedOut = $('#typeSpeedOut');
    if (speed) {
      speed.value = String(state.typeSpeed);
      if (speedOut) speedOut.textContent = `${state.typeSpeed} зн/с`;
      speed.addEventListener('input', () => {
        state.typeSpeed = Number(speed.value);
        if (speedOut) speedOut.textContent = `${state.typeSpeed} зн/с`;
      });
    }

    const lat = $('input[data-opt="latency"]');
    if (lat) {
      lat.value = String(state.latency);
      setLatency(state.latency);
      lat.addEventListener('input', () => setLatency(Number(lat.value)));
    }
  }

  /* ---------- панели ---------- */
  function openDrawer(id) {
    closeDrawers();
    const d = document.getElementById(id);
    if (!d) return;
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    elScrim.hidden = false;
    touchActivity();
  }

  function closeDrawers() {
    $$('.drawer').forEach(d => {
      d.classList.remove('open');
      d.setAttribute('aria-hidden', 'true');
    });
    elScrim.hidden = true;
  }

  function toggleDrawer(id) {
    const d = document.getElementById(id);
    if (d && d.classList.contains('open')) closeDrawers();
    else openDrawer(id);
  }

  /* ---------- горячие клавиши ---------- */
  function bindKeys() {
    window.addEventListener('keydown', e => {
      // F6..F11 работают всегда
      switch (e.key) {
        case 'F6': {
          e.preventDefault();
          const c = currentChar();
          const i = c.emotions.indexOf(state.emotion);
          const next = c.emotions[(i + 1) % c.emotions.length];
          applyEmotion(next);
          sayForEmotion(next, pick((c.lines[next] || c.lines.neutral) || ['...']));
          break;
        }
        case 'F7':
          e.preventDefault();
          setCharacter(state.charIndex + 1);
          break;
        case 'F8':
          e.preventDefault();
          toggleDrawer('setDrawer');
          break;
        case 'F9':
          e.preventDefault();
          setMuted(!state.muted);
          break;
        case 'F10':
          e.preventDefault();
          runDemo();
          break;
        case 'F11':
          e.preventDefault();
          toggleOverlay();
          break;
        case 'Escape':
          closeDrawers();
          break;
      }
    });
  }

  function toggleOverlay() {
    state.overlayVisible = !state.overlayVisible;
    root.classList.toggle('hidden-overlay', !state.overlayVisible);
    if (!state.overlayVisible) {
      closeDrawers();
    }
    toast(state.overlayVisible ? 'Оверлей показан' : 'Оверлей скрыт (F11)');
  }

  /* ---------- демо-сценарий ---------- */
  const demoScript = [
    { emo: 'neutral',  delay: 0,    text: 'Так, я подключился. Вижу твой экран.' },
    { emo: 'think',    delay: 1500, text: 'Анализирую... ты стоишь на месте уже минуту.' },
    { emo: 'smug',     delay: 2000, text: 'Впечатляющая стратегия, ничего не скажешь.' },
    { emo: 'surprise', delay: 2200, text: 'О, крипер! Сзади! СЗАДИ!' },
    { emo: 'anger',    delay: 1800, text: 'Ну конечно, взорвался. Кто бы сомневался.' },
    { emo: 'sad',      delay: 1600, text: 'Ладно. Респавнись и попробуем ещё раз.' }
  ];

  function runDemo() {
    demoScript.forEach(step => {
      setTimeout(() => {
        applyEmotion(step.emo);
        typeText(step.text);
        setTalking(true, 1400);
        pushFeed(emotionToKind(step.emo), currentChar().name, step.text);
      }, step.delay);
    });
    toast('Демо-сценарий запущен');
  }

  /* ---------- события окружения ---------- */
  function bindChrome() {
    $$('.ibtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'chars') toggleDrawer('charDrawer');
        if (act === 'settings') toggleDrawer('setDrawer');
        if (act === 'mute') setMuted(!state.muted);
        if (act === 'demo') runDemo();
      });
    });

    $$('[data-close]').forEach(btn => {
      btn.addEventListener('click', closeDrawers);
    });

    elScrim.addEventListener('click', closeDrawers);

    // сон при простое
    setInterval(() => {
      if (!opts.idleSleep) return;
      const idle = performance.now() - state.lastActivity > 12000;
      if (idle && !state.hidden) {
        state.hidden = true;
        body.classList.add('idle');
      }
    }, 3000);

    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev => {
      window.addEventListener(ev, touchActivity, { passive: true });
    });

    // когда окно не в фокусе — гасим CSS-анимации
    document.addEventListener('visibilitychange', () => {
      body.classList.toggle('idle', document.hidden);
    });
    window.addEventListener('blur', () => body.classList.add('idle'));
    window.addEventListener('focus', () => { body.classList.remove('idle'); touchActivity(); });
  }

  /* ---------- публичное API для хоста ---------- */
  /**
   * window.MineBuddy.say({ text, emotion, character, tag })
   * window.MineBuddy.event({ kind, who, text })
   * window.MineBuddy.setCharacter(idOrIndex)
   * window.MineBuddy.emotion('anger')
   * window.MineBuddy.mic(true)
   * window.MineBuddy.talking(true)
   */
  const API = {
    say(opts = {}) {
      if (opts.character != null) {
        const idx = typeof opts.character === 'number'
          ? opts.character
          : CHARS.findIndex(c => c.id === opts.character);
        if (idx >= 0) setCharacter(idx, true);
      }
      if (opts.emotion) applyEmotion(opts.emotion, true);
      if (opts.tag) elDialogueTag.textContent = opts.tag;
      if (opts.text) {
        typeText(opts.text);
        setTalking(true, 900 + opts.text.length * 40);
        pushFeed(emotionToKind(opts.emotion || state.emotion), currentChar().name, opts.text);
      }
    },
    event(e = {}) {
      pushFeed(e.kind || 'info', e.who || 'СОБЫТИЕ', e.text || '');
    },
    emotion(name) {
      applyEmotion(name);
    },
    setCharacter(idOrIndex) {
      const idx = typeof idOrIndex === 'number'
        ? idOrIndex
        : CHARS.findIndex(c => c.id === idOrIndex);
      if (idx >= 0) setCharacter(idx);
    },
    mic(on) {
      setMic(!!on);
    },
    talking(on) {
      setTalking(!!on, 1500);
    },
    mute(on) {
      setMuted(!!on);
    },
    recording(on) {
      elRec.hidden = !on;
    },
    settings: opts,
    state,
    characters: CHARS
  };

  window.MineBuddy = API;

  /* ---------- интеграция с Electron-хостом ---------- */
  function bindHost() {
    const host = window.MineBuddyHost;
    if (!host) return; // запущено в браузере — работаем автономно

    host.onMessage(payload => {
      switch (payload.type) {
        case 'bridge':
          elAiState.textContent = payload.connected ? 'мод' : 'нет мода';
          elAiState.style.color = payload.connected ? 'var(--accent)' : '';
          $('#chipAI').classList.toggle('is-on', !!payload.connected);
          setMic(!!payload.connected);
          break;

        case 'snapshot':
          applySnapshot(payload.data);
          break;

        case 'event':
          handleModEvent(payload.data);
          break;

        case 'react':
          if (config.muted) break;
          applyEmotion(payload.data.emotion || 'neutral');
          typeText(payload.data.text);
          setTalking(true, 900 + payload.data.text.length * 45);
          pushFeed(emotionToKind(payload.data.emotion), currentChar().name, payload.data.text);
          break;

        case 'setting':
          if (payload.key === 'lite') {
            opts.lite = payload.value;
            applyAllSettings();
          }
          if (payload.key === 'muted') {
            setMuted(payload.value, true);
          }
          break;

        case 'demo':
          runDemo();
          break;

        case 'cycleCharacter':
          setCharacter(state.charIndex + 1);
          break;

        case 'settings':
          toggleDrawer('setDrawer');
          break;
      }
    });

    // подтягиваем начальные настройки от хоста
    host.getConfig?.().then(cfg => {
      if (!cfg) return;
      if (typeof cfg.liteMode === 'boolean') {
        opts.lite = cfg.liteMode;
        applyAllSettings();
      }
      config.muted = !!cfg.muted;
      setMuted(config.muted, true);
    }).catch(() => {});
  }

  const config = { muted: false };

  const lastSnapshotRender = { at: 0 };

  function applySnapshot(s) {
    if (!s) return;
    const now = performance.now();
    // обновляем HUD не чаще 4 раз в секунду
    if (now - lastSnapshotRender.at < 250) return;
    lastSnapshotRender.at = now;

    if (s.mobs && Array.isArray(s.mobs)) {
      state.nearbyMobs = s.mobs.length;
    }
  }

  function handleModEvent(e) {
    if (!e || !e.kind) return;
    const who = currentChar().name;
    pushFeed(kindToFeedKind(e.kind), who, e.message || e.kind);
  }

  function kindToFeedKind(kind) {
    switch (kind) {
      case 'death':
      case 'damage':
      case 'attack_mob':
        return 'bad';
      case 'hunger':
      case 'mob_near':
        return 'warn';
      case 'xp':
      case 'mine_ore':
      case 'join':
        return 'good';
      default:
        return 'info';
    }
  }

  /* ---------- запуск ---------- */
  function init() {
    loadSettings();
    bindSettingsUI();
    bindKeys();
    bindChrome();
    bindHost();

    renderCharList();
    setCharacter(0, true);
    applyEmotion('neutral', true);
    setMic(false);
    setMuted(false, true);
    setLatency(180);

    // в overlay-режиме убираем подсказки и хром, оставляем только сцену
    if (isOverlayHost) {
      opts.hints = false;
      opts.transparent = true;
      applyAllSettings();
      body.classList.add('overlay-mode');
    }

    requestAnimationFrame(fpsLoop);

    // приветственная реплика
    setTimeout(() => {
      const c = currentChar();
      typeText(pick(c.lines.neutral));
      setTalking(true, 1400);
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
