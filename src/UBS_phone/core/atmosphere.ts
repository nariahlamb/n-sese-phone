// ===== 气氛组设定块解析（纯函数，零依赖，可被 .cjs 测试直接 require） =====
// 与 <ubp_reply> 同一条 AI 回复：<ubp_atmo> 先给出待生成群友的
// 「姓名|性别|身份|一句性格」，再由 <ubp_reply> 让这些名字像普通群成员一样发言。
// 解析必须先于 reply。

import { ATMO_CLOSE_TAG, ATMO_OPEN_TAG, lastTagBlock } from './protocol-tags';
import {
  MAX_ATMOSPHERE_IDENTITY_LEN,
  MAX_ATMOSPHERE_NAME_LEN,
  MAX_ATMOSPHERE_PERSONALITY_LEN,
  normalizeAtmosphereGender,
  normalizeAtmosphereIdentity,
} from './chat-model';

export interface AtmosphereProfile {
  name: string;
  gender: string;
  identity: string;
  personality: string;
}

/** 表头/说明行（提示词示例可能被模型抄进块里）——跳过。 */
const HEADER_RE = /^(?:名字|姓名|群友|成员|角色)\s*[|｜:：]\s*(?:性别|身份|性格|一句性格|性格[\/／]说话风格)/;

/** 姓名里不允许出现的字符（会破坏「名字: 内容」行协议或 @ 解析）。 */
const BAD_NAME_RE = /[\s@|｜:：\[\]（）()【】,，。.!！?？"'“”]/;

/** 严格性别词（仅用于三字段歧义判断；四字段允许世界观自定性别词）。 */
const GENDER_TOKEN_RE = /^(?:男|男性|男生|女|女性|女生|其他|其它|非二元|未知|不详|未设定)$/;

function cleanField(value: string): string {
  return String(value || '').trim().replace(/^["“'『「]+|["”'』」]+$/g, '').trim();
}

/** 去掉列表序号/前置符号。 */
function stripListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-*·]\s*)?(?:\d+[.、)]\s*)?/, '').trim();
}

/**
 * 一行 → 字段数组：
 * - 优先按 | / ｜ 切分（新四字段协议）；
 * - 无竖线时兼容旧冒号格式「姓名：性格」（只切第一个冒号）。
 */
function splitLine(line: string): string[] | null {
  const body = stripListPrefix(line);
  if (!body) return null;
  const pipe = body.includes('|') ? '|' : body.includes('｜') ? '｜' : '';
  if (pipe) return body.split(pipe).map(p => p.trim());
  const m = body.match(/^([^:：]{1,24})\s*[:：]\s*(.{1,200})$/);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

/**
 * 从 AI 回复中提取 <ubp_atmo> 设定块。
 * - 取最后一个闭合块；
 * - 容忍序号/列表符号/半全角分隔符；
 * - 新格式：姓名|性别|身份|性格；三字段按第二段是否性别词判断；两字段兼容旧「姓名|性格」；
 * - 姓名 2~12 字、不含协议分隔符；排除 blockedNames（主角/正式成员/已生成气氛组/通讯录）；
 * - 组内去重；最多 count 条。
 * 无块/无有效行 = []（调用方按“本轮没生成出来”处理，不报错）。
 */
export function parseAtmosphereProfiles(
  text: string,
  count: number,
  blockedNames: Iterable<string> = [],
): AtmosphereProfile[] {
  const limit = Math.max(0, Math.floor(count));
  if (!limit) return [];
  const block = lastTagBlock(String(text || ''), ATMO_OPEN_TAG, ATMO_CLOSE_TAG);
  if (!block) return [];
  const blocked = new Set(
    Array.from(blockedNames)
      .map(n => String(n || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const out: AtmosphereProfile[] = [];
  for (const rawLine of block.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line || HEADER_RE.test(line)) continue;
    const parts = splitLine(line);
    if (!parts || parts.length < 2) continue;

    let name = '';
    let gender = '';
    let identity = '';
    let personality = '';
    if (parts.length >= 4) {
      name = parts[0];
      gender = parts[1];
      identity = parts[2];
      personality = parts.slice(3).join('，');
    } else if (parts.length === 3) {
      name = parts[0];
      if (GENDER_TOKEN_RE.test(parts[1])) {
        gender = parts[1];
        personality = parts[2];
      } else {
        identity = parts[1];
        personality = parts[2];
      }
    } else {
      name = parts[0];
      personality = parts[1];
    }

    name = cleanField(name);
    gender = normalizeAtmosphereGender(cleanField(gender));
    identity = normalizeAtmosphereIdentity(cleanField(identity)).slice(0, MAX_ATMOSPHERE_IDENTITY_LEN);
    personality = cleanField(personality).slice(0, MAX_ATMOSPHERE_PERSONALITY_LEN);
    if (name.length < 2 || name.length > MAX_ATMOSPHERE_NAME_LEN) continue;
    if (BAD_NAME_RE.test(name)) continue;
    if (name === '所有人' || name === '我' || name === '你') continue;
    if (!personality) continue;
    const key = name.toLowerCase();
    if (blocked.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, gender, identity, personality });
    if (out.length >= limit) break;
  }
  return out;
}
