#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = String(process.env.SECURITY_TEST_BASE_URL || 'http://127.0.0.1:9102').replace(/\/+$/, '');
const REPORT_PATH = String(process.env.SECURITY_TEST_REPORT_PATH || './temp/security-smoketest-report.json').trim();
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.SECURITY_TEST_TIMEOUT_MS || 10_000));

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const MANUAL = 'MANUAL';

const sqlErrorRegex = /(sql syntax|syntax error|mysql|sqlite|postgres|odbc|query failed|unclosed quotation|ORA-\d+)/i;

const nowIso = () => new Date().toISOString();

const safeJson = async (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const request = async (path, { method = 'GET', headers = {}, body = undefined } = {}) => {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    const json = await safeJson(text);
    return {
      ok: true,
      url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      headers: {},
      text: '',
      json: null,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const summarizeStatuses = (items) =>
  items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

const testSqlInjection = async () => {
  const payloads = ["' OR 1=1--", '" OR "1"="1', '1;DROP TABLE users;--'];
  const routes = ['/api/sticker-packs?q=', '/api/sticker-packs/creators?q=', '/api/sticker-packs/recommendations?q='];
  const evidence = [];
  let hasFailure = false;

  for (const route of routes) {
    for (const payload of payloads) {
      const res = await request(`${route}${encodeURIComponent(payload)}`);
      const hasSqlError = sqlErrorRegex.test(res.text || '');
      const bad = !res.ok || res.status >= 500 || hasSqlError;
      if (bad) hasFailure = true;
      evidence.push({
        route,
        payload,
        status: res.status,
        network_ok: res.ok,
        sql_error_pattern: hasSqlError,
      });
    }
  }

  return {
    id: 1,
    name: 'SQL Injection',
    status: hasFailure ? FAIL : PASS,
    note: hasFailure ? 'Há indícios de falha/erro SQL em payload de injeção.' : 'Payloads SQLi não causaram erro SQL nem 5xx.',
    evidence,
  };
};

const testXss = async () => {
  const payload = '<svg/onload=alert(1)>';
  const routes = [`/stickers?q=${encodeURIComponent(payload)}`, `/user?q=${encodeURIComponent(payload)}`, `/api/sticker-packs?q=${encodeURIComponent(payload)}`];
  const evidence = [];
  let htmlRawReflected = false;
  let apiRawReflected = false;

  for (const path of routes) {
    const res = await request(path);
    const reflectedRaw = (res.text || '').includes(payload);
    const contentType = String(res.headers['content-type'] || '');
    const isHtml = /text\/html/i.test(contentType);
    const isJson = /application\/json/i.test(contentType);
    if (reflectedRaw && isHtml) htmlRawReflected = true;
    if (reflectedRaw && isJson) apiRawReflected = true;
    evidence.push({
      path,
      status: res.status,
      content_type: contentType || null,
      reflected_raw: reflectedRaw,
    });
  }

  const status = htmlRawReflected ? FAIL : apiRawReflected ? WARN : PASS;

  return {
    id: 2,
    name: 'Cross-Site Scripting (XSS)',
    status,
    note: status === FAIL ? 'Payload XSS refletido em resposta HTML.' : status === WARN ? 'Payload refletido em API JSON; revisar sanitização no frontend consumidor.' : 'Sem reflexão bruta do payload XSS nas rotas testadas.',
    evidence,
  };
};

const testCsrf = async () => {
  const resSession = await request('/api/sticker-packs/admin/session', {
    method: 'DELETE',
    headers: { 'x-forwarded-proto': 'https' },
  });
  const cookieHeader = String(resSession.headers['set-cookie'] || '');
  const hasHttpOnly = /httponly/i.test(cookieHeader);
  const hasSameSite = /samesite=/i.test(cookieHeader);
  const hasSecure = /secure/i.test(cookieHeader);

  const resOrigin = await request('/api/sticker-packs/create', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'csrf-test' }),
  });

  const blockedByAuth = [401, 403].includes(resOrigin.status);
  const cookieFlagsOk = hasHttpOnly && hasSameSite && hasSecure;
  const status = blockedByAuth && cookieFlagsOk ? PASS : WARN;

  return {
    id: 3,
    name: 'Cross-Site Request Forgery (CSRF)',
    status,
    note: status === PASS ? 'Fluxo testado bloqueou mutação não autenticada e cookies possuem flags de proteção.' : 'Validação parcial: revisar proteção CSRF em rotas autenticadas com sessão ativa.',
    evidence: [
      {
        path: '/api/sticker-packs/admin/session',
        status: resSession.status,
        cookie_flags: { http_only: hasHttpOnly, same_site: hasSameSite, secure: hasSecure },
      },
      {
        path: '/api/sticker-packs/create',
        status: resOrigin.status,
        blocked_by_auth: blockedByAuth,
      },
    ],
  };
};

