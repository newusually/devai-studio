/* ============================================================================
 * renderer/components/SessionList.tsx —— 会话列表
 * ========================================================================== */
import React, { useState } from 'react';

interface Props {
  sessions: any[];
  currentId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export default function SessionList({ sessions, currentId, onSelect, onDelete, onRename }: Props) {
  const [editing, setEditing] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  const startEdit = (s: any) => {
    setEditing(s.id);
    setDraft(s.title);
  };

  const commit = (id: string) => {
    if (draft.trim()) onRename(id, draft.trim());
    setEditing('');
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter(s =>
        (s.title || '').toLowerCase().includes(q) ||
        (s.preview || '').toLowerCase().includes(q))
    : sessions;

  return (
    <div className="sess">
      <div className="sess-head">
        历史会话 ({sessions.length})
        <input
          className="sess-search"
          placeholder="搜索历史…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
      </div>
      <div className="sess-list">
        {sessions.length === 0 && <div className="sess-empty">还没有会话</div>}
        {sessions.length > 0 && filtered.length === 0 && (
          <div className="sess-empty">没有匹配「{query}」的会话</div>
        )}
        {filtered.map(s => (
          <div
            key={s.id}
            className={`sess-item ${s.id === currentId ? 'on' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="sess-title" onDoubleClick={() => startEdit(s)}>
              {editing === s.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={() => commit(s.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commit(s.id);
                    if (e.key === 'Escape') setEditing('');
                  }}
                  onClick={e => e.stopPropagation()}
                  className="sess-input"
                />
              ) : (
                <>
                  <span className="sess-name">{s.title}</span>
                  <span className="sess-count">{s.messageCount}</span>
                </>
              )}
            </div>
            {s.preview && <div className="sess-preview">{s.preview.slice(0, 46)}</div>}
            <div className="sess-time">
              {new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </div>
            <button
              className="sess-del"
              title="删除会话"
              onClick={async (e) => {
                e.stopPropagation();
                if (confirm(`删除会话「${s.title}」？此操作不可恢复。`)) onDelete(s.id);
              }}
            >✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
