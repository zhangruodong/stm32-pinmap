#!/usr/bin/env node
/**
 * stm32-pinmap — 扫描 STM32 工程，列出每个物理引脚被谁占用，
 * 把「真冲突 / 编译期差异(车型·target) / 运行期版本差异 / 惯用法 / 定义但没人用」分开报。
 *
 * 用法:  node audit.mjs <工程目录> [--target <Keil target 名>] [--config <配置.json>]
 *
 * 只读。不改任何文件，不调用工具链。
 */
import fs from "node:fs";
import path from "node:path";

/* ─── 默认旋钮（--config 传外部 JSON 可整体覆盖）───────────────── */
const DEFAULTS = {
  skip: ["\\.git", "node_modules", "FWLib", "StdPeriph", "CMSIS", "RTE",
         "DebugConfig", "OBJ", "Listings", "Library"],
  levels: [
    ["🔴 会动/停不下来",   "(MOTOR|PWM|ENABLE|BRAKE|BLDC|PHASE|STEP|DIR|IN[1-4]\\b|OUT[1-4]\\b)"],
    ["🟠 失控/通信断",     "(CAN|UART|USART|_TX\\b|_RX\\b|WDG|NRST|PS2|USB)"],
    ["🟡 读数错/功能失效", "(SENSOR|ADC|KEY|BUTTON|IMU|MPU|ICM|GYRO|SPI|IIC|I2C|SCL|SDA|ENC|HALL|CURRENT|TEMP)"],
    ["🔵 只是不方便",      "(LED|BEEP|BUZZER|OLED|LCD|LIGHT|RGB|STRIP)"],
  ],
  defaultLevel: "⚪ 未分类",
  // 程序入口：这些函数当作活的，从它们往下走调用图
  // 程序入口。FreeRTOS 的 xTaskCreate(Show_Task, ...) 是把函数名当参数传，
  // 不是 Show_Task( ) 这种调用，抓不到边，所以任务函数也得单独当根。
  roots: ["main", "System_Init", "SystemInit", "MX_\\w+_Init",
          ".*_Handler", ".*_IRQHandler", ".*_Callback", ".*_Task", ".*_task"],
  ignore: [],
  // 判定"运行在哪版硬件上"的那个变量名 —— 运行时枚举，引脚靠
  // if (变量 == 版本) 分家。各家叫法不一样，所以默认给的是**正则片段**
  // 而不是某个具体名字，命中 Hardware_Ver / HW_Ver / BoardVer / PCBRev 这类。
  // 都不像的话就填自己的（大小写不敏感，会加上 \b 边界）。
  versionVar: "(?:Hardware|Board|HW|PCB)_?(?:Ver|Version|Rev)",
};

const argv = process.argv.slice(2);
const optOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const cfgPath = optOf("--config");
const wantTarget = optOf("--target");
const used = new Set(["--config", "--target"]);
const ROOT = argv.find((a, i) => !a.startsWith("--") && !used.has(argv[i - 1]));
if (!ROOT) {
  console.error("用法: node audit.mjs <工程目录> [--target <Keil target 名>] [--config <配置.json>]");
  process.exit(1);
}
const CFG = cfgPath && fs.existsSync(cfgPath)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, "utf8")) }
  : DEFAULTS;

const SKIP = new RegExp(CFG.skip.join("|"), "i");
const LEVELS = CFG.levels.map(([label, re]) => [label, new RegExp(re, "i")]);
const ROOTS = CFG.roots.map((r) => new RegExp(`^(?:${r})$`));
const IGNORE = (CFG.ignore || []).map((r) => new RegExp(r, "i"));

