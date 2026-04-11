import React, { useState, useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { getSocketUrl, resolveCompanyIdFromLocation } from './runtimeConfig'
import qmessageLogo from './assets/qmessage-logo.jpg'
import {
    ArrowRight,
    CheckCircle2,
    Building2,
    ShieldCheck,
    Sparkles,
    LifeBuoy,
    LayoutDashboard,
    MessageSquare,
    Send,
    Workflow,
    BarChart3
} from 'lucide-react'

const OAUTH_PENDING_COMPANY_KEY = 'pendingOAuthCompanyId'
const COMPANY_ID_REGEX = /^[a-z0-9-]{3,63}$/
const RESERVED_COMPANY_IDS = new Set(['www', 'admin', 'myadmin'])
const AUTH_REQUEST_TIMEOUT_MS = 12_000

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
    let timeoutId: number | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
    })
    try {
        return await Promise.race([promise, timeoutPromise])
    } finally {
        if (typeof timeoutId === 'number') {
            window.clearTimeout(timeoutId)
        }
    }
}

function GoogleLogo() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            className="h-5 w-5"
            aria-hidden="true"
        >
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.8 2.8 30.3.5 24 .5 14.8.5 6.9 5.8 3.1 13.5l7.8 6.1C12.8 13.6 17.9 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.5-.1-2.6-.4-3.9H24v7.4h12.9c-.3 1.8-1.8 4.4-5.1 6.2l7.9 6.1c4.8-4.4 7.8-10.8 7.8-18.8z" />
            <path fill="#FBBC05" d="M10.9 28.4c-.5-1.4-.8-2.8-.8-4.4s.3-3 .8-4.4l-7.8-6.1C1.4 16.8.5 20.3.5 24s.9 7.2 2.6 10.5l7.8-6.1z" />
            <path fill="#34A853" d="M24 47.5c6.3 0 11.6-2.1 15.5-5.7l-7.9-6.1c-2.1 1.5-4.9 2.5-7.6 2.5-6.1 0-11.2-4.1-13.1-9.7l-7.8 6.1C6.9 42.2 14.8 47.5 24 47.5z" />
        </svg>
    )
}

