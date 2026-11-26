const storageKey = 'dashboard-completion-drafts-v1';

export function createCompletionDraftStore({ apiBaseUrl, storage, fetchImpl = globalThis.fetch,
  onChange = () => {}, debounceMs = 1200 }) {
  const records = new Map();
  const timers = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (/^chengfengsunce\/[a-zA-Z0-9_.-]+#[1-9][0-9]*$/.test(key)
        && typeof value?.summary === 'string' && value.summary.length <= 500) {
        records.set(key, { summary: value.summary, revision: typeof value.revision === 'string' ? value.revision : null,
          dirty: value.dirty === true, version: 0, status: value.dirty ? 'local' : 'saved', localSaved: true });
      }
    }
  } catch {}

  function recordFor(key, fallback = '') {
    if (!records.has(key)) records.set(key, { summary: fallback, revision: null, dirty: false,
      version: 0, status: 'idle', localSaved: false });
    return records.get(key);
  }

  function persist(record) {
    try {
      storage?.setItem(storageKey, JSON.stringify(Object.fromEntries([...records].map(([key, value]) =>
        [key, { summary: value.summary, revision: value.revision, dirty: value.dirty }]))));
      record.localSaved = Boolean(storage);
    } catch { record.localSaved = false; }
  }

  function changed(key) {
    const record = recordFor(key);
    onChange(key, { summary: record.summary, dirty: record.dirty, status: record.status, localSaved: record.localSaved });
  }

  function urlFor(key) {
    const match = key.match(/^(chengfengsunce\/[a-zA-Z0-9_.-]+)#([1-9][0-9]*)$/);
    if (!match) throw new Error('需求编号无效。');
    return new URL(`/api/issues/${match[1]}/${match[2]}/completion-draft`, apiBaseUrl);
  }

  async function responseDraft(response) {
    const payload = await response.json();
    if (response.status === 409) return { ...payload, conflict: true };
    if (!response.ok) throw new Error(payload.error || '云端草稿暂未保存。');
    if (typeof payload.completion_summary !== 'string' || typeof payload.revision !== 'string') {
      throw new Error('草稿返回内容不完整。');
    }
    return payload;
  }

  function schedule(key) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); save(key); }, debounceMs));
  }

  async function load(key, fallback = '') {
    const record = recordFor(key, fallback);
    if (record.loading) return record.loading;
    if (record.writing) return record.writing;
    if (!record.dirty) { record.status = 'loading'; changed(key); }
    record.loading = (async () => {
      try {
        const remote = await responseDraft(await fetchImpl(urlFor(key), { cache: 'no-store', signal: AbortSignal.timeout(12000) }));
        if (records.get(key) !== record) return;
        if (record.dirty && record.summary !== remote.completion_summary) {
          if (record.revision !== null && record.revision !== remote.revision) record.status = 'conflict';
          else { record.revision = remote.revision; record.status = 'local'; }
        } else {
          record.summary = remote.completion_summary;
          record.revision = remote.revision;
          record.dirty = false;
          record.status = 'saved';
        }
        persist(record);
        changed(key);
      } catch {
        record.status = 'error';
        changed(key);
      } finally { record.loading = null; }
    })();
    return record.loading;
  }

  async function save(key) {
    const record = recordFor(key);
    if (record.writing) return record.writing;
    if (!record.dirty || record.status === 'conflict') return;
    if (record.loading) await record.loading;
    if (record.revision === null) await load(key);
    if (record.writing) return record.writing;
    if (!record.dirty || record.revision === null || record.status === 'conflict') return;
    const version = record.version;
    const summary = record.summary;
    record.status = 'saving';
    changed(key);
    record.writing = (async () => {
      try {
        const remote = await responseDraft(await fetchImpl(urlFor(key), { method: 'PUT', keepalive: true, signal: AbortSignal.timeout(12000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completion_summary: summary, revision: record.revision }) }));
        if (records.get(key) !== record) return;
        if (remote.conflict) {
          record.status = 'conflict';
        } else {
          record.revision = remote.revision;
          if (record.version === version) {
            record.summary = remote.completion_summary;
            record.dirty = false;
            record.status = 'saved';
          } else {
            record.status = 'local';
            schedule(key);
          }
        }
        persist(record);
        changed(key);
      } catch {
        record.status = 'error';
        changed(key);
      } finally { record.writing = null; }
    })();
    return record.writing;
  }

  return {
    value(key, fallback = '') { return recordFor(key, fallback).summary; },
    state(key) { const record = recordFor(key); return { status: record.status, dirty: record.dirty }; },
    load,
    update(key, summary) {
      const record = recordFor(key);
      record.summary = summary;
      record.version += 1;
      record.dirty = true;
      record.status = 'local';
      persist(record);
      changed(key);
      schedule(key);
    },
    async flush(keys = [...records.keys()]) {
      await Promise.all(keys.map(async key => {
        clearTimeout(timers.get(key));
        timers.delete(key);
        await save(key);
      }));
    },
    async retry(key) {
      const record = recordFor(key);
      if (!record.dirty) return load(key);
      const replace = record.status === 'conflict';
      try {
        const remote = await responseDraft(await fetchImpl(urlFor(key), { cache: 'no-store', signal: AbortSignal.timeout(12000) }));
        if (!replace && record.revision !== null && record.revision !== remote.revision && record.summary !== remote.completion_summary) {
          record.status = 'conflict';
          changed(key);
          return;
        }
        record.revision = remote.revision;
        record.status = 'local';
        await save(key);
      } catch { record.status = 'error'; changed(key); }
    },
    forget(key) {
      clearTimeout(timers.get(key));
      timers.delete(key);
      const record = recordFor(key);
      records.delete(key);
      persist(record);
    },
    dispose() { timers.forEach(clearTimeout); timers.clear(); },
  };
}
