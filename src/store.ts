
import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { resolvePath } from './config'

export class JSONStore {
    private cache: Map<string, any> = new Map()
    private writeQueue: Map<string, NodeJS.Timeout> = new Map()
    private filePaths: Map<string, string> = new Map()

    constructor() { }

    /**
     * Get data from cache or load from file if not cached
     */
    public get<T>(key: string, filePath: string, defaultValue: T): T {
        this.filePaths.set(key, filePath)

        if (!this.cache.has(key)) {
            if (fs.existsSync(filePath)) {
                try {
                    const data = fs.readFileSync(filePath, 'utf-8')
                    this.cache.set(key, JSON.parse(data))
                } catch (e) {
                    console.error(`Error reading file ${filePath}:`, e)
                    this.cache.set(key, defaultValue)
                }
            } else {
                this.cache.set(key, defaultValue)
            }
        }

        return this.cache.get(key) as T
    }

    /**
     * Update data in cache and schedule a background write
     */
    public set(key: string, data: any): void {
        this.cache.set(key, data)
        this.scheduleWrite(key)
    }

    /**
     * Force write data to disk immediately (async)
     */
    public async flush(key: string): Promise<void> {
        if (this.writeQueue.has(key)) {
            clearTimeout(this.writeQueue.get(key))
            this.writeQueue.delete(key)
        }
        await this.writeToFile(key)
    }

    private scheduleWrite(key: string) {
        if (this.writeQueue.has(key)) {
            return // Already scheduled
        }

        const timeout = setTimeout(async () => {
            this.writeQueue.delete(key)
            await this.writeToFile(key)
        }, 1000) // 1 second debounce

        this.writeQueue.set(key, timeout)
    }

    private async writeToFile(key: string) {
        const filePath = this.filePaths.get(key)
        const data = this.cache.get(key)

        if (!filePath || data === undefined) return

        try {
            await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2))
        } catch (e) {
            console.error(`Error writing file ${filePath}:`, e)
        }
    }

    // Specialized helpers for the dashboard

    public getProfiles(filePath: string): any[] {
        return this.get<any[]>('profiles', filePath, [{ id: 'default', name: 'Default Profile', unreadCount: 0 }])
    }

    public saveProfiles(profiles: any[]) {
        this.set('profiles', profiles)
    }

    public getContacts(profileId: string): Record<string, string> {
        return this.get<Record<string, string>>(`contacts:${profileId}`, resolvePath(`contacts_${profileId}.json`), {})
    }

    public saveContacts(profileId: string, contacts: any) {
        this.set(`contacts:${profileId}`, contacts)
    }

    public getMessages(profileId: string): any[] {
        return this.get<any[]>(`messages:${profileId}`, resolvePath(`messages_${profileId}.json`), [])
    }

    public addMessage(profileId: string, message: any) {
        const messages = this.getMessages(profileId)
        messages.push(message)
        if (messages.length > 1000) messages.shift()
        // We modify the array in place (reference), so strictly speaking we just need to trigger a save
        // But for consistency we call set
        this.set(`messages:${profileId}`, messages)
    }

    public deleteProfileData(profileId: string) {
        // Remove from cache
        this.cache.delete(`contacts:${profileId}`)
        this.cache.delete(`messages:${profileId}`)
        this.cache.delete(`flows:${profileId}`)
        this.cache.delete(`sessions:${profileId}`)

        // Clear any pending writes
        if (this.writeQueue.has(`contacts:${profileId}`)) clearTimeout(this.writeQueue.get(`contacts:${profileId}`))
        if (this.writeQueue.has(`messages:${profileId}`)) clearTimeout(this.writeQueue.get(`messages:${profileId}`))
    }
}

export const store = new JSONStore()