export default function Login({
    onLogin,
    forcedMessage
}: {
    onLogin: (session: Session) => void;
    forcedMessage?: string | null;
}) {
    const SOCKET_URL = getSocketUrl()
    const [loading, setLoading] = useState(false)
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [companyId, setCompanyId] = useState('')
    const [companyName, setCompanyName] = useState('')
    const [hostCompanyId, setHostCompanyId] = useState<string | null>(null)
    const [mode, setMode] = useState<'login' | 'signup'>('login')
    const [msg, setMsg] = useState('')
    const [isVisible, setIsVisible] = useState(false)
    const [googleLoading, setGoogleLoading] = useState(false)
    const [previewTab, setPreviewTab] = useState<'workspace' | 'team-inbox' | 'broadcast' | 'automation' | 'analytics'>('workspace')

    const previewTabs: Array<{
        id: 'workspace' | 'team-inbox' | 'broadcast' | 'automation' | 'analytics';
        label: string;
        icon: React.ComponentType<{ className?: string }>;
    }> = [
            { id: 'workspace', label: 'Workspace', icon: LayoutDashboard },
            { id: 'team-inbox', label: 'Inbox', icon: MessageSquare },
            { id: 'broadcast', label: 'Broadcast', icon: Send },
            { id: 'automation', label: 'Automation', icon: Workflow },
            { id: 'analytics', label: 'Analytics', icon: BarChart3 }
        ]

    const inboxPreviewRows = [
        { name: 'Aisha Rahman', assignee: 'Nadia', tag: 'hot-lead', unread: 3, message: 'Need pricing and ETA for rollout.' },
        { name: 'Daniel Lim', assignee: 'Hafiz', tag: 'support', unread: 0, message: 'Webhook callback already verified.' },
        { name: 'Sarah Wong', assignee: 'Mira', tag: 'new-signup', unread: 2, message: 'Can we migrate old template IDs?' }
    ]

    const broadcastPreviewRows = [
        { name: 'Eid Promo Segment A', status: 'Scheduled', recipients: 2500, at: 'Today - 18:30' },
        { name: 'Abandoned Cart Nudge', status: 'Processing', recipients: 980, at: 'Today - 14:10' },
        { name: 'Winback Offer', status: 'Sent', recipients: 4100, at: 'Yesterday - 21:00' }
    ]

    const analyticsPreviewRows = [
        { label: 'Inbound', value: 721, pct: 78, color: '#4f9cf9' },
        { label: 'Resolved', value: 644, pct: 69, color: '#0ea47a' },
        { label: 'Automation', value: 517, pct: 56, color: '#7c90ab' },
        { label: 'SLA Risk', value: 29, pct: 22, color: '#d18a16' }
    ]

    const normalizeCompanyId = (value: string) => value.trim().toLowerCase()

    const validateCompanyInput = () => {
        const trimmedCompany = companyId.trim()
        const normalizedCompany = normalizeCompanyId(trimmedCompany)
        if (!trimmedCompany) {
            throw new Error('Company ID is required.')
        }
        if (hostCompanyId && normalizedCompany !== normalizeCompanyId(hostCompanyId)) {
            throw new Error(`Company ID must match subdomain "${hostCompanyId}".`)
        }
        if (!COMPANY_ID_REGEX.test(normalizedCompany) || normalizedCompany.startsWith('-') || normalizedCompany.endsWith('-')) {
            throw new Error('Company ID must be 3-63 chars, lowercase letters/numbers/hyphen, and cannot start or end with hyphen.')
        }
        if (RESERVED_COMPANY_IDS.has(normalizedCompany)) {
            throw new Error('This company ID is reserved.')
        }
        return { trimmedCompany, normalizedCompany }
    }

    const signInAndValidate = async (trimmedEmail: string, rawPassword: string, expectedCompanyId: string) => {
        const signInPromise = supabase.auth.signInWithPassword({
            email: trimmedEmail,
            password: rawPassword
        })
        const { data, error } = await withTimeout(
            signInPromise,
            AUTH_REQUEST_TIMEOUT_MS,
            'Authentication request timed out. Please retry in a few seconds.'
        )
        if (error) throw error
        if (!data?.session || !data?.user) {
            throw new Error('Login succeeded but no session was created. Please confirm your email or disable email confirmations in Supabase Auth settings.')
        }
        const metaCompany = data.user.user_metadata?.company_id || data.user.app_metadata?.company_id
        if (!metaCompany) {
            await supabase.auth.signOut()
            throw new Error('This account is not assigned to any company. Ask your admin to set up your account first.')
        }
        if (normalizeCompanyId(metaCompany) !== normalizeCompanyId(expectedCompanyId)) {
            await supabase.auth.signOut()
            throw new Error(`Company ID does not match this account. Use "${metaCompany}".`)
        }
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY)
        }
        return data.session
    }

    useEffect(() => {
        setIsVisible(true)
        const inferred = resolveCompanyIdFromLocation()
        if (!inferred) return
        setHostCompanyId(inferred)
        setCompanyId(inferred)
    }, [])

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setMsg('')

        try {
            const { trimmedCompany, normalizedCompany } = validateCompanyInput()
            const trimmedEmail = email.trim().toLowerCase()
            if (!trimmedEmail) {
                throw new Error('Email is required.')
            }
            if (mode === 'signup' && password.length < 8) {
                throw new Error('Password must be at least 8 characters.')
            }
            if (mode === 'signup') {
                const res = await fetch(`${SOCKET_URL}/api/public/signup-company`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        companyId: normalizedCompany,
                        companyName: companyName.trim() || undefined,
                        email: trimmedEmail,
                        password
                    })
                })
                const json = await res.json().catch(() => null)
                if (!res.ok || !json?.success) {
                    throw new Error(json?.error || 'Failed to create company account.')
                }
            }

            const session = await signInAndValidate(trimmedEmail, password, trimmedCompany)
            onLogin(session)
        } catch (error: any) {
            const rawMessage = typeof error?.message === 'string' ? error.message : 'Unable to sign in right now. Please retry.'
            const networkLikeError =
                rawMessage.toLowerCase().includes('failed to fetch')
                || rawMessage.toLowerCase().includes('timed out')
                || rawMessage.toLowerCase().includes('gateway timeout')
                || rawMessage.toLowerCase().includes('service unavailable')
            setMsg(networkLikeError
                ? 'Auth server is busy or unreachable right now. Please retry in a few seconds.'
                : rawMessage
            )
        } finally {
            setLoading(false)
        }
    }

    const handleGoogleAuth = async () => {
        setMsg('')
        setGoogleLoading(true)
        try {
            if (mode === 'signup') {
                throw new Error('Google signup is not available. Use Create Company with email and password.')
            }
            const { normalizedCompany } = validateCompanyInput()
            if (typeof window === 'undefined') {
                throw new Error('Browser environment is required for Google sign-in.')
            }

            window.localStorage.setItem(OAUTH_PENDING_COMPANY_KEY, normalizedCompany)
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: `${window.location.origin}${window.location.pathname}`
                }
            })
            if (error) throw error
        } catch (error: any) {
            if (typeof window !== 'undefined') {
                window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY)
            }
            setMsg(error?.message || 'Google sign-in failed.')
            setGoogleLoading(false)
        }
    }

    const activeMessage = msg || forcedMessage || ''
    const successMessage = activeMessage.toLowerCase().includes('success') || activeMessage.toLowerCase().includes('check')

    const renderLandingPreview = () => {
        if (previewTab === 'workspace') {
            return (
                <div className="h-full rounded-[12px] bg-[linear-gradient(180deg,#f8fbff_0%,#f3f8ff_100%)] px-3 py-2.5">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-xs font-extrabold text-[var(--qm-text)]">Workspace Overview</p>
                            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Operations Snapshot</p>
                        </div>
                        <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-[var(--qm-brand)]">
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--qm-brand)]" />
                            Live
                        </span>
                    </div>

                    <div className="mt-3 grid grid-cols-[1.8fr_1fr_1fr] border-y border-[#d8e3f1] px-1 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">
                        <p>Queue</p>
                        <p className="text-right">Open</p>
                        <p className="text-right">SLA</p>
                    </div>

                    <div className="divide-y divide-[#dce7f4]">
                        {[
                            { queue: 'Team Inbox', open: '42', sla: '98.2%' },
                            { queue: 'Automation Queue', open: '18', sla: '99.1%' },
                            { queue: 'Broadcast Delivery', open: '5', sla: '96.4%' },
                            { queue: 'Template Review', open: '11', sla: '97.3%' }
                        ].map((row) => (
                            <div key={`workspace-row-${row.queue}`} className="grid grid-cols-[1.8fr_1fr_1fr] items-center px-1 py-2">
                                <p className="truncate text-[11px] font-bold text-[var(--qm-text)]">{row.queue}</p>
                                <p className="text-right text-[11px] font-extrabold text-[var(--qm-text)]">{row.open}</p>
                                <p className="text-right text-[11px] font-bold text-[var(--qm-text-muted)]">{row.sla}</p>
                            </div>
                        ))}
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-4 border-t border-[#d8e3f1] pt-2.5">
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Conversations</p>
                            <p className="mt-1 text-sm font-extrabold text-[var(--qm-text)]">721</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Resolved</p>
                            <p className="mt-1 text-sm font-extrabold text-[var(--qm-success)]">644</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Auto-handled</p>
                            <p className="mt-1 text-sm font-extrabold text-[var(--qm-accent)]">73%</p>
                        </div>
                    </div>
                </div>
            )
        }

        if (previewTab === 'team-inbox') {
            return (
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-extrabold text-[var(--qm-text)]">Live Team Inbox</p>
                        <span className="inline-flex h-5 items-center rounded-full border border-[#b9e7d5] bg-[#eaf9f3] px-2 text-[9px] font-black uppercase tracking-[0.08em] text-[var(--qm-brand)]">
                            {inboxPreviewRows.length} Active
                        </span>
                    </div>
                    {inboxPreviewRows.map((row) => (
                        <div key={`inbox-preview-${row.name}`} className="rounded-[10px] border border-[var(--qm-border)] bg-[#f8fbff] px-2.5 py-1.5">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="truncate text-[11px] font-extrabold text-[var(--qm-text)]">{row.name}</p>
                                    <p className="mt-0.5 truncate text-[10px] leading-snug text-[var(--qm-text-muted)]">{row.message}</p>
                                </div>
                                {row.unread > 0 ? (
                                    <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#dff7ee] px-1 text-[9px] font-black text-[var(--qm-brand)]">
                                        {row.unread}
                                    </span>
                                ) : null}
                            </div>
                            <div className="mt-1.5 flex items-center gap-1.5">
                                <span className="inline-flex h-5 items-center rounded-full border border-[#d8e1ee] bg-[#eef3f9] px-2 text-[9px] font-black uppercase tracking-[0.07em] text-[#425871]">{row.tag}</span>
                                <span className="inline-flex h-5 items-center rounded-full border border-[#b9e7d5] bg-[#eaf9f3] px-2 text-[9px] font-black uppercase tracking-[0.07em] text-[var(--qm-brand)]">Assigned {row.assignee}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )
        }

        if (previewTab === 'broadcast') {
            return (
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-xs font-extrabold text-[var(--qm-text)]">Broadcast Campaign Queue</p>
                        <span className="qm-pill qm-pill-neutral">Templates + Schedules</span>
                    </div>
                    {broadcastPreviewRows.map((row) => (
                        <div key={`broadcast-preview-${row.name}`} className="rounded-[12px] border border-[var(--qm-border)] bg-[#f8fbff] px-3 py-2.5">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="truncate text-xs font-extrabold text-[var(--qm-text)]">{row.name}</p>
                                    <p className="mt-0.5 text-[11px] text-[var(--qm-text-muted)]">{row.recipients.toLocaleString()} recipients</p>
                                </div>
                                <span className={`qm-pill ${row.status === 'Sent' ? 'qm-pill-success' : row.status === 'Processing' ? 'qm-pill-warning' : 'qm-pill-neutral'}`}>
                                    {row.status}
                                </span>
                            </div>
                            <p className="mt-1 text-[11px] text-[var(--qm-text-soft)]">{row.at}</p>
                        </div>
                    ))}
                </div>
            )
        }

        if (previewTab === 'automation') {
            return (
                <div className="relative h-full w-full rounded-[14px] border border-[var(--qm-border)] bg-[#f8fbff]">
                    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 600 340" fill="none" aria-hidden="true">
                        <path d="M118 169H260" stroke="#bed2e7" strokeWidth="2.5" />
                        <path d="M338 169H478" stroke="#bed2e7" strokeWidth="2.5" />
                        <path d="M338 169H420V94H478" stroke="#bed2e7" strokeWidth="2.5" />
                        <path d="M338 169H420V244H478" stroke="#bed2e7" strokeWidth="2.5" />
                    </svg>

                    <div className="absolute left-[28px] top-[146px] w-[150px] rounded-[12px] border border-[#cfe1f2] bg-white px-3 py-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Trigger</p>
                        <p className="mt-1 text-[11px] font-extrabold text-[var(--qm-text)]">Inbound Message</p>
                    </div>

                    <div className="absolute left-[260px] top-[132px] w-[170px] rounded-[12px] border border-[#b9e7d5] bg-[#eaf9f3] px-3 py-2.5 shadow-[0_8px_20px_rgba(14,164,122,0.12)]">
                        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-brand)]">Core Router</p>
                        <p className="mt-1 text-[11px] font-extrabold text-[var(--qm-text)]">Intent + Stage Decision</p>
                    </div>

                    <div className="absolute right-[26px] top-[74px] w-[126px] rounded-[12px] border border-[#d8e3f2] bg-white px-2.5 py-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Branch A</p>
                        <p className="mt-1 text-[11px] font-bold text-[var(--qm-text)]">Sales Route</p>
                    </div>

                    <div className="absolute right-[26px] top-[149px] w-[126px] rounded-[12px] border border-[#d8e3f2] bg-white px-2.5 py-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Branch B</p>
                        <p className="mt-1 text-[11px] font-bold text-[var(--qm-text)]">Support Route</p>
                    </div>

                    <div className="absolute right-[26px] top-[224px] w-[126px] rounded-[12px] border border-[#d8e3f2] bg-white px-2.5 py-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[var(--qm-text-soft)]">Branch C</p>
                        <p className="mt-1 text-[11px] font-bold text-[var(--qm-text)]">Billing Route</p>
                    </div>

                    <div className="absolute left-[16px] top-[14px] rounded-[10px] border border-[#d7e3f1] bg-[#f4f9ff] px-2.5 py-1.5">
                        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Mind Map Flow</p>
                    </div>
                    <div className="absolute left-[16px] bottom-[14px] rounded-[10px] border border-[#d7e3f1] bg-white px-2.5 py-1.5">
                        <p className="text-[11px] font-bold text-[var(--qm-text)]">14 workflows active - 73% auto handling</p>
                    </div>
                </div>
            )
        }

        if (previewTab === 'analytics') {
            return (
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-[12px] border border-[var(--qm-border)] bg-[#f8fbff] px-3 py-2">
                            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Response rate</p>
                            <p className="mt-1 text-base font-extrabold text-[var(--qm-text)]">89.3%</p>
                        </div>
                        <div className="rounded-[12px] border border-[var(--qm-border)] bg-[#f8fbff] px-3 py-2">
                            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Template CTR</p>
                            <p className="mt-1 text-base font-extrabold text-[var(--qm-text)]">24.1%</p>
                        </div>
                    </div>
                    <div className="rounded-[12px] border border-[var(--qm-border)] bg-[#f8fbff] p-3">
                        {analyticsPreviewRows.map((row) => (
                            <div key={`analytics-preview-${row.label}`} className="mb-2.5 last:mb-0">
                                <div className="mb-1 flex items-center justify-between text-[11px]">
                                    <span className="font-bold text-[var(--qm-text-muted)]">{row.label}</span>
                                    <span className="font-extrabold text-[var(--qm-text)]">{row.value}</span>
                                </div>
                                <div className="h-2 rounded-full bg-[#e8eef7]">
                                    <div className="h-2 rounded-full" style={{ width: `${row.pct}%`, backgroundColor: row.color }} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )
        }

        return (
            <div className="grid grid-cols-2 gap-3">
                <div className="qm-landing-pane p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Team Inbox</p>
                    <p className="mt-1 text-sm font-extrabold text-[var(--qm-text)]">3 assigned conversations</p>
                    <p className="mt-1 text-xs text-[var(--qm-text-muted)]">Assignee tags and unread triage in one list.</p>
                </div>
                <div className="qm-landing-pane p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Broadcast</p>
                    <p className="mt-1 text-sm font-extrabold text-[var(--qm-text)]">Template campaign control</p>
                    <p className="mt-1 text-xs text-[var(--qm-text-muted)]">Schedule sends and monitor queue health.</p>
                </div>
                <div className="qm-landing-pane p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Automation</p>
                    <p className="mt-1 text-sm font-extrabold text-[var(--qm-text)]">Visual workflow builder</p>
                    <p className="mt-1 text-xs text-[var(--qm-text-muted)]">Route intents, trigger replies, and escalate cleanly.</p>
                </div>
                <div className="qm-landing-pane p-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">Analytics</p>
                    <p className="mt-1 text-sm font-extrabold text-[var(--qm-text)]">Operational clarity</p>
                    <p className="mt-1 text-xs text-[var(--qm-text-muted)]">Track response quality, volume, and SLA risk.</p>
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen qm-landing-root px-4 py-5 sm:px-6 sm:py-6 lg:h-screen lg:overflow-hidden lg:px-8 lg:py-6">
            <div className="mx-auto flex h-full w-full max-w-[1450px]">
                <div className="grid h-full w-full items-stretch gap-5 lg:grid-cols-[1.15fr_0.85fr] lg:gap-6">
                    <section className={`hidden h-full min-h-0 lg:flex transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                        <div className="qm-landing-product qm-stagger-fade flex h-full min-h-0 w-full flex-col p-6 lg:p-7">
                            <div className="max-w-[760px]">
                                <div className="inline-flex items-center gap-2 qm-badge qm-badge-brand">
                                    <Sparkles className="h-3.5 w-3.5" />
                                    QMessage Platform
                                </div>
                                <h1 className="qm-landing-hero-title mt-5">
                                    The operational console for WhatsApp Business teams.
                                </h1>
                                <p className="qm-landing-subtitle">
                                    QMessage gives your team one command center for WABA setup, inbox triage, template delivery, and operational analytics.
                                    Built for real business workflows, not generic chat tooling.
                                </p>
                                <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold text-[var(--qm-text-muted)]">
                                    <span className="inline-flex items-center gap-2">
                                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--qm-brand)]" />
                                        WABA workspace control
                                    </span>
                                    <span className="inline-flex items-center gap-2">
                                        <span className="h-1.5 w-1.5 rounded-full bg-[#3f75d6]" />
                                        Team inbox operations
                                    </span>
                                    <span className="inline-flex items-center gap-2">
                                        <span className="h-1.5 w-1.5 rounded-full bg-[#8ca2bd]" />
                                        Automation performance view
                                    </span>
                                </div>
                            </div>

                            <div className="mt-6 flex min-h-0 flex-1 flex-col rounded-[22px] border border-[#dbe6f3] bg-white/92 p-4 shadow-[0_18px_45px_rgba(20,36,60,0.12)]">
                                <div className="grid grid-cols-5 gap-1.5">
                                    {previewTabs.map((tab) => {
                                        const Icon = tab.icon
                                        const active = previewTab === tab.id
                                        return (
                                            <button
                                                key={`preview-tab-${tab.id}`}
                                                type="button"
                                                onClick={() => setPreviewTab(tab.id)}
                                                className={`inline-flex min-w-0 items-center justify-center gap-1 rounded-full border px-2 py-1.5 text-[10px] font-extrabold transition-all ${active
                                                    ? 'border-[var(--qm-border-strong)] bg-[#eaf3ff] text-[var(--qm-accent)]'
                                                    : 'border-[var(--qm-border)] bg-white/80 text-[var(--qm-text-muted)] hover:bg-white hover:text-[var(--qm-text)]'
                                                    }`}
                                            >
                                                <Icon className="h-3 w-3 shrink-0" />
                                                <span className="truncate">{tab.label}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                                <div className="mx-auto mt-4 h-[370px] w-[620px] shrink-0 overflow-hidden qm-landing-window p-3">
                                    {renderLandingPreview()}
                                </div>
                                <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-semibold text-[var(--qm-text-soft)]">
                                    <span className="rounded-full border border-[#dbe4f0] bg-[#f5f8fc] px-3 py-1">Multi-company workspaces</span>
                                    <span className="rounded-full border border-[#dbe4f0] bg-[#f5f8fc] px-3 py-1">Role-based access</span>
                                    <span className="rounded-full border border-[#dbe4f0] bg-[#f5f8fc] px-3 py-1">Inbox, broadcast, automation</span>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section className={`qm-shell p-5 sm:p-6 lg:hidden transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                        <div className="inline-flex items-center gap-2 qm-badge qm-badge-brand">
                            <Sparkles className="h-3.5 w-3.5" />
                            QMessage SaaS
                        </div>
                        <h1 className="qm-title mt-4">
                            WhatsApp Business operations in one premium control panel.
                        </h1>
                        <p className="qm-subtitle mt-3">
                            Start with the MVP workflows your team needs on day one.
                        </p>
                        <div className="mt-4 qm-landing-window p-3.5">
                            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--qm-text-soft)]">MVP Features</p>
                            <div className="mt-2 divide-y divide-[#dbe6f3] rounded-[12px] border border-[#dbe6f3] bg-[#f8fbff] px-3">
                                <div className="flex items-start gap-3 py-2.5">
                                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#cde0f4] bg-white text-[var(--qm-accent)]">
                                        <MessageSquare className="h-3.5 w-3.5" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-extrabold text-[var(--qm-text)]">Team Inbox</p>
                                        <p className="mt-0.5 text-[11px] text-[var(--qm-text-muted)]">Assign staff, tag chats, and handle priority messages.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 py-2.5">
                                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#cde0f4] bg-white text-[var(--qm-brand)]">
                                        <Workflow className="h-3.5 w-3.5" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-extrabold text-[var(--qm-text)]">Automation Builder</p>
                                        <p className="mt-0.5 text-[11px] text-[var(--qm-text-muted)]">Route conversations with flow logic and escalation rules.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3 py-2.5">
                                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#cde0f4] bg-white text-[#3f75d6]">
                                        <Send className="h-3.5 w-3.5" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-extrabold text-[var(--qm-text)]">Broadcast</p>
                                        <p className="mt-0.5 text-[11px] text-[var(--qm-text-muted)]">Send template campaigns and monitor delivery status.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    <section id="auth-panel" className={`qm-shell flex h-full min-h-0 flex-col overflow-y-auto p-5 sm:p-7 lg:p-8 transition-all duration-700 delay-100 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                        <div className="mb-7 flex items-center gap-3">
                            <div className="h-12 w-12 shrink-0 rounded-2xl border border-[var(--qm-border)] bg-white p-1.5 shadow-[var(--qm-shadow-sm)]">
                                <img
                                    src={qmessageLogo}
                                    alt="QMessage logo"
                                    className="h-full w-full rounded-xl object-contain"
                                    loading="eager"
                                />
                            </div>
                            <div className="min-w-0">
                                <p className="qm-eyebrow">QMessage SaaS</p>
                                <p className="truncate text-sm font-semibold text-[var(--qm-text-muted)]">WhatsApp Business workflow platform</p>
                            </div>
                        </div>

                        <div className="mb-6">
                            <h2 className="qm-section-title">
                                {mode === 'login' ? 'Sign in to your workspace' : 'Create your company workspace'}
                            </h2>
                            <p className="qm-section-copy mt-2">
                                {mode === 'login'
                                    ? 'Access inbox, automations, contacts, and settings from one dashboard.'
                                    : 'Set up a secure company owner account and launch your WABA workspace.'}
                            </p>
                        </div>

                        <div className="mb-6 grid grid-cols-2 gap-2 rounded-[18px] border border-[var(--qm-border)] bg-[#f2f7fd] p-1.5">
                            <button
                                type="button"
                                onClick={() => setMode('login')}
                                className={`h-11 rounded-[12px] text-sm font-extrabold transition-all ${mode === 'login' ? 'bg-white text-[var(--qm-brand)] shadow-[var(--qm-shadow-sm)]' : 'text-[var(--qm-text-muted)] hover:text-[var(--qm-text)]'}`}
                            >
                                Sign In
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode('signup')}
                                className={`h-11 rounded-[12px] text-sm font-extrabold transition-all ${mode === 'signup' ? 'bg-white text-[var(--qm-brand)] shadow-[var(--qm-shadow-sm)]' : 'text-[var(--qm-text-muted)] hover:text-[var(--qm-text)]'}`}
                            >
                                Create Company
                            </button>
                        </div>

                        <p className="mb-5 text-xs font-semibold text-[var(--qm-text-soft)]">
                            Flow: Company details to owner identity to workspace access
                        </p>

                        <form onSubmit={handleAuth} className="space-y-4">
                            <div>
                                <label className="qm-label mb-2">
                                    <Building2 className="h-3.5 w-3.5" />
                                    Company ID
                                </label>
                                <input
                                    type="text"
                                    placeholder="company-id"
                                    value={companyId}
                                    onChange={e => setCompanyId(e.target.value)}
                                    className="qm-input"
                                    required
                                />
                                {hostCompanyId && (
                                    <p className="mt-2 text-xs text-[var(--qm-text-muted)]">
                                        Subdomain detected:{' '}
                                        <span className="font-bold text-[var(--qm-text)]">{hostCompanyId}</span>
                                    </p>
                                )}
                                {mode === 'signup' && !hostCompanyId && (
                                    <p className="mt-2 text-xs text-[var(--qm-text-muted)]">
                                        Workspace URL preview:{' '}
                                        <span className="font-bold text-[var(--qm-text)]">{companyId.trim().toLowerCase() || 'company-id'}.2fast.xyz</span>
                                    </p>
                                )}
                            </div>

                            {mode === 'signup' && (
                                <div>
                                    <label className="qm-label mb-2">Company Name (Optional)</label>
                                    <input
                                        type="text"
                                        placeholder="Your Company Name"
                                        value={companyName}
                                        onChange={e => setCompanyName(e.target.value)}
                                        className="qm-input"
                                    />
                                </div>
                            )}

                            <div>
                                <label className="qm-label mb-2">Email Address</label>
                                <input
                                    type="email"
                                    placeholder="name@company.com"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    className="qm-input"
                                    required
                                />
                            </div>

                            <div>
                                <div className="mb-2 flex items-center justify-between">
                                    <label className="qm-label">
                                        <ShieldCheck className="h-3.5 w-3.5" />
                                        Password
                                    </label>
                                    {mode === 'login' && (
                                        <button
                                            type="button"
                                            className="text-xs font-bold text-[var(--qm-brand)] hover:underline"
                                        >
                                            Forgot Password?
                                        </button>
                                    )}
                                </div>
                                <input
                                    type="password"
                                    placeholder="Use at least 8 characters"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    className="qm-input"
                                    required
                                />
                            </div>

                            {activeMessage && (
                                <div className={`qm-status ${successMessage ? 'qm-status-success' : 'qm-status-error'} flex items-start gap-2`}>
                                    {successMessage ? (
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                    ) : (
                                        <span className="mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-black">!</span>
                                    )}
                                    <span>{activeMessage}</span>
                                </div>
                            )}

                            <button
                                disabled={loading}
                                className="qm-btn qm-btn-primary h-[52px] w-full"
                            >
                                {loading ? (
                                    <div className="h-5 w-5 rounded-full border-2 border-white/35 border-t-white animate-spin" />
                                ) : (
                                    <>
                                        <span>{mode === 'login' ? 'Access Dashboard' : 'Create Company and Sign In'}</span>
                                        <ArrowRight className="h-4 w-4" />
                                    </>
                                )}
                            </button>

                            {mode === 'login' && (
                                <button
                                    type="button"
                                    onClick={handleGoogleAuth}
                                    disabled={loading || googleLoading}
                                    className="qm-btn qm-btn-secondary h-[52px] w-full text-[0.8rem]"
                                >
                                    {googleLoading ? (
                                        <div className="h-5 w-5 rounded-full border-2 border-[#94a3b8] border-t-[#12253a] animate-spin" />
                                    ) : (
                                        <>
                                            <GoogleLogo />
                                            <span>Continue with Google</span>
                                        </>
                                    )}
                                </button>
                            )}
                        </form>

                        <div className="mt-auto pt-6 space-y-2 text-center text-sm text-[var(--qm-text-muted)]">
                            <p className="flex items-center justify-center gap-1.5">
                                <LifeBuoy className="h-4 w-4" />
                                Need help?{' '}
                                <a href="mailto:hello@2fast.xyz" className="font-bold text-[var(--qm-text)] hover:underline">hello@2fast.xyz</a>
                            </p>
                            <p className="text-xs">
                                <a href="/support" className="font-semibold text-[var(--qm-text)] hover:underline">Support</a>
                                {' | '}
                                <a href="/privacy-policy" className="font-semibold text-[var(--qm-text)] hover:underline">Privacy Policy</a>
                                {' | '}
                                <a href="/terms-and-conditions" className="font-semibold text-[var(--qm-text)] hover:underline">Terms and Conditions</a>
                            </p>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    )
}

