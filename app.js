(function () {
  'use strict';

  /*
   * 速く感じさせるための基本方針
   * - 一度取得したデータは端末に記憶（cache）し、画面を開いたらまず記憶した内容をすぐ表示する
   * - その裏でサーバーに最新を問い合わせ、返ってきたら表示を差し替える（右上に「更新中…」）
   * - 打刻・保存は押した瞬間に画面へ反映し、サーバーへの送信は裏で行う（失敗したら元に戻して知らせる）
   */

  var CFG = window.APP_CONFIG || {};
  var TOKEN_KEY = 'kintai_token';
  var USER_KEY = 'kintai_user';
  var CACHE_PREFIX = 'kc_';
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var BREAK_START = 13 * 60;
  var BREAK_END = 14 * 60;

  var storage = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // 端末に記憶するデータ（ログアウトで全て消す）
  var cache = {
    get: function (key) { return parseJSON(storage.get(CACHE_PREFIX + key)); },
    set: function (key, v) { storage.set(CACHE_PREFIX + key, JSON.stringify(v)); },
    del: function (key) { storage.del(CACHE_PREFIX + key); },
    clearAll: function () {
      try {
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf(CACHE_PREFIX) === 0) localStorage.removeItem(k); });
      } catch (e) { /* ignore */ }
    },
  };

  var now0 = new Date();
  var state = {
    token: storage.get(TOKEN_KEY),
    user: parseJSON(storage.get(USER_KEY)),
    today: null,
    todayRecord: null,
    punching: false,
    hist: { tab: 'me', year: now0.getFullYear(), month: now0.getMonth() + 1, target: 'all' },
    edit: { target: null, dirty: false },
  };

  function $(s) { return document.querySelector(s); }
  function parseJSON(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function pad2(n) { return ('0' + n).slice(-2); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function localToday() { var d = new Date(); return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()); }
  function todayStr() { return state.today || localToday(); }
  function toInputDate(d) { return d.replace(/\//g, '-'); }
  function fromInputDate(d) { return String(d || '').replace(/-/g, '/'); }
  function weekday(d) { var p = d.split('/'); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
  function fmtDay(d) { var p = d.split('/'); return Number(p[1]) + '/' + Number(p[2]) + '(' + WEEK[weekday(d)] + ')'; }
  function nowHHmm() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function toMin(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
  function fmtMin(m) { return Math.floor(m / 60) + ':' + pad2(m % 60); }
  // サーバーと同じ計算（13:00〜14:00 と重なる時間を除く）
  function calcWork(inT, outT) {
    if (!inT || !outT) return '';
    var a = toMin(inT), b = toMin(outT);
    if (b <= a) return '';
    var brk = Math.max(0, Math.min(b, BREAK_END) - Math.max(a, BREAK_START));
    return fmtMin(b - a - brk);
  }
  function monthKey(targetId, y, m) { return 'month:' + targetId + ':' + y + '-' + m; }

  // ===== 通信 =====
  var syncCount = 0;
  function setSyncing(on) {
    syncCount = Math.max(0, syncCount + (on ? 1 : -1));
    $('#sync').hidden = syncCount === 0;
  }

  // opts.overlay: 画面全体を「読み込み中」にする（ログイン時のみ）
  function api(action, params, opts) {
    var body = Object.assign({ action: action, token: state.token }, params || {});
    var overlay = opts && opts.overlay;
    if (overlay) $('#loading').hidden = false; else setSyncing(true);
    // Content-Type を付けない（text/plain）ことで CORS の事前確認を避ける
    return fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body) })
      .catch(function () { throw new Error('通信できませんでした。電波の良い場所でもう一度お試しください。'); })
      .then(function (res) {
        return res.json().catch(function () { throw new Error('サーバーの応答が不正です（config.js の API_URL を確認してください）'); });
      })
      .then(function (j) {
        if (!j.ok) {
          var err = new Error(j.error || 'エラーが発生しました');
          err.code = j.code;
          if (j.code === 'AUTH') { clearSession(); showLogin(j.error); }
          throw err;
        }
        return j.data;
      })
      .finally(function () { if (overlay) $('#loading').hidden = true; else setSyncing(false); });
  }

  function handleError(e) {
    if (e && e.code === 'AUTH') return;
    toast((e && e.message) || 'エラーが発生しました', 'error');
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, type === 'error' ? 5000 : 2500);
  }

  // ===== セッション =====
  function saveSession(token, user) {
    state.token = token;
    state.user = user;
    storage.set(TOKEN_KEY, token);
    storage.set(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    state.token = null;
    state.user = null;
    storage.del(TOKEN_KEY);
    storage.del(USER_KEY);
    cache.clearAll();
  }

  // ===== 記憶データの更新 =====
  function getEmployees() { return cache.get('emps') || []; }

  function getTodayCache() {
    var c = cache.get('today');
    if (!c || !state.user || c.userId !== state.user.id || c.date !== localToday()) return null;
    return c.record;
  }
  function setTodayCache(rec) {
    if (!state.user) return;
    cache.set('today', { userId: state.user.id, date: localToday(), record: rec || null });
  }

  /** 1件の勤怠を、記憶している月データ（本人用・全員用）に反映する */
  function applyRecordToCache(rec) {
    if (!rec) return;
    var p = rec.date.split('/');
    var y = +p[0], m = +p[1];
    [monthKey(rec.id, y, m), monthKey('all', y, m)].forEach(function (key) {
      var d = cache.get(key);
      if (!d) return;
      var found = false;
      d.records = d.records.map(function (r) {
        if (r.date === rec.date && String(r.id) === String(rec.id)) { found = true; return rec; }
        return r;
      });
      if (!found) d.records.push(rec);
      if (key.indexOf('month:all:') !== 0) {
        var total = 0;
        d.records.forEach(function (r) { if (r.work) { var t = r.work.split(':'); total += +t[0] * 60 + +t[1]; } });
        d.totalWork = fmtMin(total);
      }
      cache.set(key, d);
    });
    if (state.user && String(rec.id) === String(state.user.id) && rec.date === localToday()) setTodayCache(rec);
  }

  /** 記憶している月データから、指定日の勤怠を探す */
  function findCachedRecord(targetId, date) {
    var p = date.split('/');
    var keys = [monthKey(targetId, +p[0], +p[1]), monthKey('all', +p[0], +p[1])];
    for (var i = 0; i < keys.length; i++) {
      var d = cache.get(keys[i]);
      if (!d) continue;
      var r = d.records.filter(function (x) { return x.date === date && String(x.id) === String(targetId); })[0];
      if (r) return { record: r };
      if (keys[i].indexOf('month:all:') !== 0) return { record: null }; // 本人の月データにない＝打刻なし
    }
    return undefined; // 記憶なし（分からない）
  }

  // ===== 画面切り替え =====
  function showView(name) {
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].id !== 'view-' + name;
    window.scrollTo(0, 0);
  }
  function isView(name) { return !$('#view-' + name).hidden; }

  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    var parts = h.split('?');
    var params = {};
    (parts[1] || '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      params[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return { name: parts[0] || 'home', params: params };
  }

  function route() {
    if (!state.token) { showLogin(); return; }
    var r = parseHash();
    if (r.name === 'edit') openEdit(r.params);
    else if (r.name === 'history') openHistory();
    else if (r.name === 'admin' && state.user && state.user.isAdmin) openAdmin();
    else openHome();
  }

  // ===== ログイン =====
  var gsiInitialized = false;
  var gsiTries = 0;
  function showLogin(msg) {
    showView('login');
    $('#login-msg').textContent = msg || '';
    if (!CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_CLIENT_ID.indexOf('ここに') >= 0) {
      $('#login-msg').textContent = 'config.js の GOOGLE_CLIENT_ID が未設定です';
      return;
    }
    if (!(window.google && google.accounts && google.accounts.id)) {
      if (gsiTries++ < 50) setTimeout(function () { showLogin(msg); }, 200);
      else $('#login-msg').textContent = 'Googleログインを読み込めませんでした。ページを再読み込みしてください。';
      return;
    }
    if (!gsiInitialized) {
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, ux_mode: 'popup' });
      gsiInitialized = true;
    }
    google.accounts.id.renderButton($('#gsi-button'), {
      theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ja', width: 260,
    });
  }

  function onCredential(resp) {
    $('#login-msg').textContent = '';
    api('login', { idToken: resp.credential }, { overlay: true })
      .then(function (d) {
        cache.clearAll();
        saveSession(d.token, d.user);
        if (location.hash === '#home') route(); else location.hash = '#home';
      })
      .catch(function (e) { $('#login-msg').textContent = e.message; });
  }

  function logout() {
    if (!confirm('ログアウトしますか？\n次に使うときは再度Googleログインが必要です。')) return;
    var p = state.token ? api('logout', {}).catch(function () {}) : Promise.resolve();
    p.then(function () {
      clearSession();
      if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
      showLogin();
    });
  }

  // ===== ホーム =====
  function tickClock() {
    var d = new Date();
    $('#home-clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function renderUserHead() {
    var u = state.user || {};
    $('#home-name').innerHTML = u.name
      ? esc(u.name) + ' さん' + (u.isAdmin ? '<span class="admin-tag">（管理者）</span>' : '')
      : '';
    $('#btn-admin').hidden = !u.isAdmin;
  }

  // pending: 'in' / 'out' のとき、そのボタンを「送信中」表示にする
  function renderToday(rec, pending) {
    state.todayRecord = rec || null;
    var d = todayStr();
    var inT = rec && rec.in ? rec.in : '';
    var outT = rec && rec.out ? rec.out : '';
    $('#home-today').textContent = fmtDay(d) + '　出勤 ' + (inT || '--:--') + ' ／ 退勤 ' + (outT || '--:--');
    renderPunchButton($('#btn-in'), '出 勤', '出勤済', inT, pending === 'in');
    renderPunchButton($('#btn-out'), '退 勤', '退勤済', outT, pending === 'out');
  }

  // 打刻済みならボタンを「✓ 出勤済 09:58」の表示に変える（押せば上書きの確認が出る）
  function renderPunchButton(btn, label, doneLabel, time, sending) {
    btn.classList.toggle('done', !!time);
    btn.querySelector('.big-label').textContent = time ? '✓ ' + doneLabel + '　' + time : label;
    btn.querySelector('.big-sub').textContent = sending ? '送信中…' : time ? 'タップで打ち直し' : '';
  }

  var homeSeq = 0; // 古い応答で新しい表示を上書きしないための番号
  function openHome() {
    showView('home');
    renderUserHead();
    tickClock();
    if (!state.punching) renderToday(getTodayCache()); // 記憶している内容をすぐ表示
    var seq = ++homeSeq;
    api('home', {})
      .then(function (d) {
        state.today = d.date;
        state.user = d.user;
        storage.set(USER_KEY, JSON.stringify(d.user));
        // 今月の自分の勤怠と社員一覧も記憶（勤怠履歴・打刻修正をすぐ表示するため）
        if (d.month) cache.set(monthKey(d.user.id, d.month.year, d.month.month), d.month);
        if (d.employees) cache.set('emps', d.employees);
        if (isView('home')) renderUserHead();
        if (seq !== homeSeq || state.punching) return; // この間に打刻していたら無視
        setTodayCache(d.record);
        if (isView('home')) renderToday(d.record);
      })
      .catch(handleError);
  }

  function punch(type, overwrite) {
    if (state.punching) return;
    var label = type === 'in' ? '出勤' : '退勤';
    var before = state.todayRecord;
    // 端末側で打刻済みが分かっていれば、送信前に確認する
    if (!overwrite && before && before[type]) {
      if (!confirm('すでに' + label + ' ' + before[type] + ' で打刻済みです。\n現在の時刻で上書きしますか？')) return;
      overwrite = true;
    }
    // 押した瞬間に表示を切り替える（時刻はサーバーの応答で確定）
    var optimistic = Object.assign({}, before || {});
    optimistic[type] = nowHHmm();
    renderToday(optimistic, type);
    state.punching = true;
    homeSeq++;

    return api('punch', { type: type, overwrite: !!overwrite })
      .then(function (d) {
        state.punching = false;
        if (d.needConfirm) {
          // 端末の記憶が古く、サーバー側では打刻済みだった場合
          var cur = Object.assign({}, before || {});
          cur[type] = d.current;
          renderToday(cur);
          if (confirm('すでに' + d.label + ' ' + d.current + ' で打刻済みです。\n現在の時刻で上書きしますか？')) return punch(type, true);
          return;
        }
        applyRecordToCache(d.record);
        setTodayCache(d.record);
        if (isView('home')) renderToday(d.record);
        toast(d.label + 'しました（' + d.time + '）', 'success');
      })
      .catch(function (e) {
        state.punching = false;
        if (isView('home')) renderToday(before); // 失敗したら元の表示に戻す
        handleError(e);
      });
  }

  // ===== 選択肢 =====
  function fillSelect(sel, list, selected, withAll) {
    var html = withAll ? '<option value="all">全員</option>' : '';
    list.forEach(function (e) {
      html += '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.active === false ? '（退職）' : '') + '</option>';
    });
    sel.innerHTML = html;
    sel.value = selected;
  }

  function refreshEmployees() {
    return api('employees', {}).then(function (d) {
      cache.set('emps', d.employees);
      return d.employees;
    });
  }

  // ===== 打刻修正 =====
  function openEdit(params) {
    showView('edit');
    var u = state.user;
    var date = params.date ? fromInputDate(params.date) : todayStr();
    state.edit.target = params.target || u.id;
    // 勤怠履歴から来たときは「戻る」で勤怠履歴へ（表示していた月・タブ・位置のまま）
    $('#edit-back').setAttribute('href', params.from === 'history' ? '#history' : '#home');

    var dateEl = $('#edit-date');
    dateEl.max = toInputDate(todayStr());
    dateEl.value = toInputDate(date);
    $('#edit-reason').value = '';
    $('#edit-save').disabled = false;

    $('#edit-target-wrap').hidden = !u.isAdmin;
    if (u.isAdmin) fillSelect($('#edit-target'), getEmployees(), state.edit.target, false);
    loadEditRecord();
    loadEditHistory();
  }

  function editTargetName() {
    if (String(state.edit.target) === String(state.user.id)) return state.user.name;
    var e = getEmployees().filter(function (x) { return String(x.id) === String(state.edit.target); })[0];
    return e ? e.name : '';
  }

  function fillEditForm(r, known) {
    $('#edit-in').value = r && r.in ? r.in : '';
    $('#edit-out').value = r && r.out ? r.out : '';
    var info = [];
    if (!known) info.push('読み込み中…');
    else if (!r) info.push('この日の打刻はありません');
    else {
      if (r.kind) info.push('区分：' + r.kind);
      if (r.work) info.push('実働 ' + r.work + '（休憩13:00〜14:00を除く）');
    }
    $('#edit-info').textContent = info.join('　');
  }

  var editSeq = 0;
  function loadEditRecord() {
    var date = fromInputDate($('#edit-date').value);
    if (!date) return;
    var target = state.edit.target;
    state.edit.dirty = false;
    // 記憶している内容をすぐ表示
    var c = findCachedRecord(target, date);
    fillEditForm(c ? c.record : null, c !== undefined);
    // 裏で最新を確認（入力を始めていたら上書きしない）
    var seq = ++editSeq;
    api('getRecord', { date: date, targetId: target })
      .then(function (d) {
        if (seq !== editSeq || state.edit.dirty || !isView('edit')) return;
        fillEditForm(d.record, true);
      })
      .catch(handleError);
  }

  var editHistSeq = 0;
  function loadEditHistory() {
    var u = state.user;
    var target = state.edit.target;
    var isSelf = String(target) === String(u.id);
    $('#edit-history-title').textContent = isSelf ? '自分の修正履歴' : '修正履歴（選択中の社員）';
    var key = 'hist:' + target;
    var cached = cache.get(key);
    if (cached) renderHistoryList($('#edit-history'), cached, false);
    else $('#edit-history').innerHTML = '<li class="empty">読み込み中…</li>';
    var seq = ++editHistSeq;
    api('history', { targetId: target })
      .then(function (d) {
        cache.set(key, d.items);
        if (seq === editHistSeq && isView('edit')) renderHistoryList($('#edit-history'), d.items, false);
      })
      .catch(handleError);
  }

  function saveEdit() {
    var date = fromInputDate($('#edit-date').value);
    if (!date) { toast('日付を選んでください', 'error'); return; }
    if (date > localToday()) { toast('未来の日付は修正できません', 'error'); return; }
    var inT = $('#edit-in').value;
    var outT = $('#edit-out').value;
    if (inT && outT && outT <= inT) { toast('退勤は出勤より後の時刻にしてください', 'error'); return; }

    var target = state.edit.target;
    var reason = $('#edit-reason').value;
    var known = findCachedRecord(target, date);
    var prev = known ? known.record : null;
    if (known !== undefined && (prev ? prev.in || '' : '') === inT && (prev ? prev.out || '' : '') === outT) {
      toast('変更はありません');
      return;
    }

    // 送信を待たずに画面と記憶を更新して、最初の画面へ戻る
    var optimistic = { date: date, id: String(target), name: editTargetName(), in: inT, out: outT, work: calcWork(inT, outT), kind: '修正' };
    applyRecordToCache(optimistic);
    cache.del('hist:' + target); // 修正履歴は次に開いたときに取り直す
    cache.del('hist:all');
    // 開いた元の画面へ戻る（勤怠履歴から来たなら勤怠履歴、それ以外はホーム）
    location.hash = $('#edit-back').getAttribute('href') || '#home';
    toast('保存中…');

    api('updateRecord', { date: date, targetId: target, in: inT, out: outT, reason: reason })
      .then(function (d) {
        applyRecordToCache(d.record);
        if (isView('home') && String(target) === String(state.user.id) && date === localToday() && !state.punching) {
          renderToday(d.record);
        }
        toast(d.changed ? '保存しました' : '変更はありません', d.changed ? 'success' : '');
      })
      .catch(function (e) {
        // 失敗したら記憶を捨てて、最新を取り直す
        var p = date.split('/');
        cache.del(monthKey(target, +p[0], +p[1]));
        cache.del(monthKey('all', +p[0], +p[1]));
        if (String(target) === String(state.user.id) && date === localToday()) cache.del('today');
        if (e && e.code === 'AUTH') return;
        toast('保存できませんでした：' + e.message, 'error');
        if (isView('home')) openHome();
        if (isView('history')) loadMonth();
      });
  }

  function renderHistoryList(ul, items, showTarget) {
    if (!items.length) { ul.innerHTML = '<li class="empty">修正履歴はありません</li>'; return; }
    ul.innerHTML = items.map(function (h) {
      return '<li>' +
        '<div class="h-top">' + esc(h.at) + '　修正者：' + esc(h.editor) + '</div>' +
        '<div class="h-main">' + (showTarget ? esc(h.target) + '　' : '') + esc(fmtDay(h.date)) + ' ' + esc(h.field) + '：' +
        esc(h.before) + ' → <b>' + esc(h.after) + '</b></div>' +
        (h.reason ? '<div class="h-reason">理由：' + esc(h.reason) + '</div>' : '') +
        '</li>';
    }).join('');
  }

  // ===== 勤怠履歴 =====
  function openHistory() {
    showView('history');
    renderTabs();
    loadMonth();
    // 打刻修正から戻ってきたときは、元のスクロール位置に戻す
    if (state.hist.scrollY) {
      window.scrollTo(0, state.hist.scrollY);
      state.hist.scrollY = 0;
    }
  }

  function renderTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === state.hist.tab);
    var isAll = state.hist.tab === 'all';
    $('#hist-target-wrap').hidden = !isAll;
    if (isAll) fillSelect($('#hist-target'), getEmployees(), state.hist.target, true);
  }

  var monthSeq = 0;
  function loadMonth() {
    var h = state.hist;
    $('#month-label').textContent = h.year + '年' + h.month + '月';
    var targetId = h.tab === 'me' ? state.user.id : h.target;
    var key = monthKey(targetId, h.year, h.month);
    var cached = cache.get(key);
    if (cached) renderMonth(cached, targetId);
    else {
      $('#hist-head').innerHTML = '';
      $('#hist-body').innerHTML = '<tr><td colspan="4" class="blank">読み込み中…</td></tr>';
      $('#hist-total').textContent = '';
    }
    var seq = ++monthSeq;
    api('month', { year: h.year, month: h.month, targetId: targetId })
      .then(function (d) {
        state.today = d.today;
        cache.set(key, d);
        if (seq === monthSeq && isView('history')) renderMonth(d, targetId);
      })
      .catch(handleError);
  }

  function badge(kind) {
    if (kind === '自動補完') return '<span class="badge auto">自動</span>';
    if (kind === '修正') return '<span class="badge edit">修正</span>';
    return '';
  }

  function dayClass(d) {
    var w = weekday(d);
    return w === 0 ? 'sun' : w === 6 ? 'sat' : '';
  }

  function renderMonth(d, targetId) {
    var u = state.user;
    var head = $('#hist-head');
    var body = $('#hist-body');
    var rows = [];
    var showAllPeople = targetId === 'all';
    var today = d.today > localToday() ? d.today : localToday();

    if (!showAllPeople) {
      head.innerHTML = '<tr><th>日付</th><th>出勤</th><th>退勤</th><th>実働</th></tr>';
      var map = {};
      d.records.forEach(function (r) { map[r.date] = r; });
      var last = new Date(d.year, d.month, 0).getDate();
      var canEdit = String(targetId) === String(u.id) || u.isAdmin;
      for (var day = 1; day <= last; day++) {
        var ds = d.year + '/' + pad2(d.month) + '/' + pad2(day);
        if (ds > today) break;
        var r = map[ds];
        rows.push(
          '<tr class="' + (canEdit ? 'clickable' : '') + '" data-date="' + ds + '" data-target="' + esc(targetId) + '">' +
          '<td class="' + dayClass(ds) + '">' + fmtDay(ds) + '</td>' +
          (r ? '<td>' + esc(r.in || '--:--') + '</td><td>' + esc(r.out || '--:--') + '</td><td>' + esc(r.work || '') + badge(r.kind) + '</td>'
             : '<td class="blank">--:--</td><td class="blank">--:--</td><td></td>') +
          '</tr>'
        );
      }
      if (!rows.length) rows.push('<tr><td colspan="4" class="blank">データがありません</td></tr>');
      else rows.reverse(); // 新しい日付を上に
      $('#hist-total').textContent = '月合計 実働 ' + (d.totalWork || '0:00');
    } else {
      head.innerHTML = '<tr><th>氏名</th><th>出勤</th><th>退勤</th><th>実働</th></tr>';
      var byDate = {};
      d.records.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
      Object.keys(byDate).sort().reverse().forEach(function (ds) {
        rows.push('<tr class="date-group"><td colspan="4" class="' + dayClass(ds) + '">' + fmtDay(ds) + '</td></tr>');
        byDate[ds].sort(function (a, b) { return +a.id - +b.id; }).forEach(function (r) {
          rows.push(
            '<tr class="' + (u.isAdmin || String(r.id) === String(u.id) ? 'clickable' : '') + '" data-date="' + r.date + '" data-target="' + esc(r.id) + '">' +
            '<td>' + esc(r.name) + '</td><td>' + esc(r.in || '--:--') + '</td><td>' + esc(r.out || '--:--') + '</td><td>' +
            esc(r.work || '') + badge(r.kind) + '</td></tr>'
          );
        });
      });
      if (!rows.length) rows.push('<tr><td colspan="4" class="blank">データがありません</td></tr>');
      $('#hist-total').textContent = '';
    }
    body.innerHTML = rows.join('');
  }

  function onHistRowClick(e) {
    var tr = e.target.closest('tr.clickable');
    if (!tr) return;
    var target = tr.dataset.target;
    var q = 'date=' + encodeURIComponent(toInputDate(tr.dataset.date));
    if (target && target !== 'all' && String(target) !== String(state.user.id)) q += '&target=' + encodeURIComponent(target);
    state.hist.scrollY = window.scrollY; // 戻ってきたときに同じ位置を表示するため
    location.hash = '#edit?' + q + '&from=history';
  }

  function moveMonth(delta) {
    var h = state.hist;
    var m = h.month + delta;
    var y = h.year;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    var t = todayStr().split('/');
    if (y > +t[0] || (y === +t[0] && m > +t[1])) return; // 未来の月へは進まない
    h.year = y;
    h.month = m;
    loadMonth();
  }

  // ===== 管理 =====
  function renderAdminEmployees(list) {
    $('#admin-emps').innerHTML = list.map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td><td>' + (e.isAdmin ? '管理者' : '一般') + '</td><td>' +
        (e.active ? '○' : '—') + '</td><td class="small">' + esc(e.lastLogin || '未ログイン') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="blank">社員が登録されていません</td></tr>';
  }

  function openAdmin() {
    showView('admin');
    renderAdminEmployees(getEmployees());
    refreshEmployees().then(function (list) { if (isView('admin')) renderAdminEmployees(list); }).catch(handleError);

    var cached = cache.get('hist:all');
    if (cached) renderHistoryList($('#admin-history'), cached, true);
    else $('#admin-history').innerHTML = '<li class="empty">読み込み中…</li>';
    api('history', { targetId: 'all' })
      .then(function (d) {
        cache.set('hist:all', d.items);
        if (isView('admin')) renderHistoryList($('#admin-history'), d.items, true);
      })
      .catch(handleError);
  }

  // ===== イベント =====
  function bind() {
    $('#btn-in').addEventListener('click', function () { punch('in'); });
    $('#btn-out').addEventListener('click', function () { punch('out'); });
    $('#btn-logout').addEventListener('click', logout);

    $('#edit-date').addEventListener('change', function () { loadEditRecord(); });
    $('#edit-target').addEventListener('change', function (e) {
      state.edit.target = e.target.value;
      loadEditRecord();
      loadEditHistory();
    });
    ['#edit-in', '#edit-out'].forEach(function (s) {
      $(s).addEventListener('input', function () { state.edit.dirty = true; });
    });
    $('#edit-save').addEventListener('click', saveEdit);

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        state.hist.tab = e.currentTarget.dataset.tab;
        renderTabs();
        loadMonth();
      });
    }
    $('#hist-target').addEventListener('change', function (e) { state.hist.target = e.target.value; loadMonth(); });
    $('#month-prev').addEventListener('click', function () { moveMonth(-1); });
    $('#month-next').addEventListener('click', function () { moveMonth(1); });
    $('#hist-body').addEventListener('click', onHistRowClick);

    window.addEventListener('hashchange', route);
    // アプリに戻ってきたとき、ホームなら本日の状態を更新
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.token && isView('home')) openHome();
    });
    setInterval(tickClock, 10000);
  }

  bind();
  route();
})();
