window.__ModuleLoader__.load({
  id: 'dsh-antigravity-acp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    // ------------------------------------------------ 工具
    function e2(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fallthrough */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    }

    /** 调宿主 API（GET + query，webServer 只支持 GET/HEAD） */
    async function api(path, payload) {
      const url = new URL('/antigravity/api/' + path, window.location.origin);
      if (payload) {
        for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, String(v));
      }
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      return res.json();
    }

    // ------------------------------------------------ 图标
    function IconAntigravity({ size }) {
      return h('svg', {
        viewBox: '0 0 64 64', width: size ?? 20, height: size ?? 20,
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: 'M32 14 L44 34 H37 V50 H27 V34 H20 Z', fill: 'currentColor', opacity: 0.9 }),
        h('rect', { x: 18, y: 55, width: 12, height: 2.5, rx: 1.25, fill: 'currentColor', opacity: 0.5 }),
        h('rect', { x: 34, y: 55, width: 12, height: 2.5, rx: 1.25, fill: 'currentColor', opacity: 0.5 }),
      );
    }

    // ------------------------------------------------ 样式（hover/focus 等 inline style 表达不了的状态）
    const CSS = [
      '.agy-btn { transition: background-color .15s ease, border-color .15s ease, opacity .15s ease; }',
      '.agy-btn:hover:not(:disabled) { background: rgba(128,128,128,.10); }',
      '.agy-btn.agy-primary:hover:not(:disabled) { opacity: .88; }',
      '.agy-btn:focus-visible { outline: 2px solid var(--dsh-accent, #4285f4); outline-offset: 1px; }',
      '.agy-select:focus-visible, .agy-input:focus-visible { outline: none; border-color: var(--dsh-accent, #4285f4); }',
      '.agy-toggle:focus-visible { outline: 2px solid var(--dsh-accent, #4285f4); outline-offset: 2px; }',
    ].join('\n')
    if (typeof document !== 'undefined' && !document.getElementById('agy-acp-style')) {
      const style = document.createElement('style')
      style.id = 'agy-acp-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ------------------------------------------------ 通用组件
    function Row({ label, hint, children }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 0', borderBottom: '1px solid rgba(128,128,128,.15)',
        },
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontWeight: 500, fontSize: 13 } }, label),
          hint && h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2, whiteSpace: 'pre-wrap' } }, hint),
        ),
        h('div', { style: { flexShrink: 0 } }, children),
      );
    }

    function Select({ value, options, onChange, disabled }) {
      return h('select', {
        value, disabled, className: 'agy-select',
        onChange: (ev) => onChange(ev.target.value),
        style: {
          padding: '6px 10px', borderRadius: 8, maxWidth: 260, fontSize: 13,
          border: '1px solid rgba(128,128,128,.25)',
          background: 'transparent', color: 'inherit',
        },
      }, options.map((o) => h('option', { key: o.value, value: o.value }, o.label)));
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('button', {
        role: 'switch', 'aria-checked': checked, disabled, className: 'agy-toggle',
        onClick: () => onChange(!checked),
        style: {
          width: 36, height: 20, borderRadius: 10, border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: checked ? 'var(--dsh-accent, #4285f4)' : 'rgba(128,128,128,.35)',
          position: 'relative', transition: 'background .15s ease', padding: 0,
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
          borderRadius: 8, background: '#fff', transition: 'left .15s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,.2)', display: 'block',
        },
      }));
    }

    function Btn({ onClick, children, primary, disabled, busy, title }) {
      return h('button', {
        onClick, disabled: disabled || busy, title,
        className: 'agy-btn' + (primary ? ' agy-primary' : ''),
        style: {
          padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
          border: primary ? '1px solid transparent' : '1px solid rgba(128,128,128,.3)',
          background: primary ? 'var(--dsh-accent, #4285f4)' : 'transparent',
          color: primary ? '#fff' : 'inherit', opacity: disabled || busy ? 0.55 : 1,
        },
      }, busy ? '…' : children);
    }

    function Badge({ tone = 'info', children }) {
      const color = { ok: '#34a853', warn: '#f9ab00', err: '#ea4335', info: '#4285f4' }[tone];
      return h('span', {
        style: {
          display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 12,
          background: color + '1a', color, border: '1px solid ' + color + '44',
        },
      }, children);
    }

    function Bar({ percent }) {
      const p = Math.max(2, Math.min(100, percent));
      const color = percent > 40 ? '#34a853' : percent > 15 ? '#f9ab00' : '#ea4335';
      return h('div', {
        style: { height: 6, borderRadius: 3, marginTop: 6, background: 'rgba(128,128,128,.18)', overflow: 'hidden' },
      }, h('div', {
        style: { height: '100%', width: p + '%', background: color, transition: 'width .3s ease' },
      }));
    }

    // ------------------------------------------------ 主面板
    function AntigravitySection() {
      const [status, setStatus] = useState({ phase: 'loading' });
      const [usage, setUsage] = useState({ phase: 'idle' });
      const [cfg, setCfg] = useState(null);          // 宿主回传的当前配置
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState(null);
      const [proxyEdit, setProxyEdit] = useState(false);
      const [proxyDraft, setProxyDraft] = useState('');
      const [diag, setDiag] = useState({ phase: 'idle', output: '' });
      const [copied, setCopied] = useState(false);

      const refresh = useCallback(async () => {
        setStatus({ phase: 'loading' });
        try {
          const st = await api('status');
          setStatus({ phase: 'ok', ...st });
          if (st.config) setCfg(st.config);
        } catch (err) {
          setStatus({ phase: 'error', message: String(err?.message ?? err) });
        }
      }, []);

      const fetchUsage = useCallback(async () => {
        setUsage({ phase: 'loading' });
        try {
          const u = await api('usage');
          setUsage({ phase: 'ok', ...u });
        } catch (err) {
          setUsage({ phase: 'error', message: String(err?.message ?? err) });
        }
      }, []);

      const runDiag = useCallback(async (kind) => {
        setDiag({ phase: 'loading', output: '' });
        try {
          const r = await api('diag', { kind });
          setDiag({ phase: 'ok', output: r.output ?? '' });
        } catch (err) {
          setDiag({ phase: 'error', output: String(err?.message ?? err) });
        }
      }, []);

      const patch = useCallback(async (p) => {
        setSaving(true);
        setMsg(null);
        try {
          await api('config', p);
          setMsg({ ok: true, text: '已保存，插件重启后生效（几秒内自动重载）' });
          setTimeout(() => setMsg(null), 4000);
          refresh();
        } catch (err) {
          setMsg({ ok: false, text: '保存失败: ' + String(err?.message ?? err) });
        } finally {
          setSaving(false);
        }
      }, [refresh]);

      useEffect(() => { refresh(); }, [refresh]);

      const st = status.phase === 'ok' ? status : null;
      const cfgProxy = cfg?.proxy || '';

      return h('div', { style: { padding: '4px 0', maxWidth: 680, fontSize: 13 } },

        // 头
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 8px' } },
          h('span', { style: { color: 'var(--dsh-accent, #4285f4)', display: 'flex' } }, h(IconAntigravity, { size: 24 })),
          h('div', null,
            h('div', { style: { fontWeight: 500, fontSize: 15 } }, 'Antigravity (ACP)'),
            h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } },
              '官方 agy acp 桥接 · 单账号 · 仅 Gemini 白名单 · 凭据由 agy 自管'),
          ),
        ),

        // ---------- 合规徽章行（呼应仓库 FAQ） ----------
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 } }, [
          ['官方协议', 'ok'], ['真实身份', 'ok'], ['凭据隔离', 'ok'], ['单账号', 'ok'], ['模型白名单', 'ok'],
        ].map(([label, tone]) => h(Badge, { key: label, tone }, label))),

        // ---------- 状态卡 ----------
        h('div', {
          style: {
            border: '1px solid rgba(128,128,128,.2)', borderRadius: 12,
            padding: '4px 16px', margin: '8px 0 12px',
          },
        },
          status.phase === 'loading' && h('div', { style: { opacity: 0.6, padding: '12px 0' } }, '正在读取'),
          status.phase === 'error' && h('div', { style: { color: '#ea4335', padding: '12px 0' } }, '状态读取失败: ' + e2(status.message)),
          st && h('div', null,
            h(Row, { label: 'agy 二进制', hint: st.command || null },
              st.binaryExists
                ? h(Badge, { tone: 'ok' }, '已找到' + (st.version ? ' · v' + e2(st.version) : ''))
                : h(Badge, { tone: 'err' }, '未找到'),
            ),
            h(Row, { label: '登录状态', hint: '凭据在 Windows 凭据管理器（gemini:antigravity）' },
              st.loggedIn === true ? h(Badge, { tone: 'ok' }, '已登录')
                : st.loggedIn === false ? h(Badge, { tone: 'err' }, '未登录')
                : h(Badge, { tone: 'warn' }, '首次对话时确认'),
            ),
            h(Row, { label: '可用模型', hint: '已按合规白名单过滤（仅 Gemini）' },
              h('span', { style: { fontSize: 13, opacity: 0.8 } },
                st.models?.length
                  ? st.models.length + ' 个 · ' + e2(st.models.slice(0, 3).map((m) => m.id).join(', '))
                    + (st.models.length > 3 ? ' 等' : '')
                  : '首次对话时发现'),
            ),
            h(Row, { label: '代理', hint: 'agy 是 Go 程序，不读系统代理，必须显式配置' },
              cfgProxy ? h(Badge, { tone: 'ok' }, e2(cfgProxy)) : h(Badge, { tone: 'warn' }, '未配置（直连）'),
            ),
          ),
        ),

        h('div', { style: { display: 'flex', gap: 8, marginBottom: 16 } },
          h(Btn, { onClick: refresh, busy: status.phase === 'loading' }, '刷新状态'),
          h(Btn, { onClick: fetchUsage, busy: usage.phase === 'loading' }, '查询额度'),
        ),

        // ---------- 额度 ----------
        usage.phase !== 'idle' && h('div', {
          style: {
            border: '1px solid rgba(128,128,128,.2)', borderRadius: 12,
            padding: '12px 16px', margin: '0 0 16px',
          },
        },
          usage.phase === 'loading' && h('div', { style: { opacity: 0.6, padding: '4px 0' } }, '查询中（走 agy，不耗模型额度）'),
          usage.phase === 'error' && h('div', { style: { color: '#ea4335', padding: '4px 0' } }, '查询失败: ' + e2(usage.message)),
          usage.phase === 'ok' && h('div', null,
            h('div', { style: { fontWeight: 500, marginBottom: 10 } }, '套餐额度'),
            (usage.groups ?? []).map((g, i) => h('div', { key: i, style: { marginBottom: 12, ...(i === (usage.groups?.length ?? 0) - 1 ? { marginBottom: 4 } : {}) } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 2 } },
                h('span', { style: { fontWeight: 500 } }, e2(g.label ?? g.name ?? '额度')),
                h('span', { style: { opacity: 0.6, fontVariantNumeric: 'tabular-nums' } },
                  e2(g.detail ?? '') + (g.resetText ? ' · ' + e2(g.resetText) : '')),
              ),
              g.percent != null && h(Bar, { percent: g.percent }),
            )),
            !(usage.groups ?? []).length && h('div', { style: { opacity: 0.6, fontSize: 13, padding: '4px 0' } },
              '上游未返回额度明细（免费套餐或该接口不可用时常见）'),
          ),
        ),

        // ---------- 行为 ----------
        h('div', { style: { fontWeight: 500, margin: '8px 0 4px' } }, '行为配置'),
        cfg && h('div', null,
          h(Row, {
            label: '权限模式',
            hint: 'supervised：每次工具操作弹窗询问（默认，最安全）\nauto：自动批准工具操作\nfull-access：完全放行（不推荐）',
          },
            h(Select, {
              value: cfg.permissionMode ?? 'supervised',
              disabled: saving,
              options: [
                { value: 'supervised', label: 'supervised · 逐次询问' },
                { value: 'auto', label: 'auto · 自动批准' },
                { value: 'full-access', label: 'full-access · 完全放行' },
              ],
              onChange: (v) => patch({ permissionMode: v }),
            }),
          ),
          h(Row, { label: '显示工具活动', hint: '把 agy 的工具调用写进对话流' },
            h(Toggle, {
              checked: cfg.showToolActivity !== false,
              disabled: saving,
              onChange: (v) => patch({ showToolActivity: v }),
            }),
          ),
          h(Row, { label: 'System 提示清洗', hint: '剥掉 DSH 工具描述，防止 Antigravity 误认领它调不到的工具（推荐开启）' },
            h(Toggle, {
              checked: cfg.sanitizeSystemPrompt !== false,
              disabled: saving,
              onChange: (v) => patch({ sanitizeSystemPrompt: v }),
            }),
          ),
          h(Row, { label: '代理地址', hint: '保存后写入插件配置并重启插件' },
            proxyEdit
              ? h('span', { style: { display: 'flex', gap: 8 } },
                  h('input', {
                    value: proxyDraft, className: 'agy-input',
                    placeholder: 'http://127.0.0.1:17890',
                    onChange: (ev) => setProxyDraft(ev.target.value),
                    style: {
                      width: 210, padding: '6px 10px', borderRadius: 8, fontSize: 13,
                      border: '1px solid rgba(128,128,128,.25)', background: 'transparent', color: 'inherit',
                    },
                  }),
                  h(Btn, {
                    primary: true, disabled: saving,
                    onClick: async () => {
                      await patch({ proxy: proxyDraft.trim() });
                      setProxyEdit(false);
                    },
                  }, '保存'),
                  h(Btn, { onClick: () => setProxyEdit(false) }, '取消'),
                )
              : h(Btn, {
                  onClick: () => { setProxyDraft(cfgProxy); setProxyEdit(true); },
                }, '修改'),
          ),
        ),

        msg && h('div', {
          style: {
            margin: '12px 0', padding: '8px 12px', borderRadius: 8, fontSize: 13,
            border: '1px solid ' + (msg.ok ? 'rgba(52,168,83,.35)' : 'rgba(234,67,53,.35)'),
            background: msg.ok ? 'rgba(52,168,83,.08)' : 'rgba(234,67,53,.08)',
            color: msg.ok ? '#34a853' : '#ea4335',
          },
        }, e2(msg.text)),

        // ---------- 诊断 ----------
        h('div', {
          style: {
            border: '1px solid rgba(128,128,128,.2)', borderRadius: 12,
            padding: '12px 16px', margin: '16px 0',
          },
        },
          h('div', { style: { fontWeight: 500, marginBottom: 10 } }, '诊断'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
            h(Btn, { onClick: () => runDiag('proxy'), busy: diag.phase === 'loading' },
              '测代理连通性'),
            h(Btn, { onClick: () => runDiag('login'), busy: diag.phase === 'loading' },
              '测 agy 登录'),
            st?.proxy && h(Btn, {
              onClick: async () => {
                const ok = await copyText('curl.exe -x ' + st.proxy + ' -s -o NUL -w "%{http_code}" -X POST https://oauth2.googleapis.com/token');
                if (ok) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }
              },
              title: '把代理连通性测试命令复制到剪贴板，在终端粘贴执行。输出 400 说明链路可达，000 说明代理不通',
            }, copied ? '已复制' : '复制 curl 命令'),
          ),
          diag.phase !== 'idle' && h('pre', {
            style: {
              margin: 0, padding: '10px 12px', borderRadius: 8, fontSize: 12,
              background: 'rgba(128,128,128,.1)', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', maxHeight: 160, overflow: 'auto',
              fontFamily: 'Consolas, monospace', fontVariantNumeric: 'tabular-nums',
            },
          },
            diag.phase === 'loading' ? '执行中'
              : diag.phase === 'error' ? '错误: ' + diag.output
              : (diag.output || '（无输出）')),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置菜单里的「Antigravity (ACP)」选项卡
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'antigravity-acp',
          order: 260,
          label: () => 'Antigravity (ACP)',
        }, AntigravitySection));
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'antigravity-acp',
          order: 260,
          label: () => 'Antigravity (ACP)',
        }, ({ size }) => h(IconAntigravity, { size })));
      },
    };
  },
});
