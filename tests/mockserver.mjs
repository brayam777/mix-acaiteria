// Servidor de teste das telas: serve o site e troca js/supabase-config.js por
// um cliente falso que manda as consultas pro PGlite (migrações + seed + dados
// de exemplo). Nada toca o banco real.
//   cd tests && npm install && npm run mock   ->  http://localhost:8099/?loja=mix
// Painel: http://localhost:8099/admin.html — entra com o e-mail shirley@teste.com
// (qualquer senha). Realtime é simulado verificando pedidos novos a cada 3s.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createTestDb, ROOT } from './supabase-stubs.mjs';

const PORT = Number(process.env.PORT) || 8099;
const ADMIN_UID = '11111111-1111-1111-1111-111111111111';

// Mesmos formatos que a API do Supabase devolve (numeric como número, datas como texto).
const db = await createTestDb({
  parsers: {
    1700: (v) => Number(v),
    1082: (v) => v,
    1114: (v) => v,
    1184: (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString(),
  },
});

await db.exec(`insert into auth.users values ('${ADMIN_UID}', 'shirley@teste.com')`);
await db.exec(`insert into acai_admins (store_id, user_id, email) select id, '${ADMIN_UID}', 'shirley@teste.com' from acai_stores where slug = 'mix'`);
// Pedidos e despesas dos últimos dias pro Caixa ter o que mostrar.
await db.exec(`
  do $$
  declare s uuid := (select id from acai_stores where slug = 'mix');
  declare d int;
  begin
    for d in 1..9 loop
      insert into acai_orders (store_id, created_at, customer_name, customer_phone, fulfillment_type, items_subtotal, total, status, payment_method)
      values (s, now() - (d || ' days')::interval, 'Cliente ' || d, '5562998765432', 'pickup', 40 + d * 7, 40 + d * 7, 'completed',
              (array['pix_maquininha','dinheiro','cartao_maquininha'])[1 + d % 3]);
      insert into acai_cash_entries (store_id, category_id, kind, amount, payment_method, entry_date, description)
      values (s, (select id from acai_cash_categories where store_id = s and name like 'Insumos%'), 'expense', 15 + d * 3, 'dinheiro',
              ((now() at time zone 'America/Sao_Paulo')::date - d), 'Compra de açaí');
    end loop;
  end $$;
`);

const jsonbCache = new Map();
async function jsonbCols(table) {
  if (!jsonbCache.has(table)) {
    const r = await db.query(`select column_name from information_schema.columns where table_name = $1 and data_type = 'jsonb'`, [table]);
    jsonbCache.set(table, new Set(r.rows.map((x) => x.column_name)));
  }
  return jsonbCache.get(table);
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('bad ident ' + s);
  return `"${s}"`;
};

async function runQuery(q) {
  await db.query(`select set_config('test.uid', $1, false)`, [q.uid || '']);
  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (q.rpc) {
    const args = Object.entries(q.args || {}).map(([k, v]) => `${ident(k)} => ${p(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)}`);
    const r = await db.query(`select * from public.${ident(q.rpc)}(${args.join(', ')})`, params);
    // Função escalar (jsonb, uuid...) volta o valor puro, como no PostgREST.
    if (r.fields.length === 1 && r.fields[0].name === q.rpc) return r.rows[0]?.[q.rpc] ?? null;
    return r.rows;
  }

  const table = ident(q.table);
  const jcols = await jsonbCols(q.table);
  const val = (col, v) => (jcols.has(col) ? p(JSON.stringify(v ?? null)) : p(v));
  const where = () => {
    const parts = (q.filters || []).map(([col, op, v]) => {
      const sqlOp = { eq: '=', gte: '>=', lte: '<=' }[op];
      if (sqlOp) return `${ident(col)} ${sqlOp} ${p(v)}`;
      if (op === 'in') return `${ident(col)} = any(${p(v)})`;
      throw new Error('op ' + op);
    });
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  };
  const order = () => (q.order?.length ? ' order by ' + q.order.map(([c, asc]) => `${ident(c)} ${asc ? 'asc' : 'desc'}`).join(', ') : '');

  let sql;
  if (q.op === 'select') sql = `select * from public.${table}${where()}${order()}`;
  if (q.op === 'delete') sql = `delete from public.${table}${where()} returning *`;
  if (q.op === 'update') {
    const sets = Object.entries(q.payload).map(([k, v]) => `${ident(k)} = ${val(k, v)}`);
    sql = `update public.${table} set ${sets.join(', ')}${where()} returning *`;
  }
  if (q.op === 'insert' || q.op === 'upsert') {
    const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
    const cols = Object.keys(rows[0]);
    sql = `insert into public.${table} (${cols.map(ident).join(', ')}) values ${rows
      .map((r) => `(${cols.map((c) => val(c, r[c])).join(', ')})`)
      .join(', ')}`;
    if (q.op === 'upsert') {
      const conflict = q.onConflict.split(',').map((s) => s.trim());
      const upd = cols.filter((c) => !conflict.includes(c)).map((c) => `${ident(c)} = excluded.${ident(c)}`);
      sql += ` on conflict (${conflict.map(ident).join(', ')}) do ${upd.length ? 'update set ' + upd.join(', ') : 'nothing'}`;
    }
    sql += ' returning *';
  }
  return (await db.query(sql, params)).rows;
}

const MOCK_CLIENT = `
// ===== CLIENTE SUPABASE FALSO (só no servidor de teste: tests/mockserver.mjs) =====
export const SUPABASE_URL = location.origin;
export const SUPABASE_ANON_KEY = 'mock';
export const isConfigured = true;
const SESSION_KEY = 'mock_session';
const listeners = [];
function session() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
async function call(q) {
  const res = await fetch('/__mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...q, uid: session()?.user?.id }) });
  const body = await res.json();
  return body.error ? { data: null, error: { message: body.error } } : { data: body.data, error: null };
}
class Builder {
  constructor(table) { this.q = { table, op: 'select', filters: [], order: [] }; }
  select() { return this; }
  insert(p) { this.q.op = 'insert'; this.q.payload = p; return this; }
  upsert(p, o) { this.q.op = 'upsert'; this.q.payload = p; this.q.onConflict = o.onConflict; return this; }
  update(p) { this.q.op = 'update'; this.q.payload = p; return this; }
  delete() { this.q.op = 'delete'; return this; }
  eq(c, v) { this.q.filters.push([c, 'eq', v]); return this; }
  gte(c, v) { this.q.filters.push([c, 'gte', v]); return this; }
  lte(c, v) { this.q.filters.push([c, 'lte', v]); return this; }
  in(c, v) { this.q.filters.push([c, 'in', v]); return this; }
  order(c, o = {}) { this.q.order.push([c, o.ascending !== false]); return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(res, rej) {
    return call(this.q).then((r) => {
      if (!r.error && this.mode) r.data = r.data?.[0] ?? null;
      if (!r.error && this.mode === 'single' && !r.data) r.error = { message: 'no rows' };
      return r;
    }).then(res, rej);
  }
}
const channels = [];
export const supabase = {
  from: (t) => new Builder(t),
  rpc: (fn, args) => call({ rpc: fn, args }),
  channel() {
    const ch = { handlers: [], on(_t, _f, h) { this.handlers.push(h); return this; }, subscribe(cb) { cb && setTimeout(() => cb('SUBSCRIBED'), 0); return this; } };
    channels.push(ch); return ch;
  },
  removeChannel() {},
  storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'img/logo.jpeg' } }) }) },
  auth: {
    onAuthStateChange(cb) { listeners.push(cb); setTimeout(() => cb('INITIAL_SESSION', session()), 0); return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { return { data: { session: session() } }; },
    async signInWithPassword({ email }) {
      if (email !== 'shirley@teste.com') return { error: { message: 'invalid' } };
      const s = { user: { id: '${ADMIN_UID}', email } };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      listeners.forEach((l) => l('SIGNED_IN', s));
      return { data: { session: s }, error: null };
    },
    async signOut() { localStorage.removeItem(SESSION_KEY); listeners.forEach((l) => l('SIGNED_OUT', null)); return { error: null }; },
    async signUp() { return { error: { message: 'mock: use shirley@teste.com' } }; },
    async resetPasswordForEmail() { return { error: null }; },
    async updateUser() { return { error: null }; },
  },
};
// Realtime simulado: a cada 3s compara os pedidos e dispara INSERT/UPDATE.
let seen = null;
setInterval(async () => {
  if (!channels.length || !session()) return;
  const rows = (await call({ table: 'acai_orders', op: 'select', filters: [], order: [['created_at', false]] })).data || [];
  if (seen === null) { seen = new Map(rows.map((o) => [o.id, o.status])); return; }
  for (const o of rows) {
    const ev = !seen.has(o.id) ? 'INSERT' : seen.get(o.id) !== o.status ? 'UPDATE' : null;
    seen.set(o.id, o.status);
    if (ev) channels.forEach((c) => c.handlers.forEach((h) => h({ eventType: ev, new: o })));
  }
}, 3000);
`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.bat': 'text/plain', '.vbs': 'text/plain',
};

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__mock') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let out;
      try {
        out = { data: await runQuery(JSON.parse(body)) };
      } catch (e) {
        out = { error: e.message };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    if (urlPath === '/js/supabase-config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(MOCK_CLIENT);
      return;
    }
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT) || file.includes(`${path.sep}tests${path.sep}`) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  })
  .listen(PORT, () => console.log(`Teste das telas em http://localhost:${PORT}/?loja=mix  (painel: /admin.html, e-mail shirley@teste.com)`));