const testDdosSafe = async () => {
  const total = 80;
  const concurrency = 16;
  let cursor = 0;
  let failures = 0;
  let serverErrors = 0;
  const latencies = [];

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;
      const startedAt = Date.now();
      const res = await request('/healthz');
      const elapsed = Date.now() - startedAt;
      latencies.push(elapsed);
      if (!res.ok) failures += 1;
      if (res.status >= 500) serverErrors += 1;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const failureRate = failures / total;
  const serverErrorRate = serverErrors / total;
  const status = failureRate <= 0.1 && serverErrorRate === 0 ? PASS : WARN;

  return {
    id: 4,
    name: 'Distributed Denial-of-Service (safe simulation)',
    status,
    note: status === PASS ? 'Serviço permaneceu estável em burst controlado local.' : 'Houve instabilidade em burst local; revisar capacidade e limites.',
    evidence: [
      {
        total,
        concurrency,
        failures,
        server_errors: serverErrors,
        failure_rate: failureRate,
        p95_ms: p95,
      },
    ],
  };
};

const testBruteForce = async () => {
  const codes = [];
  for (let i = 0; i < 14; i += 1) {
    const res = await request('/api/sticker-packs/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: 'bruteforce' }),
    });
    codes.push(res.status);
  }
  const has429 = codes.includes(429);
  return {
    id: 5,
    name: 'Brute Force Attack',
    status: has429 ? PASS : WARN,
    note: has429 ? 'Rate limiting acionado para tentativas repetidas.' : 'Não foi observado 429 no cenário simulado de força bruta.',
    evidence: [{ codes }],
  };
};

const testCredentialStuffing = async () => {
  const identities = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];
  const codes = [];
  for (let i = 0; i < 16; i += 1) {
    const identity = identities[i % identities.length];
    const res = await request('/api/sticker-packs/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, password: `P@ss${i}` }),
    });
    codes.push(res.status);
  }
  const has429 = codes.includes(429);
  return {
    id: 6,
    name: 'Credential Stuffing',
    status: has429 ? PASS : WARN,
    note: has429 ? 'Rate limiting também mitigou tentativas com credenciais variadas.' : 'Sem 429 no padrão simulado de credential stuffing.',
    evidence: [{ codes }],
  };
};

const testDirectoryTraversal = async () => {
  const paths = ['/.env', '/data/../../.env', '/data/%2e%2e/%2e%2e/.env', '/data/%252e%252e/%252e%252e/.env'];
  const evidence = [];
  let leaked = false;

  for (const path of paths) {
    const res = await request(path);
    const body = String(res.text || '');
    const maybeLeak = res.status === 200 || /DB_PASSWORD|MYSQL_PASSWORD|GITHUB_TOKEN/i.test(body);
    if (maybeLeak) leaked = true;
    evidence.push({ path, status: res.status, potential_leak: maybeLeak });
  }

  return {
    id: 7,
    name: 'Directory Traversal',
    status: leaked ? FAIL : PASS,
    note: leaked ? 'Há indício de leitura indevida de arquivo sensível.' : 'Tentativas de traversal foram bloqueadas.',
    evidence,
  };
};