/* ─── 正则 ──────────────────────────────────────────────────── */
const RE_BIT  = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)\s+P([A-I])(out|in)\s*\(\s*(\d+)\s*\)/;
const RE_PORT = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)_PORT\s+GPIO([A-I])\b/;
const RE_PIN  = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)_PIN\s+GPIO_Pin_(\d+)\b/;
const RE_TIM  = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)_TIM\s+(TIM\d+)\b/;
const RE_CH   = /^[ \t]*#\s*define\s+([A-Za-z_]\w*)_Channel\s+(\d+)\b/;
const RE_INIT = /GPIO_Init\s*\(\s*GPIO([A-I])\s*,/;
const RE_INIT_PIN = /\.?\s*GPIO_Pin\s*=\s*GPIO_Pin_(\d+)/;
const RE_CLK  = /RCC_AHB1PeriphClockCmd\s*\(\s*RCC_AHB1Periph_GPIO([A-I])\s*,\s*ENABLE\s*\)/;
const RE_VER  = /^((?:VER|HWV|HW|REV|V)\d+(?:_\d+)?)_/i;
const RE_DISPATCH = new RegExp(`\\b(?:${CFG.versionVar})\\b\\s*[=!]=\\s*(\\w+)`, "gi");
const RE_CPP  = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b[ \t]*(.*)$/;
const RE_IDENT = /\b[A-Z][A-Z0-9_]{2,}\b/g;
const RE_CALL  = /\b([A-Za-z_]\w*)\s*\(/g;
const RE_FUNCHDR = /^[A-Za-z_][\w \t\*]*[ \t\*]([A-Za-z_]\w*)[ \t]*\([^;{}]*\)[ \t]*\{?[ \t]*$/;

/* ─── 读文件：UTF-8 优先，GBK 兜底（国内 Keil 工程常是 GBK）──── */
function readText(file) {
  const buf = fs.readFileSync(file);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("gbk").decode(buf); }
}

/* 去掉注释和字符串字面量，剩下的拿来做括号计数/取标识符 */
function strip(code, st) {
  let out = "", i = 0;
  while (i < code.length) {
    if (st.block) { const e = code.indexOf("*/", i); if (e < 0) return out; st.block = false; i = e + 2; continue; }
    const c = code[i];
    if (c === "/" && code[i + 1] === "*") { st.block = true; i += 2; continue; }
    if (c === "/" && code[i + 1] === "/") break;
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < code.length && code[i] !== q) { if (code[i] === "\\") i++; i++; }
      i++; out += " "; continue;
    }
    out += c; i++;
  }
  return out;
}

/* ─── Keil target 解析：<TargetName> + <Define> ─────────────── */
function findFiles(dir, re, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.test(e.name)) findFiles(p, re, out); }
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

function parseTargets() {
  const map = new Map();
  for (const f of findFiles(ROOT, /\.uvprojx?$/i)) {
    const t = readText(f);
    for (const m of t.matchAll(/<Target\b[^>]*>([\s\S]*?)<\/Target>/g)) {
      const name = (m[1].match(/<TargetName>([^<]*)</) || [])[1];
      if (!name) continue;
      const defs = new Set();
      for (const d of m[1].matchAll(/<Define>([^<]*)<\/Define>/g))
        for (const x of d[1].split(",")) { const v = x.trim().split("=")[0]; if (v) defs.add(v); }
      map.set(name, defs);
    }
  }
  return map;
}

