#!/usr/bin/env node
/**
 * 自检：造假工程跑一遍，确认三类分类没有互相串。
 * 跑:  node selftest.mjs
 *
 * 主要防的是回归——比如位带正则漏掉开头的 P，会安静地返回 0 个引脚。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinmap-"));
fs.mkdirSync(path.join(dir, "Inc"));
fs.mkdirSync(path.join(dir, "Src"));
fs.writeFileSync(path.join(dir, "Inc/motor.h"), `
#define AIN1      PBout(13)
#define AIN1_PORT GPIOB
#define AIN1_PIN  GPIO_Pin_13
#define PWMA_PORT GPIOC
#define PWMA_PIN  GPIO_Pin_9
#define PWMA_TIM  TIM8
#define PWMA_Channel 4
#define MOTOR_EN  PDout(14)
`);
fs.writeFileSync(path.join(dir, "Inc/led.h"), `
#define VER1_0_LED_R PDout(14)
#define IIC_SDA      PBout(7)
#define READ_SDA     PBin(7)
`);
fs.writeFileSync(path.join(dir, "Inc/bus.h"), `
#if 0   // 备选接法 A
#define BUS_TX_PORT GPIOA
#define BUS_TX_PIN  GPIO_Pin_1
#elif 0 // 备选接法 B
#define BUS_TX_PORT GPIOA
#define BUS_TX_PIN  GPIO_Pin_2
#else   // 实际用的
#define BUS_TX_PORT GPIOA
#define BUS_TX_PIN  GPIO_Pin_3
#endif
`);
fs.writeFileSync(path.join(dir, "Src/main.c"), `
void init(void){ RCC_AHB1PeriphClockCmd(RCC_AHB1Periph_GPIOD, ENABLE); }
// 两个版本的写法故意不同，顺带验证默认的 versionVar 正则认得几种命名
void task(void){ if (HW_Ver == VER1_0) {} else if (BoardVersion == VER1_1) {} }
`);

// 两个模块宣称同一个引脚 PB00，但各自的 Init 只在一个车型 target 里被调用。
// 必须归到「编译期差异」，不能报成真冲突。
fs.writeFileSync(path.join(dir, "Inc/modo.h"), `
#define XXX_PORT GPIOB
#define XXX_PIN  GPIO_Pin_0
`);
fs.writeFileSync(path.join(dir, "Inc/mody.h"), `
#define YYY_PORT GPIOB
#define YYY_PIN  GPIO_Pin_0
`);
// 故意写成 CRLF + 调用点包在车型宏里。这两样各写错一次，都会让整个文件的
// 使用处掉进「没有函数归属」，于是什么都算活的、冲突被静默吞掉。
fs.writeFileSync(path.join(dir, "Src/modo.c"), "void XXX_Init(void)\r\n{\r\n\tGPIO_Init(XXX_PORT, 0);\r\n}\r\n");
fs.writeFileSync(path.join(dir, "Src/mody.c"), "void YYY_Init(void)\r\n{\r\n\tGPIO_Init(YYY_PORT, 0);\r\n}\r\n");
fs.writeFileSync(path.join(dir, "Src/targets.c"),
  "void System_Init(void)\r\n{\r\n#if defined CAR_A\r\n\tXXX_Init();\r\n#else\r\n\tYYY_Init();\r\n#endif\r\n}\r\n");
fs.writeFileSync(path.join(dir, "proj.uvprojx"), `<?xml version="1.0"?><Project>
<Targets>
<Target><TargetName>CarA</TargetName><TargetOption><TargetArmAds><Cads><VariousControls><Define>CAR_A</Define></VariousControls></Cads></TargetArmAds></TargetOption></Target>
<Target><TargetName>CarB</TargetName><TargetOption><TargetArmAds><Cads><VariousControls><Define></Define></VariousControls></Cads></TargetArmAds></TargetOption></Target>
</Targets></Project>`);

const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "audit.mjs"), dir], { encoding: "utf8" });
if (process.env.DUMP) console.log(out);
fs.rmSync(dir, { recursive: true, force: true });

// 按标题里的一小段找节，别按编号 —— 插一节就全错位
const section = (t) => {
  const i = out.search(new RegExp("^## (?:\\d+\\. )?[^\\n]*" + t, "m"));
  if (i < 0) return "";
  const j = out.indexOf("\n## ", i + 1);
  return out.slice(i, j < 0 ? undefined : j);
};

const checks = [
  ["位带宏没漏（PBout 开头的 P）",      out.includes("PB13") && out.includes("PB07")],
  ["端口对配对成功",                     out.includes("PORT/_PIN") || out.includes("PWMA")],
  ["TIM/Channel 带出来",                 /TIM8_CH4/.test(out)],
  ["默认重要度认对（MOTOR/PWM -> 🔴）",  out.includes("🔴 会动/停不下来")],
  ["版本差异归到版本节",                 section("版本差异").includes("PD14") && section("版本差异").includes("MOTOR_EN")],
  ["惯用法归到惯用法节（不是冲突）",     section("惯用法").includes("PB07") && !section("真冲突").includes("PB07")],
  ["真冲突节是空的（本例确实没有）",     section("真冲突").includes("（无")],
  ["时钟：GPIOD 已使能不报",             !section("时钟未使能").includes("GPIOD")],
  ["时钟：GPIOB 未使能要报",             section("时钟未使能").includes("GPIOB")],
  ["运行时分发点抓到两处",               section("运行时分发点").includes("VER1_0") && section("运行时分发点").includes("VER1_1")],
  ["#if 0 死分支跳过（带行尾注释）",      out.includes("PA03") && !out.includes("PA01") && !out.includes("PA02")],
  ["#if 0 的引脚不进冲突节",             !section("真冲突").includes("BUS_TX")],
  ["Keil target 解析出来",               section("编译期差异").includes("CarA") && section("编译期差异").includes("CarB")],
  ["车型宏隔开的引脚归编译期差异",       section("编译期差异").includes("PB00")],
  ["跨 target 的引脚不算真冲突",         !section("真冲突").includes("PB00")],
  ["CRLF 只在一个 target 里活也要认出来", (out.match(/PB00/g) || []).length >= 1 && section("编译期差异").includes("XXX")],
];

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}`); }
console.log(bad ? `\n${bad} 项失败` : `\n全部 ${checks.length} 项通过`);
process.exit(bad ? 1 : 0);
