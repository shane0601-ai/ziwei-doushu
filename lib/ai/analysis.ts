import { timingSafeEqual } from 'node:crypto';
import { BRANCHES, PALACE_NAMES_ORDER } from '@/lib/ziwei/constants';
import { getLiuNianSiHua, getYearBranchIndex } from '@/lib/ziwei/sihua';
import { getXiaoXianBranch } from '@/lib/ziwei/xiaoxian';

type Message = { role: 'user' | 'assistant'; content: string };
type Fields = Record<string, unknown>;

const maxBodyBytes = 128 * 1024;
const systemPrompt = '你是一位紫微斗数文化解读助手。用简体中文，先给出简要结论，再分点说明对应宫位、星曜和四化。以给出的排盘数据为准，区分命盘事实与传统解释，不编造缺失的信息、古籍引文或师承。分析某年时，优先使用本轮附带的农历流年资料，明确写出年份，并区分本命宫、流年宫和小限宫。如果用户问的是另一年，提醒在命盘上切换到对应年份再提问。把命理解读作为文化参考，不做确定性的健康、投资或人生预测。';

function object(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Fields
    : {};
}

function select(value: unknown, keys: string[]): Fields {
  const fields = object(value);
  return Object.fromEntries(keys.flatMap(key =>
    ['string', 'number', 'boolean'].includes(typeof fields[key]) ? [[key, fields[key]]] : [],
  ));
}

function chartContext(input: unknown) {
  const chart = object(input);
  if (!Array.isArray(chart.palaces) || chart.palaces.length !== 12) return null;
  const palaces = chart.palaces.map(input => {
    const palace = object(input);
    const { name, branch, stars } = palace;
    if (typeof name !== 'string' || typeof branch !== 'number' || !Number.isInteger(branch)
      || branch < 0 || branch > 11 || !Array.isArray(stars)) return null;
    return {
      ...select(palace, ['stem', 'isMingGong', 'isShenGong', 'isCurrentDaXian', 'borrowedFromName']),
      name,
      branch,
      stars: stars.slice(0, 100).map(star => select(star, ['name', 'type', 'siHua', 'brightnessRaw'])),
      selfSihua: Array.isArray(palace.selfSihua)
        ? palace.selfSihua.slice(0, 12).map(mark => select(mark, ['starName', 'siHua']))
        : [],
    };
  });
  if (palaces.includes(null)) return null;
  return {
    ...select(chart, ['wuxingJuName', 'mingZhu', 'shenZhu', 'yinYangGender', 'currentAge', 'currentDaXianIndex']),
    palaces: palaces.filter(palace => palace !== null),
    daXians: Array.isArray(chart.daXians) ? chart.daXians.slice(0, 12).map(input => {
      const period = object(input);
      const fields = select(period, ['startAge', 'endAge', 'palaceName', 'palaceBranch', 'stemName']);
      fields.siHua = select(period.siHua, ['lu', 'quan', 'ke', 'ji']);
      return fields;
    }) : [],
  };
}

function annualContext(input: unknown, chart: NonNullable<ReturnType<typeof chartContext>>, year: number) {
  const { birthInfo, lunarInfo } = object(input);
  const { lunarYear, yearBranch } = object(lunarInfo);
  const { gender } = object(birthInfo);
  if (typeof lunarYear !== 'number' || !Number.isInteger(lunarYear)) return { 年份: year, 说明: '缺少农历生年' };
  const age = year - lunarYear + 1;
  if (age < 1) return { 年份: year, 说明: '所选农历年份早于出生年' };

  const annualBranch = getYearBranchIndex(year);
  const { stemName, transforms } = getLiuNianSiHua(year);
  const palaces = PALACE_NAMES_ORDER.map((name, offset) => {
    const branch = (annualBranch - offset + 12) % 12;
    return { 流年宫: name, 地支: BRANCHES[branch], 本命宫: chart.palaces.find(p => p.branch === branch)?.name };
  });
  const smallBranch = typeof yearBranch === 'number' && Number.isInteger(yearBranch)
    && yearBranch >= 0 && yearBranch < 12 && (gender === 'male' || gender === 'female')
    ? getXiaoXianBranch(yearBranch, age, gender)
    : null;
  const decade = chart.daXians.find(period =>
    typeof period.startAge === 'number' && typeof period.endAge === 'number'
    && age >= period.startAge && age <= period.endAge,
  );

  return {
    农历年份: year,
    流年干支: stemName + BRANCHES[annualBranch],
    虚岁: age,
    所属大限: decade ?? null,
    流年十二宫: palaces,
    流年四化: Object.entries(transforms).map(([transform, star]) => ({
      四化: `化${transform}`,
      星曜: star,
      落宫: chart.palaces.filter(p => p.stars.some(s => s.name === star)).map(p => ({
        本命宫: p.name,
        流年宫: palaces[(annualBranch - p.branch + 12) % 12].流年宫,
      })),
    })),
    小限: smallBranch === null ? null : {
      地支: BRANCHES[smallBranch],
      本命宫: chart.palaces.find(p => p.branch === smallBranch)?.name,
    },
  };
}

