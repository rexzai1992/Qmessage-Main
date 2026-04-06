import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { getSocketUrl } from '../../runtimeConfig';

const SOCKET_URL = getSocketUrl();

type BroadcastSection = 'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts';

type BroadcastViewProps = {
    broadcastNav: Array<{ id: BroadcastSection; label: string }>;
    broadcastSection: BroadcastSection;
    setBroadcastSection: (section: BroadcastSection) => void;
    activeProfileId: string | null;
    sessionToken: string | null;
    BroadcastTemplateBuilder: React.ComponentType<any>;
    BroadcastTemplatesList: React.ComponentType<any>;
};

type ScheduledBroadcastRow = {
    id: string;
    name: string;
    template_name: string;
    language: string;
    scheduled_at: string | null;
    status: 'scheduled' | 'processing' | 'sent' | 'partial' | 'failed' | 'cancelled';
    recipient_count: number;
    sent_count: number;
    failed_count: number;
    last_error: string | null;
    created_at: string | null;
    processed_at: string | null;
};

const toDateTimeLocalValue = (date: Date): string => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const statusClassName = (status: ScheduledBroadcastRow['status']) => {
    if (status === 'scheduled') return 'bg-amber-50 border-amber-200 text-amber-700';
    if (status === 'processing') return 'bg-sky-50 border-sky-200 text-sky-700';
    if (status === 'sent') return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    if (status === 'partial') return 'bg-orange-50 border-orange-200 text-orange-700';
    if (status === 'failed') return 'bg-rose-50 border-rose-200 text-rose-700';
    return 'bg-slate-50 border-slate-200 text-slate-700';
};

const normalizeScheduledRowStatus = (value: any): ScheduledBroadcastRow['status'] => {
    const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (status === 'processing') return 'processing';
    if (status === 'sent') return 'sent';
    if (status === 'partial') return 'partial';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'cancelled';
    return 'scheduled';
};