/* ─── 条件求值。#if 0 / #if 1 / #if defined X 可解，其余 null ── */
function cond(expr, D) {
  let s = (expr || "").split("//")[0].split("/*")[0].trim();
  let m;
  if ((m = s.match(/^!\s*defined\s*\(?\s*(\w+)/))) return D ? !D.has(m[1]) : null;
  if ((m = s.match(/^defined\s*\(?\s*(\w+)/)))    return D ? D.has(m[1]) : null;
  s = s.replace(/[()\s]/g, "").replace(/[uUlL]+$/, "");
  return s === "0" ? false : s === "1" ? true : null;
}

/* ─── 单次扫描（针对一个 target 的宏定义集）────────────────── */
function scan(D) {
  const R = { bitDefs: [], portDefs: [], pinDefs: [], tims: new Map(), chans: new Map(),
              clocks: new Map(), dispatches: [], stdlib: [],
              usages: [], funcsOf: new Map(), files: 0, dead: 0 };

  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p); continue; }
      if (!/\.(c|h)$/i.test(e.name)) continue;
      R.files++;
      const rel = p.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/"), "").replace(/^\//, "");
      let text; try { text = readText(p); } catch { continue; }
      // 按 \r\n / \r / \n 切：Keil 工程里 CRLF 和 LF 文件常常混着，
      // 行尾留个 \r 会让所有以 $ 结尾的正则（函数声明）静默失效。
      const raw = text.split(/\r\n|\r|\n/);
      const isC = /\.c$/i.test(e.name);

      // 一遍：剥注释 + 数括号，找函数定义和它的行范围
      const clean = new Array(raw.length);
      const st = { block: false };
      for (let i = 0; i < raw.length; i++) clean[i] = strip(raw[i], st);

      const lineToFn = new Array(raw.length).fill(null);
      const funcs = [];
      if (isC) {
        const names = [];
        for (let i = 0; i < clean.length; i++) {
          const m = clean[i].match(RE_FUNCHDR);
          if (!m) continue;
          // 花括号可能跟函数名同行（`void foo(void) {`），也可能在下一行
          const inline = /\{[ \t]*$/.test(clean[i]);
          let j = i;
          if (!inline) { j = i + 1; while (j < clean.length && clean[j].trim() === "") j++; }
          if (j >= clean.length || !/^[ \t]*\{/.test(clean[j])) continue;
          // 括号对不上就一直算到文件尾 —— 别退化成"只覆盖一行"，
          // 那会让后面整个函数体被当成文件级代码，一律算成活的。
          let depth = 0, end = clean.length - 1;
          for (let k = j; k < clean.length; k++) {
            for (const ch of clean[k]) { if (ch === "{") depth++; else if (ch === "}") depth--; }
            if (depth <= 0) { end = k; break; }
          }
          funcs.push({ name: m[1], start: i, end });
          names.push(m[1]);
          i = end;
        }
        for (const f of funcs) for (let k = f.start; k <= f.end; k++) lineToFn[k] = f.name;
        R.funcsOf.set(rel, funcs);
      }
      const funcNameSet = new Set(funcs.map((f) => f.name));

      // 二遍：收集引脚定义 / 使用处 / 调用
      const stack = [];
      const active = () => stack.every((f) => f.taken);
      let lastInitPort = null, lastInitLine = 0;
      for (let i = 0; i < raw.length; i++) {
        const ln = raw[i], n = i + 1;

        // 用剥过注释的 clean[i]，不是原始行：被 /* */ 注释掉的 #if / #endif
        // 会让条件栈错位，后面的 #if defined X 就整个失效。
        const cm = clean[i].match(RE_CPP);
        if (cm) {
          const kw = cm[1], arg = cm[2];
          if (kw === "if" || kw === "ifdef" || kw === "ifndef") {
            const t = kw === "if" ? cond(arg, D) : D ? D.has((arg.match(/^\s*(\w+)/) || [])[1]) === (kw === "ifdef") : null;
            stack.push({ taken: t !== false, anyTaken: t === true, idx: 0 });
          } else if (kw === "elif") {
            const f = stack[stack.length - 1];
            if (f) { const t = cond(arg, D); f.taken = !f.anyTaken && t !== false; f.anyTaken = f.anyTaken || t === true; f.idx++; }
          } else if (kw === "else") {
            const f = stack[stack.length - 1];
            if (f) { f.taken = !f.anyTaken; f.anyTaken = true; f.idx++; }
          } else stack.pop();
        }
        if (!active()) { R.dead++; continue; }

        if (cm && (cm[1] === "if" || cm[1] === "ifdef" || cm[1] === "ifndef")) { /* #if 行本身不参与 */ }
        else {
          let m;
          if ((m = ln.match(RE_BIT)))  R.bitDefs.push({ name: m[1], port: m[2], num: +m[4], dir: m[3] === "out" ? "out" : "in", file: rel, line: n });
          if ((m = ln.match(RE_PORT))) R.portDefs.push({ base: m[1], port: m[2], file: rel, line: n });
          if ((m = ln.match(RE_PIN)))  R.pinDefs.push({ base: m[1], num: +m[2], file: rel, line: n });
          if ((m = ln.match(RE_TIM)) && !R.tims.has(m[1]))   R.tims.set(m[1], m[2]);
          if ((m = ln.match(RE_CH))  && !R.chans.has(m[1]))  R.chans.set(m[1], m[2]);
          if ((m = ln.match(RE_CLK)) && !R.clocks.has(m[1])) R.clocks.set(m[1], `${rel}:${n}`);
          if ((m = ln.match(RE_INIT))) { lastInitPort = m[1]; lastInitLine = n; }
          if (lastInitPort && (m = ln.match(RE_INIT_PIN)) && n - lastInitLine < 12)
            R.stdlib.push({ base: `GPIO_Init(GPIO${lastInitPort})`, port: lastInitPort, num: +m[1], dir: "?", file: rel, line: n });
        }
        { let g; RE_DISPATCH.lastIndex = 0; while ((g = RE_DISPATCH.exec(ln))) R.dispatches.push({ ver: g[1], file: rel, line: n }); }

        // 使用处 / 调用（只看 .c）
        if (isC && !/^[ \t]*#/.test(ln)) {
          const code = clean[i];
          const fn = lineToFn[i];
          for (const id of code.match(RE_IDENT) || []) R.usages.push({ name: id, file: rel, line: n, fn });
          // 调用边：跨文件的也要记（main.c 调 system.c 的 System_Init），
          // 过滤交给 liveFunctions，那里才知道全工程的函数名。
          RE_CALL.lastIndex = 0;
          let c;
          while ((c = RE_CALL.exec(code))) R.usages.push({ name: "@" + c[1], file: rel, line: n, fn });
        }
      }
    }
  })(ROOT);
  return R;
}

