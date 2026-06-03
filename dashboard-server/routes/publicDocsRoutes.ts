import fs from 'fs'
import path from 'path'
import type { Express } from 'express'

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function slugifyHeading(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

function renderInlineMarkdown(input: string): string {
    const tokens: string[] = []
    let output = escapeHtml(input)

    output = output.replace(/`([^`]+)`/g, (_match, code) => {
        const token = `__INLINE_CODE_${tokens.length}__`
        tokens.push(`<code style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 0.92em; background: rgba(42, 110, 244, 0.08); color: var(--qm-text); border: 1px solid var(--qm-border); border-radius: 8px; padding: 0.1em 0.4em;">${escapeHtml(code)}</code>`)
        return token
    })

    output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
        const token = `__INLINE_LINK_${tokens.length}__`
        const safeHref = escapeHtml(String(href).trim())
        const safeLabel = escapeHtml(String(label).trim())
        const external = /^https?:\/\//i.test(String(href).trim())
        tokens.push(`<a href="${safeHref}"${external ? ' target="_blank" rel="noreferrer"' : ''} style="color: var(--qm-accent); font-weight: 700; text-decoration: none;">${safeLabel}</a>`)
        return token
    })

    output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

    tokens.forEach((tokenHtml, index) => {
        output = output.replace(`__INLINE_CODE_${index}__`, tokenHtml)
        output = output.replace(`__INLINE_LINK_${index}__`, tokenHtml)
    })

    return output
}

function isTableSeparator(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.includes('|')) return false
    return trimmed
        .replace(/\|/g, '')
        .split('')
        .every((char) => char === '-' || char === ':' || char === ' ')
}

function splitMarkdownTableRow(line: string): string[] {
    return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
}