export default function BroadcastView({
    broadcastNav,
    broadcastSection,
    setBroadcastSection,
    activeProfileId,
    sessionToken,
    BroadcastTemplateBuilder,
    BroadcastTemplatesList
}: BroadcastViewProps) {
    const [scheduledRows, setScheduledRows] = useState<ScheduledBroadcastRow[]>([]);
    const [scheduledLoading, setScheduledLoading] = useState(false);
    const [scheduledSaving, setScheduledSaving] = useState(false);
    const [scheduledCancelId, setScheduledCancelId] = useState<string | null>(null);
    const [scheduledError, setScheduledError] = useState<string | null>(null);
    const [scheduledNotice, setScheduledNotice] = useState<string | null>(null);
    const [scheduleName, setScheduleName] = useState('');
    const [scheduleTemplateName, setScheduleTemplateName] = useState('');
    const [scheduleLanguage, setScheduleLanguage] = useState('en_US');
    const [scheduleAt, setScheduleAt] = useState(() => toDateTimeLocalValue(new Date(Date.now() + 15 * 60 * 1000)));
    const [scheduleRecipients, setScheduleRecipients] = useState('');
    const [approvedTemplateNames, setApprovedTemplateNames] = useState<string[]>([]);

    const canManageScheduled = Boolean(activeProfileId && sessionToken);

    const loadApprovedTemplateNames = useCallback(async () => {
        if (!activeProfileId || !sessionToken) {
            setApprovedTemplateNames([]);
            return;
        }
        try {
            const params = new URLSearchParams({
                profileId: activeProfileId,
                status: 'APPROVED',
                limit: '100',
                fields: 'id,name,status,language'
            });
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                setApprovedTemplateNames([]);
                return;
            }
            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const names = Array.from(new Set<string>(
                rows
                    .map((item: any) => (typeof item?.name === 'string' ? item.name.trim() : ''))
                    .filter((value: string) => Boolean(value))
            )).sort((a, b) => a.localeCompare(b));
            setApprovedTemplateNames(names);
        } catch {
            setApprovedTemplateNames([]);
        }
    }, [activeProfileId, sessionToken]);

    const loadScheduledBroadcasts = useCallback(async () => {
        if (!activeProfileId || !sessionToken) {
            setScheduledRows([]);
            return;
        }
        setScheduledLoading(true);
        setScheduledError(null);
        try {
            const params = new URLSearchParams({ profileId: activeProfileId });
            const res = await fetch(`${SOCKET_URL}/api/waba/scheduled-broadcasts?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load scheduled broadcasts');
            }
            const rows: ScheduledBroadcastRow[] = Array.isArray(data?.data)
                ? data.data.map((row: any) => ({
                    id: typeof row?.id === 'string' ? row.id : '',
                    name: typeof row?.name === 'string' ? row.name : '',
                    template_name: typeof row?.template_name === 'string' ? row.template_name : '',
                    language: typeof row?.language === 'string' ? row.language : 'en_US',
                    scheduled_at: typeof row?.scheduled_at === 'string' ? row.scheduled_at : null,
                    status: normalizeScheduledRowStatus(row?.status),
                    recipient_count: Number.isFinite(Number(row?.recipient_count)) ? Number(row.recipient_count) : 0,
                    sent_count: Number.isFinite(Number(row?.sent_count)) ? Number(row.sent_count) : 0,
                    failed_count: Number.isFinite(Number(row?.failed_count)) ? Number(row.failed_count) : 0,
                    last_error: typeof row?.last_error === 'string' ? row.last_error : null,
                    created_at: typeof row?.created_at === 'string' ? row.created_at : null,
                    processed_at: typeof row?.processed_at === 'string' ? row.processed_at : null
                }))
                : [];
            setScheduledRows(rows);
        } catch (error: any) {
            setScheduledError(error?.message || 'Failed to load scheduled broadcasts');
            setScheduledRows([]);
        } finally {
            setScheduledLoading(false);
        }
    }, [activeProfileId, sessionToken]);

    useEffect(() => {
        if (broadcastSection !== 'scheduled-broadcasts') return;
        setScheduledNotice(null);
        void loadScheduledBroadcasts();
        void loadApprovedTemplateNames();
    }, [broadcastSection, loadScheduledBroadcasts, loadApprovedTemplateNames]);

    const sortedScheduledRows = useMemo(() => {
        return [...scheduledRows].sort((a, b) => {
            const aTime = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
            const bTime = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
            return aTime - bTime;
        });
    }, [scheduledRows]);

    const handleCreateScheduledBroadcast = async (event: React.FormEvent) => {
        event.preventDefault();
        setScheduledError(null);
        setScheduledNotice(null);
        if (!activeProfileId || !sessionToken) {
            setScheduledError('Profile and session are required.');
            return;
        }

        const templateName = scheduleTemplateName.trim();
        if (!templateName) {
            setScheduledError('Template name is required.');
            return;
        }
        if (!scheduleRecipients.trim()) {
            setScheduledError('Add at least one recipient number.');
            return;
        }

        const scheduleDate = new Date(scheduleAt);
        if (Number.isNaN(scheduleDate.getTime())) {
            setScheduledError('Scheduled datetime is invalid.');
            return;
        }
        if (scheduleDate.getTime() < Date.now()) {
            setScheduledError('Scheduled datetime must be in the future.');
            return;
        }

        setScheduledSaving(true);
        try {
            const payload = {
                profileId: activeProfileId,
                name: scheduleName.trim() || templateName,
                template_name: templateName,
                language: scheduleLanguage.trim() || 'en_US',
                scheduled_at: scheduleDate.toISOString(),
                recipients: scheduleRecipients
            };
            const res = await fetch(`${SOCKET_URL}/api/waba/scheduled-broadcasts`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to schedule broadcast');
            }

            setScheduleName('');
            setScheduleRecipients('');
            setScheduleAt(toDateTimeLocalValue(new Date(Date.now() + 15 * 60 * 1000)));
            setScheduledNotice('Broadcast scheduled successfully.');
            await loadScheduledBroadcasts();
        } catch (error: any) {
            setScheduledError(error?.message || 'Failed to schedule broadcast');
        } finally {
            setScheduledSaving(false);
        }
    };

    const handleCancelScheduledBroadcast = async (id: string) => {
        if (!activeProfileId || !sessionToken) return;
        if (!id) return;
        if (!window.confirm('Cancel this scheduled broadcast?')) return;

        setScheduledCancelId(id);
        setScheduledError(null);
        setScheduledNotice(null);
        try {
            const params = new URLSearchParams({ profileId: activeProfileId });
            const res = await fetch(`${SOCKET_URL}/api/waba/scheduled-broadcasts/${encodeURIComponent(id)}?${params.toString()}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to cancel scheduled broadcast');
            }
            setScheduledNotice('Scheduled broadcast cancelled.');
            await loadScheduledBroadcasts();
        } catch (error: any) {
            setScheduledError(error?.message || 'Failed to cancel scheduled broadcast');
        } finally {
            setScheduledCancelId(null);
        }
    };

    return (
        <div className="h-screen pt-[72px] bg-[#f1f3f6] text-[#111b21] font-sans">
            <div className="h-full flex">
                <aside className="w-72 bg-white border-r border-[#eceff1] p-5">
                    <div className="mb-4">
                        <h2 className="text-xl font-black text-[#111b21]">Broadcast</h2>
                        <p className="text-xs text-[#6b7280] mt-1">Campaign and template workspace</p>
                    </div>
                    <div className="space-y-2">
                        {broadcastNav.map((item) => (
                            <button
                                key={item.id}
                                onClick={() => setBroadcastSection(item.id)}
                                className={`w-full text-left px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${broadcastSection === item.id
                                    ? 'bg-[#00a884]/10 text-[#00a884]'
                                    : 'text-[#111b21] hover:bg-[#f3f4f6]'
                                    }`}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                </aside>

                <main className="flex-1 overflow-hidden">
                    {broadcastSection === 'template-library' && (
                        <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading template builder…</div>}>
                            <BroadcastTemplateBuilder
                                profileId={activeProfileId || ''}
                                sessionToken={sessionToken}
                                onClose={() => setBroadcastSection('my-templates')}
                                embedded
                            />
                        </Suspense>
                    )}
                    {broadcastSection === 'my-templates' && (
                        <Suspense fallback={<div className="p-8 text-sm text-[#54656f]">Loading templates…</div>}>
                            <BroadcastTemplatesList
                                profileId={activeProfileId || ''}
                                sessionToken={sessionToken}
                                title="Template Gallery"
                            />
                        </Suspense>
                    )}
                    {broadcastSection === 'broadcast-history' && (
                        <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                            <div className="bg-white rounded-3xl border border-[#eceff1] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                                <h3 className="text-2xl font-black text-[#111b21] mb-2">Broadcast History</h3>
                                <p className="text-sm text-[#54656f]">
                                    Broadcast send logs will appear here once you start campaigns.
                                </p>
                            </div>
                        </div>
                    )}
                    {broadcastSection === 'scheduled-broadcasts' && (
                        <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                            <div className="bg-white rounded-3xl border border-[#eceff1] p-8 shadow-[0_10px_30px_rgba(0,0,0,0.05)]">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <div>
                                        <h3 className="text-2xl font-black text-[#111b21] mb-1">Scheduled Broadcasts</h3>
                                        <p className="text-sm text-[#54656f]">
                                            Schedule template sends to run automatically at your selected datetime.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void loadScheduledBroadcasts()}
                                        disabled={scheduledLoading || !canManageScheduled}
                                        className="px-4 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                                    >
                                        {scheduledLoading ? 'Refreshing...' : 'Refresh'}
                                    </button>
                                </div>

                                {!canManageScheduled ? (
                                    <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                                        Select an active profile and sign in to manage scheduled broadcasts.
                                    </div>
                                ) : (
                                    <>
                                        <form onSubmit={handleCreateScheduledBroadcast} className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
                                            <div>
                                                <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Campaign Name</label>
                                                <input
                                                    value={scheduleName}
                                                    onChange={(e) => setScheduleName(e.target.value)}
                                                    placeholder="Ramadan Promo Blast"
                                                    className="mt-2 w-full bg-white border border-[#eceff1] rounded-xl px-4 py-2.5 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Template Name</label>
                                                <input
                                                    value={scheduleTemplateName}
                                                    onChange={(e) => setScheduleTemplateName(e.target.value)}
                                                    list="scheduled-template-name-options"
                                                    placeholder="promo_template_v1"
                                                    className="mt-2 w-full bg-white border border-[#eceff1] rounded-xl px-4 py-2.5 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                    required
                                                />
                                                <datalist id="scheduled-template-name-options">
                                                    {approvedTemplateNames.map((name) => (
                                                        <option key={name} value={name} />
                                                    ))}
                                                </datalist>
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Language</label>
                                                <input
                                                    value={scheduleLanguage}
                                                    onChange={(e) => setScheduleLanguage(e.target.value)}
                                                    placeholder="en_US"
                                                    className="mt-2 w-full bg-white border border-[#eceff1] rounded-xl px-4 py-2.5 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Scheduled Datetime</label>
                                                <input
                                                    type="datetime-local"
                                                    value={scheduleAt}
                                                    onChange={(e) => setScheduleAt(e.target.value)}
                                                    className="mt-2 w-full bg-white border border-[#eceff1] rounded-xl px-4 py-2.5 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                    required
                                                />
                                            </div>
                                            <div className="lg:col-span-2">
                                                <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Recipients</label>
                                                <textarea
                                                    value={scheduleRecipients}
                                                    onChange={(e) => setScheduleRecipients(e.target.value)}
                                                    placeholder="60123456789&#10;60111222333&#10;+60199888777"
                                                    className="mt-2 w-full bg-white border border-[#eceff1] rounded-xl px-4 py-2.5 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] min-h-[120px] resize-y"
                                                    required
                                                />
                                                <p className="mt-2 text-[11px] text-[#6b7280]">
                                                    Add one phone number per line (or separate with comma). Max 500 recipients per schedule.
                                                </p>
                                            </div>
                                            <div className="lg:col-span-2 flex items-center justify-end">
                                                <button
                                                    type="submit"
                                                    disabled={scheduledSaving}
                                                    className="px-5 py-2.5 rounded-xl bg-[#00a884] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#008f6f] transition-all disabled:opacity-50"
                                                >
                                                    {scheduledSaving ? 'Scheduling...' : 'Schedule Broadcast'}
                                                </button>
                                            </div>
                                        </form>

                                        {scheduledError && (
                                            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {scheduledError}
                                            </div>
                                        )}
                                        {scheduledNotice && (
                                            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                                                {scheduledNotice}
                                            </div>
                                        )}

                                        <div className="mt-7 rounded-2xl border border-[#eceff1] overflow-hidden">
                                            <div className="px-4 py-3 border-b border-[#eceff1] bg-[#f8fafb] flex items-center justify-between">
                                                <h4 className="text-sm font-black text-[#111b21]">Queue</h4>
                                                <span className="text-[11px] uppercase tracking-widest font-black text-[#64748b]">
                                                    {sortedScheduledRows.length} items
                                                </span>
                                            </div>
                                            <div className="max-h-[420px] overflow-y-auto custom-scrollbar">
                                                {scheduledLoading ? (
                                                    <div className="px-4 py-4 text-sm text-[#64748b]">Loading scheduled broadcasts...</div>
                                                ) : sortedScheduledRows.length === 0 ? (
                                                    <div className="px-4 py-4 text-sm text-[#64748b]">No scheduled broadcasts yet.</div>
                                                ) : (
                                                    <div className="divide-y divide-[#f1f5f9]">
                                                        {sortedScheduledRows.map((row) => (
                                                            <div key={row.id} className="px-4 py-4">
                                                                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                                                                    <div>
                                                                        <div className="text-sm font-black text-[#111b21]">{row.name || row.template_name}</div>
                                                                        <div className="text-xs text-[#64748b] mt-1">
                                                                            Template <span className="font-semibold text-[#0f172a]">{row.template_name}</span> ({row.language || 'en_US'})
                                                                        </div>
                                                                        <div className="text-xs text-[#64748b] mt-1">
                                                                            Scheduled: {row.scheduled_at ? new Date(row.scheduled_at).toLocaleString() : '-'}
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-3 flex-wrap">
                                                                        <span className={`inline-flex px-2.5 py-1 rounded-full border text-[10px] font-black uppercase tracking-widest ${statusClassName(row.status)}`}>
                                                                            {row.status}
                                                                        </span>
                                                                        <span className="text-xs font-semibold text-[#334155]">
                                                                            Recipients: {row.recipient_count}
                                                                        </span>
                                                                        <span className="text-xs font-semibold text-[#334155]">
                                                                            Sent: {row.sent_count} / Failed: {row.failed_count}
                                                                        </span>
                                                                        {row.status === 'scheduled' && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => void handleCancelScheduledBroadcast(row.id)}
                                                                                disabled={scheduledCancelId === row.id}
                                                                                className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-[11px] font-black hover:bg-rose-100 disabled:opacity-50"
                                                                            >
                                                                                {scheduledCancelId === row.id ? 'Cancelling...' : 'Cancel'}
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                {row.last_error && (
                                                                    <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                                                                        {row.last_error}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