/* ─── 调用图：哪些函数是活的 ────────────────────────────────── */
function liveFunctions(R) {
  const all = new Set();
  for (const list of R.funcsOf.values()) for (const f of list) all.add(f.name);

  const isRoot = (n) => ROOTS.some((re) => re.test(n));
  const live = new Set([...all].filter(isRoot));

  // 从使用处反推调用边：usages 里 "@名字" 表示该行调用了这个名字
  const edges = new Map();  // 调用者 -> 被调用者
  for (const u of R.usages) {
    if (!u.name.startsWith("@")) continue;
    const callee = u.name.slice(1);
    if (!all.has(callee)) continue;
    if (!edges.has(u.fn)) edges.set(u.fn, new Set());
    edges.get(u.fn).add(callee);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [caller, callees] of edges) {
      if (caller !== null && !live.has(caller)) continue;
      for (const c of callees) if (!live.has(c)) { live.add(c); changed = true; }
    }
  }
  return { live, total: all.size, ok: all.size === 0 || live.size >= Math.min(3, all.size) };
}

/* ─── 主流程 ────────────────────────────────────────────────── */
const allTargets = parseTargets();
let targets;   // [{name, defines}]  —— name 为 null 表示不做条件解析
if (allTargets.size === 0) targets = [{ name: null, defines: null }];
else if (wantTarget) {
  if (!allTargets.has(wantTarget)) {
    console.error(`没有这个 target: ${wantTarget}\n可用的: ${[...allTargets].map(([k, v]) => `${k}(${[...v].join("/") || "无宏"})`).join("  ")}`);
    process.exit(1);
  }
  targets = [{ name: wantTarget, defines: allTargets.get(wantTarget) }];
} else targets = [...allTargets].map(([name, defines]) => ({ name, defines }));

const multi = targets.length > 1;

