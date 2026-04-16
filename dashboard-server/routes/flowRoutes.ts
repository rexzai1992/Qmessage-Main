import type { Express } from 'express'

export function registerFlowRoutes(app: Express, ctx: any) {
    const {
        supabase,
        parseDateInput,
        toDayKey,
        lowerBound,
        WINDOW_MS,
        resolveProfileAccess,
        requireSupabaseUserMiddleware
    } = ctx

    const isMissingColumnInSchemaCache = (error: any, column: string): boolean => {
        const raw = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
        return raw.includes('schema cache') && raw.includes(`'${column.toLowerCase()}'`)
    }

    app.get('/health', (_req: any, res: any) => {
        res.send('Dashboard Server Running')
    })

    app.get('/api/flows', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return

            const { data, error } = await supabase
                .from('workflows')
                .select('*')
                .eq('company_id', access.companyId)

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }

            const workflows = (data || []).map((workflow: any) => {
                const builderEnabled =
                    typeof workflow?.builder?.meta?.enabled === 'boolean'
                        ? workflow.builder.meta.enabled
                        : undefined
                const builderName =
                    typeof workflow?.builder?.meta?.name === 'string'
                        ? workflow.builder.meta.name
                        : ''

                return {
                    ...workflow,
                    name: workflow?.name || builderName || '',
                    enabled: workflow?.enabled === false ? false : builderEnabled === false ? false : true
                }
            })

            return res.json({ workflows })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.post('/api/flows', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return

            const payload = req.body?.workflows || req.body
            if (!Array.isArray(payload)) {
                return res.status(400).json({ success: false, error: 'workflows array required' })
            }

            const toUpsert = payload.map((wf: any) => {
                const workflowName = typeof wf?.name === 'string' ? wf.name.trim() : ''
                const workflowEnabled = wf?.enabled !== false
                const runOnNewChat = wf?.run_on_new_chat === true || wf?.runOnNewChat === true
                const nextBuilder =
                    wf?.builder && typeof wf.builder === 'object' && !Array.isArray(wf.builder)
                        ? {
                            ...wf.builder,
                            meta: {
                                ...(wf.builder.meta && typeof wf.builder.meta === 'object' ? wf.builder.meta : {}),
                                name: workflowName,
                                enabled: workflowEnabled
                            }
                        }
                        : wf?.builder || null

                return {
                    id: wf.id,
                    company_id: access.companyId,
                    name: workflowName,
                    trigger_keyword: wf.trigger_keyword || wf.triggerKeyword || '',
                    run_on_new_chat: runOnNewChat,
                    actions: wf.actions || [],
                    builder: nextBuilder,
                    enabled: workflowEnabled
                }
            })

            let { error } = await supabase.from('workflows').upsert(toUpsert, { onConflict: 'id' })

            const missingEnabledColumn = error && isMissingColumnInSchemaCache(error, 'enabled')
            const missingNameColumn = error && isMissingColumnInSchemaCache(error, 'name')
            const missingRunOnNewChatColumn = error && isMissingColumnInSchemaCache(error, 'run_on_new_chat')
            if (error && (missingEnabledColumn || missingNameColumn || missingRunOnNewChatColumn)) {
                const withoutEnabled = toUpsert.map((workflow: any) => {
                    const next = { ...workflow }
                    if (missingEnabledColumn) delete next.enabled
                    if (missingNameColumn) delete next.name
                    if (missingRunOnNewChatColumn) delete next.run_on_new_chat
                    return next
                })
                const retry = await supabase.from('workflows').upsert(withoutEnabled, { onConflict: 'id' })
                error = retry.error
            }

            if (error) {
                return res.status(500).json({ success: false, error: error.message })
            }

            return res.json({ success: true })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message })
        }
    })

    app.get('/api/analytics', requireSupabaseUserMiddleware, async (req: any, res: any) => {
        try {
            const access = await resolveProfileAccess(req, res)
            if (!access) return
            const companyId = access.companyId

            const now = new Date()
            const startDate = parseDateInput(req.query.start) || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
            const endDate = parseDateInput(req.query.end, true) || now
            if (startDate.getTime() > endDate.getTime()) {
                return res.status(400).json({ success: false, error: 'Invalid date range' })
            }

            const { data: users, error: userError } = await supabase
                .from('users')
                .select('id, tags')
                .eq('company_id', companyId)

            if (userError) {
                return res.status(500).json({ success: false, error: userError.message })
            }

            const allTags = new Set<string>()
            ;(users || []).forEach((u: any) => {
                const tags = Array.isArray(u.tags) ? u.tags : []
                tags.forEach((t: any) => {
                    if (typeof t === 'string' && t.trim()) allTags.add(t.trim())
                })
            })

            const tagFilter = typeof req.query.tag === 'string' ? req.query.tag.trim() : ''
            const filteredUsers = tagFilter
                ? (users || []).filter((u: any) => Array.isArray(u.tags) && u.tags.includes(tagFilter))
                : (users || [])

            const userIds = filteredUsers.map((u: any) => u.id)
            if (userIds.length === 0) {
                return res.json({
                    success: true,
                    data: {
                        totals: { messages_total: 0, messages_sent: 0, workflow_runs: 0, expired_messages: 0 },
                        per_day: [],
                        per_staff: [],
                        tags: Array.from(allTags).sort()
                    }
                })
            }

            const startIso = startDate.toISOString()
            const endIso = endDate.toISOString()
            const lookbackIso = new Date(startDate.getTime() - WINDOW_MS).toISOString()

            const fetchMessages = async (fromIso: string, toIso: string) => {
                const chunkSize = 200
                const rows: any[] = []
                for (let i = 0; i < userIds.length; i += chunkSize) {
                    const chunk = userIds.slice(i, i + chunkSize)
                    const { data, error } = await supabase
                        .from('messages')
                        .select('user_id, direction, created_at, workflow_state, content')
                        .in('user_id', chunk)
                        .gte('created_at', fromIso)
                        .lte('created_at', toIso)

                    if (error) {
                        throw new Error(error.message)
                    }
                    rows.push(...(data || []))
                }
                return rows
            }

            const messagesInRange = await fetchMessages(startIso, endIso)
            const messagesForInbound = await fetchMessages(lookbackIso, endIso)

            const totals = {
                messages_total: 0,
                messages_sent: 0,
                workflow_runs: 0,
                expired_messages: 0
            }

            const perDayMap = new Map<string, { total: number; inbound: number; sent: number }>()
            const staffMap = new Map<
                string,
                {
                    user_id: string
                    name: string
                    color: string | null
                    sent: number
                    total_messages: number
                    workflow_runs: number
                    expired_messages: number
                    contacts: Set<string>
                    inbound_contacts: Set<string>
                    replied_contacts: Set<string>
                    response_time_total_ms: number
                    response_time_count: number
                    last_active_ts: number
                }
            >()

            const readAgent = (content: any): { user_id: string; name: string; color: string | null } | null => {
                const candidate = content?.agent || content?.payload?.agent
                if (!candidate || typeof candidate !== 'object') return null
                const userIdRaw = typeof candidate.user_id === 'string'
                    ? candidate.user_id
                    : typeof candidate.userId === 'string'
                        ? candidate.userId
                        : ''
                const userId = userIdRaw.trim()
                if (!userId) return null
                const nameRaw = typeof candidate.name === 'string' ? candidate.name.trim() : ''
                const colorRaw = typeof candidate.color === 'string' ? candidate.color.trim() : ''
                return {
                    user_id: userId,
                    name: nameRaw || userId,
                    color: colorRaw || null
                }
            }

            const ensureStaffRow = (agent: { user_id: string; name: string; color: string | null }) => {
                const existing = staffMap.get(agent.user_id)
                if (existing) {
                    if (!existing.name && agent.name) existing.name = agent.name
                    if (!existing.color && agent.color) existing.color = agent.color
                    return existing
                }
                const created = {
                    user_id: agent.user_id,
                    name: agent.name || agent.user_id,
                    color: agent.color,
                    sent: 0,
                    total_messages: 0,
                    workflow_runs: 0,
                    expired_messages: 0,
                    contacts: new Set<string>(),
                    inbound_contacts: new Set<string>(),
                    replied_contacts: new Set<string>(),
                    response_time_total_ms: 0,
                    response_time_count: 0,
                    last_active_ts: 0
                }
                staffMap.set(agent.user_id, created)
                return created
            }

            messagesInRange.forEach((msg: any) => {
                const createdAt = new Date(msg.created_at)
                const dayKey = toDayKey(createdAt)
                const row = perDayMap.get(dayKey) || { total: 0, inbound: 0, sent: 0 }
                row.total += 1
                if (msg.direction === 'out') row.sent += 1
                if (msg.direction === 'in') row.inbound += 1
                perDayMap.set(dayKey, row)

                totals.messages_total += 1
                if (msg.direction === 'out') totals.messages_sent += 1

                if (msg.direction === 'out') {
                    const agent = readAgent(msg.content)
                    if (agent) {
                        const staff = ensureStaffRow(agent)
                        staff.sent += 1
                        staff.total_messages += 1
                        if (msg.user_id) staff.contacts.add(String(msg.user_id))
                        if (!Number.isNaN(createdAt.getTime())) {
                            staff.last_active_ts = Math.max(staff.last_active_ts, createdAt.getTime())
                        }
                    }
                    const wfId = msg.workflow_state?.workflow_id || msg.workflow_state?.workflowId
                    const stepIndex = Number(msg.workflow_state?.step_index)
                    if (wfId && (!Number.isFinite(stepIndex) || stepIndex <= 1)) {
                        totals.workflow_runs += 1
                        if (agent) {
                            const staff = ensureStaffRow(agent)
                            staff.workflow_runs += 1
                        }
                    }
                }
            })

            const inboundMap = new Map<string, number[]>()
            messagesForInbound.forEach((msg: any) => {
                if (msg.direction !== 'in') return
                const arr = inboundMap.get(msg.user_id) || []
                const ts = new Date(msg.created_at).getTime()
                if (!Number.isNaN(ts)) arr.push(ts)
                inboundMap.set(msg.user_id, arr)
            })
            inboundMap.forEach((arr) => arr.sort((a, b) => a - b))

            messagesInRange.forEach((msg: any) => {
                if (msg.direction !== 'out') return
                const outTs = new Date(msg.created_at).getTime()
                if (Number.isNaN(outTs)) return
                const inboundTimes = inboundMap.get(msg.user_id) || []
                const lower = outTs - WINDOW_MS
                const idx = lowerBound(inboundTimes, lower)
                const hasWindowReplyCandidate = idx < inboundTimes.length && inboundTimes[idx] <= outTs
                if (!hasWindowReplyCandidate) {
                    totals.expired_messages += 1
                }

                const agent = readAgent(msg.content)
                if (!agent) return
                const staff = ensureStaffRow(agent)

                const upToNowIdx = lowerBound(inboundTimes, outTs + 1) - 1
                if (upToNowIdx >= 0 && msg.user_id) {
                    staff.inbound_contacts.add(String(msg.user_id))
                }
                if (hasWindowReplyCandidate && msg.user_id) {
                    staff.replied_contacts.add(String(msg.user_id))
                    const responseMs = outTs - inboundTimes[idx]
                    if (responseMs >= 0) {
                        staff.response_time_total_ms += responseMs
                        staff.response_time_count += 1
                    }
                } else {
                    staff.expired_messages += 1
                }
            })

            const per_day = Array.from(perDayMap.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, row]) => ({
                    date,
                    total: row.total,
                    inbound: row.inbound,
                    sent: row.sent
                }))

            const per_staff = Array.from(staffMap.values())
                .map((row) => {
                    const inboundContacts = row.inbound_contacts.size
                    const repliedContacts = row.replied_contacts.size
                    const replyRate = inboundContacts > 0 ? (repliedContacts / inboundContacts) * 100 : 0
                    const avgResponseSeconds = row.response_time_count > 0
                        ? Math.round((row.response_time_total_ms / row.response_time_count) / 1000)
                        : 0
                    const onlineWindowMs = 10 * 60 * 1000
                    const isOnline = row.last_active_ts > 0 && (Date.now() - row.last_active_ts) <= onlineWindowMs
                    return {
                        user_id: row.user_id,
                        name: row.name || row.user_id,
                        color: row.color,
                        sent: row.sent,
                        total_messages: row.total_messages,
                        workflow_runs: row.workflow_runs,
                        expired_messages: row.expired_messages,
                        contacts_messaged: row.contacts.size,
                        inbound_contacts: inboundContacts,
                        replied_contacts: repliedContacts,
                        reply_rate: Number(replyRate.toFixed(1)),
                        avg_response_seconds: avgResponseSeconds,
                        is_online: isOnline
                    }
                })
                .sort((a, b) => {
                    if (b.sent !== a.sent) return b.sent - a.sent
                    return a.name.localeCompare(b.name)
                })

            return res.json({
                success: true,
                data: {
                    totals,
                    per_day,
                    per_staff,
                    tags: Array.from(allTags).sort()
                }
            })
        } catch (error: any) {
            return res.status(500).json({ success: false, error: error.message || 'Failed to load analytics' })
        }
    })
}
