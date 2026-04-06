import path from 'path'
import fs from 'fs'

export const DATA_DIR = path.join(process.cwd(), process.env.WONDERPARK_DATA_DIR || 'data-wonderpark')

if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        console.log(`[Wonderpark] Created data directory: ${DATA_DIR}`)
    } catch (e) {
        console.error(`[Wonderpark] Failed to create data directory at ${DATA_DIR}`, e)
    }
}

export function resolvePath(filename: string): string {
    const clean = filename.replace(/^\.\//, '')
    return path.join(DATA_DIR, clean)
}