const testFileUploadAttack = async () => {
  const binaryPayload = Buffer.from('MZ_fake_executable_content', 'utf8');
  const resCreate = await request('/api/sticker-packs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../../../etc/passwd', cover: 'data:text/plain;base64,QQ==' }),
  });
  const resUpload = await request('/api/sticker-packs/fake-pack/manage/stickers-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: binaryPayload,
  });
  const blocked = ![200, 201, 202].includes(resCreate.status) && ![200, 201, 202].includes(resUpload.status);

  return {
    id: 8,
    name: 'File Upload Attack',
    status: blocked ? PASS : WARN,
    note: blocked ? 'Uploads malformados/suspeitos não foram aceitos no cenário sem autenticação.' : 'Algum upload suspeito retornou sucesso; revisar validações.',
    evidence: [
      { path: '/api/sticker-packs/create', status: resCreate.status },
      { path: '/api/sticker-packs/fake-pack/manage/stickers-upload', status: resUpload.status },
    ],
  };
};

const testSessionHijacking = async () => {
  const resCookie = await request('/api/sticker-packs/admin/session', {
    method: 'DELETE',
    headers: { 'x-forwarded-proto': 'https' },
  });
  const cookieHeader = String(resCookie.headers['set-cookie'] || '');
  const hasHttpOnly = /httponly/i.test(cookieHeader);
  const hasSameSite = /samesite=/i.test(cookieHeader);
  const hasSecure = /secure/i.test(cookieHeader);

  const resForged = await request('/api/sticker-packs/admin/overview', {
    headers: { Cookie: 'omnizap_admin_panel_session=fake-session-token' },
  });
  const blocked = [401, 403].includes(resForged.status);

  const status = blocked && hasHttpOnly && hasSameSite && hasSecure ? PASS : WARN;

  return {
    id: 9,
    name: 'Session Hijacking',
    status,
    note: status === PASS ? 'Cookie protegido e sessão forjada bloqueada no endpoint admin.' : 'Validação parcial: revisar sessão/cookie para evitar hijacking.',
    evidence: [{ forged_request_status: resForged.status }, { cookie_flags: { http_only: hasHttpOnly, same_site: hasSameSite, secure: hasSecure } }],
  };
};

const testClickjacking = async () => {
  const res = await request('/user/systemadm');
  const xfo = String(res.headers['x-frame-options'] || '');
  const csp = String(res.headers['content-security-policy'] || '');
  const ok = /sameorigin/i.test(xfo) && /frame-ancestors\s+'self'/i.test(csp);

  return {
    id: 10,
    name: 'Clickjacking',
    status: ok ? PASS : WARN,
    note: ok ? 'Proteções anti-frame detectadas (X-Frame-Options + frame-ancestors).' : 'Cabeçalhos anti-clickjacking incompletos.',
    evidence: [
      {
        status: res.status,
        x_frame_options: xfo || null,
        csp_has_frame_ancestors_self: /frame-ancestors\s+'self'/i.test(csp),
      },
    ],
  };
};

const testMitm = async () => {
  const res = await request('/api/home-bootstrap');
  const hsts = String(res.headers['strict-transport-security'] || '');
  const hasHsts = /max-age=\d+/i.test(hsts);
  return {
    id: 11,
    name: 'Man-in-the-Middle (header posture)',
    status: hasHsts ? PASS : WARN,
    note: hasHsts ? 'HSTS presente. Teste MITM real ainda requer ambiente de rede controlado.' : 'HSTS ausente; reforçar proteção em tráfego HTTPS.',
    evidence: [{ status: res.status, hsts: hsts || null }],
  };
};

