const accessCodeKey = 'ziwei.aiAccessCode';

export async function requestAnalysis(path: string, body: unknown): Promise<Response> {
  const saved = sessionStorage.getItem(accessCodeKey);
  const code = (saved ?? window.prompt('请输入 AI 访问码（由站点管理员设置）'))?.trim();
  if (!code) throw new Error('输入 AI 访问码后即可使用解读。');
  if (!/^[\x21-\x7e]+$/.test(code)) throw new Error('AI 访问码只能包含英文字母、数字和英文符号。');

  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AI-Access-Code': code },
    body: JSON.stringify(body),
  });
  if (response.status === 403) sessionStorage.removeItem(accessCodeKey);
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(typeof details?.error === 'string' ? details.error : 'AI 解读暂时不可用，请稍后重试。');
  }
  sessionStorage.setItem(accessCodeKey, code);
  return response;
}