/* 每个 target 扫一遍 */
const perTarget = targets.map((tg) => {
  const R = scan(tg.defines);
  R.live = liveFunctions(R);
  const used = new Set();
  for (const u of R.usages) if (u.fn === null || R.live.live.has(u.fn)) used.add(u.name);
  // 调用图不可信时干脆不做"有没有人用"的判断，退回保守模式。
  // 宁可少报，也不能把活着的引脚说成没人用。
  // 最隐蔽的塌法是函数检测在某个文件里整个失效（正则写错、CRLF 行尾残留）：
  // 那个文件的使用处全变成"文件级"、无条件算活，冲突就静默消失了。
  // 全局比例测不出这种塌法 —— 得按文件看。
  const byFileU = new Map();
  for (const u of R.usages) { if (!byFileU.has(u.file)) byFileU.set(u.file, []); byFileU.get(u.file).push(u); }
  R.collapsed = [...byFileU].filter(([, us]) => us.length >= 20 && us.every((u) => u.fn === null)).map(([f]) => f);
  R.liveOk = R.live.total === 0 ||
    (R.live.live.size >= Math.max(1, R.live.total * 0.3) && !R.collapsed.length);
  R.usedMacros = R.liveOk ? used : null;
  R.target = tg.name;
  return R;
});

/* --debug：查「这个引脚为什么被判成没人用」。只写 stderr，不进报告。 */
if (argv.includes("--debug")) {
  for (const R of perTarget) {
    const names = [...new Set([...R.funcsOf.values()].flat().map((f) => f.name))];
    const deadFn = names.filter((n) => !R.live.live.has(n));
    const noFn = R.usages.filter((u) => u.fn === null).length;
    console.error(`[debug] target=${R.target} 函数=${R.live.total} 活=${R.live.live.size} liveOk=${R.liveOk} 无函数归属的使用处=${noFn}/${R.usages.length}`);
    console.error(`[debug]   没算活的函数(${deadFn.length}): ${deadFn.join(", ")}`);
  }
  // 函数检测一旦塌掉（正则或换行符问题），整个文件的使用处都会掉进"无函数归属"，
  // 于是什么都算活的、冲突全被吞掉。这个列表是第一个该看的东西。
  const counts = new Map();
  for (const R of perTarget) for (const [f, l] of R.funcsOf) if (!counts.has(f)) counts.set(f, l.length);
  console.error("[debug] 每个 .c 检测到的函数数: " + [...counts].sort((a, b) => a[1] - b[1]).map(([f, l]) => `${f}=${l}`).join("  "));
}

/* 合并：同一个物理引脚 -> 条目，每条记住「哪些 target 上真的在用」*/
const pinKey = (port, num) => "P" + port + String(num).padStart(2, "0");
const byPin = new Map();
const unused = [];
const bump = (key, e, tg, usedMacros) => {
  if (!byPin.has(key)) byPin.set(key, new Map());
  const bag = byPin.get(key);
  const k = `${e.base}|${e.dir}|${e.file}:${e.line}`;
  if (!bag.has(k)) bag.set(k, { ...e, names: new Set(), targets: new Set(), defTargets: new Set() });
  const cur = bag.get(k);
  cur.defTargets.add(tg);
  cur.names.add(e.base);
  // targets 记的是「这个 target 上真的有人用它」，不是「定义存在」——
  // 定义通常是无条件的，条件在调用点（#if defined CAR_A 里的 ServoA_Init()）。
  const isUsed = usedMacros === null || ["", "_PORT", "_PIN"].some((suf) => usedMacros.has(e.base + suf));
  if (isUsed) { cur.used = true; cur.targets.add(tg); }
};
const verOf = (n) => { const m = n.match(RE_VER); return m ? m[1] : null; };
const stripVer = (n) => n.replace(RE_VER, "");