const testSsrf = async () => {
  const payload = 'http://169.254.169.254/latest/meta-data/';
  const res = await request('/api/sticker-packs/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ssrf-test', source_url: payload }),
  });
  const blocked = [400, 401, 403, 405, 422].includes(res.status);
  return {
    id: 12,
    name: 'Server-Side Request Forgery (SSRF)',
    status: blocked ? PASS : MANUAL,
    note: blocked ? 'Payload SSRF não foi processado no cenário testado sem autenticação.' : 'Necessário teste autenticado em endpoint que realmente consome URLs.',
    evidence: [{ path: '/api/sticker-packs/create', status: res.status }],
  };
};

const testRce = async () => {
  const payload = '$(id)';
  const res = await request(`/api/sticker-packs?q=${encodeURIComponent(payload)}`);
  const hasExecutionEvidence = /uid=\d+/.test(res.text || '');
  const failed = !res.ok || res.status >= 500 || hasExecutionEvidence;
  return {
    id: 13,
    name: 'Remote Code Execution (RCE)',
    status: failed ? WARN : PASS,
    note: failed ? 'Houve erro/indício que merece investigação manual de RCE.' : 'Sem indício de execução remota nos payloads de smoke test.',
    evidence: [{ status: res.status, execution_pattern_found: hasExecutionEvidence }],
  };
};

const testCommandInjection = async () => {
  const payload = ';cat /etc/passwd';
  const res = await request(`/api/sticker-packs/recommendations?q=${encodeURIComponent(payload)}`);
  const leaked = /root:.*:0:0:/.test(res.text || '');
  const failed = !res.ok || res.status >= 500 || leaked;
  return {
    id: 14,
    name: 'Command Injection',
    status: failed ? WARN : PASS,
    note: failed ? 'Houve erro/indício de injeção de comando a investigar.' : 'Sem indício de command injection nos payloads aplicados.',
    evidence: [{ status: res.status, passwd_pattern_found: leaked }],
  };
};

