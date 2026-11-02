// Agente local de impressão de comanda — fica rodando no PC da cozinha,
// consulta a Supabase de tempos em tempos procurando pedido novo ainda não
// impresso, e manda a comanda pra impressora térmica (ESC/POS via
// compartilhamento local do Windows). Mesma lógica de "sai a comanda
// sozinha" que o iFood já usa.
//
// Configuração vem de config.json (veja config.example.json). Não precisa
// de instalação nenhuma além do Node.js — roda com `node agent.js`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Seu Node.js e muito antigo (precisa da versao 18 ou mais nova).');
  console.error('Instale a versao LTS em https://nodejs.org e de 2 cliques em iniciar.bat de novo.');
  process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Não achei o arquivo de configuração: ${CONFIG_PATH}`);
    console.error('Copie config.example.json pra config.json e preencha os valores.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['supabaseUrl', 'supabaseAnonKey', 'agentKey']) {
    if (!config[key]) {
      console.error(`Falta "${key}" no config.json.`);
      process.exit(1);
    }
  }
  config.storeName = config.storeName || 'Loja';
  config.pollIntervalMs = config.pollIntervalMs || 5000;
  return config;
}

const config = loadConfig();

// Impressora térmica ESC/POS não entende UTF-8 multibyte — cada acento
// vira lixo se o codepage não bater. Mais simples e seguro sem poder testar
// na impressora física: tira os acentos antes de imprimir.
function stripAccents(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const ESC = '\x1b';
const GS = '\x1d';
const INIT = `${ESC}@`;
const BOLD_ON = `${ESC}E\x01`;
const BOLD_OFF = `${ESC}E\x00`;
const ALIGN_CENTER = `${ESC}a\x01`;
const ALIGN_LEFT = `${ESC}a\x00`;
const DOUBLE_SIZE = `${GS}!\x11`;
const NORMAL_SIZE = `${GS}!\x00`;
const CUT = `${GS}V\x42\x00`;
const LINE = '----------------------------------------\n';

function currency(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ');
}

function formatAddress(address) {
  if (!address) return '';
  const parts = [address.street, address.number, address.neighborhood, address.city].filter(Boolean);
  let text = parts.join(', ');
  if (address.complement) text += ` - ${address.complement}`;
  if (address.reference) text += ` (ref: ${address.reference})`;
  return text;
}

const PAYMENT_LABELS = {
  cartao_maquininha: 'Cartao na maquininha',
  pix_maquininha: 'PIX na maquininha',
  dinheiro: 'Dinheiro',
};

function paymentDetail(order) {
  let label = PAYMENT_LABELS[order.payment_method] || order.payment_method;
  if (order.payment_method === 'dinheiro') {
    label += order.needs_change ? ` - troco para R$ ${currency(order.change_for)}` : ' - sem troco';
  }
  return label;
}

function buildReceipt(order) {
  const now = new Date(order.created_at);
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const shortId = order.order_id.slice(0, 8).toUpperCase();

  let out = INIT;
  out += ALIGN_CENTER + BOLD_ON + DOUBLE_SIZE;
  out += `${config.storeName}\n`;
  out += `NOVO PEDIDO\n`;
  out += NORMAL_SIZE + BOLD_OFF;
  out += ALIGN_LEFT;
  out += `Pedido: ${shortId}\n`;
  out += `${dateStr} ${timeStr}\n`;
  out += LINE;
  out += BOLD_ON + `Cliente: ` + BOLD_OFF + `${order.customer_name}\n`;
  out += `Telefone: ${order.customer_phone}\n`;
  out += LINE;
  if (order.fulfillment_type === 'delivery') {
    out += BOLD_ON + 'ENTREGA\n' + BOLD_OFF;
    out += `${formatAddress(order.address)}\n`;
  } else {
    out += BOLD_ON + 'RETIRAR NA LOJA\n' + BOLD_OFF;
  }
  out += LINE;
  out += BOLD_ON + 'ITENS\n' + BOLD_OFF;
  for (const item of order.items || []) {
    out += `${item.quantity}x ${item.product_name}\n`;
    if (item.selected_options && item.selected_options.length) {
      out += `   (${item.selected_options.map((o) => o.option_name).join(', ')})\n`;
    }
  }
  out += LINE;
  out += `Pagamento: ${paymentDetail(order)}\n`;
  out += BOLD_ON + DOUBLE_SIZE + `TOTAL: R$ ${currency(order.total)}\n` + NORMAL_SIZE + BOLD_OFF;
  if (order.notes) {
    out += LINE;
    out += `Obs: ${order.notes}\n`;
  }
  out += '\n\n\n';
  out += CUT;

  return stripAccents(out);
}

// Impressão direta pelo spooler do Windows (winspool, modo RAW) usando o
// nome da impressora como aparece em "Impressoras e scanners" — não precisa
// compartilhar a impressora. O script PowerShell é gravado numa pasta
// temporária a cada execução, então não há arquivo extra pra distribuir.
const PS_SCRIPT = `
param([string]$Printer, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("Nao consegui abrir a impressora '" + printer + "' (erro Windows " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Comanda Mix Acaiteria";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter falhou (erro " + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter falhou (erro " + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written) || written != bytes.Length)
            throw new Exception("WritePrinter falhou (erro " + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($File))
`;

const PS_LIST = "Get-Printer | ForEach-Object { $_.Name + '|' + $_.PortName + '|' + $_.PrinterStatus }";

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || stdout || error.message).trim()));
        else resolve(stdout);
      }
    );
  });
}

// Impressora térmica USB ligada mas sem fila no Windows (driver não
// instalado): cria a fila com o driver "Generic / Text Only", que já vem no
// Windows e deixa passar o comando ESC/POS cru. Se já existir fila pra
// aquela porta USB (com driver do fabricante, por exemplo), não mexe.
const PS_ENSURE_QUEUE = `
$ErrorActionPreference = 'Stop'
$devs = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USBPRINT\\*' }
foreach ($d in $devs) {
  $port = ($d.InstanceId -split '&')[-1]
  $exists = Get-Printer | Where-Object { $_.PortName -eq $port }
  if (-not $exists) {
    if (-not (Get-PrinterDriver -Name 'Generic / Text Only' -ErrorAction SilentlyContinue)) { Add-PrinterDriver -Name 'Generic / Text Only' }
    $name = $d.FriendlyName.Trim()
    Add-Printer -Name $name -DriverName 'Generic / Text Only' -PortName $port
    Write-Output ('Fila de impressao criada: ' + $name)
  }
}
`;

async function ensurePrinterQueue() {
  if (config.printerName) return;
  const out = await runPowerShell(['-Command', PS_ENSURE_QUEUE]);
  if (out.trim()) console.log(out.trim());
}

// Nome da impressora a usar: o do config.json, ou (em branco) detecta uma
// térmica pela lista de impressoras instaladas, ou cai na impressora padrão.
async function listPrinters() {
  const out = await runPowerShell(['-Command', PS_LIST]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, port = '', status = ''] = l.split('|');
      return { name, port, status };
    });
}

// Nome da impressora configurado no painel (vem do servidor a cada ciclo).
let remotePrinterName = null;
let warnedPrinterFallback = false;

async function resolvePrinterName() {
  const wanted = config.printerName || remotePrinterName;
  const printers = await listPrinters();
  if (wanted) {
    const found = printers.find((p) => p.name.trim().toLowerCase() === wanted.trim().toLowerCase());
    if (found) return found.name;
    if (!warnedPrinterFallback) {
      warnedPrinterFallback = true;
      console.error('Aviso: a impressora "' + wanted + '" nao existe neste computador. Usando a deteccao automatica.');
    }
  }
  const virtual = /pdf|xps|onenote|fax|anydesk|teamviewer|rustdesk/i;
  const thermal = /tm-?t|mdk|epson|receipt|pos|thermal|termica|térmica|elgin|bematech|daruma|tanca|diebold|generic|text only|58|80|cupom|ticket/i;
  const real = printers.filter((p) => !virtual.test(p.name));
  const usb = real.filter((p) => /^(usb|com|lpt|dot4)/i.test(p.port));

  const pick =
    real.find((p) => thermal.test(p.name) && /^usb/i.test(p.port)) ||
    real.find((p) => thermal.test(p.name)) ||
    (usb.length === 1 ? usb[0] : null) ||
    (real.length === 1 ? real[0] : null);

  if (!pick) {
    const lista = printers.map((p) => p.name + ' (porta ' + p.port + ')').join(' | ') || '(nenhuma)';
    throw new Error(
      'Nao consegui escolher a impressora sozinho. Impressoras encontradas: ' + lista + '. ' +
      'Coloque o nome exato da impressora em "printerName" no config.json.'
    );
  }
  return pick.name;
}

async function printToWindowsShare(rawText) {
  const tmpFile = path.join(os.tmpdir(), `comanda-${Date.now()}.prn`);
  fs.writeFileSync(tmpFile, Buffer.from(rawText, 'binary'));
  try {
    if (!config.printerName && config.printerShareName) {
      // compatibilidade com config antigo (impressora compartilhada)
      await new Promise((resolve, reject) => {
        execFile('cmd.exe', ['/c', 'copy', '/b', tmpFile, `\\\\localhost\\${config.printerShareName}`], (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message} ${stderr || ''}`));
          else resolve();
        });
      });
      return;
    }
    const printer = await resolvePrinterName();
    const psFile = path.join(os.tmpdir(), 'anoteiai-raw-print.ps1');
    fs.writeFileSync(psFile, PS_SCRIPT, 'utf8');
    await runPowerShell(['-File', psFile, '-Printer', printer, '-File', tmpFile]);
  } catch (err) {
    throw new Error(`Falha ao imprimir: ${err.message}`);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function fetchOrdersToPrint() {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_acai_orders_to_print`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_agent_key: config.agentKey }),
  });
  if (!res.ok) {
    throw new Error(`Erro ao consultar pedidos: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function markPrinted(orderId) {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/mark_acai_order_printed`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_agent_key: config.agentKey, p_order_id: orderId }),
  });
  if (!res.ok) {
    throw new Error(`Erro ao marcar pedido como impresso: HTTP ${res.status} ${await res.text()}`);
  }
}

// Pedido mais velho que isso (agente ficou desligado, PC dormindo...) não é
// impresso — comanda velha na cozinha só confunde. É marcado como impresso
// pra não ficar voltando a cada ciclo.
const MAX_AGE_MS = (config.maxAgeHours || 12) * 3600 * 1000;

function rpcHeaders() {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: 'Bearer ' + config.supabaseAnonKey,
    'Content-Type': 'application/json',
  };
}

// Avisa o servidor que o agente esta vivo e recebe de volta o nome da
// impressora configurado no painel e se existe um pedido de teste de impressao.
async function fetchTasks() {
  const res = await fetch(config.supabaseUrl + '/rest/v1/rpc/get_acai_agent_tasks', {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({
      p_agent_key: config.agentKey,
      p_agent_info: os.hostname() + ' | Windows ' + os.release() + ' | Node ' + process.version,
    }),
  });
  if (!res.ok) throw new Error('Erro ao consultar tarefas: HTTP ' + res.status + ' ' + (await res.text()));
  const rows = await res.json();
  return rows[0] || {};
}

async function markTest(testId, errorMessage) {
  const res = await fetch(config.supabaseUrl + '/rest/v1/rpc/mark_acai_print_test', {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({ p_agent_key: config.agentKey, p_test_id: testId, p_error: errorMessage || null }),
  });
  if (!res.ok) throw new Error('Erro ao responder o teste: HTTP ' + res.status + ' ' + (await res.text()));
}

function sampleOrder() {
  return {
    order_id: 'TESTE000-0000-0000-0000-000000000000',
    customer_name: 'Teste de impressao',
    customer_phone: '(00) 00000-0000',
    fulfillment_type: 'delivery',
    address: { street: 'Rua de Teste', number: '123', neighborhood: 'Centro', city: 'Sua cidade' },
    payment_method: 'dinheiro',
    needs_change: true,
    change_for: 100,
    notes: 'Comanda de teste - pode jogar fora',
    total: 48.4,
    created_at: new Date().toISOString(),
    items: [
      { quantity: 1, product_name: 'Acai 500ml de teste', selected_options: [] },
      { quantity: 2, product_name: 'Refrigerante', selected_options: [] },
    ],
  };
}

async function runRequestedTest(testId) {
  console.log('[' + new Date().toLocaleTimeString('pt-BR') + '] Teste de impressao pedido pelo painel...');
  try {
    await printToWindowsShare(buildReceipt(sampleOrder()));
    await markTest(testId, null);
    console.log('  -> comanda de teste impressa.');
  } catch (err) {
    console.error('  -> ERRO no teste: ' + err.message);
    try { await markTest(testId, err.message); } catch (e2) { console.error('  -> ' + e2.message); }
  }
}

async function pollOnce() {
  try {
    const tasks = await fetchTasks();
    remotePrinterName = tasks.printer_name || null;
    if (tasks.test_id) await runRequestedTest(tasks.test_id);
  } catch (err) {
    console.error('Aviso: ' + err.message);
  }

  const orders = await fetchOrdersToPrint();
  for (const order of orders) {
    if (Date.now() - new Date(order.created_at).getTime() > MAX_AGE_MS) {
      console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Pedido ${order.order_id.slice(0, 8)} e antigo demais, nao imprimi (marcado como visto).`);
      try { await markPrinted(order.order_id); } catch (err) { console.error(`  -> ${err.message}`); }
      continue;
    }
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Imprimindo pedido ${order.order_id.slice(0, 8)} — ${order.customer_name}...`);
    try {
      await printToWindowsShare(buildReceipt(order));
      await markPrinted(order.order_id);
      console.log('  -> impresso com sucesso.');
    } catch (err) {
      console.error(`  -> ERRO ao imprimir pedido ${order.order_id.slice(0, 8)}: ${err.message}`);
      console.error('     Vai tentar de novo no proximo ciclo (nao marquei como impresso).');
    }
  }
}

// Modo de teste (testar-impressao.bat): confere tudo e imprime uma comanda de
// exemplo, sem tocar em nenhum pedido real. Mostra OK/FALHA em cada etapa.
async function runTest() {
  const ok = (m) => console.log('  [OK]    ' + m);
  const fail = (m) => console.log('  [FALHA] ' + m);
  console.log('=== TESTE DO AGENTE DE IMPRESSAO ===');
  console.log('Windows: ' + os.release() + ' | Node: ' + process.version);

  try {
    remotePrinterName = (await fetchTasks()).printer_name || null;
    if (remotePrinterName) console.log('Impressora configurada no painel: ' + remotePrinterName);
  } catch (err) {
    console.log('  [AVISO] nao consegui ler a configuracao do servidor: ' + err.message);
  }

  try {
    await ensurePrinterQueue();
  } catch (err) {
    console.log('  [AVISO] nao consegui criar a fila sozinho: ' + err.message);
  }

  let printers = [];
  try {
    printers = await listPrinters();
    console.log('Impressoras no Windows:');
    printers.forEach((p) => console.log('   - ' + p.name + '  (porta ' + p.port + ', ' + p.status + ')'));
    const porPorta = {};
    printers.forEach((p) => { (porPorta[p.port] = porPorta[p.port] || []).push(p.name); });
    Object.entries(porPorta)
      .filter(([porta, nomes]) => nomes.length > 1 && /^usb/i.test(porta))
      .forEach(([porta, nomes]) => console.log('  [INFO]  varias filas usam a mesma impressora (' + porta + '): ' + nomes.join(', ') + ' — normal quando iFood/99Food tambem imprimem nela.'));
    printers
      .filter((p) => /offline|paused|error|pausad/i.test(p.status))
      .forEach((p) => console.log('  [AVISO] "' + p.name + '" esta com status "' + p.status + '" — o Windows pode estar segurando os trabalhos dela.'));
  } catch (err) {
    fail('nao consegui listar as impressoras: ' + err.message);
  }

  let printer = null;
  try {
    printer = await resolvePrinterName();
    ok('impressora escolhida: ' + printer);
  } catch (err) {
    fail(err.message);
  }

  try {
    const orders = await fetchOrdersToPrint();
    ok('conexao com o servidor e chave da loja (' + orders.length + ' pedido(s) pendente(s))');
  } catch (err) {
    fail('servidor/chave: ' + err.message);
  }

  if (printer) {
    try {
      await printToWindowsShare(buildReceipt({
        order_id: 'TESTE000-0000-0000-0000-000000000000',
        customer_name: 'Teste de impressao',
        customer_phone: '(00) 00000-0000',
        fulfillment_type: 'delivery',
        address: { street: 'Rua de Teste', number: '123', neighborhood: 'Centro', city: 'Sua cidade' },
        payment_method: 'dinheiro',
        needs_change: true,
        change_for: 100,
        notes: 'Comanda de teste - pode jogar fora',
        total: 48.4,
        created_at: new Date().toISOString(),
        items: [
          { quantity: 1, product_name: 'Acai 500ml de teste', selected_options: [] },
          { quantity: 2, product_name: 'Refrigerante', selected_options: [] },
        ],
      }));
      ok('comanda de teste enviada pra impressora — confira se saiu o papel');
    } catch (err) {
      fail(err.message);
    }
  }
  console.log('=== FIM DO TESTE ===');
}

async function main() {
  if (process.argv.includes('--teste')) {
    await runTest();
    return;
  }
  console.log(`Agente de impressao "${config.storeName}" iniciado.`);
  console.log(`Verificando pedidos novos a cada ${config.pollIntervalMs / 1000}s...`);
  try {
    remotePrinterName = (await fetchTasks()).printer_name || null;
  } catch (err) {
    console.error(`Aviso: ${err.message}`);
  }
  try {
    await ensurePrinterQueue();
  } catch (err) {
    console.error(`Aviso: nao consegui preparar a fila da impressora sozinho (${err.message})`);
  }
  try {
    const alvo = !config.printerName && config.printerShareName
      ? `\\\\localhost\\${config.printerShareName} (compartilhada)`
      : await resolvePrinterName();
    console.log(`Impressora: ${alvo}`);
  } catch (err) {
    console.error(`Atencao: ${err.message}`);
  }
  console.log('Rodando. (Pra reiniciar o agente, de 2 cliques em iniciar.bat.)\n');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`Erro no ciclo de verificacao: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

process.on('unhandledRejection', (err) => console.error('Erro inesperado: ' + (err && err.message ? err.message : err)));

main();
