(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var TOKEN_KEY = 'kintai_token';
  var USER_KEY = 'kintai_user';
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  var storage = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  var now0 = new Date();
  var state = {
    token: storage.get(TOKEN_KEY),
    user: parseJSON(storage.get(USER_KEY)),
    today: null,
    employees: null,
    hist: { tab: 'me', year: now0.getFullYear(), month: now0.getMonth() + 1, target: 'all' },
    edit: { target: null },
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

  // ===== 通信 =====
  var loadingCount = 0;
  function setLoading(on) {
    loadingCount += on ? 1 : -1;
    $('#loading').hidden = loadingCount <= 0;
  }

  function api(action, params, opts) {
    var body = Object.assign({ action: action, token: state.token }, params || {});
    var quiet = opts && opts.quiet;
    if (!quiet) setLoading(true);
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
      .finally(function () { if (!quiet) setLoading(false); });
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
    state.employees = null;
    storage.del(TOKEN_KEY);
    storage.del(USER_KEY);
  }

  // ===== 画面切り替え =====
  function showView(name) {
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].id !== 'view-' + name;
    window.scrollTo(0, 0);
  }

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
    api('login', { idToken: resp.credential })
      .then(function (d) {
        saveSession(d.token, d.user);
        if (location.hash === '#home') route(); else location.hash = '#home';
      })
      .catch(function (e) { $('#login-msg').textContent = e.message; });
  }

  function logout() {
    if (!confirm('ログアウトしますか？\n次に使うときは再度Googleログインが必要です。')) return;
    var p = state.token ? api('logout', {}, { quiet: true }).catch(function () {}) : Promise.resolve();
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
    $('#home-name').textContent = u.name ? u.name + ' さん' : '';
    $('#btn-admin').hidden = !u.isAdmin;
  }

  function renderToday(rec) {
    var d = todayStr();
    var inT = rec && rec.in ? rec.in : '--:--';
    var outT = rec && rec.out ? rec.out : '--:--';
    $('#home-today').textContent = fmtDay(d) + '　出勤 ' + inT + ' ／ 退勤 ' + outT;
  }

  function openHome() {
    showView('home');
    renderUserHead();
    tickClock();
    api('home', {}, { quiet: true })
      .then(function (d) {
        state.today = d.date;
        state.user = d.user;
        storage.set(USER_KEY, JSON.stringify(d.user));
        renderUserHead();
        renderToday(d.record);
      })
      .catch(handleError);
  }

  function punch(type, overwrite) {
    var btns = [$('#btn-in'), $('#btn-out')];
    btns.forEach(function (b) { b.disabled = true; });
    return api('punch', { type: type, overwrite: !!overwrite })
      .then(function (d) {
        if (d.needConfirm) {
          btns.forEach(function (b) { b.disabled = false; });
          if (confirm('すでに' + d.label + ' ' + d.current + ' で打刻済みです。\n現在の時刻で上書きしますか？')) return punch(type, true);
          return;
        }
        renderToday(d.record);
        toast(d.label + 'しました（' + d.time + '）', 'success');
      })
      .catch(handleError)
      .finally(function () { btns.forEach(function (b) { b.disabled = false; }); });
  }

  // ===== 社員一覧（選択肢用） =====
  function loadEmployees() {
    if (state.employees) return Promise.resolve(state.employees);
    return api('employees', {}, { quiet: true }).then(function (d) {
      state.employees = d.employees;
      return d.employees;
    });
  }

  function fillSelect(sel, list, selected, withAll) {
    var html = withAll ? '<option value="all">全員</option>' : '';
    list.forEach(function (e) {
      html += '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.active === false ? '（退職）' : '') + '</option>';
    });
    sel.innerHTML = html;
    sel.value = selected;
  }

  // ===== 打刻修正 =====
  function openEdit(params) {
    showView('edit');
    var u = state.user;
    var date = params.date ? fromInputDate(params.date) : todayStr();
    state.edit.target = params.target || u.id;

    var dateEl = $('#edit-date');
    dateEl.max = toInputDate(todayStr());
    dateEl.value = toInputDate(date);
    $('#edit-reason').value = '';

    $('#edit-target-wrap').hidden = !u.isAdmin;
    if (u.isAdmin) {
      loadEmployees().then(function (list) {
        fillSelect($('#edit-target'), list, state.edit.target, false);
      }).catch(handleError);
    }
    loadEditRecord();
    loadEditHistory();
  }

  function loadEditRecord() {
    var date = fromInputDate($('#edit-date').value);
    if (!date) return;
    $('#edit-info').textContent = '';
    api('getRecord', { date: date, targetId: state.edit.target })
      .then(function (d) {
        var r = d.record;
        $('#edit-in').value = r && r.in ? r.in : '';
        $('#edit-out').value = r && r.out ? r.out : '';
        var info = [];
        if (!r) info.push('この日の打刻はありません');
        else {
          if (r.kind) info.push('区分：' + r.kind);
          if (r.work) info.push('実働 ' + r.work + '（休憩13:00〜14:00を除く）');
        }
        $('#edit-info').textContent = info.join('　');
      })
      .catch(handleError);
  }

  function loadEditHistory() {
    var u = state.user;
    var isSelf = String(state.edit.target) === String(u.id);
    $('#edit-history-title').textContent = isSelf ? '自分の修正履歴' : '修正履歴（選択中の社員）';
    api('history', { targetId: state.edit.target }, { quiet: true })
      .then(function (d) { renderHistoryList($('#edit-history'), d.items, false); })
      .catch(handleError);
  }

  function saveEdit() {
    var date = fromInputDate($('#edit-date').value);
    if (!date) { toast('日付を選んでください', 'error'); return; }
    var inT = $('#edit-in').value;
    var outT = $('#edit-out').value;
    if (inT && outT && outT <= inT) { toast('退勤は出勤より後の時刻にしてください', 'error'); return; }
    var btn = $('#edit-save');
    btn.disabled = true;
    api('updateRecord', { date: date, targetId: state.edit.target, in: inT, out: outT, reason: $('#edit-reason').value })
      .then(function (d) {
        if (!d.changed) { toast('変更はありません'); return; }
        toast('保存しました', 'success');
        $('#edit-reason').value = '';
        loadEditRecord();
        loadEditHistory();
      })
      .catch(handleError)
      .finally(function () { btn.disabled = false; });
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
  }

  function renderTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === state.hist.tab);
    var isAll = state.hist.tab === 'all';
    $('#hist-target-wrap').hidden = !isAll;
    if (isAll) {
      loadEmployees().then(function (list) {
        fillSelect($('#hist-target'), list, state.hist.target, true);
      }).catch(handleError);
    }
  }

  function loadMonth() {
    var h = state.hist;
    $('#month-label').textContent = h.year + '年' + h.month + '月';
    $('#hist-body').innerHTML = '';
    $('#hist-total').textContent = '';
    var targetId = h.tab === 'me' ? state.user.id : h.target;
    api('month', { year: h.year, month: h.month, targetId: targetId })
      .then(function (d) {
        state.today = d.today;
        renderMonth(d, targetId);
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

    if (!showAllPeople) {
      head.innerHTML = '<tr><th>日付</th><th>出勤</th><th>退勤</th><th>実働</th></tr>';
      var map = {};
      d.records.forEach(function (r) { map[r.date] = r; });
      var last = new Date(d.year, d.month, 0).getDate();
      var canEdit = String(targetId) === String(u.id) || u.isAdmin;
      for (var day = 1; day <= last; day++) {
        var ds = d.year + '/' + pad2(d.month) + '/' + pad2(day);
        if (ds > d.today) break;
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
        byDate[ds].forEach(function (r) {
          rows.push(
            '<tr class="' + (u.isAdmin || String(r.id) === String(u.id) ? 'clickable' : '') + '" data-date="' + r.date + '" data-target="' + esc(r.id) + '">' +
            '<td>' + esc(r.name) + '</td><td>' + esc(r.in || '--:--') + '</td><td>' + esc(r.out || '--:--') + '</td><td>' +
            esc(r.work || '') + badge(r.kind) + '</td></tr>'
          );
        });
      });
      if (!rows.length) rows.push('<tr><td colspan="4" class="blank">データがありません</td></tr>');
    }
    body.innerHTML = rows.join('');
  }

  function onHistRowClick(e) {
    var tr = e.target.closest('tr.clickable');
    if (!tr) return;
    var target = tr.dataset.target;
    var q = 'date=' + encodeURIComponent(toInputDate(tr.dataset.date));
    if (target && target !== 'all' && String(target) !== String(state.user.id)) q += '&target=' + encodeURIComponent(target);
    location.hash = '#edit?' + q;
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
  function openAdmin() {
    showView('admin');
    state.employees = null; // 最新を取り直す
    loadEmployees().then(function (list) {
      $('#admin-emps').innerHTML = list.map(function (e) {
        return '<tr><td>' + esc(e.name) + '</td><td>' + (e.isAdmin ? '管理者' : '一般') + '</td><td>' +
          (e.active ? '○' : '—') + '</td><td class="small">' + esc(e.lastLogin || '未ログイン') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="blank">社員が登録されていません</td></tr>';
    }).catch(handleError);
    api('history', { targetId: 'all' })
      .then(function (d) { renderHistoryList($('#admin-history'), d.items, true); })
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
      if (!document.hidden && state.token && !$('#view-home').hidden) openHome();
    });
    setInterval(tickClock, 10000);
  }

  bind();
  route();
})();
