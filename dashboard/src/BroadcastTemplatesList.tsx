import React, { useEffect, useMemo, useState } from 'react';
import { getSocketUrl } from './runtimeConfig';

const SOCKET_URL = getSocketUrl();

type BroadcastTemplatesListProps = {
    profileId: string;
    sessionToken?: string | null;
    title?: string;
};

type TemplateRow = {
    id: string;
    name: string;
    status: string;
    category: string;
    language: string;
    quality: string;
    rejectedReason: string;
    parameterFormat: string;
    components: any[];
    createdTime: string;
};

type TemplatePreview = {
    header: string | null;
    body: string;
    footer: string | null;
    buttons: string[];
    media: {
        type: 'image' | 'video' | 'document';
        url: string | null;
        filename: string | null;
        label: string;
        isPdf: boolean;
    } | null;
};

const normalizeStatus = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase();
};

const statusToneClass = (status: string): string => {
    if (status === 'APPROVED') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (status === 'PENDING') return 'bg-amber-50 text-amber-700 border-amber-200';
    if (status === 'REJECTED' || status === 'DISABLED') return 'bg-rose-50 text-rose-700 border-rose-200';
    if (status === 'PAUSED') return 'bg-orange-50 text-orange-700 border-orange-200';
    return 'bg-slate-50 text-slate-700 border-slate-200';
};

const normalizeComponentType = (value: unknown): string => {
    if (typeof value !== 'string') return 'UNKNOWN';
    return value.trim().toUpperCase();
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value.trim());

const isPdfFile = (value: string): boolean => /\.pdf(?:$|[?#])/i.test(value);

const extractUrlFromString = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isHttpUrl(trimmed)) return trimmed;
    const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
    return match?.[0] || null;
};

const extractPreviewUrl = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === 'string') return extractUrlFromString(value);
    if (Array.isArray(value)) {
        for (const entry of value) {
            const next = extractPreviewUrl(entry);
            if (next) return next;
        }
        return null;
    }
    if (typeof value === 'object') {
        const candidate = value as Record<string, any>;
        const preferredKeys = ['link', 'url', 'src', 'href', 'image_url', 'video_url', 'document_url'];
        for (const key of preferredKeys) {
            const next = extractPreviewUrl(candidate[key]);
            if (next) return next;
        }
        for (const nested of Object.values(candidate)) {
            const next = extractPreviewUrl(nested);
            if (next) return next;
        }
    }
    return null;
};

const filenameFromUrl = (url: string): string | null => {
    if (!url) return null;
    const clean = url.split('?')[0]?.split('#')[0] || url;
    const last = clean.split('/').filter(Boolean).pop();
    if (!last) return null;
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
};

const readPreviewText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value
            .map((item) => readPreviewText(item))
            .filter(Boolean)
            .join('\n');
    }
    if (value && typeof value === 'object') {
        const candidate = value as Record<string, any>;
        const commonKeys = ['text', 'label', 'title', 'url', 'phone_number', 'value'];
        for (const key of commonKeys) {
            if (typeof candidate[key] === 'string' && candidate[key].trim()) {
                return candidate[key];
            }
        }
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return '';
        }
    }
    return '';
};

const buildTemplatePreview = (components: any[]): TemplatePreview => {
    const safeComponents = Array.isArray(components) ? components : [];
    const byType = (type: string) => safeComponents.find((component) => normalizeComponentType(component?.type) === type);

    const headerComponent = byType('HEADER');
    const bodyComponent = byType('BODY');
    const footerComponent = byType('FOOTER');
    const buttonsComponent = byType('BUTTONS');

    let header: string | null = null;
    let media: TemplatePreview['media'] = null;
    if (headerComponent) {
        const format = typeof headerComponent?.format === 'string'
            ? headerComponent.format.toUpperCase()
            : 'TEXT';
        if (format === 'TEXT') {
            const headerText = readPreviewText(
                headerComponent?.text
                || headerComponent?.example?.header_text?.[0]
                || headerComponent?.example
            );
            header = headerText || null;
        } else {
            const type: 'image' | 'video' | 'document' = format === 'IMAGE'
                ? 'image'
                : format === 'VIDEO'
                    ? 'video'
                    : 'document';
            const mediaUrl = extractPreviewUrl([
                headerComponent?.image,
                headerComponent?.video,
                headerComponent?.document,
                headerComponent?.example?.header_url,
                headerComponent?.example?.header_handle,
                headerComponent?.example,
                headerComponent
            ]);
            const explicitFilename = readPreviewText(
                headerComponent?.document?.filename
                || headerComponent?.filename
                || ''
            );
            const derivedFilename = mediaUrl ? filenameFromUrl(mediaUrl) : null;
            const filename = explicitFilename || derivedFilename || null;
            const isPdf = type === 'document' && Boolean(
                (filename && isPdfFile(filename))
                || (mediaUrl && isPdfFile(mediaUrl))
            );
            media = {
                type,
                url: mediaUrl,
                filename,
                label: type === 'image' ? 'Image' : type === 'video' ? 'Video' : isPdf ? 'PDF' : 'Document',
                isPdf
            };
            header = filename && type === 'document' ? filename : null;
        }
    }

    const body = readPreviewText(bodyComponent?.text || bodyComponent?.example || '');
    const footer = readPreviewText(footerComponent?.text || footerComponent?.example || '') || null;
    const buttons = Array.isArray(buttonsComponent?.buttons)
        ? buttonsComponent.buttons
            .map((button: any) =>
                readPreviewText(button?.text || button?.title || button?.label || button?.url || button?.phone_number || button)
            )
            .filter(Boolean)
        : [];

    return {
        header,
        body,
        footer,
        buttons,
        media
    };
};