async function readInput(request: Request): Promise<Fields> {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        throw new RangeError('Request body too large');
      }
      body += decoder.decode(value, { stream: true });
    }
    return object(JSON.parse(body + decoder.decode()));
  } finally {
    reader.releaseLock();
  }
}

function messagesFor(input: Fields, mode: 'interpret' | 'heming'): Message[] | null {
  if (mode === 'heming') {
    const chartA = chartContext(input.chartA);
    const chartB = chartContext(input.chartB);
    if (!chartA || !chartB) return null;
    const question = typeof input.question === 'string' ? input.question.slice(0, 4000) : '';
    return [{
      role: 'user',
      content: `以甲、乙分别说明两张盘的关系倾向，再分析互动优势、分歧和沟通建议。问题：${question || '请做整体合盘分析。'}\n甲：${JSON.stringify(chartA)}\n乙：${JSON.stringify(chartB)}`,
    }];
  }

  const chart = chartContext(input.chart);
  if (!chart || !Array.isArray(input.messages)) return null;
  const messages = input.messages.slice(-12).flatMap(value => {
    const { role, content } = object(value);
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      return [{ role, content: content.slice(0, 8000) } satisfies Message];
    }
    return [];
  });
  if (messages.at(-1)?.role !== 'user') return null;
  const firstUser = messages.findIndex(message => message.role === 'user');
  const history = messages.slice(firstUser);
  history[0].content = `以下是本轮解读的命盘资料：\n${JSON.stringify(chart)}\n\n用户问题：${history[0].content}`;
  const year = input.analysisYear;
  if (typeof year === 'number' && Number.isInteger(year) && year >= 1 && year <= 9999) {
    const latest = history[history.length - 1];
    latest.content += `\n\n本轮所选农历流年资料：\n${JSON.stringify(annualContext(input.chart, chart, year))}`;
  }
  return history;
}

export async function analyze(request: Request, mode: 'interpret' | 'heming') {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  const accessCode = process.env.AI_ACCESS_CODE?.trim();
  if (!key || !accessCode) {
    return Response.json({ error: '请先在服务器配置 DeepSeek 密钥和 AI 访问码。' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-ai-access-code') ?? '');
  const expected = Buffer.from(accessCode);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return Response.json({ error: 'AI 访问码有误，请重新输入。' }, { status: 403 });
  }

  let input: Fields;
  try {
    input = await readInput(request);
  } catch (error) {
    return Response.json({ error: '请求过大或格式无效。' }, { status: error instanceof RangeError ? 413 : 400 });
  }
  const messages = messagesFor(input, mode);
  if (!messages) return Response.json({ error: '请提供完整命盘和有效问题。' }, { status: 400 });

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        thinking: { type: 'disabled' },
        max_tokens: 2500,
        stream: false,
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
    });
    if (!response.ok) {
      const error = response.status === 429
        ? 'AI 服务暂时繁忙，请稍后重试。'
        : 'AI 服务请求失败，请检查服务器上的 DeepSeek 配置和账户余额。';
      return Response.json({ error }, { status: 502 });
    }
    const result = await response.json();
    const content: unknown = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return Response.json({ error: 'AI 没有返回可显示的解读。' }, { status: 502 });
    }
    return new Response(`data: ${JSON.stringify({ delta: { text: content } })}\n\ndata: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: '暂时无法连接 AI 服务，请稍后重试。' }, { status: 502 });
  }
}