function renderMarkdownToHtml(markdown: string): { bodyHtml: string; tocHtml: string } {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n')
    const blocks: string[] = []
    const tocEntries: Array<{ level: number; text: string; slug: string }> = []

    let index = 0
    while (index < lines.length) {
        const rawLine = lines[index] ?? ''
        const line = rawLine.trimEnd()
        const trimmed = line.trim()

        if (!trimmed) {
            index += 1
            continue
        }

        if (trimmed.startsWith('```')) {
            const language = trimmed.slice(3).trim().toLowerCase()
            const codeLines: string[] = []
            index += 1
            while (index < lines.length && !lines[index].trim().startsWith('```')) {
                codeLines.push(lines[index])
                index += 1
            }
            if (index < lines.length) index += 1
            blocks.push(
                `<pre class="qm-card" style="margin: 18px 0 24px; padding: 18px; overflow: auto; background: #12253a; color: #f8fbff; border-color: rgba(255, 255, 255, 0.06);"><code${language ? ` class="language-${escapeHtml(language)}"` : ''} style="background: transparent; color: inherit; border: 0; padding: 0; font-size: 0.9rem; line-height: 1.65; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; display: block;">${escapeHtml(codeLines.join('\n'))}</code></pre>`
            )
            continue
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
        if (headingMatch) {
            const level = headingMatch[1].length
            const text = headingMatch[2].trim()
            const slug = slugifyHeading(text)
            tocEntries.push({ level, text, slug })
            blocks.push(`<h${level} id="${slug}">${renderInlineMarkdown(text)}</h${level}>`)
            index += 1
            continue
        }

        if (index + 1 < lines.length && trimmed.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
            const headerCells = splitMarkdownTableRow(trimmed)
            const rowLines: string[][] = []
            index += 2
            while (index < lines.length) {
                const candidate = (lines[index] ?? '').trim()
                if (!candidate || !candidate.includes('|')) break
                rowLines.push(splitMarkdownTableRow(candidate))
                index += 1
            }

            const headerHtml = headerCells.map((cell) => `<th style="padding: 12px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--qm-border); background: rgba(14, 164, 122, 0.06); color: var(--qm-text-soft); font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase;">${renderInlineMarkdown(cell)}</th>`).join('')
            const bodyHtml = rowLines
                .map((cells) => `<tr>${cells.map((cell) => `<td style="padding: 12px 14px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--qm-border); color: var(--qm-text);">${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
                .join('')

            blocks.push(`<div class="qm-card-soft" style="overflow-x: auto; margin: 18px 0 24px;"><table style="width: 100%; border-collapse: collapse;"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`)
            continue
        }

        const bulletMatch = trimmed.match(/^[-*+]\s+(.*)$/)
        if (bulletMatch) {
            const items: string[] = []
            while (index < lines.length) {
                const current = (lines[index] ?? '').trim()
                const match = current.match(/^[-*+]\s+(.*)$/)
                if (!match) break
                items.push(`<li>${renderInlineMarkdown(match[1])}</li>`)
                index += 1
            }
            blocks.push(`<ul>${items.join('')}</ul>`)
            continue
        }

        const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/)
        if (orderedMatch) {
            const items: string[] = []
            while (index < lines.length) {
                const current = (lines[index] ?? '').trim()
                const match = current.match(/^\d+\.\s+(.*)$/)
                if (!match) break
                items.push(`<li>${renderInlineMarkdown(match[1])}</li>`)
                index += 1
            }
            blocks.push(`<ol>${items.join('')}</ol>`)
            continue
        }

        const paragraphLines: string[] = [trimmed]
        index += 1
        while (index < lines.length) {
            const nextLine = (lines[index] ?? '').trim()
            if (!nextLine) {
                index += 1
                break
            }
            if (
                nextLine.startsWith('```')
                || /^#{1,6}\s+/.test(nextLine)
                || /^[-*+]\s+/.test(nextLine)
                || /^\d+\.\s+/.test(nextLine)
                || (nextLine.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? ''))
            ) {
                break
            }
            paragraphLines.push(nextLine)
            index += 1
        }
        blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`)
    }

    const tocHtml = tocEntries
        .filter((entry) => entry.level <= 3)
        .map((entry) => {
            const paddingLeft = entry.level === 1 ? 14 : entry.level === 2 ? 24 : 34
            const fontSize = entry.level === 1 ? '0.84rem' : entry.level === 2 ? '0.8rem' : '0.76rem'
            const textColor = entry.level === 1 ? 'var(--qm-text)' : 'var(--qm-text-muted)'
            return `<a class="qm-card-soft" href="#${entry.slug}" style="display: block; padding: 10px 14px 10px ${paddingLeft}px; text-decoration: none; font-size: ${fontSize}; font-weight: 700; color: ${textColor};">${escapeHtml(entry.text)}</a>`
        })
        .join('')

    return {
        bodyHtml: blocks.join('\n'),
        tocHtml
    }
}

function resolveDashboardStylesheetHref(): string | null {
    const dashboardIndexPath = path.join(process.cwd(), 'dashboard', 'dist', 'index.html')
    if (!fs.existsSync(dashboardIndexPath)) {
        return null
    }

    try {
        const dashboardIndexHtml = fs.readFileSync(dashboardIndexPath, 'utf-8')
        const stylesheetMatch = dashboardIndexHtml.match(/<link\s+rel="stylesheet"[^>]*href="([^"]+)"/i)
        return stylesheetMatch?.[1] ?? null
    } catch {
        return null
    }
}

function renderApiDocsPage(markdown: string, updatedAt: string): string {
    const { bodyHtml, tocHtml } = renderMarkdownToHtml(markdown)
    const dashboardStylesheetHref = resolveDashboardStylesheetHref()
    const dashboardStylesheetTag = dashboardStylesheetHref
        ? `\n  <link rel="stylesheet" crossorigin href="${escapeHtml(dashboardStylesheetHref)}" />`
        : ''

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QMessage API Reference</title>${dashboardStylesheetTag}
</head>
<body class="qm-app-gradient">
  <div style="min-height: 100vh; padding: 24px 20px 40px;">
    <div style="max-width: 1280px; margin: 0 auto; display: grid; gap: 20px;">
      <header class="qm-shell" style="padding: 28px;">
        <div style="display: flex; gap: 18px; flex-wrap: wrap; align-items: end; justify-content: space-between;">
          <div style="display: grid; gap: 12px; flex: 1 1 620px; min-width: 0;">
            <span class="qm-eyebrow">Backend-Owned API</span>
            <div class="qm-title" style="max-width: 860px;">QMessage Runtime API Reference</div>
            <p class="qm-subtitle" style="margin: 0; max-width: 860px;">Public reference for the live Express backend. This page uses the same web styling as the dashboard and covers authentication, route parameters, payloads, examples, and the current signaling-first limitations for Meta WhatsApp calling.</p>
          </div>
          <aside class="qm-card-soft" style="padding: 18px; flex: 0 1 320px; min-width: min(100%, 260px);">
            <div class="qm-label" style="margin-bottom: 10px;">Endpoint</div>
            <div style="font-weight: 700; color: var(--qm-text); word-break: break-word;">Available online at <code style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; background: rgba(42, 110, 244, 0.08); padding: 2px 6px; border-radius: 8px; border: 1px solid var(--qm-border);">/docs/api/</code></div>
            <div class="qm-label" style="margin: 18px 0 10px;">Last Updated</div>
            <div style="color: var(--qm-text-muted); font-weight: 600;">${escapeHtml(updatedAt)}</div>
          </aside>
        </div>
      </header>
      <main style="display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start;">
        <nav class="qm-card" aria-label="Table of contents" style="position: sticky; top: 20px; padding: 18px; flex: 0 1 300px; width: min(100%, 300px);">
          <div class="qm-label" style="margin-bottom: 14px;">On This Page</div>
          <div style="display: grid; gap: 8px;">${tocHtml}</div>
        </nav>
        <article class="qm-shell" style="padding: 28px; overflow: hidden; flex: 1 1 760px; min-width: 0;">
          <div style="display: grid; gap: 12px; color: var(--qm-text); line-height: 1.72;">${bodyHtml}</div>
          <div style="margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--qm-border); display: flex; flex-wrap: wrap; gap: 10px;">
            <a class="qm-btn qm-btn-secondary" href="/api/public/config">Public Config JSON</a>
            <a class="qm-btn qm-btn-secondary" href="/api/v1/public/config">Versioned Config JSON</a>
            <a class="qm-btn qm-btn-secondary" href="/support">Support</a>
            <a class="qm-btn qm-btn-secondary" href="/">Back to Login</a>
          </div>
        </article>
      </main>
    </div>
  </div>
</body>
</html>`
}

export function registerPublicDocsRoutes(app: Express) {
    const apiDocsPath = path.join(process.cwd(), 'docs', '23-official-meta-api-reference.md')

    app.get(['/docs/api', '/docs/api/'], (_req: any, res: any) => {
        if (!fs.existsSync(apiDocsPath)) {
            return res.status(404).send('API documentation file not found.')
        }

        const markdown = fs.readFileSync(apiDocsPath, 'utf-8')
        const stats = fs.statSync(apiDocsPath)
        const updatedAt = stats.mtime.toISOString()

        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'public, max-age=60')
        return res.send(renderApiDocsPage(markdown, updatedAt))
    })
}
