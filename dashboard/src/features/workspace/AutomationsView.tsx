import React from 'react';
import { Check, Copy, Plus, Workflow } from 'lucide-react';

type AutomationsViewProps = {
    workflows: any[];
    profileId: string | null;
    sessionToken: string | null;
    apiBaseUrl: string;
    onOpenBuilder: (workflowId: string | null) => void;
    onCreateWorkflow: () => void;
    onToggleWorkflowEnabled: (workflowId: string, nextEnabled: boolean) => void;
    onCopyWorkflow: (workflowId: string) => void;
};

export default function AutomationsView({
    workflows,
    profileId,
    sessionToken,
    apiBaseUrl,
    onOpenBuilder,
    onCreateWorkflow,
    onToggleWorkflowEnabled,
    onCopyWorkflow
}: AutomationsViewProps) {
    const lastActionAtRef = React.useRef(0);
    const [fallbackConfig, setFallbackConfig] = React.useState<{
        text: string;
        limit: number | '';
    }>({
        text: '',
        limit: 3
    });
    const [fallbackLoading, setFallbackLoading] = React.useState(false);
    const [fallbackSaving, setFallbackSaving] = React.useState(false);
    const [fallbackError, setFallbackError] = React.useState<string | null>(null);
    const [fallbackNotice, setFallbackNotice] = React.useState<string | null>(null);

    const getWorkflowId = (value: unknown): string => {
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return '';
    };
    const getWorkflowName = (value: unknown): string => {
        if (typeof value === 'string') return value.trim();
        return '';
    };

    const runOncePerTap = (fn: () => void) => {
        const now = Date.now();
        if (now - lastActionAtRef.current < 220) return;
        lastActionAtRef.current = now;
        fn();
    };

    const bindOpenHandlers = (fn: () => void) => ({
        onClick: () => runOncePerTap(fn),
        onMouseDown: () => runOncePerTap(fn),
        onTouchStart: () => runOncePerTap(fn)
    });

    const canManageFallback = Boolean(profileId && sessionToken);

    const fetchFallbackSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setFallbackLoading(true);
        setFallbackError(null);
        setFallbackNotice(null);
        fetch(`${apiBaseUrl}/api/company/fallback-settings?profileId=${encodeURIComponent(profileId)}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Fallback settings fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const cfg = data?.data || {};
                    setFallbackConfig({
                        text: typeof cfg.fallback_text === 'string' ? cfg.fallback_text : '',
                        limit: typeof cfg.fallback_limit === 'number' ? cfg.fallback_limit : 3
                    });
                } else {
                    setFallbackError(data?.error || 'Failed to load fallback settings');
                }
            })
            .finally(() => setFallbackLoading(false));
    }, [apiBaseUrl, profileId, sessionToken]);

    const handleSaveFallbackSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setFallbackSaving(true);
        setFallbackError(null);
        setFallbackNotice(null);
        const payload = {
            fallback_text: fallbackConfig.text,
            fallback_limit: fallbackConfig.limit === '' ? null : Number(fallbackConfig.limit)
        };
        fetch(`${apiBaseUrl}/api/company/fallback-settings`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                ...payload
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Fallback settings save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setFallbackNotice('Fallback settings saved.');
                } else {
                    setFallbackError(data?.error || 'Failed to save fallback settings');
                }
            })
            .finally(() => setFallbackSaving(false));
    }, [apiBaseUrl, fallbackConfig.limit, fallbackConfig.text, profileId, sessionToken]);

    React.useEffect(() => {
        fetchFallbackSettings();
    }, [fetchFallbackSettings]);

    const handleOpenWorkflowBuilder = () => {
        const hasAnyWorkflow = workflows.some((wf: any) => Boolean(getWorkflowId(wf?.id)));
        if (hasAnyWorkflow) {
            // Let parent choose the currently selected workflow first.
            onOpenBuilder(null);
            return;
        }
        // If no workflow exists yet, create one and open builder immediately.
        onCreateWorkflow();
    };

    return (
        <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className="h-full max-w-6xl mx-auto flex flex-col p-4 md:p-6 gap-3 overflow-hidden">
                <div className="bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                            <h2 className="text-lg md:text-xl font-semibold text-[#111b21] tracking-tight">Automations</h2>
                            <p className="text-[11px] text-[#54656f] mt-1">
                                Your saved workflows for this company profile.
                            </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                {...bindOpenHandlers(onCreateWorkflow)}
                                className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 cursor-pointer"
                            >
                                <Plus className="w-3 h-3" />
                                New Automation
                            </button>
                            <button
                                type="button"
                                {...bindOpenHandlers(handleOpenWorkflowBuilder)}
                                className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1 cursor-pointer pointer-events-auto"
                            >
                                <Workflow className="w-3 h-3" />
                                Open Workflow Builder
                            </button>
                        </div>
                    </div>
                </div>

                <div className="bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Fallback Message</h3>
                            <p className="text-[11px] text-[#54656f] mt-1">
                                Default reply when users press an invalid button or option.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={fetchFallbackSettings}
                            disabled={!canManageFallback || fallbackLoading}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {fallbackLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                    </div>

                    {!canManageFallback && (
                        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                            Select a profile and make sure you are logged in to manage fallback settings.
                        </div>
                    )}

                    {fallbackError && (
                        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                            {fallbackError}
                        </div>
                    )}

                    {fallbackNotice && (
                        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                            {fallbackNotice}
                        </div>
                    )}

                    <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
                        <div className="lg:col-span-2">
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Fallback Text</label>
                            <textarea
                                className="mt-2 w-full min-h-[92px] bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-70"
                                value={fallbackConfig.text}
                                onChange={(e) => setFallbackConfig(prev => ({ ...prev, text: e.target.value }))}
                                placeholder="automation not in setting"
                                disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                            />
                            <p className="text-[11px] text-[#7a8b97] mt-2">
                                Leave empty to stop sending fallback replies.
                            </p>
                        </div>
                        <div>
                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Max Times</label>
                            <input
                                type="number"
                                min={0}
                                className="mt-2 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-70"
                                value={fallbackConfig.limit}
                                onChange={(e) => {
                                    const next = e.target.value === '' ? '' : Number(e.target.value);
                                    setFallbackConfig(prev => ({ ...prev, limit: next }));
                                }}
                                placeholder="3"
                                disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                            />
                            <p className="text-[11px] text-[#7a8b97] mt-2">
                                Set to <code className="font-mono">0</code> for unlimited replies.
                            </p>
                        </div>
                    </div>

                    <div className="mt-4 flex justify-end">
                        <button
                            type="button"
                            onClick={handleSaveFallbackSettings}
                            disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                            className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {fallbackSaving ? 'Saving…' : 'Save Fallback Settings'}
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 bg-white border border-[#e6ebef] rounded-2xl overflow-hidden">
                    {workflows.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center px-6">
                            <Workflow className="w-12 h-12 text-[#aebac1] mb-3" />
                            <p className="text-[#111b21] font-bold">No workflows yet</p>
                            <p className="text-xs text-[#8696a0] mt-1 mb-4">
                                Create your first automation workflow in Chatflow builder.
                            </p>
                            <button
                                type="button"
                                {...bindOpenHandlers(onCreateWorkflow)}
                                className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 cursor-pointer"
                            >
                                Create Workflow
                            </button>
                        </div>
                    ) : (
                        <div className="h-full overflow-y-auto custom-scrollbar">
                            <div className="hidden md:grid grid-cols-12 gap-2 px-4 py-2 border-b border-[#eef2f5] bg-[#fcfdfe]">
                                <span className="col-span-3 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Workflow</span>
                                <span className="col-span-3 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Trigger</span>
                                <span className="col-span-1 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Steps</span>
                                <span className="col-span-1 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Status</span>
                                <span className="col-span-4 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97] text-right">Actions</span>
                            </div>

                            <div className="divide-y divide-[#eef2f5]">
                                {workflows.map((wf: any, idx: number) => {
                                    const workflowId = getWorkflowId(wf?.id);
                                    const workflowName = getWorkflowName(wf?.name);
                                    const workflowLabel = workflowName || 'Untitled workflow';
                                    const actionCount = Array.isArray(wf?.actions) ? wf.actions.length : 0;
                                    const triggerKeyword = (wf?.trigger_keyword || '').toString().trim();
                                    const isEnabled = wf?.enabled !== false;
                                    const openRowBuilder = () => {
                                        if (workflowId) onOpenBuilder(workflowId);
                                        else handleOpenWorkflowBuilder();
                                    };
                                    return (
                                        <div
                                            key={`automation-workflow-${workflowLabel}-${idx}`}
                                            {...bindOpenHandlers(openRowBuilder)}
                                            className="grid grid-cols-12 gap-2 px-4 py-3 hover:bg-[#fafcfd] transition-colors cursor-pointer"
                                        >
                                            <div className="col-span-12 md:col-span-3 min-w-0">
                                                <p className="text-[12px] font-semibold text-[#111b21] truncate">{workflowLabel}</p>
                                                {!workflowName && (
                                                    <p className="text-[10px] text-[#8c9aa4] mt-0.5">Set name in workflow builder</p>
                                                )}
                                            </div>

                                            <div className="col-span-8 md:col-span-3 min-w-0">
                                                <p className="text-[11px] text-[#4b5c68] truncate">{triggerKeyword || 'manual only'}</p>
                                            </div>

                                            <div className="col-span-4 md:col-span-1">
                                                <span className="inline-flex items-center text-[11px] text-[#4b5c68] font-medium">
                                                    {actionCount}
                                                </span>
                                            </div>

                                            <div className="col-span-6 md:col-span-1">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide ${isEnabled
                                                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-600'
                                                    }`}>
                                                    {isEnabled ? 'On' : 'Off'}
                                                </span>
                                            </div>

                                            <div className="col-span-6 md:col-span-4 flex items-center justify-end gap-1.5">
                                                <button
                                                    type="button"
                                                    disabled={!workflowId}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onOpenBuilder(workflowId));
                                                    }}
                                                    onMouseDown={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onOpenBuilder(workflowId));
                                                    }}
                                                    onTouchStart={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onOpenBuilder(workflowId));
                                                    }}
                                                    className="h-7 px-2.5 rounded-md bg-[#00a884] text-white text-[9px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                                                >
                                                    Builder
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={!workflowId}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onCopyWorkflow(workflowId));
                                                    }}
                                                    onMouseDown={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onCopyWorkflow(workflowId));
                                                    }}
                                                    onTouchStart={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onCopyWorkflow(workflowId));
                                                    }}
                                                    className="h-7 px-2.5 rounded-md border border-[#dbe2e8] bg-white text-[#334155] text-[9px] font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-1 hover:bg-[#f8fafc] disabled:opacity-60 disabled:cursor-not-allowed"
                                                >
                                                    <Copy className="w-3 h-3" />
                                                    Copy
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={!workflowId}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    onMouseDown={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    onTouchStart={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    className={`h-7 px-2.5 rounded-md border text-[9px] font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed ${isEnabled
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                                        } cursor-pointer`}
                                                >
                                                    <Check className="w-3 h-3" />
                                                    {isEnabled ? 'Untick To Off' : 'Tick To Run'}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