for (const R of perTarget) {
  const tg = R.target;
  for (const d of R.bitDefs) bump(pinKey(d.port, d.num), { ...d, base: d.name, style: "位带" }, tg, R.usedMacros);
  for (const prt of R.portDefs) {
    const cands = R.pinDefs.filter((x) => x.base === prt.base);
    // 只有一个候选就配对；多个候选得看是同一个 #if 分支里的（靠行号远近判断）
    const pn = cands.length === 1 ? cands[0] : cands.find((x) => x.file === prt.file && Math.abs(x.line - prt.line) < 40);
    if (!pn) continue;
    const tim = R.tims.get(prt.base);
    bump(pinKey(prt.port, pn.num), {
      base: prt.base, name: `${prt.base}_PORT/_PIN`, dir: "?",
      style: tim ? `端口对 + ${tim}_CH${R.chans.get(prt.base) ?? "?"}` : "端口对",
      file: prt.file, line: pn.line, port: prt.port, num: pn.num,
    }, tg, R.usedMacros);
  }
  for (const s of R.stdlib) bump(pinKey(s.port, s.num), { ...s }, tg, R.usedMacros);
}

// 同一引脚、同一 base、同一方向 -> 合并（同一个宏在 .h/.c 各写一次不算两处）
for (const [key, bag] of byPin) {
  const merged = new Map();
  for (const e of bag.values()) {
    const k = e.base;      // 同名就是同一个信号，方向取更具体的那个（out/in 优先于 ?）
    if (!merged.has(k)) merged.set(k, e);
    else {
      const c = merged.get(k);
      for (const t of e.targets) c.targets.add(t);
      for (const t of e.defTargets) c.defTargets.add(t);
      if (e.used) c.used = true;
      if (c.dir === "?" && e.dir !== "?") c.dir = e.dir;
    }
  }
  byPin.set(key, [...merged.values()]);
}

/* ─── 分类 ──────────────────────────────────────────────────── */
const lastSeg = (s) => (s || "").split("_").filter(Boolean).pop().toUpperCase();
const levelOf = (n) => { for (const [l, re] of LEVELS) if (re.test(n)) return l; return CFG.defaultLevel; };

const realConflicts = [], compileDiff = [], versionClashes = [], idioms = [];
for (const [key, list] of [...byPin].sort()) {
  if (list.length < 2) continue;
  if (list.some((e) => IGNORE.some((re) => re.test(e.base)))) continue;

  // 只有真的有人用的 claim 才算冲突候选，没人用的那个归第五节。
  // 这里不能限定 multi —— 单 target 模式同样要排除"另一个压根没人用"的情况。
  const claimed = list.filter((e) => e.targets.size);
  // 没有任何一个 target 上同时活着两个 -> 编译期差异（车型宏隔开的），不是冲突
  const seenT = new Set();
  let shared = false;
  for (const e of claimed) for (const t of e.targets) { if (seenT.has(t)) shared = true; seenT.add(t); }
  if (claimed.length >= 2 && !shared) { compileDiff.push([key, list]); continue; }

  const names = list.map((e) => e.base);
  const versions = new Set(list.map((e) => verOf(e.base)).filter(Boolean));
  const dirs = new Set(list.map((e) => e.dir));
  // 惯用法判据是「同信号、方向互补」——方向未知（端口对）的不参与，
  // 否则 LED_G + RGB_G 这种同文件别名会被误判成软件 I2C。
  if (dirs.size > 1 && !dirs.has("?") && new Set(names.map(lastSeg)).size === 1) { idioms.push([key, list]); continue; }
  // 同一个文件里的多个名字是作者自己的别名——一个文件就是一个模块，
  // 模块不会跟自己抢引脚。合并成一条再往下判。（惯用法上面已经挑走了，
  // 所以这里的同文件条目只剩下别名，不会误伤 PB08 那种 in/out 交替。）
  const merged = new Map();
  for (const e of list) { if (!merged.has(e.file)) merged.set(e.file, []); merged.get(e.file).push(e); }
  const g = [...merged.values()].map((grp) => {
    if (grp.length === 1) return grp[0];
    const head = grp.find((e) => e.dir !== "?") ?? grp[0];
    return { ...head,
      base: grp.map((e) => e.base).join(" / "),
      style: grp.map((e) => e.style).join(" + "),
      used: grp.some((e) => e.used),
      targets: new Set(grp.flatMap((e) => [...e.targets])),
    };
  });
  if (g.length < 2) continue;
  const tagged = g.map((e) => verOf(e.base));
  if (versions.size > 1 || (versions.size === 1 && tagged.some((t) => !t))) { versionClashes.push([key, g]); continue; }
  // 版本差异和惯用法看的是"定义"本身，只有冲突才要求两边都真的有人用 ——
  // 否则单 target 模式下 #if 隔开的那个模块会被误报成冲突。
  if (claimed.length < 2) continue;
  realConflicts.push([key, g]);
}

