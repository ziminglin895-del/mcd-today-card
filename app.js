/**
 * app.js — 麦门今日情报卡
 *
 * 功能：
 *  - 通过 JSON-RPC over fetch 直连麦当劳 MCP（https://mcp.mcd.cn，Streamable HTTP）
 *  - 聚合 5 个只读工具：now-time-info / campaign-calendar / available-coupons /
 *    query-my-account / query-lottery-info（只查询，绝不调用 draw-lottery / auto-bind-coupons 等写操作）
 *  - 无 Token 时进入 Demo 模式：样例数据走同一套归一化管线，卡片标注「演示数据」
 *  - 结果渲染为 Canvas 竖版卡片，可下载 PNG 分享
 */
(function () {
  'use strict';

  var MCP_URL = 'https://mcp.mcd.cn';
  var TOKEN_KEY = 'mcd_today_card_token';
  var WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  /* ---------------- 工具函数 ---------------- */

  function $(id) { return document.getElementById(id); }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return Number(n).toLocaleString('zh-CN');
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (var i = 0; i < keys.length; i++) {
      if (obj[keys[i]] !== undefined && obj[keys[i]] !== null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return undefined;
  }

  function asList(raw, keys) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return [];
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(raw[keys[i]])) return raw[keys[i]];
    }
    if (raw.data && typeof raw.data === 'object') return asList(raw.data, keys);
    return [];
  }

  function shortDate(s) {
    if (!s) return '';
    var m = String(s).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return Number(m[2]) + '月' + Number(m[3]) + '日';
    return String(s);
  }

  /* ---------------- MCP 客户端（JSON-RPC over Streamable HTTP） ---------------- */

  function McpClient(token) {
    this.token = token;
    this.sessionId = null;
    this._id = 0;
  }

  McpClient.prototype._parseRpcBody = function (text, wantId) {
    text = (text || '').trim();
    if (!text) return null;
    if (text.charAt(0) === '{') {
      try { return JSON.parse(text); } catch (e) { return null; }
    }
    // SSE 形式：多行 data: {...}
    var found = null;
    text.split(/\r?\n/).forEach(function (line) {
      if (line.indexOf('data:') === 0) {
        try {
          var obj = JSON.parse(line.slice(5).trim());
          if (obj && (obj.id === wantId || obj.result || obj.error)) found = obj;
        } catch (e) { /* ignore */ }
      }
    });
    return found;
  };

  McpClient.prototype._rpc = function (method, params, isNotification) {
    var self = this;
    var headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + this.token
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    var body = { jsonrpc: '2.0', method: method, params: params || {} };
    if (!isNotification) body.id = ++this._id;

    return fetch(MCP_URL, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        var sid = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
        if (sid) self.sessionId = sid;
        if (isNotification) return null;
        if (res.status === 401) throw new Error('Token 无效或已过期（401），请检查后重试');
        if (res.status === 429) throw new Error('请求太频繁被限流（429），请稍后再试');
        if (!res.ok) throw new Error('MCP 服务返回 HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        if (isNotification) return null;
        var obj = self._parseRpcBody(text, body.id);
        if (!obj) throw new Error('MCP 响应解析失败');
        if (obj.error) throw new Error('MCP 错误：' + (obj.error.message || JSON.stringify(obj.error)));
        return obj.result;
      });
  };

  McpClient.prototype.initialize = function () {
    var self = this;
    return this._rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcd-today-card', version: '1.0.0' }
    }).then(function () {
      return self._rpc('notifications/initialized', {}, true).catch(function () { return null; });
    });
  };

  McpClient.prototype.callTool = function (name, args) {
    return this._rpc('tools/call', { name: name, arguments: args || {} })
      .then(function (result) { return parseToolPayload(result); });
  };

  function parseToolPayload(result) {
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    var parts = result.content || [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].type === 'text' && typeof parts[i].text === 'string') {
        try { return JSON.parse(parts[i].text); }
        catch (e) { return { rawText: parts[i].text }; }
      }
    }
    return result;
  }

  /* ---------------- 数据归一化：不同工具返回 → 统一卡片模型 ---------------- */

  function normalizeTime(raw) {
    var now = new Date();
    var dateStr = pick(raw || {}, ['date', 'today', 'currentDate', 'dateTime', 'now']);
    var d = now;
    if (dateStr) {
      var parsed = new Date(String(dateStr).replace(/-/g, '/'));
      if (!isNaN(parsed.getTime())) d = parsed;
    }
    return {
      label: (d.getMonth() + 1) + '月' + d.getDate() + '日',
      weekday: pick(raw || {}, ['weekDay', 'weekday', 'week']) || WEEKDAYS[d.getDay()],
      full: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    };
  }

  function normalizeCampaign(raw) {
    var list = asList(raw, ['campaigns', 'list', 'activities', 'items']);
    var ongoing = list.filter(function (c) {
      var s = String(pick(c, ['status', 'state']) || 'ongoing').toLowerCase();
      return s === 'ongoing' || s === 'active' || s === 'running' || s.indexOf('进行') >= 0 || s === '';
    });
    var use = ongoing.length ? ongoing : list;
    var first = use[0] || {};
    return {
      headline: pick(first, ['name', 'title', 'campaignName', 'activityName']) || '今日暂无进行中活动',
      detail: pick(first, ['description', 'desc', 'subtitle', 'intro']) || '',
      count: use.length
    };
  }

  function normalizeCoupons(raw) {
    var list = asList(raw, ['coupons', 'list', 'items', 'data']);
    var total = pick(raw || {}, ['total', 'count', 'totalCount']);
    var first = list[0] || {};
    return {
      count: (total !== undefined ? Number(total) : list.length) || 0,
      topName: pick(first, ['name', 'title', 'couponName']) || '',
      topDesc: pick(first, ['description', 'desc', 'condition', 'rule']) || ''
    };
  }

  function normalizeAccount(raw) {
    raw = raw || {};
    if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) raw = raw.data;
    return {
      points: pick(raw, ['availablePoints', 'points', 'balance', 'score', 'available']),
      expiring: pick(raw, ['expiringPoints', 'expirePoints', 'soonExpirePoints', 'expiring', 'willExpirePoints']) || 0,
      expireDate: pick(raw, ['expireDate', 'expiringDate', 'nearestExpireDate', 'expireTime']) || ''
    };
  }

  function normalizeLottery(raw) {
    raw = raw || {};
    if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) raw = raw.data;
    var prizes = asList(raw, ['prizes', 'prizeList', 'awards', 'rewards']).map(function (p) {
      return typeof p === 'string' ? p : (pick(p, ['name', 'prizeName', 'title']) || '');
    }).filter(Boolean);
    return {
      name: pick(raw, ['name', 'title', 'activityName', 'lotteryName']) || '今日抽奖',
      topPrize: prizes[0] || '',
      prizeCount: prizes.length,
      cost: pick(raw, ['costPoints', 'points', 'cost', 'requiredPoints'])
    };
  }

  function failedTile() { return { failed: true }; }

  /* ---------------- 组装卡片模型 ---------------- */

  function buildDemoModel() {
    var raw = window.MCD_DEMO_RAW;
    return {
      mode: 'demo',
      time: normalizeTime(raw['now-time-info']),
      campaign: normalizeCampaign(raw['campaign-calendar']),
      coupons: normalizeCoupons(raw['available-coupons']),
      account: normalizeAccount(raw['query-my-account']),
      lottery: normalizeLottery(raw['query-lottery-info'])
    };
  }

  function buildLiveModel(token, log) {
    var client = new McpClient(token);
    var model = { mode: 'live', time: normalizeTime(null), campaign: failedTile(), coupons: failedTile(), account: failedTile(), lottery: failedTile() };

    function step(name, label, apply) {
      log('… 正在查询' + label + '（' + name + '）');
      return client.callTool(name, {}).then(function (raw) {
        apply(raw);
        log('✓ ' + label + '已获取');
      }).catch(function (err) {
        log('✗ ' + label + '查询失败：' + err.message);
      });
    }

    return client.initialize().then(function () {
      log('✓ 已连接麦当劳 MCP（initialize 完成）');
      var jobs = [
        step('now-time-info', '当前时间', function (raw) { model.time = normalizeTime(raw); }),
        step('campaign-calendar', '今日活动', function (raw) { model.campaign = normalizeCampaign(raw); }),
        step('available-coupons', '可领优惠券', function (raw) { model.coupons = normalizeCoupons(raw); }),
        step('query-my-account', '我的账户积分', function (raw) { model.account = normalizeAccount(raw); }),
        step('query-lottery-info', '今日抽奖信息', function (raw) { model.lottery = normalizeLottery(raw); })
      ];
      return Promise.all(jobs).then(function () { return model; });
    });
  }

  /* ---------------- Canvas 卡片绘制 ---------------- */

  var CW = 750, CH = 1000;
  var RED = '#DA291C', YELLOW = '#FFC72C', INK = '#27251F', GRAY = '#8A8378', CREAM = '#FFF8EC';

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapLines(ctx, text, maxWidth, maxLines) {
    text = String(text || '');
    var lines = [], cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      if (ctx.measureText(cur + ch).width > maxWidth && cur) { lines.push(cur); cur = ch; }
      else cur += ch;
      if (lines.length === maxLines) break;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines) {
      var consumed = lines.join('').length;
      if (consumed < text.replace(/\n/g, '').length) {
        var last = lines[maxLines - 1];
        while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last + '…';
      }
    }
    return lines;
  }

  function drawLines(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    var lines = wrapLines(ctx, text, maxWidth, maxLines);
    lines.forEach(function (ln, i) { ctx.fillText(ln, x, y + i * lineHeight); });
    return lines.length;
  }

  function drawTile(ctx, x, y, w, h, color, iconChar, label, main, mainSize, sub, subColor) {
    ctx.save();
    ctx.shadowColor = 'rgba(60,40,0,0.10)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    rr(ctx, x, y, w, h, 24);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();

    // 图标圆
    ctx.beginPath();
    ctx.arc(x + 48, y + 50, 29, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 30px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(iconChar, x + 48, y + 52);

    // 标签
    ctx.fillStyle = GRAY;
    ctx.font = '500 24px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 92, y + 51);

    // 主信息
    ctx.fillStyle = INK;
    ctx.font = '700 ' + mainSize + 'px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.textBaseline = 'alphabetic';
    drawLines(ctx, main, x + 30, y + 138, w - 60, mainSize + 12, mainSize <= 30 ? 2 : 1);

    // 副信息（底部锚定：先折行，再从底边往上排，避免多行时溢出格子）
    ctx.fillStyle = subColor || GRAY;
    ctx.font = '400 22px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    var subLines = wrapLines(ctx, sub, w - 60, 2);
    var subFirstY = y + h - 28 - (subLines.length - 1) * 30;
    subLines.forEach(function (ln, i) { ctx.fillText(ln, x + 30, subFirstY + i * 30); });
  }

  function drawCard(canvas, model) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CW, CH);

    // 背景
    ctx.fillStyle = CREAM;
    ctx.fillRect(0, 0, CW, CH);

    // 顶部红带
    ctx.save();
    rr(ctx, 0, -30, CW, 232, 30);
    ctx.clip();
    ctx.fillStyle = RED;
    ctx.fillRect(0, 0, CW, 202);
    // 金色双拱（装饰）
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.arc(CW / 2 - 47, 96, 47, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(CW / 2 + 47, 96, 47, Math.PI, 0);
    ctx.stroke();
    ctx.restore();

    // 标题
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 47px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('麦门今日情报卡', CW / 2, 168);
    ctx.font = '500 19px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText("McDONALD'S · DAILY INTEL CARD", CW / 2, 42);

    // 日期 + 模式徽标
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = '700 35px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.fillText(model.time.label + ' ' + model.time.weekday, 40, 262);

    var badge = model.mode === 'demo' ? '演示数据' : '真实数据';
    ctx.font = '700 21px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    var bw = ctx.measureText(badge).width + 34;
    rr(ctx, CW - 40 - bw, 232, bw, 40, 20);
    ctx.fillStyle = model.mode === 'demo' ? '#F59E0B' : '#1D9E75';
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(badge, CW - 40 - bw / 2, 260);
    ctx.textAlign = 'left';

    // 四格情报
    var MX = 36, GAP = 20, TW = (CW - MX * 2 - GAP) / 2, TH = 252, TY1 = 292, TY2 = TY1 + TH + GAP;

    var camp = model.campaign, coup = model.coupons, acc = model.account, lot = model.lottery;

    drawTile(ctx, MX, TY1, TW, TH, RED, '活', '今日活动',
      camp.failed ? '暂时取不到' : camp.headline, 29,
      camp.failed ? '该项查询失败，可稍后重试' : ('共 ' + camp.count + ' 场进行中' + (camp.detail ? ' · ' + camp.detail : '')));

    drawTile(ctx, MX + TW + GAP, TY1, TW, TH, '#F59E0B', '券', '可领优惠券',
      coup.failed ? '暂时取不到' : (coup.count + ' 张待领'), 42,
      coup.failed ? '该项查询失败，可稍后重试' : (coup.topName ? ('如「' + coup.topName + '」' + (coup.topDesc ? ' · ' + coup.topDesc : '')) : '暂无可领优惠券'));

    var accSub, accSubColor;
    if (acc.failed) { accSub = '该项查询失败，可稍后重试'; }
    else if (Number(acc.expiring) > 0) { accSub = fmtNum(acc.expiring) + ' 分' + (acc.expireDate ? '将于 ' + shortDate(acc.expireDate) + ' 过期' : '即将过期') + '，记得用掉'; accSubColor = RED; }
    else { accSub = '近期没有要过期的积分'; }
    drawTile(ctx, MX, TY2, TW, TH, '#1D9E75', '分', '我的积分',
      acc.failed ? '暂时取不到' : (fmtNum(acc.points) + ' 分'), 42, accSub, accSubColor);

    var lotSub = lot.failed ? '该项查询失败，可稍后重试'
      : ((lot.topPrize ? '头奖「' + lot.topPrize + '」' : '今日可参与') + (lot.cost ? ' · ' + lot.cost + ' 积分/次' : ''));
    drawTile(ctx, MX + TW + GAP, TY2, TW, TH, '#7C5CD6', '奖', '今日抽奖',
      lot.failed ? '暂时取不到' : lot.name, 29, lotSub);

    // 今日一句话
    var summary = buildSummary(model);
    rr(ctx, MX, 830, CW - MX * 2, 84, 18);
    ctx.fillStyle = '#FFF1C9';
    ctx.fill();
    ctx.fillStyle = '#7A5B00';
    ctx.font = '500 23px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    drawLines(ctx, '📌 ' + summary, MX + 24, 866, CW - MX * 2 - 48, 32, 2);

    // 页脚
    ctx.fillStyle = GRAY;
    ctx.font = '400 20px "PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('数据来源：麦当劳 MCP（mcp.mcd.cn）· 本卡只做查询展示，不领券、不抽奖', CW / 2, 952);
    ctx.font = '400 18px "PingFang SC","Microsoft YaHei",sans-serif';
    var now = new Date();
    ctx.fillText('麦门今日情报卡 mcd-today-card · 生成于 ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + (model.mode === 'demo' ? ' · 演示模式' : ''), CW / 2, 980);
    ctx.textAlign = 'left';
  }

  function buildSummary(model) {
    var parts = [];
    if (!model.campaign.failed && model.campaign.count > 0) parts.push('今天有 ' + model.campaign.count + ' 场活动进行中');
    if (!model.coupons.failed && model.coupons.count > 0) parts.push(model.coupons.count + ' 张券可以领');
    if (!model.account.failed && Number(model.account.expiring) > 0) parts.push(fmtNum(model.account.expiring) + ' 积分快过期了');
    if (!model.lottery.failed) parts.push('抽奖「' + model.lottery.name + '」今日可参与');
    if (!parts.length) return '今天的情报暂时取不到，喝杯可乐再刷新一次。';
    return parts.join('，') + '。';
  }

  /* ---------------- UI 逻辑 ---------------- */

  function logLine(text) {
    var ul = $('log');
    var li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
    ul.scrollTop = ul.scrollHeight;
  }

  function setBusy(busy) {
    $('btn-generate').disabled = busy;
    $('btn-demo').disabled = busy;
  }

  function render(model) {
    drawCard($('card'), model);
    $('btn-download').disabled = false;
    window.__lastModel = model;
    window.__cardReady = true;
    var badge = $('mode-badge');
    badge.textContent = model.mode === 'demo' ? '当前：演示模式（样例数据）' : '当前：真实数据（来自你的麦当劳账号）';
    badge.className = 'badge ' + model.mode;
  }

  function generate(useDemo) {
    var token = ($('token').value || '').trim();
    $('log').innerHTML = '';
    window.__cardReady = false;
    setBusy(true);
    if (useDemo || !token) {
      if (!token && !useDemo) logLine('未填写 Token，自动进入演示模式（样例数据）。');
      logLine('演示模式：使用内置样例数据生成卡片，卡片右上角会标注「演示数据」。');
      setTimeout(function () { render(buildDemoModel()); setBusy(false); }, 60);
      return;
    }
    logLine('正在连接麦当劳 MCP …');
    buildLiveModel(token, logLine).then(function (model) {
      render(model);
      setBusy(false);
    }).catch(function (err) {
      logLine('✗ 连接失败：' + err.message);
      logLine('已自动用演示数据生成一张卡，你也可以检查 Token 后重试。');
      render(buildDemoModel());
      setBusy(false);
    });
  }

  function init() {
    var saved = '';
    try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
    if (saved) $('token').value = saved;

    $('btn-save-token').addEventListener('click', function () {
      try { localStorage.setItem(TOKEN_KEY, ($('token').value || '').trim()); } catch (e) { /* ignore */ }
      logLine('✓ Token 已保存到本机浏览器（localStorage），不会上传到任何服务器。');
    });
    $('btn-clear-token').addEventListener('click', function () {
      $('token').value = '';
      try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
      logLine('Token 已清除。');
    });
    $('btn-generate').addEventListener('click', function () { generate(false); });
    $('btn-demo').addEventListener('click', function () { generate(true); });
    $('btn-download').addEventListener('click', function () {
      var model = window.__lastModel;
      var name = '麦门今日情报卡-' + (model ? model.time.full : 'today') + '.png';
      $('card').toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }, 'image/png');
    });

    var q = new URLSearchParams(location.search);
    if (q.get('demo') === '1' || q.get('autogen') === '1') {
      generate(q.get('demo') === '1');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
