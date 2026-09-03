/* DMAIC Tools 注册激活核心逻辑（浏览器与 Node 通用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMAIC = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var SERIAL_START = 1001;
  var BIOS_PLACEHOLDER = 'TBFBYOEM';
  var PC_PLACEHOLDER = 'PCNAME';
  var REG_HEADER = ['注册序号', '账号名', '支付兑换码', '日期序列', 'BIOS序列号', '计算机名', '激活密钥', '联系电话', '联系邮箱', '注册时间', '激活时间'];
  var CODES_HEADER = ['兑换码'];
  var FEEDBACK_FILE = 'feedback.json';
  var FEEDBACK_MAX = 300;

  var ACCOUNT_RE = /^[A-Za-z]{5,9}$/;
  var PHONE_RE = /^[\d+()\-\s]{5,20}$/;
  var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  /* 账号名不区分大小写：查重 / 找回 / 反馈均按小写比较 */
  function sameAccount(a, b) {
    return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
  }

  /* ---------- 支付兑换码：生成与校验 ----------
     数据码 = MOD(种子×987654321+123456789, 9000000000)+1000000000  (10位)
     校验码 = 98 - MOD(数据码×100, 97)  (2位)
     校验： (前10位×100+后2位) MOD 97 = 1                              */

  function isValidCode(code) {
    if (typeof code !== 'string' || !/^\d{12}$/.test(code)) return false;
    var d = Number(code.slice(0, 10));
    var c = Number(code.slice(10));
    return (d * 100 + c) % 97 === 1;
  }

  function randomSeed() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return BigInt(a[0]);
    }
    return BigInt(Math.floor(Math.random() * 4294967296));
  }

  function codeFromSeed(seed) {
    var data = (BigInt(seed) * 987654321n + 123456789n) % 9000000000n + 1000000000n;
    var check = 98n - ((data * 100n) % 97n);
    return data.toString() + check.toString().padStart(2, '0');
  }

  function generateCode() { return codeFromSeed(randomSeed()); }

  function generateCodeFromSeed(seed) {
    var s = Number(seed);
    if (!isFinite(s) || s < 0 || Math.floor(s) !== s) return null;
    return codeFromSeed(BigInt(s));
  }

  function generateCodesFromSeeds(start, end) {
    var a = Number(start), b = Number(end);
    if (!isFinite(a) || !isFinite(b) || a < 0 || b < a || b - a + 1 > 10000) return null;
    var out = [];
    for (var i = a; i <= b; i++) out.push(codeFromSeed(BigInt(i)));
    return out;
  }

  function generateCodes(n) {
    var set = new Set();
    var guard = 0;
    while (set.size < n && guard < n * 50) { set.add(generateCode()); guard++; }
    return Array.from(set);
  }

  /* ---------- BIOS 序列号归一化 ---------- */

  function normalizeBios(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return BIOS_PLACEHOLDER;
    var lines = v.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    v = lines.length ? lines[lines.length - 1] : '';
    if (!v) return BIOS_PLACEHOLDER;
    if (/^serial\s*number$/i.test(v)) return BIOS_PLACEHOLDER;
    if (/to\s*be\s*filled\s*by\s*o\.?\s*e\.?\s*m\.?/i.test(v)) return BIOS_PLACEHOLDER;
    if (/^(none|null|n\/a|default string|unknown|not specified|system serial number)$/i.test(v)) return BIOS_PLACEHOLDER;
    v = v.replace(/[,\r\n\t]/g, '');
    return v;
  }

  /* ---------- 计算机名归一化 ----------
     空 / 缺失 → PCNAME；不足 4 位左补 0；清除 CSV 非法字符 */

  function normalizeComputerName(raw) {
    var v = String(raw == null ? '' : raw).replace(/[,\r\n"']/g, '').trim();
    if (!v) return PC_PLACEHOLDER;
    if (v.length < 4) v = v.padStart(4, '0');
    return v;
  }

  /* ---------- 16 位激活密钥 ----------
     ① 注册序号后四位 ② 日期序列前四位 ③ BIOS序列号后四位 ④ 计算机名后四位
     （③④ 连字符不计入位数；按 ①②③④①②③④①②③④①②③④ 逐位交叉） */

  function buildKey(serial, dateSeq, bios, computerName) {
    var s = String(serial).slice(-4);
    var d = String(dateSeq == null ? '' : dateSeq).slice(0, 4);
    var b = String(bios == null ? '' : bios).replace(/-/g, '').slice(-4);
    var c = String(computerName == null ? '' : computerName).replace(/-/g, '').slice(-4);
    if (s.length < 4 || d.length < 4 || b.length < 4 || c.length < 4) return null;
    var key = '';
    for (var i = 0; i < 4; i++) key += s[i] + d[i] + b[i] + c[i];
    return key;
  }

  /* ---------- CSV ---------- */

  function sanitize(v) {
    return String(v == null ? '' : v).replace(/[,\r\n"']/g, '').trim();
  }

  function parseCsv(text) {
    if (!text) return [];
    var clean = String(text).replace(/^\uFEFF/, '');
    return clean.split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l; })
      .map(function (l) { return l.split(',').map(function (f) { return f.trim(); }); });
  }

  function toCsv(rows) {
    return '\uFEFF' + rows.map(function (r) { return r.join(','); }).join('\r\n') + '\r\n';
  }

  /* 旧版 10 列记录（无激活时间）补齐为 11 列：激活时间按注册时间回填 */
  function ensureRow(row) {
    var r = row.slice();
    if (r.length >= 11) return r;
    while (r.length < 10) r.push('');
    r.push(r[9] || '');
    return r;
  }

  function dateSequence(d) {
    var dt = d ? new Date(d) : new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return '' + dt.getFullYear() + p(dt.getMonth() + 1) + p(dt.getDate());
  }

  function nowTime(d) {
    var dt = d ? new Date(d) : new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
      ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
  }

  function parseCnTime(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return isNaN(d.getTime()) ? null : d;
  }

  function oneYearLater(d) {
    var n = new Date(d.getTime());
    n.setFullYear(n.getFullYear() + 1);
    return n;
  }

  /* ---------- base64（UTF-8 安全） ---------- */

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  function b64ToUtf8(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ---------- 输入校验 ---------- */

  function validateInput(input) {
    var errors = {};
    var account = String(input.account || '').trim();
    if (!ACCOUNT_RE.test(account)) errors.account = '账号须为 5~9 位字母（不区分大小写）';

    var code = String(input.code || '').replace(/\s+/g, '');
    if (!/^\d{12}$/.test(code)) errors.code = '支付兑换码须为 12 位数字';
    else if (!isValidCode(code)) errors.code = '兑换码校验失败，请核对后重新输入';

    var phone = String(input.phone || '').trim();
    if (!PHONE_RE.test(phone)) errors.phone = '请填写有效的联系电话';

    var email = String(input.email || '').trim();
    if (!EMAIL_RE.test(email)) errors.email = '请填写有效的联系邮箱';

    var bios = normalizeBios(input.bios);
    if (bios.length < 4) errors.bios = 'BIOS 序列号无效，请按提示获取';

    var computerName = normalizeComputerName(input.computerName);

    return { errors: errors, account: account, code: code, phone: phone, email: email, bios: bios, computerName: computerName };
  }

  /* ---------- 注册流程 ----------
     api.getFile(path) -> {content, sha} | null(404)
     api.putFile(path, content, sha, message) -> Promise，冲突时抛 {status:409/422} */

  function nextSerial(regBody) {
    var max = SERIAL_START - 1;
    for (var i = 0; i < regBody.length; i++) {
      var n = parseInt(regBody[i][0], 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  }

  async function register(api, input, onProgress) {
    var v = validateInput(input);
    if (Object.keys(v.errors).length) return { ok: false, errors: v.errors };

    var dateSeq = dateSequence(input.now);
    var time = nowTime(input.now);
    var prog = onProgress || function () {};

    for (var attempt = 0; attempt < 3; attempt++) {
      prog('connect');
      var files = await Promise.all([api.getFile('codes.csv'), api.getFile('registrations.csv')]);
      var codesFile = files[0], regFile = files[1];

      if (!codesFile) return { ok: false, error: '兑换码码池尚未初始化，请联系卖家' };
      var pool = parseCsv(codesFile.content).slice(1)
        .map(function (r) { return r[0]; })
        .filter(Boolean);
      if (!pool.length) return { ok: false, error: '兑换码码池为空，请联系卖家补充' };

      prog('verify');
      if (pool.indexOf(v.code) === -1) {
        return { ok: false, errors: { code: '兑换码不在有效码池中，请核对（如确认无误请联系卖家）' } };
      }

      var regRows = regFile ? parseCsv(regFile.content) : [];
      var body = regRows.length > 1 ? regRows.slice(1).map(ensureRow) : [];
      for (var i = 0; i < body.length; i++) {
        if (body[i][2] === v.code) {
          return { ok: false, errors: { code: '该兑换码已被使用，每个兑换码仅可激活一次' } };
        }
      }
      for (var a = 0; a < body.length; a++) {
        if (sameAccount(body[a][1], v.account)) {
          return { ok: false, errors: { account: '该账号名已被注册（不区分大小写），请更换账号名' } };
        }
      }

      var serial = nextSerial(body);
      var key = buildKey(serial, dateSeq, v.bios, v.computerName);
      if (!key) return { ok: false, errors: { bios: '机器信息无效，请联系卖家' } };

      /* 首次注册：激活时间 = 注册时间 */
      var newRow = [String(serial), v.account, v.code, dateSeq, v.bios, v.computerName, key, sanitize(v.phone), sanitize(v.email), time, time];

      prog('write');
      var newCsv = toCsv([REG_HEADER].concat(body).concat([newRow]));
      try {
        await api.putFile('registrations.csv', newCsv, regFile ? regFile.sha : null,
          '注册 序号' + serial + ' 账号' + v.account);
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
      return { ok: true, serial: serial, key: key, account: v.account, code: v.code, bios: v.bios, computerName: v.computerName, dateSeq: dateSeq, registeredAt: time, activatedAt: time };
    }
    return { ok: false, error: '系统繁忙（写入冲突），请稍后重试' };
  }

  /* ---------- 找回激活码 ----------
     条件：账号名存在；联系电话与联系邮箱均与注册库一致；
           距上次激活时间满一年及以上（每个账号一年仅可找回一次）。
     动作：按当前日期序列与页面采集的 BIOS / 计算机名重新生成激活码，
           覆盖该账号行的日期序列、BIOS、计算机名、激活密钥、激活时间
           （注册时间与其余信息保持不变）。 */

  async function recover(api, input, onProgress) {
    var account = String(input.account || '').trim();
    var errors = {};
    if (!ACCOUNT_RE.test(account)) errors.account = '账号须为 5~9 位字母（不区分大小写）';
    var phone = String(input.phone || '').trim();
    if (!PHONE_RE.test(phone)) errors.phone = '请填写有效的联系电话';
    var email = String(input.email || '').trim();
    if (!EMAIL_RE.test(email)) errors.email = '请填写有效的联系邮箱';
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var bios = normalizeBios(input.bios);
    var computerName = normalizeComputerName(input.computerName);
    var prog = onProgress || function () {};

    for (var attempt = 0; attempt < 3; attempt++) {
      prog('connect');
      var regFile = await api.getFile('registrations.csv');
      if (!regFile) return { ok: false, error: '注册库尚未创建，暂无任何注册记录' };
      var regRows = parseCsv(regFile.content);
      if (regRows.length <= 1) return { ok: false, error: '注册库暂无注册记录' };
      var body = regRows.slice(1).map(ensureRow);

      var idx = -1;
      for (var i = 0; i < body.length; i++) {
        if (sameAccount(body[i][1], account)) { idx = i; break; }
      }
      if (idx === -1) return { ok: false, errors: { account: '该账号名尚未注册，请核对后重试' } };
      var row = body[idx];

      prog('verify');
      var phoneOk = row[7] === phone;
      var emailOk = row[8] === email;
      if (!phoneOk || !emailOk) {
        var bad = [];
        if (!phoneOk) bad.push('联系电话');
        if (!emailOk) bad.push('联系邮箱');
        return { ok: false, error: '核对失败：' + bad.join('、') + '与注册信息不符，无法找回' };
      }

      var actTime = row[10] || row[9];
      var last = parseCnTime(actTime);
      if (!last) return { ok: false, error: '激活时间记录异常，请联系卖家处理' };
      var next = oneYearLater(last);
      var now = input.now ? new Date(input.now) : new Date();
      if (now.getTime() < next.getTime()) {
        return {
          ok: false,
          error: '每个账号一年仅可找回一次激活码。该账号上次激活时间为 ' + actTime +
            '，需在 ' + nowTime(next) + ' 之后方可再次找回'
        };
      }

      var dateSeq = dateSequence(input.now);
      var key = buildKey(row[0], dateSeq, bios, computerName);
      if (!key) return { ok: false, errors: { bios: '机器信息无效，请联系卖家' } };

      prog('write');
      body[idx] = [row[0], row[1], row[2], dateSeq, bios, computerName, key, row[7], row[8], row[9], nowTime(input.now)];
      try {
        await api.putFile('registrations.csv', toCsv([REG_HEADER].concat(body)), regFile.sha,
          '找回激活码 账号' + account);
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
      return { ok: true, serial: parseInt(row[0], 10), key: key, account: account, dateSeq: dateSeq, bios: bios, computerName: computerName, activatedAt: nowTime(input.now) };
    }
    return { ok: false, error: '系统繁忙（写入冲突），请稍后重试' };
  }

  /* ---------- 用户反馈 ----------
     条件：账号名存在；联系电话 / 联系邮箱至少一项与注册库一致。
     存储：feedback.json（JSON 数组），每条含
           账号名、反馈时间、BIOS序列号、计算机名、反馈内容（≤300 字）。 */

  function sanitizeFeedbackText(text) {
    return String(text == null ? '' : text).trim().slice(0, FEEDBACK_MAX);
  }

  function checkIdentity(row, input) {
    var phone = String(input.phone || '').trim();
    var email = String(input.email || '').trim();
    return {
      phoneFilled: !!phone,
      emailFilled: !!email,
      phoneMatch: !!phone && row[7] === phone,
      emailMatch: !!email && row[8] === email
    };
  }

  async function checkFeedbackIdentity(api, input) {
    var account = String(input.account || '').trim();
    var errors = {};
    if (!ACCOUNT_RE.test(account)) errors.account = '账号须为 5~9 位字母（不区分大小写）';
    var phone = String(input.phone || '').trim();
    var email = String(input.email || '').trim();
    if (phone && !PHONE_RE.test(phone)) errors.phone = '联系电话格式不正确';
    if (email && !EMAIL_RE.test(email)) errors.email = '联系邮箱格式不正确';
    if (!phone && !email) errors.phone = '请至少填写联系电话或联系邮箱中的一项';
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var regFile = await api.getFile('registrations.csv');
    if (!regFile) return { ok: false, error: '注册库尚未创建，暂无任何注册记录' };
    var regRows = parseCsv(regFile.content);
    var body = regRows.length > 1 ? regRows.slice(1).map(ensureRow) : [];
    var row = null;
    for (var i = 0; i < body.length; i++) {
      if (sameAccount(body[i][1], account)) { row = body[i]; break; }
    }
    if (!row) return { ok: false, errors: { account: '该账号名尚未注册，请核对后重试' } };

    var id = checkIdentity(row, input);
    if (!id.phoneMatch && !id.emailMatch) {
      return { ok: false, error: '核对失败：联系电话 / 联系邮箱均与注册信息不符（需至少一项正确）' };
    }
    return { ok: true, account: row[1], matched: id.phoneMatch && id.emailMatch ? 'both' : (id.phoneMatch ? 'phone' : 'email') };
  }

  async function submitFeedback(api, input) {
    var pre = await checkFeedbackIdentity(api, input);
    if (!pre.ok) return pre;

    var text = sanitizeFeedbackText(input.text);
    if (!text) return { ok: false, errors: { text: '请填写反馈内容' } };

    var bios = normalizeBios(input.bios);
    var computerName = normalizeComputerName(input.computerName);
    var entry = {
      账号名: pre.account || String(input.account || '').trim(),
      反馈时间: nowTime(input.now),
      BIOS序列号: bios,
      计算机名: computerName,
      反馈内容: text
    };

    for (var attempt = 0; attempt < 3; attempt++) {
      var fbFile = await api.getFile(FEEDBACK_FILE);
      var entries = [];
      if (fbFile) {
        try {
          var parsed = JSON.parse(fbFile.content);
          if (Array.isArray(parsed)) entries = parsed;
        } catch (e) {
          return { ok: false, error: '反馈文件数据异常（JSON 解析失败），请联系卖家处理' };
        }
      }
      entries.push(entry);
      try {
        await api.putFile(FEEDBACK_FILE, JSON.stringify(entries, null, 2) + '\n',
          fbFile ? fbFile.sha : null, '用户反馈 ' + entry.账号名);
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
      return { ok: true, entry: entry, total: entries.length };
    }
    return { ok: false, error: '系统繁忙（写入冲突），请稍后重试' };
  }

  async function readFeedback(api) {
    var f = await api.getFile(FEEDBACK_FILE);
    if (!f) return { ok: true, entries: [] };
    try {
      var parsed = JSON.parse(f.content);
      return { ok: true, entries: Array.isArray(parsed) ? parsed : [] };
    } catch (e) {
      return { ok: false, error: '反馈文件数据异常（JSON 解析失败）' };
    }
  }

  async function clearFeedback(api) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var f = await api.getFile(FEEDBACK_FILE);
      if (!f) return { ok: true, cleared: 0 };
      var count = 0;
      try {
        var parsed = JSON.parse(f.content);
        if (Array.isArray(parsed)) count = parsed.length;
      } catch (e) {
        return { ok: false, error: '反馈文件数据异常（JSON 解析失败），未做清空' };
      }
      if (!count) return { ok: true, cleared: 0 };
      try {
        await api.putFile(FEEDBACK_FILE, JSON.stringify([], null, 2) + '\n', f.sha, '清空重置用户反馈记录');
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
      return { ok: true, cleared: count };
    }
    return { ok: false, error: '系统繁忙（写入冲突），请稍后重试' };
  }

  return {
    SERIAL_START: SERIAL_START,
    BIOS_PLACEHOLDER: BIOS_PLACEHOLDER,
    PC_PLACEHOLDER: PC_PLACEHOLDER,
    REG_HEADER: REG_HEADER,
    CODES_HEADER: CODES_HEADER,
    FEEDBACK_FILE: FEEDBACK_FILE,
    FEEDBACK_MAX: FEEDBACK_MAX,
    isValidCode: isValidCode,
    generateCode: generateCode,
    generateCodeFromSeed: generateCodeFromSeed,
    generateCodesFromSeeds: generateCodesFromSeeds,
    generateCodes: generateCodes,
    normalizeBios: normalizeBios,
    normalizeComputerName: normalizeComputerName,
    sameAccount: sameAccount,
    buildKey: buildKey,
    sanitize: sanitize,
    sanitizeFeedbackText: sanitizeFeedbackText,
    parseCsv: parseCsv,
    toCsv: toCsv,
    ensureRow: ensureRow,
    dateSequence: dateSequence,
    nowTime: nowTime,
    parseCnTime: parseCnTime,
    oneYearLater: oneYearLater,
    utf8ToB64: utf8ToB64,
    b64ToUtf8: b64ToUtf8,
    validateInput: validateInput,
    nextSerial: nextSerial,
    register: register,
    recover: recover,
    checkFeedbackIdentity: checkFeedbackIdentity,
    submitFeedback: submitFeedback,
    readFeedback: readFeedback,
    clearFeedback: clearFeedback
  };
});
