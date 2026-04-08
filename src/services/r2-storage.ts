import { randomBytes } from 'crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export type MediaMessageType = 'image' | 'video' | 'document'
export type MediaUploadPurpose = 'quick_reply' | 'chat_message' | 'app_logo'

type R2Config = {
    accountId: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    uploadTtlSeconds: number
    downloadTtlSeconds: number
    maxImageBytes: number
    maxVideoBytes: number
    maxDocumentBytes: number
}

const DEFAULT_UPLOAD_TTL_SECONDS = 300
const DEFAULT_DOWNLOAD_TTL_SECONDS = 600
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_VIDEO_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024

let cachedConfig: R2Config | null | undefined
let cachedClient: S3Client | null = null

function readEnvValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function parsePositiveInt(value: unknown, fallback: number): number {
    const raw = Number(value)
    if (!Number.isFinite(raw)) return fallback
    const normalized = Math.floor(raw)
    if (normalized <= 0) return fallback
    return normalized
}

function loadConfig(): R2Config | null {
    const accountId = readEnvValue(process.env.R2_ACCOUNT_ID)
    const bucket = readEnvValue(process.env.R2_BUCKET)
    const accessKeyId = readEnvValue(process.env.R2_ACCESS_KEY_ID)
    const secretAccessKey = readEnvValue(process.env.R2_SECRET_ACCESS_KEY)
    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null

    const genericMaxBytes = parsePositiveInt(process.env.R2_MAX_UPLOAD_BYTES, 0)
    const maxImageBytes = parsePositiveInt(process.env.R2_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES)
    const maxVideoBytes = parsePositiveInt(process.env.R2_MAX_VIDEO_BYTES, genericMaxBytes || DEFAULT_MAX_VIDEO_BYTES)
    const maxDocumentBytes = parsePositiveInt(process.env.R2_MAX_DOCUMENT_BYTES, genericMaxBytes || DEFAULT_MAX_DOCUMENT_BYTES)

    return {
        accountId,
        bucket,
        accessKeyId,
        secretAccessKey,
        uploadTtlSeconds: parsePositiveInt(process.env.R2_UPLOAD_URL_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS),
        downloadTtlSeconds: parsePositiveInt(process.env.R2_DOWNLOAD_URL_TTL_SECONDS, DEFAULT_DOWNLOAD_TTL_SECONDS),
        maxImageBytes,
        maxVideoBytes,
        maxDocumentBytes
    }
}

function getConfig(): R2Config | null {
    if (cachedConfig !== undefined) return cachedConfig
    cachedConfig = loadConfig()
    return cachedConfig
}

function getClient(config: R2Config): S3Client {
    if (cachedClient) return cachedClient
    cachedClient = new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        }
    })
    return cachedClient
}

function normalizeCompanySegment(companyId: string): string {
    const normalized = (companyId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
    return normalized || 'company'
}

function sanitizeFilename(fileName: string): string {
    const normalized = (fileName || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
    return (normalized || 'asset').slice(0, 120)
}

function normalizeAssetKey(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/^\/+/, '') : ''
}

export function isR2Configured(): boolean {
    return Boolean(getConfig())
}

export function normalizeUploadPurpose(value: unknown): MediaUploadPurpose | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'quick_reply') return 'quick_reply'
    if (normalized === 'chat_message') return 'chat_message'
    if (normalized === 'app_logo') return 'app_logo'
    return null
}

export function normalizeMediaMessageType(value: unknown): MediaMessageType | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized
    return null
}

export function isAllowedMimeType(messageType: MediaMessageType, mimeType: string): boolean {
    const normalized = readEnvValue(mimeType).toLowerCase()
    if (!normalized) return false
    if (messageType === 'image') return normalized.startsWith('image/')
    if (messageType === 'video') return normalized.startsWith('video/')
    return true
}

export function getMaxUploadBytes(messageType: MediaMessageType): number {
    const config = getConfig()
    if (!config) return 0
    if (messageType === 'image') return config.maxImageBytes
    if (messageType === 'video') return config.maxVideoBytes
    return config.maxDocumentBytes
}

export function buildAssetKey(args: {
    companyId: string
    purpose: MediaUploadPurpose
    messageType: MediaMessageType
    fileName: string
}): string {
    const companySegment = normalizeCompanySegment(args.companyId)
    const safeFileName = sanitizeFilename(args.fileName)
    const nonce = randomBytes(8).toString('hex')
    return `companies/${companySegment}/${args.purpose}/${args.messageType}/${Date.now()}-${nonce}-${safeFileName}`
}

export function assertCompanyAssetKey(companyId: string, assetKeyRaw: string): string {
    const assetKey = normalizeAssetKey(assetKeyRaw)
    if (!assetKey) {
        throw new Error('assetKey is required.')
    }
    const expectedPrefix = `companies/${normalizeCompanySegment(companyId)}/`
    if (!assetKey.startsWith(expectedPrefix)) {
        throw new Error('Asset key does not belong to this company.')
    }
    return assetKey
}

export async function createUploadUrl(args: {
    companyId: string
    purpose: MediaUploadPurpose
    messageType: MediaMessageType
    fileName: string
    mimeType: string
    sizeBytes: number
}): Promise<{
    assetKey: string
    uploadUrl: string
    headers: Record<string, string>
    expiresAt: string
}> {
    const config = getConfig()
    if (!config) {
        throw new Error('R2 storage is not configured.')
    }

    const assetKey = buildAssetKey({
        companyId: args.companyId,
        purpose: args.purpose,
        messageType: args.messageType,
        fileName: args.fileName
    })
    const client = getClient(config)
    const mimeType = readEnvValue(args.mimeType) || 'application/octet-stream'
    const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: assetKey,
        ContentType: mimeType
    })
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: config.uploadTtlSeconds })
    return {
        assetKey,
        uploadUrl,
        headers: { 'Content-Type': mimeType },
        expiresAt: new Date(Date.now() + config.uploadTtlSeconds * 1000).toISOString()
    }
}

export async function createDownloadUrl(args: {
    companyId: string
    assetKey: string
}): Promise<string> {
    const config = getConfig()
    if (!config) {
        throw new Error('R2 storage is not configured.')
    }
    const assetKey = assertCompanyAssetKey(args.companyId, args.assetKey)
    const client = getClient(config)
    const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: assetKey
    })
    return getSignedUrl(client, command, { expiresIn: config.downloadTtlSeconds })
}
