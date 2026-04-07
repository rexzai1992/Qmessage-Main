export type CompanyMediaMessageType = 'image' | 'video' | 'document'
export type CompanyMediaUploadPurpose = 'quick_reply' | 'chat_message'

export type UploadedCompanyMedia = {
    assetKey: string
    mimeType: string
    sizeBytes: number
    fileName: string
}

function readTrimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

export async function uploadFileToCompanyStorage(args: {
    apiBaseUrl: string
    profileId: string
    sessionToken: string
    purpose: CompanyMediaUploadPurpose
    messageType: CompanyMediaMessageType
    file: File
}): Promise<UploadedCompanyMedia> {
    const { apiBaseUrl, profileId, sessionToken, purpose, messageType, file } = args
    const createRes = await fetch(`${apiBaseUrl}/api/company/media/upload-url?profileId=${encodeURIComponent(profileId)}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${sessionToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            purpose,
            messageType,
            fileName: file.name || `${messageType}-${Date.now()}`,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size
        })
    })
    const createData = await createRes.json().catch(() => null)
    if (!createRes.ok || !createData?.success) {
        throw new Error(createData?.error || 'Failed to create upload URL.')
    }
    const assetKey = readTrimmed(createData?.data?.assetKey)
    const uploadUrl = readTrimmed(createData?.data?.uploadUrl)
    if (!assetKey || !uploadUrl) {
        throw new Error('Upload URL response is missing required fields.')
    }

    const rawHeaders = createData?.data?.headers
    const uploadHeaders = new Headers()
    if (rawHeaders && typeof rawHeaders === 'object') {
        Object.entries(rawHeaders).forEach(([key, value]) => {
            const headerName = readTrimmed(key)
            const headerValue = readTrimmed(value)
            if (headerName && headerValue) uploadHeaders.set(headerName, headerValue)
        })
    }
    if (!uploadHeaders.has('Content-Type')) {
        uploadHeaders.set('Content-Type', file.type || 'application/octet-stream')
    }

    const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: uploadHeaders,
        body: file
    })
    if (!uploadRes.ok) {
        throw new Error('Upload to storage failed.')
    }

    return {
        assetKey,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        fileName: file.name || `${messageType}-${Date.now()}`
    }
}