/* ─── 输出 ──────────────────────────────────────────────────── */
const L = console.log;
const files = Math.max(...perTarget.map((r) => r.files));
const dead = Math.max(...perTarget.map((r) => r.dead));
const clocks = new Map(); for (const R of perTarget) for (const [k, v] of R.clocks) if (!clocks.has(k)) clocks.set(k, v);
const dispatches = []; const seenD = new Set();
for (const R of perTarget) for (const d of R.dispatches) { const k = `${d.file}:${d.line}:${d.ver}`; if (!seenD.has(k)) { seenD.add(k); dispatches.push({ ...d, target: R.target }); } }

L(`# STM32 引脚占用审计\n`);
L(`- 工程目录: \`${ROOT}\``);
L(`- 扫描: **${files}** 个 .c/.h`);
if (dead) L(`- 跳过 **${dead}** 行不参与编译的代码（` + "`#if 0`" + ` 备用配置、厂家头文件里的编译器分支等）`);
if (multi) L(`- Keil target: **${targets.length}** 个 — ${targets.map((t) => "`" + t.name + "`").join(", ")}`);
else if (targets[0].name) L(`- Keil target: \`${targets[0].name}\`${allTargets.get(targets[0].name).size ? `（宏: ${[...allTargets.get(targets[0].name)].join(", ")}）` : ""}`);
for (const R of perTarget) {
  if (R.collapsed?.length)
    L(`- ⚠️ 这些文件里一个函数都没认出来，里面的使用处全被当成"文件级"：${R.collapsed.map((f) => "`" + f + "`").join(", ")}`);
  if (!R.liveOk)
    L(`- ⚠️ target \`${R.target ?? "默认"}\` 的调用图只认出 ${R.live.live.size}/${R.live.total} 个函数，不可信 —— 已关闭「有没有人用」的判断`);
}
L(`- 识别到 **${byPin.size}** 个物理引脚被定义`);
const vers = new Set(); for (const l of byPin.values()) for (const e of l) { const v = verOf(e.base); if (v) vers.add(v); }
if (vers.size) L(`- 运行期硬件版本标签: ${[...vers].sort().map((v) => "`" + v + "`").join(", ")}`);
L("");

L(`## 引脚占用表\n`);
L(multi
  ? `| 引脚 | 重要度 | 功能 | 方向 | 版本 | 写法 | target | 定义处 |`
  : `| 引脚 | 重要度 | 功能 | 方向 | 版本 | 写法 | 定义处 |`);
L(multi ? `|---|---|---|---|---|---|---|---|` : `|---|---|---|---|---|---|---|`);
for (const [key, list] of [...byPin].sort()) {
  list.forEach((e, i) => {
    const v = verOf(e.base);
    const fn = stripVer(e.base);
    const loc = e.file.includes(":") ? e.file : `${e.file}:${e.line}`;
    const tgs = multi ? [...e.targets].filter(Boolean).join(",") || "—" : null;
    const cells = [levelOf(fn), fn + (e.used ? "" : " ⚠️没人用"), e.dir, v ?? "—", e.style, `\`${loc}\``];
    if (multi) cells.splice(5, 0, tgs);
    L(`| ${i === 0 ? "**" + key + "**" : ""} | ${cells.join(" | ")} |`);
  });
}
L("");
// 按引脚聚合，别让同一个引脚在第五节里出现好几次标题
for (const [key, list] of [...byPin].sort()) {
  const dead = list.filter((e) => e.used !== true);
  if (dead.length) unused.push([key, dead]);
}

