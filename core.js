/* DMAIC Tools 注册激活核心逻辑（浏览器与 Node 通用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMAIC = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var SERIAL_START = 1901;
  var BIOS_PLACEHOLDER = 'TBFBYOEM';
  var REG_HEADER = ['注册序号', '账号名', '支付兑换码', '日期序列', 'BIOS序列号', '激活密钥', '联系电话', '联系邮箱', '注册时间'];
  var CODES_HEADER = ['兑换码'];

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

  /* ---------- 12 位激活密钥 ----------
     ① 序列号后四位 ② 账户名后四位 ③ BIOS序列号后四位
     按 ①②③①②③①②③①②③ 逐位交叉                          */

  function buildKey(serial, account, bios) {
    var s = String(serial).slice(-4);
    var a = String(account).slice(-4);
    var b = String(bios).slice(-4);
    if (s.length < 4 || a.length < 4 || b.length < 4) return null;
    var key = '';
    for (var i = 0; i < 4; i++) key += s[i] + a[i] + b[i];
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

  function dateSequence(d) {
    var dt = d ? new Date(d) : new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return '' + dt.getFullYear() + p(dt.getMonth() + 1) + p(dt.getDate());
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
    if (!/^[A-Za-z]{5,9}$/.test(account)) errors.account = '账号须为 5~9 位字母（区分大小写）';

    var code = String(input.code || '').replace(/\s+/g, '');
    if (!/^\d{12}$/.test(code)) errors.code = '支付兑换码须为 12 位数字';
    else if (!isValidCode(code)) errors.code = '兑换码校验失败，请核对后重新输入';

    var phone = String(input.phone || '').trim();
    if (!/^[\d+()\-\s]{5,20}$/.test(phone)) errors.phone = '请填写有效的联系电话';

    var email = String(input.email || '').trim();
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) errors.email = '请填写有效的联系邮箱';

    var bios = normalizeBios(input.bios);
    if (bios.length < 4) errors.bios = 'BIOS 序列号无效，请按提示获取';

    return { errors: errors, account: account, code: code, phone: phone, email: email, bios: bios };
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
      var body = regRows.slice(1);
      for (var i = 0; i < body.length; i++) {
        if (body[i][2] === v.code) {
          return { ok: false, errors: { code: '该兑换码已被使用，每个兑换码仅可激活一次' } };
        }
      }

      var serial = nextSerial(body);
      var key = buildKey(serial, v.account, v.bios);
      if (!key) return { ok: false, errors: { bios: 'BIOS 序列号无效' } };

      var dt = new Date();
      var time = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') +
        ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      var newRow = [String(serial), v.account, v.code, dateSeq, v.bios, key, sanitize(v.phone), sanitize(v.email), time];

      prog('write');
      var newCsv = toCsv([REG_HEADER].concat(body).concat([newRow]));
      try {
        await api.putFile('registrations.csv', newCsv, regFile ? regFile.sha : null,
          '注册 序号' + serial + ' 账号' + v.account);
      } catch (e) {
        if (e && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
      return { ok: true, serial: serial, key: key, account: v.account, code: v.code, bios: v.bios, dateSeq: dateSeq };
    }
    return { ok: false, error: '系统繁忙（写入冲突），请稍后重试' };
  }

  return {
    SERIAL_START: SERIAL_START,
    BIOS_PLACEHOLDER: BIOS_PLACEHOLDER,
    REG_HEADER: REG_HEADER,
    CODES_HEADER: CODES_HEADER,
    isValidCode: isValidCode,
    generateCode: generateCode,
    generateCodeFromSeed: generateCodeFromSeed,
    generateCodesFromSeeds: generateCodesFromSeeds,
    generateCodes: generateCodes,
    normalizeBios: normalizeBios,
    buildKey: buildKey,
    sanitize: sanitize,
    parseCsv: parseCsv,
    toCsv: toCsv,
    dateSequence: dateSequence,
    utf8ToB64: utf8ToB64,
    b64ToUtf8: b64ToUtf8,
    validateInput: validateInput,
    nextSerial: nextSerial,
    register: register
  };
});
