
import path from 'path'
import fs from 'fs'

// Default to 'data' folder in current working directory
export const DATA_DIR = path.join(process.cwd(), 'data')

// Ensure directory exists synchronously on startup
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        console.log(`Created data directory: ${DATA_DIR}`)
    } catch (e) {
        console.error(`Failed to create data directory at ${DATA_DIR}`, e)
    }
}

export function resolvePath(filename: string): string {
    // Remove ./ prefix if present
    const clean = filename.replace(/^\.\//, '')
    return path.join(DATA_DIR, clean)
}