const section = (title, arr, empty) => {
  L(`## ${title}\n`);
  if (!arr.length) { L(`${empty}\n`); return; }
  for (const [key, list] of arr) {
    L(`**${key}**`);
    for (const e of list) {
      const v = verOf(e.base);
      const loc = e.file.includes(":") ? e.file : `${e.file}:${e.line}`;
      const tg = multi && e.targets.size ? `  〔${[...e.targets].filter(Boolean).join(", ") || "—"}〕` : "";
      L(`- ${v ? "`" + v + "` " : ""}**${e.base}** (${e.dir}, ${e.style}) — \`${loc}\`${tg}`);
    }
    L("");
  }
};

L(`⚠️ 五节的关系：**冲突**要改代码；**编译期差异**和**版本差异**不是 bug，但改名时最容易踩；**惯用法**和**没人用**是正常的。\n`);
section("1. 真冲突 —— 同一 target、同一版本内，一个引脚被两个模块认领", realConflicts, "（无。这是好事。）");
section("2. 编译期差异 —— 各 Keil target 的定义不同（车型宏隔开）", compileDiff,
  "（无。）");
if (compileDiff.length) L(`> 这些引脚**永远不会同时编译进同一个 target**。改引脚时按 target 分别确认。\n`);
section("3. 运行期版本差异 —— 同一引脚在不同硬件版本下用途不同", versionClashes, "（无。）");
if (versionClashes.length) L(`> 这类**编译期不会报错**：两套宏同时存在，只有运行时的 ` + "`if (版本 == …)`" + ` 才能分开。\n` +
  `> 改引脚时只改一套 = 另一版板子上直接驱动错外设。\n`);
section("4. 惯用法 —— 同一引脚 in/out 交替（软件 I2C 等），正常", idioms, "（无。）");
section("5. 定义了但全工程没有活的使用处", unused.slice(0, 40), "（无。）");
if (unused.length > 40) L(`…还有 ${unused.length - 40} 条\n`);
if (unused.length) L(`> 可能是给别的 target / 未来用的配置。**冲突判定时会参考它**：没人用的宏不该报成冲突。\n`);

L(`## 时钟未使能\n`);
const usedPorts = new Set([...byPin.keys()].map((k) => k[1]));
const missing = [...usedPorts].filter((p) => !clocks.has(p)).sort();
if (missing.length) {
  L(`以下端口的引脚有定义，但全工程没找到 \`RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOx, ENABLE)\`：\n`);
  for (const p of missing) L(`- **GPIO${p}**`);
  L(`\n可能是时钟在别处（APB1/APB2 或直接写寄存器）打开，也可能是真漏了。\n`);
} else L(`（全部已使能。）\n`);

L(`## 运行时分发点\n`);
if (dispatches.length) {
  L(`这些地方按硬件版本分叉。**改引脚时这几行必须同步看**：\n`);
  L(multi ? `| 版本 | target | 位置 |\n|---|---|---|` : `| 版本 | 位置 |\n|---|---|`);
  for (const d of dispatches) L(multi ? `| \`${d.ver}\` | ${d.target ?? "—"} | \`${d.file}:${d.line}\` |` : `| \`${d.ver}\` | \`${d.file}:${d.line}\` |`);
  L("");
} else L(`（没有运行时分发，说明版本差异全靠编译期宏 —— 那样更危险，因为没有任何一处能看出用了哪版。）\n`);

L(`---`);
L(`只读审计，未修改任何文件。`);
