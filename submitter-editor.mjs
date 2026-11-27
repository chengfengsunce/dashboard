const storageKey = 'dashboard-submitter-edits-v1';

export function createSubmitterEditor({ dialog, apiBaseUrl, storage, onSaved, fetchImpl = globalThis.fetch }) {
  const input = dialog.querySelector('input[name="submitter"]');
  const note = dialog.querySelector('[role="status"]');
  const save = dialog.querySelector('[type="submit"]');
  const close = dialog.querySelector('[data-close-submitter]');
  const reload = dialog.querySelector('[data-reload-submitter]');
  const pending = new Map();
  let target = null;
  let revision = null;
  let requestId = 0;
  let saving = false;
  try {
    for (const [key, value] of JSON.parse(storage?.getItem(storageKey) || '[]')) {
      if (/^chengfengsunce\/[a-zA-Z0-9_.-]+#[1-9][0-9]*$/.test(key)
        && typeof value?.submitter === 'string' && value.submitter.length <= 60
        && Number.isFinite(Date.parse(value.updated_at))) pending.set(key, value);
    }
  } catch {}

  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify([...pending])); } catch {}
  }

  function route() {
    return new URL(`/api/issues/${target.repo_full_name}/${target.number}/submitter`, apiBaseUrl);
  }

  async function readCurrent() {
    if (!target || saving) return;
    const currentRequest = ++requestId;
    revision = null;
    input.disabled = true;
    save.disabled = true;
    reload.hidden = true;
    note.textContent = '正在读取最新姓名…';
    try {
      const response = await fetchImpl(route(), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!dialog.open || requestId !== currentRequest) return;
      if (!response.ok) throw new Error(result.error || '无法读取姓名，请稍后重试。');
      if (typeof result.submitter !== 'string' || !/^[0-9a-f]{64}$/.test(result.revision || '')) throw new Error('姓名读取不完整，请重新读取。');
      revision = result.revision;
      input.value = result.submitter;
      input.disabled = false;
      save.disabled = false;
      note.textContent = '';
      input.focus();
      input.select();
    } catch (error) {
      if (!dialog.open || requestId !== currentRequest) return;
      note.textContent = error.message || '无法读取姓名，请稍后重试。';
      reload.hidden = false;
    }
  }

  close.addEventListener('click', () => { if (!saving) dialog.close(); });
  reload.addEventListener('click', readCurrent);
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    const key = target && `${target.repo_full_name}#${target.number}`;
    requestId += 1;
    target = null;
    revision = null;
    [...document.querySelectorAll('[data-edit-submitter]')].find(button => button.dataset.editSubmitter === key)?.focus();
  });
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !target || revision === null) return;
    const submitter = input.value.trim();
    if (!submitter || submitter.length > 60 || /[<>\r\n]/.test(submitter)) {
      note.textContent = '请填写不超过60字的提出人姓名。';
      return;
    }
    saving = true;
    input.disabled = true;
    save.disabled = true;
    close.disabled = true;
    reload.hidden = true;
    note.textContent = '正在保存…';
    try {
      const response = await fetchImpl(route(), { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submitter, revision }), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) { revision = null; save.disabled = true; }
        throw new Error(result.error || '保存失败，请稍后重试。');
      }
      if (result.submitter !== submitter || !Number.isFinite(Date.parse(result.updated_at))) throw new Error('保存结果未确认，请重新读取后核对。');
      const key = `${target.repo_full_name}#${target.number}`;
      pending.set(key, { submitter: result.submitter, updated_at: result.updated_at });
      persist();
      onSaved(key, result);
      dialog.close();
    } catch (error) {
      note.textContent = error instanceof TypeError || error instanceof SyntaxError || error.name === 'TimeoutError'
        ? '保存结果未确认，输入已保留，请重新读取后核对。' : error.message || '保存失败，请稍后重试。';
      reload.hidden = false;
    } finally {
      saving = false;
      input.disabled = false;
      save.disabled = revision === null;
      close.disabled = false;
    }
  });

  return {
    open(issue) {
      if (saving) return;
      target = { repo_full_name: issue.repo_full_name || 'chengfengsunce/dashboard', number: issue.number || String(issue.id || '').split(':').pop() };
      dialog.querySelector('[data-submitter-title]').textContent = issue.title;
      input.value = issue.submitter || '';
      dialog.showModal();
      readCurrent();
    },
    normalize(issue, key, sourceUpdatedAt = issue.updated_at) {
      const saved = pending.get(key);
      if (!saved) return issue;
      if (Date.parse(sourceUpdatedAt) >= Date.parse(saved.updated_at)) {
        pending.delete(key);
        persist();
        return issue;
      }
      return { ...issue, submitter: saved.submitter };
    },
  };
}
