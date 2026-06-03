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
        tokens.push(`<code>${escapeHtml(code)}</code>`)
        return token
    })

    output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
        const token = `__INLINE_LINK_${tokens.length}__`
        const safeHref = escapeHtml(String(href).trim())
        const safeLabel = escapeHtml(String(label).trim())
        const external = /^https?:\/\//i.test(String(href).trim())
        tokens.push(`<a href="${safeHref}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${safeLabel}</a>`)
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
                `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`
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

            const headerHtml = headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')
            const bodyHtml = rowLines
                .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
                .join('')

            blocks.push(`<div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`)
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
        .map((entry) => `<a class="toc-link level-${entry.level}" href="#${entry.slug}">${escapeHtml(entry.text)}</a>`)
        .join('')

    return {
        bodyHtml: blocks.join('\n'),
        tocHtml
    }
}

function renderApiDocsPage(markdown: string, updatedAt: string): string {
    const { bodyHtml, tocHtml } = renderMarkdownToHtml(markdown)

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Reference · 2fast</title>
  <style>
    :root {
      --bg: #eef4f2;
      --surface: #ffffff;
      --surface-soft: #f7fbfa;
      --line: #d8e6e1;
      --text: #102a24;
      --muted: #52706a;
      --brand: #0f8f72;
      --brand-deep: #0b6f59;
      --code: #0f172a;
      --code-bg: #f3f7fb;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background:
        radial-gradient(circle at top left, rgba(15, 143, 114, 0.12), transparent 34%),
        linear-gradient(180deg, #f4faf8 0%, var(--bg) 100%);
      color: var(--text);
    }
    a { color: var(--brand-deep); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .hero {
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 20px 18px;
    }
    .eyebrow {
      display: inline-block;
      padding: 6px 12px;
      border: 1px solid #c8dfd7;
      border-radius: 999px;
      background: rgba(255,255,255,0.72);
      color: var(--brand-deep);
      font: 700 11px/1.2 Arial, sans-serif;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 20px;
      align-items: end;
      margin-top: 14px;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(34px, 5vw, 58px);
      line-height: 0.96;
      letter-spacing: -0.04em;
    }
    .hero p {
      margin: 12px 0 0;
      max-width: 780px;
      font: 15px/1.7 Arial, sans-serif;
      color: var(--muted);
    }
    .meta-card {
      padding: 16px 18px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255,255,255,0.84);
      backdrop-filter: blur(8px);
      box-shadow: 0 20px 50px rgba(16, 42, 36, 0.08);
      font: 13px/1.6 Arial, sans-serif;
      color: var(--muted);
    }
    .meta-card strong {
      display: block;
      color: var(--text);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 6px;
    }
    .layout {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 20px 40px;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 20px;
    }
    .toc,
    .content {
      border: 1px solid var(--line);
      border-radius: 22px;
      background: rgba(255,255,255,0.9);
      box-shadow: 0 20px 50px rgba(16, 42, 36, 0.08);
    }
    .toc {
      position: sticky;
      top: 20px;
      align-self: start;
      padding: 18px;
      font-family: Arial, sans-serif;
    }
    .toc-title {
      margin: 0 0 12px;
      font-size: 12px;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 800;
    }
    .toc-links {
      display: grid;
      gap: 8px;
    }
    .toc-link {
      display: block;
      color: var(--text);
      border-radius: 10px;
      padding: 8px 10px;
      background: transparent;
      font-size: 13px;
      line-height: 1.4;
    }
    .toc-link:hover {
      background: var(--surface-soft);
      text-decoration: none;
    }
    .toc-link.level-2 { margin-left: 10px; color: var(--muted); }
    .toc-link.level-3 { margin-left: 20px; color: var(--muted); font-size: 12px; }
    .content {
      padding: 28px;
      overflow: hidden;
    }
    .content h1,
    .content h2,
    .content h3,
    .content h4,
    .content h5,
    .content h6 {
      scroll-margin-top: 90px;
      margin-top: 34px;
      margin-bottom: 14px;
      line-height: 1.1;
      letter-spacing: -0.03em;
    }
    .content h1:first-child,
    .content h2:first-child {
      margin-top: 0;
    }
    .content h1 { font-size: 40px; }
    .content h2 {
      padding-top: 20px;
      border-top: 1px solid #e7efec;
      font-size: 30px;
    }
    .content h3 { font-size: 24px; }
    .content h4 { font-size: 19px; }
    .content p,
    .content li {
      font: 15px/1.72 Arial, sans-serif;
      color: #17332d;
    }
    .content p { margin: 0 0 14px; }
    .content ul,
    .content ol {
      margin: 0 0 18px 20px;
      padding: 0;
    }
    .content li + li { margin-top: 6px; }
    .content code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.92em;
      background: var(--code-bg);
      color: var(--code);
      border: 1px solid #dbe6f2;
      border-radius: 6px;
      padding: 0.1em 0.4em;
    }
    .content pre {
      margin: 16px 0 22px;
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 16px;
      padding: 18px;
      overflow: auto;
      border: 1px solid #1e293b;
    }
    .content pre code {
      background: transparent;
      color: inherit;
      border: 0;
      padding: 0;
      font-size: 13px;
      line-height: 1.6;
      display: block;
    }
    .table-wrap {
      overflow-x: auto;
      margin: 16px 0 24px;
      border: 1px solid var(--line);
      border-radius: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font: 13px/1.5 Arial, sans-serif;
      background: white;
    }
    th, td {
      text-align: left;
      vertical-align: top;
      padding: 12px 14px;
      border-bottom: 1px solid #e6efec;
    }
    th {
      background: #f6fbf9;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .08em;
      font-size: 11px;
    }
    tr:last-child td { border-bottom: 0; }
    .footer-nav {
      margin-top: 28px;
      padding-top: 18px;
      border-top: 1px solid #e7efec;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      font: 12px/1.4 Arial, sans-serif;
    }
    .footer-link {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid #d6e5e0;
      background: #f3faf7;
      padding: 8px 12px;
      color: var(--brand-deep);
      font-weight: 700;
    }
    @media (max-width: 960px) {
      .hero-grid,
      .layout {
        grid-template-columns: 1fr;
      }
      .toc {
        position: static;
      }
    }
  </style>
</head>
<body>
  <header class="hero">
    <span class="eyebrow">Official Meta API</span>
    <div class="hero-grid">
      <div>
        <h1>Q Message Runtime API Reference</h1>
        <p>Public reference for the live Express backend. This page covers authentication, route parameters, payloads, examples, and the current signaling-first limitations for Meta WhatsApp calling.</p>
      </div>
      <aside class="meta-card">
        <strong>Endpoint</strong>
        Available online at <code>/docs/api/</code>
        <br /><br />
        <strong>Last Updated</strong>
        ${escapeHtml(updatedAt)}
      </aside>
    </div>
  </header>
  <main class="layout">
    <nav class="toc" aria-label="Table of contents">
      <div class="toc-title">On This Page</div>
      <div class="toc-links">${tocHtml}</div>
    </nav>
    <article class="content">
      ${bodyHtml}
      <div class="footer-nav">
        <a class="footer-link" href="/api/public/config">Public Config JSON</a>
        <a class="footer-link" href="/api/v1/public/config">Versioned Config JSON</a>
        <a class="footer-link" href="/support">Support</a>
        <a class="footer-link" href="/">Back to Login</a>
      </div>
    </article>
  </main>
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