const testXxe = async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<root><name>&xxe;</name></root>`;
  const res = await request('/api/sticker-packs/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  const leaked = /root:.*:0:0:/.test(res.text || '');
  const blocked = [400, 401, 403, 405, 415, 422, 429].includes(res.status) && !leaked;
  return {
    id: 15,
    name: 'XML External Entity (XXE)',
    status: blocked ? PASS : WARN,
    note: blocked ? 'Payload XXE bloqueado/não processado.' : 'Comportamento inesperado para payload XXE.',
    evidence: [{ status: res.status, passwd_pattern_found: leaked }],
  };
};

const testBrokenAuth = async () => {
  const checks = ['/api/sticker-packs/admin/overview', '/api/system-summary', '/api/email/health'];
  const evidence = [];
  let allBlocked = true;
  for (const path of checks) {
    const res = await request(path);
    const blocked = [401, 403].includes(res.status);
    if (!blocked) allBlocked = false;
    evidence.push({ path, status: res.status, blocked });
  }
  return {
    id: 16,
    name: 'Broken Authentication',
    status: allBlocked ? PASS : FAIL,
    note: allBlocked ? 'Endpoints protegidos bloquearam acesso sem credenciais.' : 'Algum endpoint protegido respondeu sem bloqueio esperado.',
    evidence,
  };
};

const testBrokenAccessControl = async () => {
  const resAdminFake = await request('/api/sticker-packs/admin/users', {
    headers: { 'x-admin-token': 'fake-token' },
  });
  const resContact = await request('/api/support');
  const blocked = [401, 403].includes(resAdminFake.status) && [401, 403].includes(resContact.status);
  return {
    id: 17,
    name: 'Broken Access Control',
    status: blocked ? PASS : FAIL,
    note: blocked ? 'Acesso privilegiado foi negado sem autorização válida.' : 'Há rota sensível sem bloqueio consistente.',
    evidence: [
      { path: '/api/sticker-packs/admin/users', status: resAdminFake.status },
      { path: '/api/support', status: resContact.status },
    ],
  };
};

const testOpenRedirect = async () => {
  const probes = ['/stickers/create?next=https://evil.example', '/stickers/admin?next=//evil.example'];
  const evidence = [];
  let vulnerable = false;
  for (const path of probes) {
    const res = await request(path);
    const location = String(res.headers.location || '');
    const open = /^https?:\/\/evil\.example/i.test(location) || /^\/\/evil\.example/i.test(location);
    if (open) vulnerable = true;
    evidence.push({ path, status: res.status, location: location || null, open_redirect: open });
  }
  return {
    id: 18,
    name: 'Open Redirect',
    status: vulnerable ? FAIL : PASS,
    note: vulnerable ? 'Foi observada possibilidade de redirecionamento aberto.' : 'Não houve redirecionamento aberto nas rotas testadas.',
    evidence,
  };
};

const testParameterTampering = async () => {
  const probes = ['/api/sticker-packs?limit=-1000&page=-1', '/api/sticker-packs?limit=1000000&page=999999', '/api/sticker-packs/creators?limit=999999'];
  const evidence = [];
  let failed = false;
  for (const path of probes) {
    const res = await request(path);
    const bad = !res.ok || res.status >= 500;
    if (bad) failed = true;
    evidence.push({ path, status: res.status, ok: res.ok });
  }
  return {
    id: 19,
    name: 'Parameter Tampering',
    status: failed ? WARN : PASS,
    note: failed ? 'Algum parâmetro adulterado gerou falha de servidor.' : 'Parâmetros adulterados não causaram erro crítico no smoke test.',
    evidence,
  };
};

const testPathManipulation = async () => {
  const probes = ['/api/sticker-packs/%2e%2e/admin/overview', '/api/sticker-packs/..%2Fadmin%2Foverview', '/api/sticker-packs/%2e%2e/%2e%2e/.env', '/api/sticker-packs/%252e%252e/%252e%252e/.env'];
  const evidence = [];
  let bypass = false;
  for (const path of probes) {
    const res = await request(path);
    const bad = [200, 201, 202].includes(res.status);
    if (bad) bypass = true;
    evidence.push({ path, status: res.status, suspicious_success: bad });
  }
  return {
    id: 20,
    name: 'Path Manipulation',
    status: bypass ? FAIL : PASS,
    note: bypass ? 'Payload de manipulação de caminho obteve sucesso inesperado.' : 'Manipulações de caminho foram bloqueadas.',
    evidence,
  };
};

const run = async () => {
  const startedAt = nowIso();
  const tests = [testSqlInjection, testXss, testCsrf, testDdosSafe, testBruteForce, testCredentialStuffing, testDirectoryTraversal, testFileUploadAttack, testSessionHijacking, testClickjacking, testMitm, testSsrf, testRce, testCommandInjection, testXxe, testBrokenAuth, testBrokenAccessControl, testOpenRedirect, testParameterTampering, testPathManipulation];

  const results = [];
  for (const testFn of tests) {
    try {
      const result = await testFn();
      results.push(result);
      console.log(`[security-smoketest] ${String(result.id).padStart(2, '0')} ${result.name}: ${result.status}`);
    } catch (error) {
      const fallbackResult = {
        id: results.length + 1,
        name: testFn.name || 'unknown-test',
        status: WARN,
        note: `Falha ao executar teste: ${error?.message || error}`,
        evidence: [],
      };
      results.push(fallbackResult);
      console.log(`[security-smoketest] ${String(fallbackResult.id).padStart(2, '0')} ${fallbackResult.name}: ${fallbackResult.status}`);
    }
  }

  const endedAt = nowIso();
  const summary = summarizeStatuses(results);
  const report = {
    base_url: BASE_URL,
    started_at: startedAt,
    ended_at: endedAt,
    summary,
    results,
  };

  const reportDir = path.dirname(path.resolve(REPORT_PATH));
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('[security-smoketest] ---');
  console.log(`[security-smoketest] base_url=${BASE_URL}`);
  console.log(`[security-smoketest] summary=${JSON.stringify(summary)}`);
  console.log(`[security-smoketest] report_path=${REPORT_PATH}`);
};

run().catch((error) => {
  console.error('[security-smoketest] fatal_error', error?.message || error);
  process.exit(2);
});
