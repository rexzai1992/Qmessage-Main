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
        tokens.push(`<code class="qm-docs-inline-code">${escapeHtml(code)}</code>`)
        return token
    })

    output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
        const token = `__INLINE_LINK_${tokens.length}__`
        const safeHref = escapeHtml(String(href).trim())
        const safeLabel = escapeHtml(String(label).trim())
        const external = /^https?:\/\//i.test(String(href).trim())
        tokens.push(`<a class="qm-docs-link" href="${safeHref}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${safeLabel}</a>`)
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
                `<pre class="qm-docs-code"${language ? ` data-language="${escapeHtml(language)}"` : ''}><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`
            )
            continue
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
        if (headingMatch) {
            const level = headingMatch[1].length
            const text = headingMatch[2].trim()
            const slug = slugifyHeading(text)
            tocEntries.push({ level, text, slug })
            blocks.push(`<h${level} class="qm-docs-heading qm-docs-heading-${level}" id="${slug}">${renderInlineMarkdown(text)}</h${level}>`)
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

            const headerHtml = headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')
            const bodyHtml = rowLines
                .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
                .join('')

            blocks.push(`<div class="qm-docs-table-wrap"><table class="qm-docs-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`)
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
            return `<a class="qm-docs-toc-link qm-docs-toc-level-${entry.level}" href="#${entry.slug}">${escapeHtml(entry.text)}</a>`
        })
        .join('')

    return {
        bodyHtml: blocks.join('\n'),
        tocHtml
    }
}