export default function BroadcastTemplatesList({
    profileId,
    sessionToken,
    title = 'Template Gallery'
}: BroadcastTemplatesListProps) {
    const [items, setItems] = useState<TemplateRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'APPROVED' | 'PENDING' | 'REJECTED'>('ALL');
    const [selectedTemplate, setSelectedTemplate] = useState<TemplateRow | null>(null);
    const selectedPreview = useMemo(
        () => (selectedTemplate ? buildTemplatePreview(selectedTemplate.components) : null),
        [selectedTemplate]
    );

    const loadTemplates = async () => {
        if (!profileId || !sessionToken) return;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set('profileId', profileId);
            params.set('limit', '100');
            params.set('fields', 'id,name,status,category,language,quality_score,rejected_reason,parameter_format,components,created_time');
            if (statusFilter !== 'ALL') params.set('status', statusFilter);
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load templates');
            }

            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const mapped: TemplateRow[] = rows.map((row: any) => ({
                id: typeof row?.id === 'string' ? row.id : '',
                name: typeof row?.name === 'string' ? row.name : '',
                status: normalizeStatus(row?.status),
                category: typeof row?.category === 'string' ? row.category : '',
                language: typeof row?.language === 'string' ? row.language : '',
                quality: typeof row?.quality_score?.score === 'string'
                    ? row.quality_score.score
                    : typeof row?.quality_score === 'string'
                        ? row.quality_score
                        : '',
                rejectedReason: typeof row?.rejected_reason === 'string' ? row.rejected_reason : '',
                parameterFormat: typeof row?.parameter_format === 'string' ? row.parameter_format : '',
                components: Array.isArray(row?.components) ? row.components : [],
                createdTime: typeof row?.created_time === 'string' ? row.created_time : ''
            }));

            const filtered = mapped.filter((item) => item.id && item.name);
            setItems(filtered);
            setSelectedTemplate((prev) => {
                if (!prev) return null;
                const next = filtered.find((item) => item.id === prev.id) || null;
                return next;
            });
        } catch (err: any) {
            setError(err?.message || 'Failed to load templates');
            setItems([]);
            setSelectedTemplate(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTemplates();
    }, [profileId, sessionToken, statusFilter]);

    const filteredItems = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((item) =>
            item.name.toLowerCase().includes(q) ||
            item.id.toLowerCase().includes(q) ||
            item.language.toLowerCase().includes(q)
        );
    }, [items, query]);

    return (
        <div className="h-full overflow-y-auto custom-scrollbar p-6">
            <div className="bg-white rounded-3xl border border-[#eceff1] shadow-[0_10px_30px_rgba(0,0,0,0.05)] p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
                    <div>
                        <h2 className="text-2xl font-black text-[#111b21]">{title}</h2>
                        <p className="text-sm text-[#64748b] mt-1">View approved and pending templates on this WABA profile.</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void loadTemplates()}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl border border-[#e5e7eb] bg-white text-xs font-bold text-[#111b21] hover:bg-[#f9fafb] disabled:opacity-50"
                    >
                        {loading ? 'Refreshing...' : 'Refresh'}
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-4">
                    {(['ALL', 'APPROVED', 'PENDING', 'REJECTED'] as const).map((status) => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            className={`px-3 py-2 rounded-xl border text-xs font-bold ${statusFilter === status
                                ? 'bg-[#111b21] text-white border-[#111b21]'
                                : 'bg-white text-[#111b21] border-[#e5e7eb] hover:bg-[#f9fafb]'
                                }`}
                        >
                            {status}
                        </button>
                    ))}
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search name / id / language"
                        className="ml-auto min-w-[240px] flex-1 max-w-[360px] bg-white border border-[#e5e7eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                    />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4">
                    <div className="border border-[#e5e7eb] rounded-xl overflow-hidden min-h-[520px]">
                        <div className="max-h-[70vh] overflow-y-auto custom-scrollbar">
                            {loading ? (
                                <div className="px-4 py-4 text-sm text-[#6b7280]">Loading templates...</div>
                            ) : error ? (
                                <div className="px-4 py-4 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">{error}</div>
                            ) : filteredItems.length === 0 ? (
                                <div className="px-4 py-4 text-sm text-[#6b7280]">No templates found.</div>
                            ) : (
                                <table className="w-full text-left">
                                    <thead className="sticky top-0 bg-[#f9fafb] border-b border-[#e5e7eb]">
                                        <tr className="text-[10px] uppercase tracking-widest text-[#6b7280] font-black">
                                            <th className="px-3 py-2">Name</th>
                                            <th className="px-3 py-2">Status</th>
                                            <th className="px-3 py-2">Category</th>
                                            <th className="px-3 py-2">Lang</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredItems.map((item) => (
                                            <tr
                                                key={item.id}
                                                className={`border-b border-[#f1f5f9] last:border-b-0 ${selectedTemplate?.id === item.id ? 'bg-[#f0fdfa]' : ''}`}
                                            >
                                                <td className="px-3 py-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => setSelectedTemplate(item)}
                                                        className="text-left text-sm font-semibold text-[#0f172a] hover:text-[#00a884] hover:underline"
                                                    >
                                                        {item.name}
                                                    </button>
                                                    <div className="text-[11px] text-[#64748b] font-mono">{item.id}</div>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <span className={`inline-flex px-2 py-1 rounded-full border text-[10px] font-black ${statusToneClass(item.status)}`}>
                                                        {item.status || 'UNKNOWN'}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2 text-xs font-semibold text-[#334155]">{item.category || '-'}</td>
                                                <td className="px-3 py-2 text-xs font-semibold text-[#334155]">{item.language || '-'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>

                    <div className="rounded-2xl border border-[#e5e7eb] bg-[#f8fafc] p-3">
                        <div className="text-[11px] uppercase tracking-widest font-black text-[#64748b] mb-2">
                            WhatsApp Preview
                        </div>
                        {selectedTemplate && selectedPreview ? (
                            <div className="mx-auto w-[320px] rounded-[34px] bg-[#111b21] p-2.5 shadow-[0_24px_40px_rgba(15,23,42,0.25)]">
                                <div className="rounded-[26px] overflow-hidden bg-[#e5ddd5]">
                                    <div className="h-8 bg-[#202c33] text-white px-3 flex items-center justify-between text-[10px] font-bold">
                                        <span>{selectedTemplate.name}</span>
                                        <span>{selectedTemplate.language || 'en_US'}</span>
                                    </div>
                                    <div className="p-3 min-h-[420px] bg-[radial-gradient(circle_at_1px_1px,#d4cec7_1px,transparent_0)] [background-size:12px_12px]">
                                        <div className="max-w-[84%] bg-white rounded-2xl rounded-tl-md px-3 py-2 shadow-sm border border-[#eef1f5]">
                                            {selectedPreview.media && (
                                                <div className="mb-2">
                                                    {selectedPreview.media.type === 'image' && selectedPreview.media.url ? (
                                                        <img
                                                            src={selectedPreview.media.url}
                                                            alt={selectedPreview.media.filename || 'Template image'}
                                                            className="w-full max-h-[160px] object-cover rounded-lg border border-[#d9e2ec]"
                                                        />
                                                    ) : selectedPreview.media.type === 'video' && selectedPreview.media.url ? (
                                                        <video
                                                            src={selectedPreview.media.url}
                                                            controls
                                                            className="w-full max-h-[160px] rounded-lg border border-[#d9e2ec] bg-black"
                                                        />
                                                    ) : selectedPreview.media.type === 'document' && selectedPreview.media.isPdf && selectedPreview.media.url ? (
                                                        <iframe
                                                            title="Template PDF preview"
                                                            src={selectedPreview.media.url}
                                                            className="w-full h-[170px] rounded-lg border border-[#d9e2ec] bg-white"
                                                        />
                                                    ) : (
                                                        <div className="rounded-lg border border-[#d9e2ec] bg-[#f8fafc] px-2.5 py-2 text-[11px] text-[#334155]">
                                                            <div className="font-semibold">{selectedPreview.media.label}</div>
                                                            <div className="truncate">{selectedPreview.media.filename || 'Attachment preview'}</div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {selectedPreview.header && (
                                                <div className="text-[11px] font-semibold text-[#111b21] mb-1 whitespace-pre-wrap break-words">
                                                    {selectedPreview.header}
                                                </div>
                                            )}
                                            <div className="text-[12px] text-[#111b21] whitespace-pre-wrap break-words">
                                                {selectedPreview.body || 'No preview text.'}
                                            </div>
                                            {selectedPreview.footer && (
                                                <div className="mt-1.5 text-[10px] text-[#667781] whitespace-pre-wrap break-words">
                                                    {selectedPreview.footer}
                                                </div>
                                            )}
                                        </div>
                                        {selectedPreview.buttons.length > 0 && (
                                            <div className="mt-2 max-w-[84%] space-y-1">
                                                {selectedPreview.buttons.map((button, index) => (
                                                    <div
                                                        key={`${selectedTemplate.id}-preview-btn-${index}`}
                                                        className="rounded-xl border border-[#d9e2ec] bg-white px-2 py-1.5 text-center text-[11px] font-semibold text-[#00a884]"
                                                    >
                                                        {button}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="h-[420px] rounded-xl border border-dashed border-[#cbd5e1] bg-white/80 px-4 py-3 text-sm text-[#475569] flex items-center justify-center text-center">
                                Click a template name to show preview.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