function renderDocsStyles(): string {
    return `<style>
  .qm-docs-page {
    min-height: 100vh;
    margin: 0;
    overflow-x: hidden;
    color: var(--qm-text, #12253a);
    background:
      radial-gradient(circle at 10% 0%, rgba(14, 164, 122, 0.16), transparent 30%),
      radial-gradient(circle at 92% 8%, rgba(42, 110, 244, 0.14), transparent 28%),
      linear-gradient(180deg, #f7faff 0%, #f4f8fc 55%, #f6f8fb 100%);
    font-family: var(--qm-font-body, "Manrope", "Segoe UI", Arial, sans-serif);
  }

  .qm-docs-page * {
    box-sizing: border-box;
  }

  .qm-docs-frame {
    width: min(100%, 1320px);
    margin: 0 auto;
    padding: clamp(16px, 2vw, 28px) clamp(14px, 2.2vw, 26px) 44px;
  }

  .qm-docs-stack {
    display: grid;
    gap: 20px;
    min-width: 0;
  }

  .qm-docs-hero {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--qm-border, #dde5f0);
    border-radius: 30px;
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(248, 252, 255, 0.94)),
      radial-gradient(circle at 92% 0%, rgba(14, 164, 122, 0.14), transparent 32%);
    box-shadow: var(--qm-shadow-lg, 0 24px 54px rgba(17, 35, 60, 0.14));
    padding: clamp(22px, 3vw, 38px);
  }

  .qm-docs-hero::after {
    content: "";
    position: absolute;
    inset: auto -90px -120px auto;
    width: 280px;
    height: 280px;
    border-radius: 999px;
    background: rgba(42, 110, 244, 0.08);
    pointer-events: none;
  }

  .qm-docs-hero-grid {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
    gap: 22px;
    align-items: end;
  }

  .qm-docs-eyebrow {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(14, 164, 122, 0.2);
    border-radius: 999px;
    background: rgba(216, 246, 236, 0.72);
    color: #0f805f;
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.14em;
    padding: 7px 11px;
    text-transform: uppercase;
  }

  .qm-docs-title {
    max-width: 860px;
    margin: 14px 0 0;
    color: var(--qm-text, #12253a);
    font-family: var(--qm-font-display, "Sora", "Segoe UI", Arial, sans-serif);
    font-size: clamp(2rem, 4vw, 4rem);
    letter-spacing: -0.05em;
    line-height: 0.98;
    overflow-wrap: break-word;
  }

  .qm-docs-subtitle {
    max-width: 820px;
    margin: 16px 0 0;
    color: var(--qm-text-muted, #586b82);
    font-size: clamp(0.98rem, 1vw, 1.08rem);
    line-height: 1.65;
  }

  .qm-docs-meta-card {
    min-width: 0;
    border: 1px solid #dfe8f3;
    border-radius: 22px;
    background: rgba(255, 255, 255, 0.72);
    box-shadow: var(--qm-shadow-sm, 0 4px 14px rgba(17, 35, 60, 0.06));
    padding: 18px;
    backdrop-filter: blur(8px);
  }

  .qm-docs-meta-label {
    display: block;
    margin-bottom: 8px;
    color: var(--qm-text-soft, #7a8ba0);
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .qm-docs-meta-label-spaced {
    margin-top: 18px;
  }

  .qm-docs-meta-value {
    color: var(--qm-text, #12253a);
    font-weight: 800;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .qm-docs-layout {
    display: grid;
    grid-template-columns: minmax(220px, 290px) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
    min-width: 0;
  }

  .qm-docs-toc {
    position: sticky;
    top: 20px;
    max-height: calc(100vh - 40px);
    overflow: auto;
    border: 1px solid var(--qm-border, #dde5f0);
    border-radius: 24px;
    background: rgba(255, 255, 255, 0.88);
    box-shadow: var(--qm-shadow-sm, 0 4px 14px rgba(17, 35, 60, 0.06));
    padding: 16px;
  }

  .qm-docs-toc-title {
    margin: 0 0 12px;
    color: var(--qm-text-soft, #7a8ba0);
    font-size: 0.7rem;
    font-weight: 900;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .qm-docs-toc-list {
    display: grid;
    gap: 2px;
  }

  .qm-docs-toc-link {
    display: block;
    border-radius: 12px;
    color: var(--qm-text-muted, #586b82);
    font-size: 0.82rem;
    font-weight: 750;
    line-height: 1.35;
    padding: 8px 10px;
    text-decoration: none;
    transition: background-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
    overflow-wrap: anywhere;
  }

  .qm-docs-toc-link:hover {
    background: #edf6ff;
    color: var(--qm-text, #12253a);
    transform: translateX(1px);
  }

  .qm-docs-toc-level-1 {
    color: var(--qm-text, #12253a);
    font-weight: 900;
  }

  .qm-docs-toc-level-2 {
    padding-left: 18px;
  }

  .qm-docs-toc-level-3 {
    padding-left: 30px;
    color: var(--qm-text-soft, #7a8ba0);
    font-size: 0.76rem;
  }

  .qm-docs-article {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--qm-border, #dde5f0);
    border-radius: 28px;
    background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
    box-shadow: var(--qm-shadow-lg, 0 24px 54px rgba(17, 35, 60, 0.14));
    padding: clamp(22px, 3vw, 40px);
  }

  .qm-docs-content {
    min-width: 0;
    max-width: 100%;
    color: var(--qm-text, #12253a);
    font-size: 0.96rem;
    line-height: 1.78;
  }

  .qm-docs-content > *:first-child {
    margin-top: 0;
  }

  .qm-docs-content p {
    margin: 0 0 16px;
    color: var(--qm-text-muted, #586b82);
    overflow-wrap: break-word;
  }

  .qm-docs-heading {
    scroll-margin-top: 24px;
    max-width: 920px;
    color: var(--qm-text, #12253a);
    font-family: var(--qm-font-display, "Sora", "Segoe UI", Arial, sans-serif);
    letter-spacing: -0.025em;
    overflow-wrap: anywhere;
  }

  .qm-docs-heading-1 {
    margin: 0 0 18px;
    font-size: clamp(1.55rem, 2.5vw, 2.35rem);
    line-height: 1.08;
  }

  .qm-docs-heading-2 {
    margin: 34px 0 12px;
    padding-top: 22px;
    border-top: 1px solid #e7eef6;
    font-size: clamp(1.24rem, 2vw, 1.72rem);
    line-height: 1.16;
  }

  .qm-docs-heading-3 {
    margin: 26px 0 10px;
    font-size: 1.08rem;
    line-height: 1.28;
  }

  .qm-docs-heading-4,
  .qm-docs-heading-5,
  .qm-docs-heading-6 {
    margin: 22px 0 8px;
    font-size: 0.96rem;
    line-height: 1.3;
  }

  .qm-docs-content ul,
  .qm-docs-content ol {
    margin: 0 0 18px;
    padding-left: 1.25rem;
    color: var(--qm-text-muted, #586b82);
  }

  .qm-docs-content li {
    margin: 7px 0;
    padding-left: 3px;
    overflow-wrap: break-word;
  }

  .qm-docs-link {
    color: var(--qm-accent, #2a6ef4);
    font-weight: 800;
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .qm-docs-link:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .qm-docs-inline-code {
    display: inline;
    max-width: 100%;
    border: 1px solid #d8e3f2;
    border-radius: 8px;
    background: rgba(42, 110, 244, 0.08);
    color: var(--qm-text, #12253a);
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.9em;
    padding: 0.1em 0.38em;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .qm-docs-code {
    position: relative;
    max-width: 100%;
    margin: 18px 0 24px;
    overflow-x: auto;
    overflow-y: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 20px;
    background:
      linear-gradient(135deg, rgba(42, 110, 244, 0.12), transparent 38%),
      #12253a;
    color: #f8fbff;
    box-shadow: 0 18px 38px rgba(18, 37, 58, 0.18);
    padding: 18px;
    white-space: pre;
    -webkit-overflow-scrolling: touch;
  }

  .qm-docs-code code {
    display: block;
    min-width: max-content;
    border: 0;
    background: transparent;
    color: inherit;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.86rem;
    line-height: 1.72;
    padding: 0;
    white-space: pre;
  }

  .qm-docs-table-wrap {
    max-width: 100%;
    margin: 18px 0 24px;
    overflow-x: auto;
    border: 1px solid #dfe8f3;
    border-radius: 20px;
    background: #ffffff;
    box-shadow: var(--qm-shadow-sm, 0 4px 14px rgba(17, 35, 60, 0.06));
    -webkit-overflow-scrolling: touch;
  }

  .qm-docs-table {
    width: 100%;
    min-width: 620px;
    border-collapse: collapse;
  }

  .qm-docs-table th,
  .qm-docs-table td {
    padding: 13px 15px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid #edf2f7;
    overflow-wrap: anywhere;
  }

  .qm-docs-table th {
    background: #f3f9f7;
    color: var(--qm-text-soft, #7a8ba0);
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .qm-docs-table td {
    color: var(--qm-text, #12253a);
    font-size: 0.9rem;
    line-height: 1.55;
  }

  .qm-docs-table tr:last-child td {
    border-bottom: 0;
  }

  .qm-docs-footer {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid var(--qm-border, #dde5f0);
  }

  .qm-docs-footer .qm-btn {
    text-decoration: none;
  }

  @media (max-width: 900px) {
    .qm-docs-hero-grid,
    .qm-docs-layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .qm-docs-toc {
      position: static;
      max-height: none;
    }
  }

  @media (max-width: 520px) {
    .qm-docs-frame {
      padding: 12px 10px 30px;
    }

    .qm-docs-hero,
    .qm-docs-article,
    .qm-docs-toc {
      border-radius: 20px;
    }

    .qm-docs-hero,
    .qm-docs-article {
      padding: 18px;
    }

    .qm-docs-title {
      font-size: clamp(1.55rem, 9.5vw, 2.05rem);
      letter-spacing: -0.04em;
      line-height: 1.04;
    }

    .qm-docs-table {
      min-width: 560px;
    }

    .qm-docs-code {
      border-radius: 16px;
      padding: 14px;
    }

    .qm-docs-footer .qm-btn {
      width: 100%;
    }
  }
</style>`
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
    const docsStyles = renderDocsStyles()

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QMessage API Reference</title>${dashboardStylesheetTag}
  ${docsStyles}
</head>
<body class="qm-docs-page">
  <div class="qm-docs-frame">
    <div class="qm-docs-stack">
      <header class="qm-docs-hero">
        <div class="qm-docs-hero-grid">
          <div>
            <span class="qm-docs-eyebrow">Backend-Owned API</span>
            <h1 class="qm-docs-title">QMessage Runtime API Reference</h1>
            <p class="qm-docs-subtitle">Public reference for the live Express backend. This page covers authentication, route parameters, payloads, examples, diagnostics, and current Meta WhatsApp calling behavior.</p>
          </div>
          <aside class="qm-docs-meta-card" aria-label="Documentation metadata">
            <span class="qm-docs-meta-label">Endpoint</span>
            <div class="qm-docs-meta-value">Available online at <code class="qm-docs-inline-code">/docs/api/</code></div>
            <span class="qm-docs-meta-label qm-docs-meta-label-spaced">Last Updated</span>
            <div class="qm-docs-meta-value">${escapeHtml(updatedAt)}</div>
          </aside>
        </div>
      </header>
      <main class="qm-docs-layout">
        <nav class="qm-docs-toc" aria-label="Table of contents">
          <p class="qm-docs-toc-title">On This Page</p>
          <div class="qm-docs-toc-list">${tocHtml}</div>
        </nav>
        <article class="qm-docs-article">
          <div class="qm-docs-content">${bodyHtml}</div>
          <div class="qm-docs-footer">
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
